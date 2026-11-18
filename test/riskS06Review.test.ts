// Review of the hq/S-06-risk branch (2 reviewers): reproductions moved to test/. The last block — it was fail-open, now: an invalid number
// is replaced by the approved one, new entries are closed.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RISK, loadConfig, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState, haltReason } from '../src/risk/risk.js';
import { NftLive } from '../src/live/nftLive.js';

const dir = mkdtempSync(join(tmpdir(), 'rv-risk-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const load = (json: string) => { const p = join(dir, `r${n++}.json`); writeFileSync(p, json); return loadConfig({ AGENT_ROOT: dir, AGENT_RISK_JSON: p } as NodeJS.ProcessEnv).risk; };
const ROOT = join(__dirname, '..');
// Example: capital $60 with a daily stop of 0.2 gives a $12 threshold (example fixture numbers, not real ones)
const live = { ...loadConfig({ AGENT_ROOT: ROOT, AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk, initialCapitalUsd: 60 };
const T = (h: number, m = 0, s = 0, ms = 0) => new VirtualClock(Date.UTC(2026, 10, 18, h, m, s, ms));

function first(cfg: RiskConfig, e: number, f: (st: RiskState, x: number) => void) {
  for (let c = 1; c <= e * 100; c++) { const st = new RiskState(cfg, T(10), e); f(st, c / 100); if (st.dailyStopActive()) return c / 100; }
  return Infinity;
}

describe('thresholds by hand', () => {
  it('E × bucket × loss kind: the first stop = ceil(0.2·E·b) to the cent', () => {
    for (const e of [10, 50, 200]) for (const b of [1, 0.8, 0.5]) {
      const cfg = { ...live, huntBucketShare: b };
      const want = Math.ceil(Math.round(0.2 * e * b * 1e6) / 1e4) / 100;
      expect(first(cfg, e, (st, x) => st.recordPnl(-x)), `real ${e} ${b}`).toBe(want);
      expect(first(cfg, e, (st, x) => st.setUnrealized(-x)), `float ${e} ${b}`).toBe(want);
      // a mix: 60 % closed (in cents) + the rest floating
      expect(first(cfg, e, (st, x) => { const r = Math.round(x * 60) / 100; st.recordPnl(-r); st.setUnrealized(-(Math.round((x - r) * 100) / 100)); }), `mix ${e} ${b}`).toBe(want);
      // a morning profit does not widen the base: +5 closed, then a loss — the threshold from E·b, not from (E+5)·b
      expect(first(cfg, e, (st, x) => { st.recordPnl(5); st.recordPnl(-(x + 5)); }), `profit-then-loss ${e} ${b}`).toBe(want);
    }
  });
  it('a floating profit does not offset a closed loss; floating NaN — stop on', () => {
    const st = new RiskState(live, T(10)); st.recordPnl(-12); st.setUnrealized(+20); expect(st.dailyStopActive()).toBe(true);
    st.setUnrealized(NaN); expect(st.dailyStopActive()).toBe(true); expect(st.halted()).toBe(true);
  });
  it('partial sales, fees (spend), the Solana deposit in proceeds: the 00:00 base is unchanged within the day', () => {
    const c = T(1); const st = new RiskState(live, c);
    st.openPosition({ id: 'a', chain: 'solana', token: 'A', costUsd: 25.002, openedAtUtc: c.iso() }); // price + deposit
    st.spend(0.37); st.realizePartial('a', 6.1, 12.5); st.closePosition('a', 7.3, 0); st.spend(0.011);
    expect(st.dayStartBucketUsd).toBeCloseTo(60, 9);
    for (let i = 0; i < 500; i++) st.recordPnl(i % 2 ? 0.0137 : -0.0137); // addition drift
    expect(Math.abs(st.dayStartBucketUsd - 60)).toBeLessThan(1e-9);
  });
});

describe('UTC day change', () => {
  it('23:59:59.999 → 00:00:00.000: the stop is lifted, base = capital at 00:00', () => {
    const c = T(23, 59, 59, 999); const st = new RiskState(live, c); st.recordPnl(-12);
    expect(st.dailyStopActive()).toBe(true);
    c.advance(1);
    expect(st.todayPnl()).toBe(0); expect(st.dailyStopActive()).toBe(false); expect(st.dailyStopLimitUsd()).toBeCloseTo(0.2 * 48, 9);
  });
  it('a position across midnight, closed at 00:01 with −12: the loss goes to the new day, base $60 (capital at 00:00 without floating)', () => {
    const c = T(23, 50); const st = new RiskState(live, c);
    st.openPosition({ id: 'p', chain: 'solana', token: 'T', costUsd: 20, openedAtUtc: c.iso() }); st.setUnrealized(-12);
    c.advance(11 * 60_000);
    st.closePosition('p', 8, 0); // the monitor has not zeroed the floating yet: −12 + −12 — stricter, not softer
    expect(st.dayStartBucketUsd).toBeCloseTo(60, 9); expect(st.dailyStopPnlUsd()).toBeCloseTo(-24, 9); expect(st.dailyStopActive()).toBe(true);
    st.setUnrealized(0); expect(st.dailyStopActive()).toBe(true);
  });
  it('a restart across midnight before the first monitor pass: the floating −12 from the snapshot holds the stop', () => {
    const c = T(23, 50); const st = new RiskState(live, c);
    st.openPosition({ id: 'p', chain: 'solana', token: 'T', costUsd: 20, openedAtUtc: c.iso() }); st.recordPnl(-1); st.setUnrealized(-12);
    const snap = JSON.parse(JSON.stringify(st.snapshot()));
    c.advance(20 * 60_000);
    const st2 = new RiskState(live, c); st2.restore(snap);
    expect(st2.dailyStopLimitUsd()).toBeCloseTo(0.2 * 59, 9); expect(st2.dailyStopActive()).toBe(true);
  });
});

describe('old field compatibility', () => {
  it('closed losses only: s/(1+s) gives the same first stop as the previous rule (± 1 cent towards strict), E = $1…$500', () => {
    const old = load('{"dailyLossStopShare": 0.28}'); // old field example
    let worse = 0, stricter = 0;
    for (let e100 = 100; e100 <= 50000; e100 += 37) {
      const e = e100 / 100;
      let prev = Infinity; for (let c = 1; c <= e100; c++) { const L = c / 100; if (-L <= -0.28 * (e - L)) { prev = L; break; } }
      const now = first(old, e, (st, x) => st.recordPnl(-x));
      if (now > prev + 1e-9) worse++; if (now < prev - 1e-9) { stricter++; expect(prev - now).toBeLessThan(0.0100001); }
    }
    expect(worse).toBe(0);
  });
});

describe('other risk.json limits: a string with a comma — was silently no limit, now the approved limit and a stop on new entries', () => {
  it('live.mintMaxShareOfEquity "0,25", bridgeMaxShareOfEquity "0,5", slippageBps 10000: default numbers (example), the mint cap works', () => {
    const cfg = load('{"live": {"mintMaxShareOfEquity": "0,25", "bridgeMaxShareOfEquity": "0,5", "slippageBps": 10000}}');
    expect(cfg.live).toEqual(DEFAULT_RISK.live);
    expect(cfg.riskProblems).toHaveLength(3);
    const nl = new NftLive({ cfg: { maxWallets: 8, maxShareOfEquity: cfg.live.mintMaxShareOfEquity }, equityUsd: () => 60, ethUsd: () => 4000 } as any);
    expect(nl.budgetProblem(1, {} as any)).toBeDefined(); // a $4000 mint with $60 capital — over the cap
    expect(1000 > 60 * cfg.live.bridgeMaxShareOfEquity).toBe(true); // bridge.ts:148 — a $1000 bridge exceeds the bridge share
    const st = new RiskState(cfg, T(10));
    expect(haltReason(cfg, st)).toMatch(/^risk\.json: .*live\.mintMaxShareOfEquity="0,25"/);
  });
});

describe('review B: valid files pass, an unused old field does not break startup', () => {
  it('the example risk.json loads without problems', () => {
    expect(live.riskProblems).toEqual([]);
    expect(live.dailyLossStopShareOfDayStart).toBe(0.2);
  });
  it('the new field is valid, the old one = null or "0,28" — no problems', () => {
    const base = JSON.stringify({ ...JSON.parse(JSON.stringify(live)), riskProblems: undefined });
    for (const old of [null, '0,28']) expect(load(JSON.stringify({ ...JSON.parse(base), dailyLossStopShare: old })).riskProblems, String(old)).toEqual([]);
  });
  it('the second line sees all fields: maxOpenPositions 2.5 and minActionUsd −1 in a config from code', () => {
    const cfg2 = { ...DEFAULT_RISK, maxOpenPositions: 2.5, minActionUsd: -1 } as unknown as RiskConfig;
    expect(new RiskState(cfg2, T(10)).stopConfigProblem()).toMatch(/minActionUsd=-1.*maxOpenPositions=2\.5/);
  });
});

describe('review B, nice-to-have 4: a floating NaN holds the stop even after a restart', () => {
  it('setUnrealized(NaN) → snapshot via JSON → stop on; the first monitor pass with a number — as usual', () => {
    const cfg = { ...DEFAULT_RISK, initialCapitalUsd: 60 };
    const st = new RiskState(cfg, T(10));
    st.openPosition({ id: 'p', chain: 'solana', token: 'T', costUsd: 20, openedAtUtc: '2026-11-18T00:00:00Z' });
    st.setUnrealized(NaN);
    expect(st.dailyStopActive()).toBe(true);
    const st2 = new RiskState(cfg, T(10)); st2.restore(JSON.parse(JSON.stringify(st.snapshot())));
    expect(st2.dailyStopActive()).toBe(true);
    expect(st2.halted()).toBe(true);
    st2.setUnrealized(-1); expect(st2.dailyStopActive()).toBe(false);
    expect(st2.snapshot().unrealizedUnknown).toBeUndefined();
  });
});
