// E-10, acceptance round 4 (PR #48): one transaction — one ledger record, in any "caller / late channel" order,
// for buys and sales. Auto-events are off (the monitor is called by hand), the executor time is virtual;
// in the end-to-end tests the sender's clock is vitest fake timers.
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const TOKEN = '0x4444444444444444444444444444444444444444';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: `ape ${TOKEN}` };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (sizeUsd = 2): Decision => ({ action: 'buy_token', sizeUsd, chain: 'base', reasons: [], trust, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: TOKEN },
  check: { ok: true, chain: 'base', address: TOKEN, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-10-30T08:00:00.000Z' } } as any);
const H = '0x' + 'a'.repeat(64);
const HS = '0x' + 'c'.repeat(64);
const RAW = 2000n * 10n ** 18n;
const OK = { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: H, note: 'late: got 2000' };
const PEND = { ok: false, pending: true, mode: 'live', qty: 0, raw: 0n, decimals: 0, spentUsd: 0, tx: H, note: 'stuck' };
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

function setup(notifier?: { send(t: string): Promise<void> }) {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, notifier ?? { async send(t) { sent.push(t); } }, clock);
  paper.liveMode = 'live';
  return { clock, store, risk, paper, sent };
}
/** A stub trader for a buy "in flight": the test gives the outcome to the caller (settle) and to the late channel (handler). */
function buyTrader(over: Record<string, unknown> = {}) {
  let settle!: (r: any) => void; const settled = new Promise<any>(r => { settle = r; });
  const t: any = {
    handler: undefined as any, acks: [] as string[],
    setLateOutcomeHandler(h: any) { this.handler = h; },
    clearGhost(_c: string, hash: string) { this.acks.push(hash); },
    async buyToken() { return { ...PEND, decimals: 18, note: 'tx pending' }; },
    settleBuy: () => settled,
    async buyFromLateReceipt() { return OK; },
    ...over,
  };
  return { t, settle };
}
const lateBuy = (o: Record<string, unknown> = {}) => ({ chain: 'base', hash: H, addr: '0xabc', nonce: 3, kind: 'expired', state: 'mined', receipt: { status: '0x1' }, treasury: true, ...o });

describe('E-10 round 4: a buy "in flight" — one ledger record in any order', () => {
  it('repro A/B (late-race): the late channel first, then the caller gets the same outcome → ONE position, cash charged once', async () => {
    const e = setup(); const { t, settle } = buyTrader(); e.paper.trader = t;
    const cash0 = e.risk.cashUsd;
    await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
    t.handler(lateBuy());  // the background saw the receipt
    settle(OK);            // and so did the caller
    await tick();
    expect(e.risk.positions.length).toBe(1); expect(e.paper.open.size).toBe(1); expect(e.store.openPositions().length).toBe(1);
    expect(cash0 - e.risk.cashUsd).toBeCloseTo(2.02, 5); // before: −4.04 for a single buy
    expect(e.paper.pendingBuyUsd()).toBe(0);
    expect(t.acks).toEqual([H]);
    expect(e.sent.filter(m => /BUY/.test(m)).length).toBe(1);
  });

  it('reverse order: the caller first, then the late channel with the same hash → one position, NO false "no pair" alarm, the address block is lifted', async () => {
    const e = setup(); const { t, settle } = buyTrader(); e.paper.trader = t;
    const cash0 = e.risk.cashUsd;
    await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
    settle(OK); await tick();
    expect(e.risk.positions.length).toBe(1);
    t.handler(lateBuy()); await tick();
    expect(e.risk.positions.length).toBe(1); expect(cash0 - e.risk.cashUsd).toBeCloseTo(2.02, 5);
    expect(e.sent.some(m => /no pair|blocked/.test(m))).toBe(false); // before: a false alarm and a treasury block until restart
    expect(t.acks).toEqual([H]);
  });

  it('the caller gave up (wait deadline), its "not confirmed" mark and the late outcome queue up in any order → one position, no reserve on top of the position', async () => {
    for (const lateFirst of [true, false]) {
      const e = setup(); const { t, settle } = buyTrader(); e.paper.trader = t;
      await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
      if (lateFirst) { t.handler(lateBuy()); settle(PEND); } else { settle(PEND); await tick(); expect(e.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5); t.handler(lateBuy()); }
      await tick();
      expect([lateFirst, e.risk.positions.length, e.paper.pendingBuyUsd()]).toEqual([lateFirst, 1, 0]);
      await expect(e.paper.execute(MSG, buy(), 2)).rejects.not.toThrow(/still pending/); // the token block is lifted (a refusal now comes from other rules)
    }
  });

  it('after the wait deadline the transaction finally dropped / was replaced → reserve and token block lifted, no position, a message to the owner', async () => {
    const e = setup(); const { t, settle } = buyTrader(); e.paper.trader = t;
    const cash0 = e.risk.cashUsd;
    await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
    settle(PEND); await tick();
    expect(e.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5);
    t.handler(lateBuy({ state: 'replaced', receipt: undefined })); await tick();
    expect(e.paper.pendingBuyUsd()).toBe(0); expect(e.risk.positions.length).toBe(0); expect(e.risk.cashUsd).toBe(cash0);
    expect(e.sent.some(m => /finally did not happen \(replaced\)/.test(m))).toBe(true);
    // if it still lands in a block later — there is no pair in the ledger: an alarm, the treasury block stays
    t.handler(lateBuy({ kind: 'ghost' })); await tick();
    expect(e.sent.some(m => /it has no pair in the ledger — the treasury on this chain is blocked/.test(m))).toBe(true);
    expect(t.acks).toEqual([H]); // the only confirmation is from "replaced" (nothing to reconcile); the ghost is not confirmed
  });

  it('a late receipt with a revert → reserve released, the address block lifted (nothing to change in the ledger); a successful receipt with no tokens in the logs → alarm, the block stays', async () => {
    const e = setup(); const { t, settle } = buyTrader({ async buyFromLateReceipt() { return { ...PEND, pending: false, note: 'reverted' }; } }); e.paper.trader = t;
    await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
    settle(PEND); await tick();
    t.handler(lateBuy({ receipt: { status: '0x0' } })); await tick();
    expect(e.paper.pendingBuyUsd()).toBe(0); expect(e.risk.positions.length).toBe(0); expect(t.acks).toEqual([H]);
    const e2 = setup(); const b2 = buyTrader({ async buyFromLateReceipt() { return { ...PEND, pending: false, note: 'late: got 0' }; } }); e2.paper.trader = b2.t;
    await expect(e2.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
    b2.settle(PEND); await tick();
    b2.t.handler(lateBuy()); await tick();
    expect(b2.t.acks).toEqual([]); expect(e2.sent.some(m => /the transaction succeeded, but late: got 0 — no position/.test(m))).toBe(true);
  });
});

describe('E-10 round 4: the late outcome handler does not swallow errors and does not leave the treasury silently blocked', () => {
  it('repro B3-3: Telegram fails on the BUY card → position recorded, block lifted, no unhandled exceptions, the failure is in the log', async () => {
    const sent: string[] = [];
    const e = setup({ async send(m: string) { if (/BUY|Late/.test(m)) throw new Error('telegram down'); sent.push(m); } });
    const { t, settle } = buyTrader(); e.paper.trader = t;
    const unhandled: unknown[] = []; const on = (r: unknown) => unhandled.push(r); process.on('unhandledRejection', on);
    const errs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
      settle(PEND); await tick();
      t.handler(lateBuy()); await tick(60);
      expect(unhandled.length).toBe(0);
      expect(e.risk.positions.length).toBe(1); expect(e.paper.pendingBuyUsd()).toBe(0);
      expect(t.acks).toEqual([H]); // before: reserve released, the ghost stayed — the treasury blocked silently
      expect(errs.mock.calls.some(c => /notification failed|not sent/.test(String(c[0])))).toBe(true);
    } finally { process.off('unhandledRejection', on); errs.mockRestore(); }
  });

  it('parsing the receipt threw → the reserve and the token block stay, the address block is NOT lifted, an error in the log and a message to the owner', async () => {
    const e = setup(); const { t, settle } = buyTrader({ async buyFromLateReceipt() { throw new Error('bad receipt'); } }); e.paper.trader = t;
    const errs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
      settle(PEND); await tick();
      t.handler(lateBuy()); await tick();
      expect(e.risk.positions.length).toBe(0); expect(e.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5); expect(t.acks).toEqual([]);
      expect(errs.mock.calls.some(c => /was NOT applied to the ledger/.test(String(c[0])))).toBe(true);
      expect(e.sent.some(m => /failure writing to the ledger \(Error: bad receipt\).*treasury on base — block not lifted/.test(m))).toBe(true);
      // the outcome is not lost: a repeat delivery of the same receipt (after the fix) records the position
      t.buyFromLateReceipt = async () => OK;
      t.handler(lateBuy()); await tick();
      expect(e.risk.positions.length).toBe(1); expect(e.paper.pendingBuyUsd()).toBe(0); expect(t.acks).toEqual([H]);
    } finally { errs.mockRestore(); }
  });

  it('writing the position to risk threw → the reserve comes back (the outcome is not in the ledger), the block is not lifted, a message to the owner', async () => {
    const e = setup(); const { t, settle } = buyTrader(); e.paper.trader = t;
    const errs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
      settle(PEND); await tick();
      const real = e.risk.openPosition.bind(e.risk);
      e.risk.openPosition = () => { throw new Error('risk state broken'); };
      t.handler(lateBuy()); await tick();
      expect(e.paper.open.size).toBe(0); expect(e.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5); expect(t.acks).toEqual([]);
      expect(e.sent.some(m => /failure writing to the ledger/.test(m))).toBe(true);
      e.risk.openPosition = real;
    } finally { errs.mockRestore(); }
  });

  it('item 5: an outcome without a pair in the ledger — for the treasury "blocked until reconciliation", for a minter burner wallet — "the treasury is NOT blocked"', async () => {
    const e = setup(); const { t } = buyTrader(); e.paper.trader = t;
    t.handler(lateBuy({ hash: '0x' + 'e'.repeat(64), kind: 'ghost' })); await tick();
    expect(e.sent.at(-1)).toMatch(/it has no pair in the ledger — the treasury on this chain is blocked until reconciliation/); expect(t.acks).toEqual([]);
    t.handler(lateBuy({ hash: '0x' + 'f'.repeat(64), addr: '0xburner', treasury: false })); await tick();
    expect(e.sent.at(-1)).toMatch(/from burner wallet 0xburner .* the treasury is NOT blocked/); expect(t.acks).toEqual(['0x' + 'f'.repeat(64)]);
    // a final "dropped" without a pair is not an alarm
    const n = e.sent.length;
    t.handler(lateBuy({ hash: '0x' + 'd'.repeat(64), state: 'dropped', receipt: undefined })); await tick();
    expect(e.sent.length).toBe(n);
  });

  it('#48 leftover: a reverted "ghost" (status 0x0, no money left) without a pair in the ledger — the text says "reverted", the block lifts itself (treasury and burner wallet)', async () => {
    const e = setup(); const { t } = buyTrader(); e.paper.trader = t;
    const HC = '0x' + 'c'.repeat(64); const HB = '0x' + 'b'.repeat(64);
    t.handler(lateBuy({ hash: HC, kind: 'ghost', receipt: { status: '0x0' } })); await tick();
    expect(e.sent.at(-1)).toMatch(/landed in a block reverted after it was considered dropped .* no money left, only gas; .* block lifted \(treasury on base\)/);
    expect(e.sent.at(-1)).not.toMatch(/blocked/);
    expect(t.acks).toEqual([HC]);
    t.handler(lateBuy({ hash: HB, addr: '0xburner', treasury: false, receipt: { status: '0x0' } })); await tick();
    expect(e.sent.at(-1)).toMatch(/reverted after the wait limit .* block lifted \(wallet 0xburner \(a burner, not the treasury\)\)/);
    expect(t.acks).toEqual([HC, HB]);
    // a successful receipt without a pair — as before: an alarm, the block stays
    t.handler(lateBuy({ hash: '0x' + 'e'.repeat(64), kind: 'ghost' })); await tick();
    expect(e.sent.at(-1)).toMatch(/it has no pair in the ledger — the treasury on this chain is blocked until reconciliation/); expect(t.acks).toEqual([HC, HB]);
  });
});

