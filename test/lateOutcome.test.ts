// E-10, acceptance round 4 (PR #48): a transaction outcome has exactly one recipient — the caller (awaitOutcome) OR the late
// outcome subscriber (onLateOutcome), in any "caller / background" order. Separate file: the tests run a fake clock for tens of minutes.
// Round 3 reviewer repros (A: race, race2, race3; B: ghost-receipt) are moved here as regression tests.
import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmSender, PENDING_MAX_MS, GHOST_WATCH_MS } from '../src/live/evm.js';

const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://r', send: ['http://r'], priorityMatters: true } as const;
const acc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const TX = { to: '0x000000000000000000000000000000000000dEaD' as const, value: 1n, gas: 21_000n };
const RECEIPT = { status: '0x1', blockNumber: '0x10', logs: [] };

/** A node that keeps the transaction in the pool (knows the hash, the nonce is taken) until the test says "mined" or "replaced". */
function node() {
  const st = { mined: false, latest: 3, known: true };
  const rpc = async (_u: string, m: string, params: any[]) => {
    if (m === 'eth_sendRawTransaction') return params[0];
    if (m === 'eth_getTransactionCount') return params[1] === 'latest' ? '0x' + (st.mined ? 4 : st.latest).toString(16) : '0x4';
    if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
    if (m === 'eth_maxPriorityFeePerGas') return '0x1';
    if (m === 'eth_getTransactionReceipt') return st.mined ? RECEIPT : null;
    if (m === 'eth_getTransactionByHash') return st.known ? { hash: params[0] } : null;
    throw new Error(m);
  };
  return { st, rpc };
}
/** A sender with a transaction "in flight" and a late outcome subscriber. */
async function pendingTx(maxPendingMs = 15 * 60_000) {
  const n = node();
  const s = new EvmSender({ ...chain } as any, n.rpc as any);
  const late: { hash: string; state: string; kind: string }[] = [];
  s.onLateOutcome = (rec, o, kind) => late.push({ hash: rec.hash, state: o.state, kind });
  s.maxPendingMs = maxPendingMs;
  const p = s.send(acc, TX); await vi.advanceTimersByTimeAsync(50_000); const r = await p;
  expect(r.pending).toBe(true);
  return { ...n, s, late, hash: r.hash, h: r.hash.toLowerCase() };
}
const isExpired = (s: EvmSender, h: string) => s.outcomes.get(h)?.state === 'expired';

