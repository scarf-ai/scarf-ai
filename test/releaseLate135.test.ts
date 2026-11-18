// #135 R1: /release not-sold for a sale that may still land in a block. (1) While the transaction is on the network — refusal. (2) A released sale
// is remembered for 24 h (memory and database): a late 0x1 outcome is counted once (no more than the remainder), and does not become a ghost without a pair.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const H = ('0x' + 'c'.repeat(64)) as `0x${string}`;
const H2 = '0x' + 'd'.repeat(64);
const EVM = '0x4444444444444444444444444444444444444444';
const RAW = 2000n * 10n ** 18n;
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-18T08:00:00.000Z', text: 'ape' };
const D: Decision = { action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] } as any, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM } as any,
  check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-19T08:00:00.000Z' } } as any;
const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
const late0x1 = { chain: 'base', hash: H, addr: '0xabc', nonce: 3, kind: 'expired', state: 'mined', receipt: { status: '0x1', logs: [] }, treasury: true };

/** A TP1 sale "in flight", the caller gave up — the hold is pending. stillInNetwork is set by the test; a second sale (if it gets there) — ok right away. */
async function held(o: { live?: 'yes' | 'no' | 'unknown'; store?: Store; clock?: VirtualClock; risk?: RiskState } = {}) {
  const clock = o.clock ?? new VirtualClock(Date.UTC(2026, 10, 18, 8));
  const store = o.store ?? new Store(':memory:'); const risk = o.risk ?? new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = []; let sells = 0;
  const p = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t: string) { sent.push(t); } }, clock); p.liveMode = 'live';
  p.trader = { setLateOutcomeHandler() {}, clearGhost() {}, ghostBlocks() { return []; },
    ...(o.live ? { async stillInNetwork() { return o.live; } } : {}),
    async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
    async sellToken() { sells++; return sells === 1 ? { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, nonce: 3, from: '0xabc', note: 'sell pending' }
      : { ok: true, mode: 'live', proceedsUsd: 2.4, soldRaw: RAW / 2n, tx: H2, note: 'sold' }; },
    async settleTx() { return 'unknown'; } } as any;
  await p.execute(MSG, D, 1); const cash0 = risk.cashUsd;
  await p.monitor(market, { tokensOnly: true }); await tick();
  expect(p.holds().map(x => x.tx)).toEqual([H]);
  return { p, store, risk, clock, sent, cash0, sells: () => sells };
}

describe('#135 R1 (1): not-sold while the transaction is still on the network — refusal', () => {
  it('stillInNetwork "yes" / "unknown" → refusal, the hold stays; "no" → released', async () => {
    const y = await held({ live: 'yes' });
    expect(await y.p.release(H, 'not-sold')).toBe(`Transaction ${H} is still on the network (a node holds it without a block) — wait for the outcome; it cannot be released as "did not go through" now.`);
    expect(y.p.holds().map(x => x.tx)).toEqual([H]);
    const u = await held({ live: 'unknown' });
    expect(await u.p.release(H, 'not-sold')).toMatch(/^Could not check whether 0xc+ is still on the network \(the node did not answer\) — repeat \/release later\./);
    expect(u.p.holds()).toHaveLength(1);
    const n = await held({ live: 'no' });
    expect(await n.p.release(H, 'not-sold')).toMatch(/lifted on the owner's command \(did not go through\).*I will count it once/);
    expect(n.p.holds()).toEqual([]);
  });

  it('trader: in flight at the sender → yes; outcome decided (in a block/ghost) → no; a node knows it without a receipt → yes; nobody knows → no; the node is silent → unknown', async () => {
    const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;
    const mk = (o: { known?: boolean; receipt?: boolean; down?: boolean }) => new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500,
      fetchImpl: (async (_u: any, init: any) => {
        if (o.down) throw Object.assign(new TypeError('fetch failed'), {});
        const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
        if (b.method === 'eth_getTransactionByHash') return res(o.known ? { hash: b.params[0] } : null);
        if (b.method === 'eth_getTransactionReceipt') return res(o.receipt ? { status: '0x1', blockNumber: '0x1', transactionHash: b.params[0] } : null);
        throw new Error(b.method);
      }) as any });
    const a = mk({}); a.sender('base')!.pendingTx.set(H, { addr: '0xabc', nonce: 3, hash: H, atMs: 0 });
    expect(await a.stillInNetwork('base', H)).toBe('yes');
    const b = mk({}); b.sender('base')!.outcomes.set(H, { state: 'mined', receipt: { blockNumber: '0x1' }, atMs: 0, late: true });
    expect(await b.stillInNetwork('base', H)).toBe('no');
    expect(await mk({ known: true }).stillInNetwork('base', H)).toBe('yes');
    expect(await mk({ known: true, receipt: true }).stillInNetwork('base', H)).toBe('no');
    expect(await mk({ known: false }).stillInNetwork('base', H)).toBe('no');
    expect(await mk({ down: true }).stillInNetwork('base', H)).toBe('unknown');
  });
});

