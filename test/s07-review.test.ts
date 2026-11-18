// S-07 (#113), acceptance round 1 (HQ 2026-11-12 10:45 UTC): the reviewers' reproductions — now regression tests.
// repro A — as sent (they failed on the defect). repro B — assertions rewritten from "the defect is present" to the correct behaviour.
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { DEFAULT_RISK, loadConfig, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState, sizeAction } from '../src/risk/risk.js';
import { Blacklist, decide } from '../src/decide/decide.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { prefilter } from '../src/extract/prefilter.js';
import type { MarketClient } from '../src/checks/token.js';
import type { Decision, Intent, RawMessage, TrustResult } from '../src/types.js';
// S-02: the S-07 exit tests — without the memecoinEntry entry filter (the entry is checked in test/entry.test.ts)
function exitsOnly<T extends object>(r: T): T { const { memecoinEntry: _drop, ...x } = r as T & { memecoinEntry?: unknown }; return x as T; }

// ---------- repro A (reviewer A) ----------
const MINTS = ['4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump', '2qw313mavnLCGnz9L2GAsDvEvwJdWCuLyxv3vtM7pump', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'];

async function setup(withClasses: boolean, capital?: number) {
  const base0 = exitsOnly(loadConfig({ AGENT_ROOT: resolve(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk);
  const base = capital ? { ...base0, initialCapitalUsd: capital, perActionShareByTier: { ...base0.perActionShareByTier, fast: 0.1 } } : base0;
  const cfg = withClasses ? base : (() => { const c: any = { ...base }; delete c.memecoinClasses; return c; })();
  const clock = new VirtualClock(Date.UTC(2026, 10, 11, 12));
  const prices = new Map<string, number>();
  const market: MarketClient = {
    async market(t: string) { return { chain: 'solana', symbol: 'X', priceUsd: prices.get(t) ?? 0.001, liquidityUsd: 60_000, fdvUsd: 600_000, pairAgeMinutes: 30 * 60, buys24h: 2000, sells24h: 1800 }; },
    async rug() { return { risk: 'low', freezeOrMintAuthority: false, reasons: [] }; },
  } as any;
  const risk = new RiskState(cfg, clock);
  const store = new Store(':memory:');
  const paper = new PaperExecutor(cfg, risk, store, { async send() {} }, clock);
  const dd = { cfg, risk, market, clock, blacklist: new Blacklist(), ethUsd: () => 3000 };
  const tr: TrustResult = { score: 8, tier: 'fast', basis: 'author', notes: [] };
  let n = 0;
  async function buy(mint: string) {
    prices.set(mint, 0.001);
    const it: Intent = { kind: 'token_call', chain: 'solana', tokenAddress: mint, urls: [], summary: 'buy', stance: 'buy', confidence: 0.7 } as Intent;
    const d = await decide(it, tr, prefilter(`buy ${mint}`), dd, { mainTextAddresses: new Set([mint]) } as any);
    if (d.action !== 'buy_token') return d;
    const m: RawMessage = { id: String(++n), sourceServer: 'P', channel: 'calls', author: 'a', tsUtc: clock.iso(), text: `buy ${mint}` };
    const id = store.saveDecision(m, d, 'paper', clock.iso());
    await paper.execute(m, d, typeof id === 'number' ? id : n);
    return d;
  }
  return { cfg, clock, prices, market, risk, paper, buy };
}

describe('repro A: core stop loss is visible to equity / daily stop while the moonbag lives (M1)', () => {
  for (const withClasses of [false, true]) it(`withClasses=${withClasses}`, async () => {
    const e = await setup(withClasses);
    const d = await e.buy(MINTS[0]);
    expect(d.action).toBe('buy_token');
    e.prices.set(MINTS[0], 0.0006); // −40 %: the main part stop fires, the moonbag stays
    await e.paper.monitor(e.market);
    // The loss of the main part (example: $20 × 0.4) — must get into capital and the daily result (as before the request)
    expect(e.risk.todayPnl() + Math.min(0, e.risk.unrealizedUsd)).toBeLessThan(-3);
  });
});

describe('repro A: maxOpenMoonbags (example 3) caps simultaneous tails (M2)', () => {
  it('5 positions decided in a row → at most 3 carry a moonbag; all cores stop out → ≤ 3 tails', async () => {
    const e = await setup(true, 1000);
    const ds: Decision[] = [];
    for (let i = 0; i < 5; i++) ds.push(await e.buy(MINTS[i]));
    expect(ds.every(d => d.action === 'buy_token')).toBe(true);
    expect(ds.filter(d => (d.exitPlan?.moonbagShare ?? 0) > 0).length).toBe(3);
    for (let i = 0; i < 5; i++) e.prices.set(MINTS[i], 0.0006);
    await e.paper.monitor(e.market);
    expect(e.risk.moonbagCount()).toBeLessThanOrEqual(3);
    expect(e.risk.tailCount()).toBeLessThanOrEqual(3);
  });
});

// ---------- repro B (reviewer B), assertions — the correct behaviour ----------
const CFG: RiskConfig = { ...DEFAULT_RISK, initialCapitalUsd: 62.5 }; // example: fast 0.2 × $62.50 fits $12.40
const CFG_CLASSES: RiskConfig = exitsOnly(loadConfig({ AGENT_ROOT: resolve(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk);
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-12T08:00:00.000Z', text: 'ape' };
const trustFast = { score: 8, tier: 'fast' as const, basis: 'author' as const, notes: [] };
const tokB = (i: number) => '0x' + String(i).repeat(40).slice(0, 40);
const buyB = (i: number, moon: number): Decision => ({ action: 'buy_token', sizeUsd: 12.4, chain: 'base', reasons: [], trust: trustFast, estGasUsd: 0,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.7, tokenAddress: tokB(i) },
  check: { ok: true, chain: 'base', address: tokB(i), priceUsd: 1, reasons: [] },
  exitPlan: { stopPrice: 0.6, tp1Price: 1.5, tp1Share: 0.5, trailingPct: 35, timeStopAtUtc: '2026-11-15T08:00:00.000Z', stopPct: 40, tpX: 1.5,
    timeStopMinGainPct: 15, tokenClass: 'conviction', breakevenAfterTp1: true,
    ...(moon ? { moonbagShare: moon, moonbagStopPct: 80, moonbagArmX: 5, moonbagTrailingPct: 50, moonbagMaxHours: 336 } : {}) } } as any);
const flat = (priceUsd: number): MarketClient => ({ async market() { return { chain: 'base', priceUsd }; }, async rug() { return undefined; } } as any);

function runB(cfg: RiskConfig = { ...CFG_CLASSES, initialCapitalUsd: 62.5 }) {
  const clock = new VirtualClock(Date.UTC(2026, 10, 12, 8));
  const risk = new RiskState(cfg, clock);
  const paper = new PaperExecutor(cfg, risk, new Store(':memory:'), { async send() {} }, clock);
  return { clock, risk, paper };
}

describe('repro B: a moonbag does not hide the core loss from day stop / hard stop / sizing (M1)', () => {
  it('4 positions, price −42 %: the day stop fires with and without a moonbag; equity is real', async () => {
    const a = runB();
    for (let i = 1; i <= 4; i++) await a.paper.execute(MSG, buyB(i, 0), i);
    await a.paper.monitor(flat(0.58), { tokensOnly: true });
    expect(a.risk.dailyStopActive()).toBe(true);
    expect(a.risk.todayPnl()).toBeLessThan(-15);

    const b = runB();
    for (let i = 1; i <= 4; i++) await b.paper.execute(MSG, buyB(i, 0.25), i);
    await b.paper.monitor(flat(0.58), { tokensOnly: true }); // the main part stop (−40 %), the moonbag (−80 %) stays
    const tailValue = [...b.paper.open.values()].reduce((s, p) => s + p.qtyLeft * 0.58, 0);
    const realEquity = b.risk.cashUsd + tailValue;
    expect(b.risk.todayPnl()).toBeLessThan(-14);                          // the main part loss is recorded
    expect(Math.abs(b.risk.markedEquityUsd - realEquity)).toBeLessThan(0.5); // capital including tails ≈ the real one
    expect(b.risk.dailyStopActive()).toBe(true);
    const s = sizeAction({ ...CFG_CLASSES, initialCapitalUsd: 62.5 }, b.risk, { tier: 'fast', chain: 'base', estGasUsd: 0 });
    expect(s.ok).toBe(false);                                             // the daily stop — no new entries
    // The tails close: the result is not counted a second time
    const before = b.risk.equityUsd;
    await b.paper.monitor(flat(0.1), { tokensOnly: true });              // −90 %: the moonbag stop (−80 %)
    expect(b.paper.open.size).toBe(0);
    const tailLoss = b.risk.equityUsd - before;
    expect(tailLoss).toBeLessThan(0);
    expect(tailLoss).toBeGreaterThan(-4 * 12.4 * 0.25);                   // no more than the cost of the tails
    expect(b.risk.cashUsd).toBeCloseTo(b.risk.equityUsd, 6);             // everything closed: cash = capital
  });

  it('take-profit is realized at once and not counted twice at close', async () => {
    const b = runB();
    await b.paper.execute(MSG, buyB(1, 0.25), 1);
    const cost = 12.4;
    await b.paper.monitor(flat(1.6), { tokensOnly: true });  // the first take-profit
    expect(b.risk.todayPnl()).toBeGreaterThan(0);
    await b.paper.monitor(flat(0.1), { tokensOnly: true });  // everything else — by stops
    expect(b.paper.open.size).toBe(0);
    expect(b.risk.cashUsd).toBeCloseTo(b.risk.equityUsd, 6);
    expect(b.risk.equityUsd - 62.5).toBeCloseTo(b.risk.cashUsd - 62.5, 6);
    expect(b.risk.equityUsd - 62.5).toBeGreaterThan(-cost);
  });
});

describe('repro B: tail limit (example 3) holds (M2)', () => {
  it('2 tails + 5 entries → the executor opens moonbags only up to the limit; never more than 3 tails', async () => {
    const MAX = (CFG_CLASSES as any).memecoinClasses.maxOpenMoonbags as number;
    expect(MAX).toBe(3);
    const big = { ...CFG_CLASSES, initialCapitalUsd: 1000 };
    const { risk, paper } = runB(big);
    const prices = new Map<string, number>();
    const market: MarketClient = { async market(t: string) { return { chain: 'base', priceUsd: prices.get(t) ?? 1 }; }, async rug() { return undefined; } } as any;
    let n = 0;
    // The decision was made when there were < 3 tails (as in the "decision → execution" race): all have a moonbag
    const open = async () => { n++; await paper.execute(MSG, { ...buyB(n, 0.15), sizeUsd: 4.9, trust: { ...trustFast, tier: 'full' } } as any, n); return n; };
    for (let k = 0; k < 2; k++) { const i = await open(); prices.set(tokB(i), 0.58); await paper.monitor(market, { tokensOnly: true }); }
    expect(risk.moonbagCount()).toBe(2);
    const batch: number[] = [];
    for (let k = 0; k < 5; k++) batch.push(await open());
    expect([...paper.open.values()].filter(p => (p.moonbagQty ?? 0) > 0).length).toBe(3); // 2 tails + 1 new
    for (const i of batch) prices.set(tokB(i), 0.58);
    await paper.monitor(market, { tokensOnly: true });
    expect(risk.tailCount()).toBeLessThanOrEqual(3);
    expect(risk.moonbagCount()).toBeLessThanOrEqual(3);
  });
});

describe('moonbag peak survives a restart (S-07, nice-to-have)', () => {
  it('a new peak of a position with a moonbag is saved without a sale', async () => {
    const cfg = { ...CFG_CLASSES, initialCapitalUsd: 62.5 };
    const clock = new VirtualClock(Date.UTC(2026, 10, 12, 8));
    const store = new Store(':memory:');
    const paper = new PaperExecutor(cfg, new RiskState(cfg, clock), store, { async send() {} }, clock);
    await paper.execute(MSG, buyB(1, 0.25), 1);
    await paper.monitor(flat(1.3), { tokensOnly: true }); // below the ×1.5 take-profit — no sales, but a new peak
    const row = store.openPositions()[0];
    expect(JSON.parse(row.state).peakPrice).toBeCloseTo(1.3, 9);
  });
});