/** A position of 2000 tokens is opened at once; the monitor at the take-profit price sends a sale of half, it is "in flight" (hash HS). */
async function sellSetup() {
  const e = setup();
  let settle!: (st: string) => void; const settled = new Promise<string>(r => { settle = r; });
  const t: any = {
    handler: undefined as any, acks: [] as string[], sells: 0,
    setLateOutcomeHandler(h: any) { this.handler = h; },
    clearGhost(_c: string, hash: string) { this.acks.push(hash); },
    async buyToken() { return { ...OK, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
    async sellToken() { this.sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: HS, soldRaw: RAW / 2n, note: 'sell pending' }; },
    settleTx: () => settled,
  };
  e.paper.trader = t;
  await e.paper.execute(MSG, buy(), 1);
  const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } }; // above tp1 (0.002)
  await e.paper.monitor(market, { tokensOnly: true });
  expect(t.sells).toBe(1);
  const pos = [...e.paper.open.values()][0];
  expect(pos.qtyLeft).toBe(2000); expect(pos.exitingUntilMs).toBeGreaterThan(e.clock.now());
  return { ...e, t, settle, pos, market, cashAfterBuy: e.risk.cashUsd };
}
const lateSell = (o: Record<string, unknown> = {}) => ({ chain: 'base', hash: HS, addr: '0xabc', nonce: 4, kind: 'expired', state: 'mined', receipt: { status: '0x1' }, treasury: true, ...o });