describe('#135 R1 (2): a released sale did land in a block', () => {
  it('a late 0x1 → counted once (half sold, proceeds in cash), a message to the owner; the monitor does not sell the same step a second time', async () => {
    const w = await held({ live: 'no' });
    await w.p.release(H, 'not-sold');
    expect(JSON.parse(w.store.openPositions()[0].state).releasedSells).toEqual([expect.objectContaining({ tx: H, qty: 1000, proceeds: 2.5 })]);
    await (w.p as any).onLateOutcome(late0x1);
    const pos = [...w.p.open.values()][0];
    expect(pos.qtyLeft).toBe(1000); expect(w.risk.cashUsd - w.cash0).toBeCloseTo(2.5, 6);
    expect(w.sent.some(t => /released by \/release not-sold, got a late outcome/.test(t))).toBe(true);
    expect(w.sent.some(t => /Late sale receipt 0xc+ .* — counted/.test(t))).toBe(true);
    expect(JSON.parse(w.store.openPositions()[0].state).releasedSells).toBeUndefined();
    await w.p.monitor(market, { tokensOnly: true }); await tick();
    expect(w.sells()).toBe(1);
    await (w.p as any).onLateOutcome(late0x1); // repeated delivery
    expect(w.risk.cashUsd - w.cash0).toBeCloseTo(2.5, 6);
  });

  it('after the release the monitor sold the step again; a late 0x1 of the first — counted no more than the remainder (the position is closed, not negative)', async () => {
    const w = await held({ live: 'no' });
    await w.p.release(H, 'not-sold');
    await w.p.monitor(market, { tokensOnly: true }); await tick();
    expect(w.sells()).toBe(2);
    const pos = [...w.p.open.values()][0]; expect(pos.qtyLeft).toBe(1000);
    await (w.p as any).onLateOutcome(late0x1);
    expect(w.p.open.size).toBe(0); // remainder 1000 — 1000 counted (not 1000 out of an already zero one)
    expect(w.store.openPositions()).toEqual([]);
  });

  it('a released one is remembered after a restart (database) and no longer than 24 h; a revert (0x0) — the record is removed without counting', async () => {
    const w = await held({ live: 'no' });
    await w.p.release(H, 'not-sold');
    const p2 = new PaperExecutor(DEFAULT_RISK, w.risk, w.store, { async send() {} }, w.clock); p2.liveMode = 'live';
    p2.trader = { setLateOutcomeHandler() {}, clearGhost() {} } as any; p2.restore();
    await (p2 as any).onLateOutcome({ ...late0x1, receipt: { status: '0x0' } });
    expect(w.risk.cashUsd).toBe(w.cash0); expect(JSON.parse(w.store.openPositions()[0].state).releasedSells).toBeUndefined();
    // older than 24 h — not remembered: a late outcome — as before, a transaction without a pair
    const x = await held({ live: 'no' });
    await x.p.release(H, 'not-sold');
    x.clock.advance(24 * 3600_000 + 1);
    await (x.p as any).onLateOutcome(late0x1);
    expect(x.risk.cashUsd).toBe(x.cash0);
    expect(x.sent.at(-1)).toMatch(/it has no pair in the ledger — the treasury on this chain is blocked until reconciliation .* \/release 0xc+ not-sold \(lift the block\)/);
  });

  it('a sale receipt without a status — a hint with both options (the sale is in the ledger)', async () => {
    const w = await held({ live: 'no' });
    await (w.p as any).onLateOutcome({ ...late0x1, receipt: { blockNumber: '0x1' } });
    expect(w.sent.at(-1)).toMatch(/\/release 0xc+ sold \(the sale went through — count it\) or \/release 0xc+ not-sold/);
  });
});
