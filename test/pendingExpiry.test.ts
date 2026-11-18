// E-10, acceptance round 2: "expired" ≠ "dropped". A separate file: the tests turn the clock by tens of minutes, background watchers
// of other tests must not share fake timers with them.
import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmSender, PENDING_MAX_MS } from '../src/live/evm.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';

const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;

describe('E-10 round 2, blocker 1: a stuck transaction — expired, not dropped', () => {
  it('blocker 1 (repro A/B): a transaction stuck past the wait limit that the nodes know — expired, NOT dropped: the caller gets pending, the nonce is not reset, the reserve stays', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const f: typeof fetch = async (_u: any, init: any) => { const b = JSON.parse(init.body); const res = (r: any) => new Response(JSON.stringify({ result: r }));
      if (b.method === 'eth_getTransactionCount') return res(b.params[1] === 'latest' ? '0x3' : '0x4'); // the node holds nonce 3 in the pool
      if (b.method === 'eth_getTransactionReceipt') return res(null);
      if (b.method === 'eth_getTransactionByHash') return res({ hash: b.params[0] });
      throw new Error(b.method); };
    const t = new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
    const s = t.sender('base')!;
    vi.useFakeTimers();
    try {
      const addr = W.evmTreasury.address.toLowerCase();
      await s.nonce(W.evmTreasury.address); // next = 5 (4 from the node, reserved)
      const H = ('0x' + 'a'.repeat(64)) as `0x${string}`;
      s.maxPendingMs = 15 * 60_000; // instead of 30 min — so that the fake-timer test does not spin thousands of polls
      s.trackPending(addr, 3, H);
      let r: any; let i = 0;
      for (;; i++) { const p = t.settleBuy({ chain: 'base', token: '0x' + '2'.repeat(40), sizeUsd: 1, tx: H, decimals: 18 }); await vi.advanceTimersByTimeAsync(11 * 60_000); r = await p; if (!r.pending || i >= 2) break; }
      expect(i).toBe(2); // all polls — outcome unknown
      expect(s.outcomes.get(H)?.state).toBe('expired');
      expect(r.pending).toBe(true); expect(r.note).toMatch(/stuck|still no receipt/);
      expect(s.pendingTx.has(H)).toBe(true); // the record is alive: the address stays blocked (a new transaction will not queue behind the stuck one)
      expect(await s.nonce(W.evmTreasury.address, false)).toBe(5); // the local next (4 read from the node and reserved → 5) is NOT reset
      const pS = t.settleTx('base', H); await vi.advanceTimersByTimeAsync(11 * 60_000); expect(await pS).toBe('unknown'); // expired outwards = "unknown", not dropped
      // Only if the nodes stopped knowing the hash and the slot is free — then dropped
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('blocker 1 (repro B, at the EvmSender level): send → longer than the wait limit in the mempool → awaitOutcome = expired, nonce taken; slot replacement → replaced', async () => {
    const acc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    let latest = 3; let sentOnce = false;
    const rpc = async (_u: string, m: string, params: any[]) => {
      // before sending the pending counter is 4 (our tx gets nonce 4); after — the node holds it in the pool: pending 5
      if (m === 'eth_getTransactionCount') return params[1] === 'latest' ? '0x' + latest.toString(16) : (sentOnce ? '0x5' : '0x4');
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x1';
      if (m === 'eth_sendRawTransaction') { sentOnce = true; return params[0]; }
      if (m === 'eth_getTransactionReceipt') return null;
      if (m === 'eth_getTransactionByHash') return null; // nobody knows the hash, but the pending counter 4 > 3: someone holds the slot (the same tx at the sequencer)
      throw new Error(m);
    };
    const s = new EvmSender({ ...chain, rpc: 'http://r', send: ['http://r'] }, rpc as any);
    vi.useFakeTimers();
    try {
      s.maxPendingMs = 15 * 60_000; // instead of 30 min (PENDING_MAX_MS) — saves fake time in the test
      expect(PENDING_MAX_MS).toBe(30 * 60_000); // the owner's decision 2026-11-11 10:17 UTC: wait limit 30 min (was 3 h)
      const p = s.send(acc, { to: '0x000000000000000000000000000000000000dEaD', value: 1n, gas: 21_000n }); await vi.advanceTimersByTimeAsync(50_000); const r = await p;
      expect(r.pending).toBe(true);
      await vi.advanceTimersByTimeAsync(s.maxPendingMs + 3 * 60_000);
      expect(s.pendingTx.size).toBe(1); // the record is alive
      expect(s.outcomes.get(r.hash.toLowerCase())?.state).toBe('expired');
      const o = s.awaitOutcome(r.hash); await vi.advanceTimersByTimeAsync(10_000); const res = await o;
      expect(res.state).toBe('expired');
      expect(await s.nonce(acc.address, false)).toBe(5); // the nonce is not reset while the tx is in the pool
      // The slot is taken in a block on all nodes (latest 5 > 4), no receipt → replaced: the record is removed, the nonce re-read
      latest = 5;
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(s.outcomes.get(r.hash.toLowerCase())?.state).toBe('replaced'); expect(s.pendingTx.size).toBe(0);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('round 3 item 1 (repro Y): a send-only lane (sequencer, "method not available") does not vote — a really dropped transaction becomes dropped, the address is unblocked', async () => {
    const acc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const rpc = async (u: string, m: string, params: any[]) => {
      if (m === 'eth_sendRawTransaction') return params[0];
      if (u === 'http://seq') throw new Error(`${m}: the method ${m} does not exist/is not available`); // the parsed answer of a send-only sequencer
      if (m === 'eth_getTransactionCount') return '0x3';
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x1';
      if (m === 'eth_getTransactionReceipt' || m === 'eth_getTransactionByHash') return null; // the reading node: no transaction
      throw new Error(m);
    };
    const s = new EvmSender({ ...chain, rpc: 'http://read', send: ['http://read', 'http://seq'] } as any, rpc as any);
    vi.useFakeTimers();
    try {
      s.maxPendingMs = 15 * 60_000;
      const p = s.send(acc, { to: '0x000000000000000000000000000000000000dEaD', value: 1n, gas: 21_000n }); await vi.advanceTimersByTimeAsync(50_000); const r = await p;
      expect(r.pending).toBe(true);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(s.outcomes.get(r.hash.toLowerCase())?.state).toBe('dropped');
      expect(s.hasPending(acc.address)).toBeUndefined();
      expect(await s.nonce(acc.address, false)).toBe(3);
      // And if there are no reading nodes at all (all lanes send-only) — it cannot be decided: unknown, the record lives
      const s2 = new EvmSender({ ...chain, rpc: 'http://seq', send: ['http://seq'] } as any, rpc as any);
      expect(await s2.txKnown('0x' + 'f'.repeat(64))).toBe('noanswer');
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('round 3 item 2 (repro X): a receipt after expired → a ghost on the address AND the late outcome delivered to the subscriber; without a subscriber — only the block', async () => {
    const acc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    let mined = false;
    const rpc = async (_u: string, m: string, params: any[]) => {
      if (m === 'eth_sendRawTransaction') return params[0];
      if (m === 'eth_getTransactionCount') return params[1] === 'latest' ? (mined ? '0x4' : '0x3') : '0x4';
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x1';
      if (m === 'eth_getTransactionReceipt') return mined ? { status: '0x1', blockNumber: '0x10', logs: [] } : null;
      if (m === 'eth_getTransactionByHash') return { hash: params[0] };
      throw new Error(m);
    };
    const s = new EvmSender({ ...chain, rpc: 'http://read', send: ['http://read'] } as any, rpc as any);
    const late: any[] = []; s.onLateOutcome = (rec, o, kind) => late.push({ rec, o, kind });
    vi.useFakeTimers();
    try {
      s.maxPendingMs = 15 * 60_000;
      const p = s.send(acc, { to: '0x000000000000000000000000000000000000dEaD', value: 1n, gas: 21_000n }); await vi.advanceTimersByTimeAsync(50_000); const r = await p;
      await vi.advanceTimersByTimeAsync(s.maxPendingMs + 3 * 60_000);
      expect(s.outcomes.get(r.hash.toLowerCase())?.state).toBe('expired');
      const o = s.awaitOutcome(r.hash); await vi.advanceTimersByTimeAsync(10_000); expect((await o).state).toBe('expired'); // the caller gave up
      mined = true;
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(s.outcomes.get(r.hash.toLowerCase())?.state).toBe('mined');
      expect(s.hasPending(acc.address)?.ghost).toBe(true); // the address is under a ghost until reconciliation
      expect(late.length).toBe(1); expect(late[0].kind).toBe('expired'); expect(late[0].o.state).toBe('mined'); expect(late[0].rec.hash).toBe(r.hash);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('round 3 item 3 (repro B): dropped → a retry with the same nonce and fees (the same hash) lands in a block → NOT a ghost, the address is free', async () => {
    const acc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
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
      const tx = { to: '0x000000000000000000000000000000000000dEaD' as const, value: 1n, gas: 21_000n };
      const p1 = s.send(acc, tx); await vi.advanceTimersByTimeAsync(50_000); const r1 = await p1;
      expect(r1.pending).toBe(true);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(s.outcomes.get(r1.hash.toLowerCase())?.state).toBe('dropped'); // background: dropped, nonce reset, watchGhost started
      known = true;
      const p2 = s.send(acc, tx); await vi.advanceTimersByTimeAsync(50_000); const r2 = await p2;
      expect(r2.hash).toBe(r1.hash); // the same nonce, the same fees → the same hash
      mined = { status: '0x1', blockNumber: '0x10' };
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(s.outcomes.get(r1.hash.toLowerCase())?.state).toBe('mined');
      expect(s.hasPending(acc.address)).toBeUndefined(); // a legitimate retry landed in a block — no ghost, the address is free
      expect(s.ghostMined.size).toBe(0);
    } finally { vi.useRealTimers(); }
  }, 30_000);
});
