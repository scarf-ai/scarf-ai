// Review #113 (S-07 V2), round 3, a fresh look. A red test = the defect is present. "control" blocks — checks that there is no defect (must be green).
// Round 4: moved to test/ (Strategy). Changes against what was sent: the config path; O1 — an own find carries ownPick/sourceScore (fix V1, as HQ suggested),
// score enumeration — via raising the own find; Zh1 — now the owner gets a message at startup.
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { classesFrom, classesProblem } from '../src/decide/tokenClass.js';
import { evaluateExit, moonbagFields, type OpenPos } from '../src/exec/exits.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const CFG: RiskConfig = exitsOnly(loadConfig({ AGENT_ROOT: resolve(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk);
const C = classesFrom(CFG)!;
const T0 = Date.UTC(2026, 10, 14, 8);
const TOKEN = '0x4444444444444444444444444444444444444444';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: new Date(T0).toISOString(), text: `ape ${TOKEN}` };
const trust = { score: 8, tier: 'fast' as const, basis: 'author' as const, notes: [] };
// The call profile plan as decide builds it (V2)
function buyCall(): Decision {
  const ex = C.profiles.call;
  return { action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust, estGasUsd: 0,
    intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.7, tokenAddress: TOKEN } as any,
    check: { ok: true, chain: 'base', address: TOKEN, priceUsd: 0.001, reasons: [] },
    exitPlan: { stopPrice: 0.001 * (1 - ex.floorPct / 100), tp1Price: 0.001 * ex.ladder[0][0], tp1Share: ex.ladder[0][1], stopPct: ex.floorPct, tpX: ex.ladder[0][0],
      trailingPct: ex.trailingPct, timeStopAtUtc: new Date(T0 + ex.holdHours * 3600_000).toISOString(), hardTimeStop: true, timeStopMinGainPct: 0,
      tokenClass: 'call', breakevenAfterTp1: ex.breakevenAfterFirst, ladder: ex.ladder, checks: ex.checks,
      moonbagShare: ex.moonbag.share, moonbagStopPct: ex.moonbag.stopPct, moonbagArmX: ex.moonbag.armX, moonbagTrailingPct: ex.moonbag.trailingPct, moonbagMaxHours: ex.moonbag.maxHours } };
}
function setup(store = new Store(':memory:'), clock = new VirtualClock(T0), risk?: RiskState) {
  risk ??= new RiskState(CFG, clock);
  const paper = new PaperExecutor(CFG, risk, store, { async send() {} }, clock);
  let px: number | undefined = 0.001;
  const market: MarketClient = { async market() { return px === undefined ? undefined : { chain: 'base', priceUsd: px }; }, async rug() { return undefined; } } as any;
  return { clock, store, risk, paper, market, setPx: (v: number | undefined) => { px = v; } };
}
const settle = async (e: ReturnType<typeof setup>) => { await new Promise(r => setTimeout(r, 30)); await e.paper.monitor(e.market, { tokensOnly: true }).catch(() => {}); };
const liveTrader = (st: 'ok' | 'failed' | 'dropped', log: number[]) => {
  let n = 0;
  return {
    async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: 2000n * 10n ** 18n, decimals: 18, spentUsd: 2, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
    async sellToken(a: any) { n++; log.push(a.shadowQty); return { ok: false, mode: 'live', proceedsUsd: 0.5, pending: true, tx: '0x' + String(n).padStart(64, 'c'), soldRaw: BigInt(Math.round(a.shadowQty)) * 10n ** 18n, note: 'sell pending' }; },
    async settleTx() { return st; },
  } as any;
};

describe('control: live, a ladder step "in flight"', () => {
  it('pending → ok: the step is counted once, breakeven is on', async () => {
    const e = setup(); e.paper.liveMode = 'live'; const log: number[] = []; e.paper.trader = liveTrader('ok', log);
    await e.paper.execute(MSG, buyCall(), 1); const p = [...e.paper.open.values()][0];
    e.setPx(0.00125); await e.paper.monitor(e.market, { tokensOnly: true }); await settle(e);
    expect(log.length).toBe(1); expect(p.rungsDone).toBe(1); expect(p.stopPrice).toBeCloseTo(p.entryPrice, 12);
    expect(p.qtyLeft).toBeCloseTo(2000 * (1 - 0.2), 6);
  });
  it('pending → failed / dropped: the state is rolled back, the step is sold again exactly once, ≤ 100 % in total', async () => {
    for (const st of ['failed', 'dropped'] as const) {
      const e = setup(); e.paper.liveMode = 'live'; const log: number[] = []; e.paper.trader = liveTrader(st, log);
      await e.paper.execute(MSG, buyCall(), 1); const p = [...e.paper.open.values()][0];
      e.setPx(0.00125); await e.paper.monitor(e.market, { tokensOnly: true }); await settle(e);
      expect(p.rungsDone ?? 0).toBe(0); expect(p.stopPrice).toBeLessThan(p.entryPrice);
      expect(log.length).toBe(2); // a repeat of the same step after a refusal
      expect(log.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2 * 2000 * 0.2 + 1e-6);
    }
  });
  it('a behavior-check exit pending → dropped, the price recovered → the check does not fire again with a stale price', async () => {
    const e = setup(); e.paper.liveMode = 'live'; const log: number[] = []; e.paper.trader = liveTrader('dropped', log);
    await e.paper.execute(MSG, buyCall(), 1); const p = [...e.paper.open.values()][0];
    e.clock.advance(21 * 60_000); e.setPx(0.0007); await e.paper.monitor(e.market, { tokensOnly: true });
    expect(log.length).toBe(1);
    e.setPx(0.0008); await settle(e);
    expect(log.length).toBe(1); expect(p.qtyLeft).toBe(2000);
  });
});