describe('E-10 round 4: a sale "in flight" (partial, TP1) — counted once in any order', () => {
  it('the late channel first, then the caller gets "ok" for the same hash → half is sold ONCE, the proceeds are counted once', async () => {
    const e = await sellSetup();
    e.t.handler(lateSell()); e.settle('ok'); await tick();
    expect(e.pos.qtyLeft).toBe(1000); // before: applyTokenSell twice: remainder 0 and double proceeds
    expect(e.risk.cashUsd - e.cashAfterBuy).toBeCloseTo(2.5, 5);
    expect(e.pos.tp1Done).toBe(true); expect(e.pos.exitingUntilMs).toBeUndefined();
    expect(BigInt(e.pos.live!.raw!)).toBe(RAW / 2n);
    expect(e.sent.filter(m => /LIVE SELL/.test(m)).length).toBe(1);
    expect(e.t.acks).toEqual([HS]);
  });

  it('reverse order: the caller first, then the late channel → once, no false alarm', async () => {
    const e = await sellSetup();
    e.settle('ok'); await tick();
    expect(e.pos.qtyLeft).toBe(1000);
    e.t.handler(lateSell()); await tick();
    expect(e.pos.qtyLeft).toBe(1000); expect(e.risk.cashUsd - e.cashAfterBuy).toBeCloseTo(2.5, 5);
    expect(BigInt(e.pos.live!.raw!)).toBe(RAW / 2n);
    expect(e.sent.some(m => /no pair|already closed otherwise|blocked/.test(m))).toBe(false);
    expect(e.t.acks).toEqual([HS]);
  });

  it('the caller gave up (wait deadline): the position is frozen for an hour, the record stays; a late receipt in any queue order → counted once', async () => {
    for (const lateFirst of [true, false]) {
      const e = await sellSetup();
      if (lateFirst) { e.t.handler(lateSell()); e.settle('unknown'); }
      else { e.settle('unknown'); await tick(); expect(e.pos.exitingUntilMs).toBe(e.clock.now() + 60 * 60_000); expect(e.sent.some(m => /neither confirmed nor rejected within 30 min/.test(m))).toBe(true); e.t.handler(lateSell()); }
      await tick();
      expect([lateFirst, e.pos.qtyLeft, e.pos.exitingUntilMs]).toEqual([lateFirst, 1000, undefined]);
      expect(e.risk.cashUsd - e.cashAfterBuy).toBeCloseTo(2.5, 5);
    }
  });

  it('a late revert or a final "dropped" → the position is under the monitor again (the stop works), the address block is lifted', async () => {
    for (const ev of [lateSell({ receipt: { status: '0x0' } }), lateSell({ state: 'dropped', receipt: undefined })]) {
      const e = await sellSetup();
      e.settle('unknown'); await tick();
      e.t.handler(ev); await tick();
      expect(e.pos.qtyLeft).toBe(2000); expect(e.pos.exitingUntilMs).toBeUndefined(); expect(e.risk.cashUsd).toBe(e.cashAfterBuy);
      await e.paper.monitor(e.market, { tokensOnly: true });
      expect(e.t.sells).toBe(2); // the monitor sells again
    }
  });

  // #135 finishing (review 2026-11-16): an EVM sale handed to the background after the wait deadline holds the position until the late outcome — a new
  // sale of the same position does not go out before it (it used to; only the sender's address block held it back)
  it('an EVM sale handed to the background holds the position until the outcome; after a final "dropped" the monitor sells again — once', async () => {
    const e = await sellSetup();
    e.settle('unknown'); await tick();
    const H2 = '0x' + 'd'.repeat(64);
    e.t.sellToken = async () => { e.t.sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H2, soldRaw: RAW / 2n, note: 'sell pending' }; };
    e.t.settleTx = () => new Promise(() => undefined);
    e.pos.exitingUntilMs = undefined; // even without the freeze timer
    await e.paper.monitor(e.market, { tokensOnly: true });
    expect(e.t.sells).toBe(1); // the first sale's outcome is unknown — no second one
    e.t.handler(lateSell({ state: 'dropped', receipt: undefined })); await tick();
    await e.paper.monitor(e.market, { tokensOnly: true });
    expect(e.t.sells).toBe(2); // the first will not execute — the position is under the monitor again
    const frozen = e.pos.exitingUntilMs;
    expect(frozen).toBeGreaterThan(e.clock.now());
    await e.paper.monitor(e.market, { tokensOnly: true });
    expect(e.t.sells).toBe(2); expect(e.pos.exitingUntilMs).toBe(frozen); // otherwise the monitor would sell a third time
  });
});