describe('E-10 round 4: one outcome recipient — the caller OR the late outcome subscriber', () => {
  it('the wait limit is 30 min (the owner\'s decision 2026-11-11 10:17 UTC), a ghost after "dropped" is still watched for 3 h', () => {
    expect(PENDING_MAX_MS).toBe(30 * 60_000);
    expect(GHOST_WATCH_MS).toBe(3 * 60 * 60_000);
  });

  it('repro A (race): the receipt appears while the caller is still polling after expired → ONLY the subscriber gets the receipt, the caller gets expired', async () => {
    vi.useFakeTimers();
    try {
      const t = await pendingTx();
      await vi.advanceTimersByTimeAsync(t.s.maxPendingMs + 3 * 60_000);
      expect(isExpired(t.s, t.h)).toBe(true);
      const o = t.s.awaitOutcome(t.hash); // the caller is still waiting
      t.st.mined = true;                  // the receipt appears right now
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await o).state).toBe('expired'); // before, this was mined AND a late delivery at once → double accounting
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(t.late).toEqual([{ hash: t.hash, state: 'mined', kind: 'expired' }]); // exactly one delivery
      expect((await t.s.awaitOutcome(t.hash)).state).toBe('expired'); // and when asked again, the caller does not get the receipt
      expect(t.s.hasPending(acc.address)?.ghost).toBe(true); // the address is blocked until the ledger confirms the record
      t.s.ackLate(t.hash);
      expect(t.s.hasPending(acc.address)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  }, 30_000);

  for (const off of [0, 250, 500, 750, 1000, 1250, 1500, 1750]) {
    it(`repro A (race2, window): the caller polls after expired, receipt after 333 ms, offset ${off} ms → exactly one recipient`, async () => {
      vi.useFakeTimers();
      try {
        const t = await pendingTx();
        await vi.advanceTimersByTimeAsync(t.s.maxPendingMs + 3 * 60_000 + off);
        expect(isExpired(t.s, t.h)).toBe(true);
        const o = t.s.awaitOutcome(t.hash);
        await vi.advanceTimersByTimeAsync(333);
        t.st.mined = true;
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        const caller = (await o).state === 'mined' ? 1 : 0;
        expect(caller + t.late.length).toBe(1);
        expect(t.late.length).toBe(1); // after expired the recipient is the subscriber
      } finally { vi.useRealTimers(); }
    }, 30_000);
  }

  it('reverse order: the caller waits ACROSS the moment the deadline expires, the receipt — at any second around it → exactly one recipient, the receipt is not lost', async () => {
    vi.useFakeTimers();
    try {
      // Dry run: when the background declares expired (from the moment of sending)
      const dry = await pendingTx(); const t0 = Date.now();
      while (!isExpired(dry.s, dry.h)) await vi.advanceTimersByTimeAsync(250);
      const expireAfter = Date.now() - t0;
      for (const off of [-8000, -5000, -3000, -2000, -1000, -500, -250, 0, 250, 500, 1000, 2000, 3000, 5000, 8000]) {
        const t = await pendingTx(); const start = Date.now();
        await vi.advanceTimersByTimeAsync(expireAfter - 4 * 60_000);
        const o = t.s.awaitOutcome(t.hash); // the caller's 10-minute poll covers the expiry moment
        await vi.advanceTimersByTimeAsync(start + expireAfter + off - Date.now());
        t.st.mined = true;
        await vi.advanceTimersByTimeAsync(12 * 60_000);
        const res = await o;
        const caller = res.state === 'mined' ? 1 : 0;
        expect([off, caller + t.late.length]).toEqual([off, 1]); // neither "both" nor "nobody"
        if (!caller) { expect(res.state).toBe('expired'); expect(t.late[0]).toEqual({ hash: t.hash, state: 'mined', kind: 'expired' }); expect(t.s.hasPending(acc.address)?.ghost).toBe(true); }
        else expect(t.s.hasPending(acc.address)).toBeUndefined(); // the caller took it itself — no block
        expect(t.s.pendingTx.size).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  }, 60_000);

  for (const off of [-3000, -2000, -1000, -500, 0, 500, 1000, 1500, 2000]) {
    it(`repro A (race3): the resolveLost recheck finds the receipt after expired (offset ${off} ms from the 5-minute poll) → ghost AND delivery to the subscriber`, async () => {
      vi.useFakeTimers();
      try {
        const t = await pendingTx();
        while (!isExpired(t.s, t.h)) await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(5 * 60_000 + off);
        t.st.mined = true;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.s.outcomes.get(t.h)?.state).toBe('mined');
        expect(t.late).toEqual([{ hash: t.hash, state: 'mined', kind: 'expired' }]); // before: 0 deliveries and no ghost
        expect(t.s.hasPending(acc.address)?.ghost).toBe(true);
        expect(t.s.pendingTx.size).toBe(0);
      } finally { vi.useRealTimers(); }
    }, 30_000);
  }

  it('the caller\'s last poll (last) hands the outcome to the subscriber itself: after the deadline the receipt goes only via the subscription; before it — only to the caller', async () => {
    vi.useFakeTimers();
    try {
      // 1) no receipt until the end of the last poll → expired, the record is handed over, the background delivers
      const t = await pendingTx(60 * 60_000); // the sender's deadline is far away: it is the caller who hands over
      const o = t.s.awaitOutcome(t.hash, 2 * 60_000, { last: true });
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect((await o).state).toBe('expired');
      expect(t.s.pendingTx.get(t.h)?.handedOver).toBe('expired'); expect(t.late.length).toBe(0);
      expect((await t.s.awaitOutcome(t.hash, 1_000)).state).toBe('expired'); // ownership does not come back
      t.st.mined = true;
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(t.late).toEqual([{ hash: t.hash, state: 'mined', kind: 'expired' }]);
      // 2) the receipt arrived during the last poll → the caller gets it itself, nothing for the subscriber
      const u = await pendingTx(60 * 60_000);
      const o2 = u.s.awaitOutcome(u.hash, 2 * 60_000, { last: true });
      await vi.advanceTimersByTimeAsync(30_000); u.st.mined = true; await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect((await o2).state).toBe('mined'); expect(u.late.length).toBe(0); expect(u.s.hasPending(acc.address)).toBeUndefined();
      // 3) not the last poll: deadline passed → unknown, the caller keeps ownership (the next poll gets the receipt)
      const v = await pendingTx(60 * 60_000);
      const o3 = v.s.awaitOutcome(v.hash, 2 * 60_000); await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect((await o3).state).toBe('unknown'); expect(v.s.pendingTx.get(v.h)?.handedOver).toBeUndefined();
      v.st.mined = true;
      const o4 = v.s.awaitOutcome(v.hash, 2 * 60_000); await vi.advanceTimersByTimeAsync(10_000);
      expect((await o4).state).toBe('mined'); expect(v.late.length).toBe(0);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('after the wait deadline the outcome is closed for good even without a receipt: the nonce slot is taken by another → replaced goes to the subscriber (the reserve does not hang until restart)', async () => {
    vi.useFakeTimers();
    try {
      const t = await pendingTx();
      await vi.advanceTimersByTimeAsync(t.s.maxPendingMs + 3 * 60_000);
      expect(isExpired(t.s, t.h)).toBe(true);
      t.st.known = false; t.st.latest = 5; // the slot is taken in a block on all nodes, no receipt for the hash
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      expect(t.late).toEqual([{ hash: t.hash, state: 'replaced', kind: 'expired' }]);
      expect(t.s.hasPending(acc.address)).toBeUndefined(); // nothing to reconcile: the address is free, the nonce is re-read
      expect((await t.s.awaitOutcome(t.hash, 1_000)).state).toBe('expired'); // the result is not duplicated to the caller
      // Before the wait deadline "dropped / replaced" still goes to the caller, not the subscriber
      const u = await pendingTx();
      u.st.known = false; u.st.latest = 5;
      const o = u.s.awaitOutcome(u.hash); await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect((await o).state).toBe('replaced'); expect(u.late.length).toBe(0);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('repro B (ghost-receipt): "dropped" → a retry with the same hash gets a receipt within 3 s → result "in a block", no ghost', async () => {
    let mined: any = null; let known = false;
    const rpc = async (_u: string, m: string, params: any[]) => {
      if (m === 'eth_getTransactionCount') return mined ? '0x4' : '0x3';
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x0';
      if (m === 'eth_sendRawTransaction') { if (known) return params[0]; throw new TypeError('fetch failed'); }
      if (m === 'eth_getTransactionReceipt') return mined;
      if (m === 'eth_getTransactionByHash') return known ? { hash: 'x' } : null;
      throw new Error(m);
    };
    const s = new EvmSender({ chain: 'robinhood', id: 4663, native: 'ETH', rpc: 'http://r', send: ['http://r'], priorityMatters: false } as any, rpc as any);
    vi.useFakeTimers();
    try {
      const p1 = s.send(acc, TX); await vi.advanceTimersByTimeAsync(50_000); const r1 = await p1;
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(s.outcomes.get(r1.hash.toLowerCase())?.state).toBe('dropped');
      known = true; // retry: the sequencer accepts, the transaction lands in a block while waiting for the receipt
      const p2 = s.send(acc, TX);
      await vi.advanceTimersByTimeAsync(3_000); mined = { status: '0x1', blockNumber: '0x10' };
      await vi.advanceTimersByTimeAsync(5_000); const r2 = await p2;
      expect(r2.hash).toBe(r1.hash); expect(r2.ok).toBe(true); expect(r2.pending).toBe(false);
      expect(s.outcomes.get(r1.hash.toLowerCase())?.state).toBe('mined'); // send() with a receipt remembers the result
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(s.ghostMined.size).toBe(0); expect(s.hasPending(acc.address)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('all lanes refused, the caller does not wait for the outcome (abandon), but the gateway forwarded the transaction and it landed → late outcome "ghost" and an address block, not silence', async () => {
    const mk = () => {
      const st = { mined: false, known: false };
      const rpc = async (_u: string, m: string, params: any[]) => {
        if (m === 'eth_sendRawTransaction') throw new Error('eth_sendRawTransaction: internal error'); // the gateway answered with an error but forwarded it
        if (m === 'eth_getTransactionCount') return params[1] === 'latest' ? (st.mined ? '0x4' : '0x3') : '0x4';
        if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
        if (m === 'eth_maxPriorityFeePerGas') return '0x1';
        if (m === 'eth_getTransactionReceipt') return st.mined ? RECEIPT : null;
        if (m === 'eth_getTransactionByHash') return st.known ? { hash: params[0] } : null;
        throw new Error(m);
      };
      const s = new EvmSender({ ...chain } as any, rpc as any);
      const late: any[] = []; s.onLateOutcome = (rec, o, kind) => late.push({ hash: rec.hash, state: o.state, kind });
      return { st, s, late };
    };
    vi.useFakeTimers();
    try {
      // 1) the caller got a refusal and does not wait (sale: sellToken → abandon)
      const a = mk(); a.st.known = true;
      const p = a.s.send(acc, TX); await vi.advanceTimersByTimeAsync(5_000); const r = await p;
      expect(r.pending).toBe(true); expect(r.unknown).toContain('rejected-by-all-lanes');
      a.s.abandon(r.hash);
      await vi.advanceTimersByTimeAsync(20_000); a.st.mined = true; await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(a.late).toEqual([{ hash: r.hash, state: 'mined', kind: 'ghost' }]);
      expect(a.s.hasPending(acc.address)?.ghost).toBe(true);
      // 2) the caller waits for the outcome itself (buy: settleBuy → awaitOutcome) — it gets the receipt, the subscriber does not
      const b = mk(); b.st.known = true;
      const p2 = b.s.send(acc, TX); await vi.advanceTimersByTimeAsync(5_000); const r2 = await p2;
      const o = b.s.awaitOutcome(r2.hash);
      await vi.advanceTimersByTimeAsync(20_000); b.st.mined = true; await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect((await o).state).toBe('mined'); expect(b.late.length).toBe(0); expect(b.s.hasPending(acc.address)).toBeUndefined();
      // 3) a rejected and abandoned transaction really dropped — the subscriber is not bothered
      const c = mk();
      const p3 = c.s.send(acc, TX); await vi.advanceTimersByTimeAsync(5_000); const r3 = await p3; c.s.abandon(r3.hash);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(c.s.outcomes.get(r3.hash.toLowerCase())?.state).toBe('dropped'); expect(c.late.length).toBe(0); expect(c.s.hasPending(acc.address)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('two late outcomes on one address not confirmed by the ledger: confirming one does not lift the block for the other; a subscriber failure does not lift the block', async () => {
    vi.useFakeTimers();
    try {
      const t = await pendingTx();
      const addr = acc.address.toLowerCase();
      const H2 = ('0x' + 'b'.repeat(64)) as `0x${string}`;
      t.s.trackPending(addr, 9, H2);
      t.s.onLateOutcome = () => { throw new Error('ledger down'); }; // a subscriber exception does not crash the background and does not lift the block
      const errs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await vi.advanceTimersByTimeAsync(t.s.maxPendingMs + 3 * 60_000);
      t.st.mined = true;
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      expect(t.s.ghostMined.size).toBe(2);
      expect(errs.mock.calls.some(c => /late outcome handler/.test(String(c[0])))).toBe(true);
      errs.mockRestore();
      t.s.ackLate(t.hash);
      expect(t.s.hasPending(addr)?.hash).toBe(H2); // the second outcome is not confirmed by the ledger — the address is still blocked
      t.s.ackLate(H2);
      expect(t.s.hasPending(addr)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  }, 30_000);
});
