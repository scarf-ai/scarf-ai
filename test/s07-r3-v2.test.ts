// Review #113 round 3 (2026-11-14): V2 — the plan from risk.json (in the public copy — an example fixture), ladder accounting, N1 on the ladder,
// a deferred step sale, the "scan" profile. The repro-a convention: red = the defect is present.
// Round 4: moved to test/ (Strategy). Changes against what was sent: the config path; an own find carries ownPick/sourceScore (fix V1).
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { Blacklist, decide } from '../src/decide/decide.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { prefilter } from '../src/extract/prefilter.js';
import type { MarketClient } from '../src/checks/token.js';
import type { Decision, Intent, RawMessage, TrustResult } from '../src/types.js';
// S-02: the S-07 exit tests — without the memecoinEntry entry filter (the entry is checked in test/entry.test.ts)
function exitsOnly<T extends object>(r: T): T { const { memecoinEntry: _drop, ...x } = r as T & { memecoinEntry?: unknown }; return x as T; }

const BASE = exitsOnly(loadConfig({ AGENT_ROOT: resolve(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk);
const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';

function setup(trust: TrustResult, cfgOver: Partial<RiskConfig> = {}) {
  const cfg: RiskConfig = { ...BASE, ...cfgOver };
  const clock = new VirtualClock(Date.UTC(2026, 10, 14, 0));
  let price = 0.001;
  const market: MarketClient = {
    async market() { return { chain: 'solana', symbol: 'X', priceUsd: price, liquidityUsd: 60_000, fdvUsd: 600_000, pairAgeMinutes: 30 * 60, buys24h: 2000, sells24h: 1800 }; },
    async rug() { return { risk: 'low', freezeOrMintAuthority: false, reasons: [] }; },
  } as any;
  const risk = new RiskState(cfg, clock);
  const store = new Store(':memory:');
  const sent: string[] = [];
  const paper = new PaperExecutor(cfg, risk, store, { async send(t: string) { sent.push(t); } }, clock);
  const dd = { cfg, risk, market, clock, blacklist: new Blacklist(), ethUsd: () => 3000 };
  async function buy(intentOver: Partial<Intent> = {}, analyst = false) {
    const it = { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.7, ...intentOver } as Intent;
    const d = await decide(it, trust, prefilter(`buy ${MINT}`), dd, { mainTextAddresses: new Set([MINT]), ...(analyst ? { analyst: true } : {}) } as any);
    if (d.action !== 'buy_token') return d;
    const m: RawMessage = { id: '1', sourceServer: 'P', channel: 'calls', author: 'a', tsUtc: clock.iso(), text: `buy ${MINT}` };
    const id = store.saveDecision(m, d, 'paper', clock.iso());
    await paper.execute(m, d, typeof id === 'number' ? id : 1);
    return d;
  }
  return { cfg, clock, risk, paper, store, sent, market, buy, setPrice: (x: number) => { price = 0.001 * x; } };
}
const CALL: TrustResult = { score: 8, tier: 'fast', basis: 'author', notes: [] };

describe('V2 plan from risk.json = the example fixture', () => {
  it('call (score 8): floor −45, ladder 20 % at 1.2/1.8/2.7/4.05, trail 35, checks 20/45/90/300, hold 48 h, moon 20 % / −80 / ×5 / 50 / 336 h', async () => {
    const e = setup(CALL);
    const d = await e.buy();
    expect(d.action).toBe('buy_token');
    const x: any = d.exitPlan;
    expect([x.tokenClass, x.stopPct, x.trailingPct, x.breakevenAfterTp1, x.hardTimeStop]).toEqual(['call', 45, 35, true, true]);
    expect(x.ladder).toEqual([[1.2, 0.2], [1.8, 0.2], [2.7, 0.2], [4.05, 0.2]]);
    expect(x.checks).toEqual([[20, 0.75], [45, 0.7], [90, 0.65], [300, 0.85]]);
    expect(Date.parse(x.timeStopAtUtc) - e.clock.now()).toBe(48 * 3600_000);
    expect([x.moonbagShare, x.moonbagStopPct, x.moonbagArmX, x.moonbagTrailingPct, x.moonbagMaxHours]).toEqual([0.2, 80, 5, 50, 336]);
  });
  it('1b: analyst sell-by 4 h shortens only the core, moonbag stays; analyst stop 10 % does not narrow the floor', async () => {
    const e = setup(CALL);
    const d = await e.buy({ sellByHours: 4, stopLossPct: 10 } as any, true);
    const x: any = d.exitPlan;
    expect(Date.parse(x.timeStopAtUtc) - e.clock.now()).toBe(4 * 3600_000);
    expect(x.moonbagShare).toBe(0.2);
    expect(x.stopPct).toBe(45);
  });
});

describe('V2 behaviour checks (call)', () => {
  it('20 min at 0.74× → core sold, moonbag kept', async () => {
    const e = setup(CALL); await e.buy();
    e.clock.advance(20 * 60_000); e.setPrice(0.74);
    await e.paper.monitor(e.market, { tokensOnly: true });
    const p = [...e.paper.open.values()][0];
    expect(p.qtyLeft).toBeCloseTo(p.qty * 0.2, 6);
  });
  it('first ladder sale at 1.25× → 20 % sold, floor moves to entry (breakeven)', async () => {
    const e = setup(CALL); await e.buy();
    e.setPrice(1.25); await e.paper.monitor(e.market, { tokensOnly: true }); // rung 1
    const p = [...e.paper.open.values()][0];
    expect(p.qtyLeft).toBeCloseTo(p.qty * (1 - 0.2), 6);
    expect(p.stopPrice).toBeCloseTo(p.entryPrice, 12); // breakeven after first sale
  });
});

describe('Ladder accounting: several rungs in one tick, realizePartial on each sale, tail, close', () => {
  it('×3.5 in one tick → rungs 1–3 as one sale; ×5.5 → rung 4; tail only; moon trailing closes; cash = equity, P&L = proceeds − cost', async () => {
    const e = setup(CALL); await e.buy();
    const p = [...e.paper.open.values()][0];
    const cost = p.costUsd, qty = p.qty;
    let sold = 0; const proceeds: number[] = [];
    const tick = async (x: number) => { const before = p.qtyLeft; e.setPrice(x); const c0 = e.risk.cashUsd; await e.paper.monitor(e.market, { tokensOnly: true }); sold += before - p.qtyLeft; if (e.risk.cashUsd !== c0) proceeds.push(e.risk.cashUsd - c0); };
    await tick(3.5);
    expect(p.rungsDone).toBe(3);
    expect(sold).toBeCloseTo(qty * 0.6, 6);
    expect(e.risk.positions[0].costUsd).toBeCloseTo(cost * (1 - 0.6), 9);       // cost of the sold part removed
    expect(e.risk.equityUsd - 100).toBeCloseTo(proceeds[0] - cost * 0.6, 9);    // realised at once
    await tick(5.5);
    expect(p.rungsDone).toBe(4);
    expect(p.qtyLeft).toBeCloseTo(qty * 0.2, 6);
    expect(e.risk.activeCount()).toBe(0); expect(e.risk.moonbagCount()).toBe(1);
    await tick(2.4); // moon armed at ×5 (peak 5.5) → trailing 50 % → ≤ 2.75 sells
    expect(e.paper.open.size).toBe(0);
    expect(sold).toBeCloseTo(qty, 6);
    expect(e.risk.equityUsd).toBeCloseTo(e.risk.cashUsd, 9);
    expect(e.risk.equityUsd - 100).toBeCloseTo(proceeds.reduce((a, b) => a + b, 0) - cost, 9);
  });
  it('without moonbag (tail limit reached) the ladder sells 80 % and the 20 % core rest lives on trailing — never more than 100 % sold', async () => {
    const e = setup(CALL, { memecoinClasses: { ...(BASE as any).memecoinClasses, maxOpenMoonbags: 0 } } as any);
    const d = await e.buy();
    expect((d.exitPlan as any).moonbagShare ?? 0).toBe(0);
    const p = [...e.paper.open.values()][0];
    e.setPrice(6); await e.paper.monitor(e.market, { tokensOnly: true });
    expect(p.qtyLeft).toBeCloseTo(p.qty * 0.2, 6);
    e.setPrice(3); await e.paper.monitor(e.market, { tokensOnly: true }); // trailing 35 % from 6
    expect(e.paper.open.size).toBe(0);
    expect(e.risk.equityUsd).toBeCloseTo(e.risk.cashUsd, 9);
  });
});

describe('N1 on the V2 ladder: exitToken after a rung', () => {
  it('rung 1 sold, then analyst sell → cash = equity', async () => {
    const e = setup(CALL); await e.buy();
    e.setPrice(1.25); await e.paper.monitor(e.market, { tokensOnly: true });
    expect(await e.paper.exitToken(MINT, 'analyst: sell', e.market)).toBe(true);
    expect(e.risk.equityUsd).toBeCloseTo(e.risk.cashUsd, 6);
  });
});

describe('Profile «scan» per document: bot cards, unknown authors, own picks (score 0)', () => {
  it('analyst own pick (router raises score 0 → 4) must trade by «scan»', async () => {
    const own: TrustResult = { score: 4, tier: 'full', basis: 'author', notes: ['analyst own pick (source trust 0) → treated as 4, full checks'], ownPick: true, sourceScore: 0 } as any;
    const e = setup(own);
    const d = await e.buy({}, true);
    expect(d.action).toBe('buy_token');
    expect((d.exitPlan as any).tokenClass).toBe('scan');
  });
  it('score 0 (bot card, unknown author) never reaches the exit plan: journal only', async () => {
    const e = setup({ score: 0, tier: 'journal', basis: 'author', notes: [] } as any);
    const d = await e.buy({}, true);
    expect(d.action).toBe('journal_only'); // explains why "scan" is unreachable by score: a score < 4 is not traded
  });
});

describe('Behaviour checks survive a restart (checksDone is not saved without a sale or a new peak)', () => {
  it('checks 20/45/90 passed at 0.95×, restart at 3 h, price 0.65× → no check is due, nothing must be sold', async () => {
    const e = setup(CALL); await e.buy();
    for (const m of [20, 45, 90]) { e.clock.set(Date.UTC(2026, 10, 14, 0) + m * 60_000); e.setPrice(0.95); await e.paper.monitor(e.market, { tokensOnly: true }); }
    expect([...e.paper.open.values()][0].checksDone).toBe(3);
    // restart
    e.clock.set(Date.UTC(2026, 10, 14, 3));
    const r2 = new RiskState(e.cfg, e.clock); r2.restore(e.risk.snapshot());
    const p2 = new PaperExecutor(e.cfg, r2, e.store, { async send() {} }, e.clock); p2.restore();
    e.setPrice(0.65); await p2.monitor(e.market, { tokensOnly: true });
    const p = [...p2.open.values()][0];
    expect(p.qtyLeft).toBeCloseTo(p.qty, 6);
  });
});