describe('control: evaluateExit trajectories (a pure function), sold ≤ 100 %, the tail closes once', () => {
  it('random trajectories: total sales ≤ qty, no sales after closing', () => {
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 3000; run++) {
      const prof = run % 2 ? C.profiles.call : C.profiles.scan;
      const p: OpenPos = { id: 'x', token: 't', chain: 'base', entryPrice: 1, qty: 1000, qtyLeft: 1000, costUsd: 1, peakPrice: 1, tp1Done: false, openedAtMs: 0,
        stopPrice: 1 - prof.floorPct / 100, tp1Price: prof.ladder[0][0], tp1Share: prof.ladder[0][1], trailingPct: prof.trailingPct, timeStopAtMs: prof.holdHours * 3600_000, timeStopMinGainPct: 0, hardTimeStop: true,
        ...moonbagFields({ breakevenAfterTp1: true, ladder: prof.ladder, checks: prof.checks, moonbagShare: run % 3 ? prof.moonbag.share : 0, moonbagStopPct: prof.moonbag.stopPct, moonbagArmX: prof.moonbag.armX, moonbagTrailingPct: prof.moonbag.trailingPct, moonbagMaxHours: prof.moonbag.maxHours }, 1000, 1, 0) } as OpenPos;
      let price = 1, t = 0, sold = 0, closedAt = -1;
      for (let i = 0; i < 400; i++) {
        t += rnd() < 0.1 ? rnd() * 6 * 3600_000 : rnd() * 600_000;
        price = Math.max(1e-6, price * Math.exp((rnd() - 0.5) * (rnd() < 0.05 ? 3 : 0.4)));
        const a = evaluateExit(p, rnd() < 0.03 ? NaN : price, t);
        if (a.kind === 'sell') {
          expect(closedAt).toBe(-1); expect(a.qty).toBeGreaterThan(0); expect(a.qty).toBeLessThanOrEqual(p.qtyLeft + 1e-9);
          p.qtyLeft -= a.qty; sold += a.qty; if (p.qtyLeft <= p.qty * 1e-9) closedAt = i;
        }
      }
      expect(sold).toBeLessThanOrEqual(1000 + 1e-6);
    }
  });
});

describe('O2: a restart between checks — a passed check is not saved and is repeated with a later price', () => {
  it('20 min: 0.77× (passes 0.75×) → restart → 25 min: 0.72× — before the 45-min check (0.7×) there must be no sale (example numbers)', async () => {
    const store = new Store(':memory:'); const clock = new VirtualClock(T0);
    const e = setup(store, clock); await e.paper.execute(MSG, buyCall(), 1);
    clock.advance(21 * 60_000); e.setPx(0.00077); await e.paper.monitor(e.market, { tokensOnly: true });
    expect([...e.paper.open.values()][0].checksDone).toBe(1);
    const e2 = setup(store, clock, e.risk); e2.paper.restore();
    clock.advance(4 * 60_000); e2.setPx(0.00072); await e2.paper.monitor(e2.market, { tokensOnly: true });
    { const q = [...e2.paper.open.values()][0]; expect(q.qtyLeft).toBe(q.qty); } // red: the main part was sold "by the 20 min check"
  });
});

describe('O3: the monitor missed the check moment (no price) — the earliest, stricter threshold is applied to the late price', () => {
  it('no price 10–94 min, at 95 min 0.67× (above the 90 min threshold 0.65×) — there must be no sale (example numbers)', async () => {
    const e = setup(); await e.paper.execute(MSG, buyCall(), 1);
    e.setPx(undefined);
    for (let m = 10; m < 95; m += 5) { e.clock.advance(5 * 60_000); await e.paper.monitor(e.market, { tokensOnly: true }); }
    e.setPx(0.00067); e.clock.set(T0 + 95 * 60_000); await e.paper.monitor(e.market, { tokensOnly: true });
    { const q = [...e.paper.open.values()][0]; expect(q.qtyLeft).toBe(q.qty); expect(q.checksDone).toBe(3); } // red: "behavior check 20 min: 0.67x < 0.75x"
  });
  for (const [px, sold] of [[0.00072, false], [0.00068, true]] as const) it(`the same at minute 56 (the 20 and 45 min checks are due), price ${px / 0.001}× — only the 45-minute one applies (0.7×): ${sold ? 'sale' : 'no sale'}`, async () => {
    const e = setup(); await e.paper.execute(MSG, buyCall(), 1);
    e.setPx(undefined);
    for (let m = 10; m < 65; m += 5) { e.clock.advance(5 * 60_000); await e.paper.monitor(e.market, { tokensOnly: true }); }
    e.setPx(px); e.clock.advance(60_000); await e.paper.monitor(e.market, { tokensOnly: true });
    const q = [...e.paper.open.values()][0];
    expect(q.checksDone).toBe(2);
    if (sold) expect(q.qtyLeft).toBeCloseTo(q.qty * 0.2, 6); else expect(q.qtyLeft).toBe(q.qty);
  });
});