// ── End-to-end: PaperExecutor + real LiveTrader + EvmSender, the node keeps the transaction in the pool ────────────────────────────────
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const w64 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const topicAddr = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const chainCfg = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true };

function stack() {
  const e = setup();
  const W = new Wallets(newKeyMaterial(0)); const me = W.evmTreasury.address;
  const st = { mined: false, receipts: 0 };
  const receipt = () => ({ status: '0x1', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x1',
    logs: [{ address: TOKEN, topics: [T, topicAddr('0x' + '9'.repeat(40)), topicAddr(me)], data: w64(RAW) }] });
  const f: typeof fetch = async (_u: any, init: any) => {
    const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ result }));
    if (b.method === 'eth_getTransactionCount') return res(b.params[1] === 'latest' ? (st.mined ? '0x4' : '0x3') : '0x4'); // nonce 3 in the pool
    if (b.method === 'eth_getTransactionReceipt') { if (st.mined) st.receipts++; return res(st.mined ? receipt() : null); }
    if (b.method === 'eth_getTransactionByHash') return res({ hash: b.params[0] });
    throw new Error(b.method);
  };
  const trader = new LiveTrader({ wallets: W, chains: { base: chainCfg } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
  const s = trader.sender('base')!;
  e.paper.trader = trader;
  return { ...e, W, me, st, trader, s };
}

describe('E-10 round 4, end-to-end: executor + trader + sender, a receipt at any second around the wait deadline', () => {
  it('buy: receipt before the deadline, at the deadline and after it → always exactly one position, cash charged once, reserve and block lifted', async () => {
    vi.useFakeTimers();
    try {
      const run = async (minedAfterMs: number | undefined) => {
        const x = stack();
        x.trader.buyToken = (async () => { x.s.trackPending(x.me, 3, H as `0x${string}`); return { ...PEND, decimals: 18, note: `tx pending (no receipt yet): ${H}` }; }) as any;
        const cash0 = x.risk.cashUsd; const t0 = Date.now();
        await expect(x.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
        let handedOverAt: number | undefined;
        const until = t0 + 50 * 60_000;
        while (Date.now() < until) {
          if (minedAfterMs !== undefined && !x.st.mined && Date.now() - t0 >= minedAfterMs) x.st.mined = true;
          if (handedOverAt === undefined && x.s.pendingTx.get(H)?.handedOver) handedOverAt = Date.now() - t0;
          await vi.advanceTimersByTimeAsync(250);
        }
        return { x, cash0, handedOverAt, spent: cash0 - x.risk.cashUsd };
      };
      // Dry run without a receipt: the deadline passed → alarm, the reserve stays, the address is blocked, the outcome is handed to the background
      const dry = await run(undefined);
      expect(dry.handedOverAt).toBeGreaterThan(29 * 60_000); expect(dry.handedOverAt).toBeLessThan(33 * 60_000);
      expect(dry.x.risk.positions.length).toBe(0); expect(dry.x.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5);
      expect(dry.x.sent.some(m => /was not confirmed within 30 min/.test(m))).toBe(true);
      expect(dry.x.s.hasPending(dry.x.me)).toBeDefined();
      const T0 = dry.handedOverAt!;
      const seen = new Set<string>();
      for (const off of [-25 * 60_000, -60_000, -6000, -3000, -1500, -750, -250, 0, 250, 750, 1500, 3000, 6000, 60_000, 12 * 60_000]) {
        const r = await run(T0 + off);
        const lateMsg = r.x.sent.some(m => /Late (buy |sale )?receipt/.test(m));
        seen.add(lateMsg ? 'late' : 'caller');
        expect([off, r.x.risk.positions.length, r.x.store.openPositions().length]).toEqual([off, 1, 1]);
        expect(r.spent).toBeCloseTo(2.00 + 21000 * 1e-18 * 4000, 6); // size + gas from the receipt — once
        expect(r.x.paper.pendingBuyUsd()).toBe(0);
        expect(r.x.s.hasPending(r.x.me)).toBeUndefined(); // neither an "in flight" record nor an unconfirmed block
        expect(r.x.sent.filter(m => /BUY/.test(m)).length).toBe(1);
        expect(r.x.sent.some(m => /no pair/.test(m))).toBe(false);
      }
      expect([...seen].sort()).toEqual(['caller', 'late']); // both delivery paths were checked
    } finally { vi.useRealTimers(); }
  }, 120_000);

  it('sale (partial): receipt before the deadline, at it and after → the sale is counted exactly once, the monitor sent nothing again meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const run = async (minedAfterMs: number | undefined) => {
        const x = stack();
        x.trader.buyToken = (async () => ({ ...OK, tx: '0x' + 'b'.repeat(64), note: 'got' })) as any;
        await x.paper.execute(MSG, buy(), 1);
        let sells = 0;
        x.trader.sellToken = (async () => {
          const pend = x.s.hasPending(x.me);
          if (pend) return { ok: false, mode: 'live', proceedsUsd: 0, note: `a previous tx ${pend.hash} is still unresolved` }; // like the real sellToken
          sells++; x.s.trackPending(x.me, 3, HS as `0x${string}`);
          return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: HS, soldRaw: RAW / 2n, note: `sell pending: ${HS}` };
        }) as any;
        const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
        const cash0 = x.risk.cashUsd; const t0 = Date.now();
        await x.paper.monitor(market, { tokensOnly: true });
        const pos = [...x.paper.open.values()][0];
        let handedOverAt: number | undefined;
        const until = t0 + 50 * 60_000;
        while (Date.now() < until) {
          if (minedAfterMs !== undefined && !x.st.mined && Date.now() - t0 >= minedAfterMs) x.st.mined = true;
          if (handedOverAt === undefined && x.s.pendingTx.get(HS)?.handedOver) handedOverAt = Date.now() - t0;
          await vi.advanceTimersByTimeAsync(250);
        }
        return { x, pos, sells, handedOverAt, got: x.risk.cashUsd - cash0, market };
      };
      const dry = await run(undefined);
      expect(dry.handedOverAt).toBeGreaterThan(29 * 60_000); expect(dry.handedOverAt).toBeLessThan(33 * 60_000);
      expect(dry.pos.qtyLeft).toBe(2000); expect(dry.got).toBe(0);
      expect(dry.x.sent.some(m => /neither confirmed nor rejected within 30 min/.test(m))).toBe(true);
      const T0 = dry.handedOverAt!;
      const seen = new Set<string>();
      for (const off of [-25 * 60_000, -60_000, -6000, -3000, -1500, -750, -250, 0, 250, 750, 1500, 3000, 6000, 60_000, 12 * 60_000]) {
        const r = await run(T0 + off);
        seen.add(r.x.sent.some(m => /Late sale receipt/.test(m)) ? 'late' : 'caller');
        expect([off, r.pos.qtyLeft, r.sells]).toEqual([off, 1000, 1]);
        expect(r.got).toBeCloseTo(2.5, 5);
        expect(r.x.sent.filter(m => /LIVE SELL/.test(m)).length).toBe(1);
        expect(r.x.s.hasPending(r.x.me)).toBeUndefined();
        expect(r.pos.exitingUntilMs).toBeUndefined();
      }
      expect([...seen].sort()).toEqual(['caller', 'late']);
    } finally { vi.useRealTimers(); }
  }, 120_000);

  it('an approve that landed in a block after the wait deadline is not a ledger record: no alarm, the treasury block is lifted at once (the stop-loss does not stall)', async () => {
    vi.useFakeTimers();
    try {
      const x = stack();
      const HA = ('0x' + '7'.repeat(64)) as `0x${string}`;
      (x.trader as any).pendingApprove.set(`base:${TOKEN}`, { hash: HA, atMs: Date.now() });
      (x.trader as any).noteApprove('base', HA); // like sellToken after sending an approve
      x.s.maxPendingMs = 15 * 60_000;
      x.s.trackPending(x.me, 3, HA);
      await vi.advanceTimersByTimeAsync(x.s.maxPendingMs + 3 * 60_000);
      expect(x.s.outcomes.get(HA)?.state).toBe('expired');
      x.st.mined = true;
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(x.s.outcomes.get(HA)?.state).toBe('mined');
      expect(x.s.hasPending(x.me)).toBeUndefined();
      expect(x.sent.some(m => /no pair|blocked/.test(m))).toBe(false);
      expect((await x.s.quickOutcome(HA)).state).toBe('mined'); // the sale will see the confirmed approve and go on
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('an approve that was deemed dropped and already forgotten lands in a block as a ghost → also not a ledger record: no alarm and no treasury block', async () => {
    const x = stack();
    const HA = ('0x' + '8'.repeat(64)) as `0x${string}`;
    (x.trader as any).noteApprove('base', HA); // the approve was sent; the pendingApprove record is already removed by now (outcome "dropped")
    expect((x.trader as any).pendingApprove.size).toBe(0);
    (x.s as any).deliverLate({ addr: x.me.toLowerCase(), nonce: 3, hash: HA, atMs: 0 }, { state: 'mined', receipt: { status: '0x1' } }, 'ghost');
    await tick();
    expect(x.s.hasPending(x.me)).toBeUndefined();
    expect(x.sent.some(m => /no pair|blocked/.test(m))).toBe(false);
    // while a ghost of an unknown treasury transaction is still an alarm and a block
    const HX = ('0x' + '9'.repeat(64)) as `0x${string}`;
    (x.s as any).deliverLate({ addr: x.me.toLowerCase(), nonce: 4, hash: HX, atMs: 0 }, { state: 'mined', receipt: { status: '0x1' } }, 'ghost');
    await tick();
    expect(x.s.hasPending(x.me)?.ghost).toBe(true);
    expect(x.sent.some(m => /it has no pair in the ledger — the treasury on this chain is blocked/.test(m))).toBe(true);
  });
});

describe('E-10 round 4 (after independent reviewer notes): the position freeze rests on the sale record, not only on the timer', () => {
  it('the caller already has the receipt, the ledger write is still queued, and the freeze timer expired → the monitor and an urgent exit do not resend the same sale', async () => {
    const e = await sellSetup();
    e.clock.advance(16 * 60_000); // the 15-minute timer expired (the executor was busy: bridge, NFT), the outcome is not in the ledger yet
    expect(e.pos.exitingUntilMs).toBeLessThan(e.clock.now());
    await e.paper.monitor(e.market, { tokensOnly: true });
    expect(await e.paper.exitToken(TOKEN, 'alert', e.market)).toBe(false);
    expect(e.t.sells).toBe(1); // before: a second sale of the same half
    e.settle('ok'); await tick();
    expect(e.pos.qtyLeft).toBe(1000); expect(e.risk.cashUsd - e.cashAfterBuy).toBeCloseTo(2.5, 5);
    await e.paper.monitor(e.market, { tokensOnly: true }); // the outcome is in the ledger — the position is under the monitor again
    expect(e.t.sells).toBe(1); // TP1 is already taken, no new reasons to sell
  });

  it('Solana (no background watcher): after the wait deadline the text does not promise "I will count it myself", the record is removed, the next sale lifts the freeze as usual', async () => {
    const e = setup();
    let tx = 'SIG1', st = 'unknown', calls = 0;
    e.paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ...OK, tx: 'SIGB', note: 'got' }; },
      async sellToken() { return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx, soldRaw: RAW / 2n, note: 'send: may still land' }; },
      async settleTx() { calls++; return st; } } as any;
    const d = buy(); d.chain = 'solana'; d.intent.chain = 'solana'; (d.check as any).chain = 'solana';
    await e.paper.execute(MSG, d, 1);
    const pos = [...e.paper.open.values()][0];
    const market: MarketClient = { async market() { return { chain: 'solana', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
    await e.paper.monitor(market, { tokensOnly: true }); await tick(60);
    expect(calls).toBe(18); // Solana is polled, as before, up to 3 h
    const msg = e.sent.find(m => /was neither confirmed nor rejected/.test(m))!;
    expect(msg).toMatch(/within 3 h .*check the wallet manually; I will not touch the position for an hour, then the monitor will sell again/);
    expect(msg).not.toMatch(/I will count it myself/);
    expect(pos.exitingUntilMs).toBe(e.clock.now() + 60 * 60_000);
    e.clock.advance(61 * 60_000); tx = 'SIG2'; st = 'ok';
    await e.paper.monitor(market, { tokensOnly: true }); await tick();
    expect(pos.qtyLeft).toBe(1000); expect(pos.exitingUntilMs).toBeUndefined(); // the abandoned SIG1 record does not hold the freeze
  });

  it('Solana: a buy with no outcome within the wait deadline — the text says "until a restart", not "I will record it myself"', async () => {
    const e = setup(); let calls = 0;
    e.paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ...PEND, tx: 'SIGB', decimals: 9, note: 'send: may still land' }; },
      async settleBuy() { calls++; return { ...PEND, tx: 'SIGB' }; } } as any;
    const d = buy(); d.chain = 'solana'; d.intent.chain = 'solana'; (d.check as any).chain = 'solana';
    await expect(e.paper.execute(MSG, d, 1)).rejects.toThrow(/pending/);
    await tick(60);
    expect(calls).toBe(18);
    const msg = e.sent.find(m => /was not confirmed within/.test(m))!;
    expect(msg).toMatch(/within 3 h — check the wallet manually; until a restart this token is not bought/);
    expect(msg).not.toMatch(/I will record it myself/);
    expect(e.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5);
  });

  // #135 finishing (review 2026-11-16): before, after an hour the monitor reached the trader and the refusal came from the sender's address block; with
  // a receipt with an unreadable status there was no block — the position was sold a second time. Now the sale record itself holds the position
  it('EVM: the caller gave up → the record stays for the late outcome and holds the position even after an hour (#135: no repeat goes out even without the sender block)', async () => {
    const e = await sellSetup();
    e.settle('unknown'); await tick();
    expect(e.pos.exitingUntilMs).toBe(e.clock.now() + 60 * 60_000);
    e.clock.advance(61 * 60_000);
    await e.paper.monitor(e.market, { tokensOnly: true });
    expect(e.t.sells).toBe(1); // the monitor does not go to the trader: the first sale's outcome is not known yet
    e.t.handler(lateSell()); await tick();
    expect(e.pos.qtyLeft).toBe(1000); expect(e.risk.cashUsd - e.cashAfterBuy).toBeCloseTo(2.5, 5); // the late outcome is counted once
  });
});

describe('acceptance #114: a revert is only an explicit status 0x0; an unreadable receipt status does not lift the block', () => {
  const noPair = (receipt: any, hash = '0x' + 'e'.repeat(64)) => lateBuy({ hash, kind: 'ghost', receipt });
  const cases: [string, any, boolean][] = [
    ['0x1', { status: '0x1', blockNumber: '0x1' }, false],
    ['0x0', { status: '0x0', blockNumber: '0x1' }, true],
    ['no field', { blockNumber: '0x1', root: '0x' + '1'.repeat(64) }, false],
    ['null', { status: null, blockNumber: '0x1' }, false],
    ['"0x01"', { status: '0x01', blockNumber: '0x1' }, false],
    ['number 0', { status: 0, blockNumber: '0x1' }, false],
  ];
  for (const [name, receipt, shouldClear] of cases) {
    it(`a receipt without a pair in the ledger, status ${name} → the block ${shouldClear ? 'is lifted (revert)' : 'stays, alarm'}`, async () => {
      const e = setup(); const { t } = buyTrader(); e.paper.trader = t;
      t.handler(noPair(receipt)); await tick();
      expect(t.acks.length > 0).toBe(shouldClear);
      if (shouldClear) expect(e.sent.at(-1)).toMatch(/reverted.*no money left/);
      else expect(e.sent.at(-1)).toMatch(/it has no pair in the ledger — the treasury on this chain is blocked until reconciliation/);
    });
  }

  it('a revert lifts the block only for its own hash', async () => {
    const e = setup(); const { t } = buyTrader(); e.paper.trader = t;
    const A = '0x' + 'a'.repeat(64), B = '0x' + 'b'.repeat(64);
    t.handler(noPair({ status: '0x1', blockNumber: '0x1' }, A)); t.handler(noPair({ status: '0x0', blockNumber: '0x1' }, B)); await tick();
    expect(t.acks).toEqual([B]);
  });

  it('a late buy with a pair in the ledger and an unreadable status: not a "revert" — an alarm, the address block stays; an explicit 0x0 — a revert, the block is lifted', async () => {
    for (const [receipt, isRevert] of [[{ blockNumber: '0x1' }, false], [{ status: null }, false], [{ status: '0x01' }, false], [{ status: '0x0' }, true]] as [any, boolean][]) {
      const e = setup();
      const { t, settle } = buyTrader({ async buyFromLateReceipt(p: any) { return { ...PEND, pending: false, note: p.receipt?.status === '0x0' ? 'reverted' : 'receipt status unreadable' }; } });
      e.paper.trader = t;
      await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
      settle(PEND); await tick();
      t.handler(lateBuy({ receipt })); await tick();
      expect(e.risk.positions.length).toBe(0);
      expect([JSON.stringify(receipt), t.acks.length]).toEqual([JSON.stringify(receipt), isRevert ? 1 : 0]);
      if (isRevert) expect(e.sent.at(-1)).toMatch(/finally did not happen \(reverted\)/);
      else expect(e.sent.at(-1)).toMatch(/the receipt status is unreadable \(.*\) — money may have left — no position, check the wallet; treasury on base — blocked until reconciliation/);
    }
  });

  it('a late sale with an unreadable status: not "did not go through" — the position is not touched, the block stays, the monitor does not sell again; a readable receipt is then counted once', async () => {
    const e = await sellSetup();
    e.settle('unknown'); await tick();
    e.t.handler(lateSell({ receipt: { blockNumber: '0x1' } })); await tick();
    expect(e.pos.qtyLeft).toBe(2000); expect(e.t.acks).toEqual([]);
    expect(e.sent.at(-1)).toMatch(/the receipt status is unreadable \(no field\) — money may have left — the sale is neither recorded nor cancelled in the ledger, I am not touching the position/);
    expect(e.pos.exitingUntilMs).toBe(e.clock.now() + 60 * 60_000); // the freeze after the wait deadline is not lifted
    e.t.handler(lateSell()); await tick(); // the same transaction, the receipt became readable
    expect(e.pos.qtyLeft).toBe(1000); expect(e.risk.cashUsd - e.cashAfterBuy).toBeCloseTo(2.5, 5); expect(e.t.acks).toEqual([HS]);
  });

  it('LiveTrader.buyFromLateReceipt: "reverted" — only for status 0x0', async () => {
    const t = new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: { base: chainCfg } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: (async () => { throw new Error('no rpc'); }) as any });
    const note = async (receipt: any) => (await t.buyFromLateReceipt({ chain: 'base', token: TOKEN, sizeUsd: 2, tx: H, decimals: 18, receipt })).note;
    expect(await note({ status: '0x0' })).toBe('reverted');
    for (const rc of [{}, { status: null }, { status: '0x01' }, undefined]) expect(await note(rc)).toBe('receipt status unreadable');
  });
});