describe('Zh1: a broken version 2 block — a message to the owner at startup', () => {
  it('a typo in one field → the block is rejected (the previous scheme), a message with the reason goes out at startup', () => {
    const raw = JSON.parse(JSON.stringify((CFG as any).memecoinClasses)); raw.profiles.call.breakevenAfterFirst = 'true';
    const bad = { ...CFG, memecoinClasses: raw } as any;
    expect(classesFrom(bad)).toBeUndefined();
    expect(classesProblem(bad)).toMatch(/profiles\.call: breakevenAfterFirst/);
    expect(classesProblem(CFG)).toBeUndefined();
    const sent: string[] = []; const clock = new VirtualClock(T0);
    new PaperExecutor(bad, new RiskState(bad, clock), new Store(':memory:'), { async send(t: string) { sent.push(t); } }, clock).restore();
    expect(sent.join('\n')).toMatch(/memecoinClasses block was rejected: profiles\.call: breakevenAfterFirst/);
    const ok: string[] = [];
    new PaperExecutor(CFG, new RiskState(CFG, clock), new Store(':memory:'), { async send(t: string) { ok.push(t); } }, clock).restore();
    expect(ok).toEqual([]);
  });
});

// ---------- O1: the "scan" profile is unreachable for a trade — bot cards and own finds go by "call" ----------
import { Blacklist, decide } from '../src/decide/decide.js';
import { prefilter } from '../src/extract/prefilter.js';
import { tierFor } from '../src/trust/trust.js';
import type { Intent, TrustResult } from '../src/types.js';
// S-02: the S-07 exit tests — without the memecoinEntry entry filter (the entry is checked in test/entry.test.ts)
function exitsOnly<T extends object>(r: T): T { const { memecoinEntry: _drop, ...x } = r as T & { memecoinEntry?: unknown }; return x as T; }
describe('O1: the scan profile is never applied to a position being opened', () => {
  const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
  const mk = () => {
    const clock = new VirtualClock(T0); const risk = new RiskState(CFG, clock);
    const market: MarketClient = { async market() { return { chain: 'solana', symbol: 'X', priceUsd: 0.001, liquidityUsd: 60_000, fdvUsd: 600_000, pairAgeMinutes: 30 * 60, buys24h: 2000, sells24h: 1800 }; },
      async rug() { return { risk: 'low', freezeOrMintAuthority: false, reasons: [] }; } } as any;
    return { cfg: CFG, risk, market, clock, blacklist: new Blacklist(), ethUsd: () => 3000 };
  };
  const it0: Intent = { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'scan card', stance: 'buy', confidence: 0.8 } as Intent;
  it('a scan-feed bot card from an author without a score → "own find" (router.ts:127, score 4) → must go by scan', async () => {
    const own: TrustResult = { score: 4, tier: tierFor(4), basis: 'author', notes: ['analyst own pick (source trust 0) → treated as 4, full checks'], ownPick: true, sourceScore: 0 } as any;
    const d = await decide(it0, own, prefilter(`buy ${MINT}`), mk() as any, { mainTextAddresses: new Set([MINT]), analyst: true } as any);
    expect(d.action).toBe('buy_token');
    expect(d.exitPlan?.tokenClass).toBe('scan'); // red: 'call' (4 steps) instead of scan (2 steps)
  });
  it('across all scores 0..10 (score < 4 — an own find raised by the router to 4): 0..3 → scan, 4..10 → call', async () => {
    const got: string[] = [];
    for (let s = 0; s <= 10; s++) {
      const tr = s < 4 ? { score: 4, tier: tierFor(4), basis: 'author', notes: [], ownPick: true, sourceScore: s } : { score: s, tier: tierFor(s), basis: 'author', notes: [] };
      const d = await decide(it0, tr as any, prefilter(`buy ${MINT}`), mk() as any, { mainTextAddresses: new Set([MINT]), analyst: s < 4 } as any);
      got.push(d.action === 'buy_token' ? String(d.exitPlan?.tokenClass) : d.action);
    }
    expect(got).toEqual([...Array(4).fill('scan'), ...Array(7).fill('call')]);
  });
});