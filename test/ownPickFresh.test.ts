// S-02 option B in full (the owner's decision 2026-11-16 "Yes, open it", an internal document): fresh pairs (< 10 min) are open for the agent's
// own finds (trust.ownPick, level full). Calls by full-level people — the previous 10 min age threshold.
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState } from '../src/risk/risk.js';
import { Blacklist, decide } from '../src/decide/decide.js';
import { prefilter } from '../src/extract/prefilter.js';
import { evaluateToken, QUALITY_BY_TIER } from '../src/checks/token.js';
import { tierFor } from '../src/trust/trust.js';
import type { Intent, TrustResult } from '../src/types.js';

const CFG = loadConfig({ AGENT_ROOT: process.cwd(), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk;
const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
const clock = new VirtualClock(Date.UTC(2026, 10, 16, 12));
const intent = { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.7 } as Intent;
const own: TrustResult = { score: 4, tier: 'full', basis: 'author', notes: [], ownPick: true, sourceScore: 0 } as any;
const human5: TrustResult = { score: 5, tier: tierFor(5), basis: 'author', notes: [] };
const RUG = { risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] };
const mkt = (m: { pct?: number; age?: number; liq?: number }) => ({ chain: 'solana' as const, symbol: 'X', priceUsd: 0.0003, liquidityUsd: m.liq ?? 43_000, fdvUsd: 250_000,
  pairAgeMinutes: m.age, buys24h: 2300, sells24h: 2000, ...(m.pct === undefined ? {} : { priceChangeH1Pct: m.pct }) });
function run(trust: TrustResult, m: { pct?: number; age?: number; liq?: number }) {
  const market = { market: async () => mkt(m), rug: async () => RUG };
  const dd = { cfg: CFG, risk: new RiskState(CFG, clock), market, clock, blacklist: new Blacklist(), ethUsd: () => 3000 };
  return decide(intent, trust, prefilter(`buy ${MINT}`), dd as any, { mainTextAddresses: new Set([MINT]), analyst: true } as any);
}

describe('fresh pairs for own finds (the owner\'s decision 2026-11-16)', () => {
  it('own find, pair 5 min, ×1.2 in an hour, liquidity $43k → buy_token', async () => {
    const d = await run(own, { pct: 20, age: 5 });
    expect(d.action).toBe('buy_token');
    expect(d.reasons.join(' | ')).toMatch(/pair 5 min \(fresh\)/);
  });

  it('a call by a person with score 5 (full) on a 5 min pair → skip by age, as before', async () => {
    expect(human5.tier).toBe('full');
    const d = await run(human5, { pct: 20, age: 5 });
    expect(d.action).toBe('skip');
    expect(d.reasons).toContain('quality: pair age 5 min < 10');
  });

  it('own find: the other full thresholds did not change (liquidity $5k → skip); the "fresh…old" middle and a rise ≥ maxRunUp1h — skip by S-02 (example fixture numbers)', async () => {
    expect((await run(own, { pct: 20, age: 5, liq: 5_000 })).reasons).toContain('quality: liquidity $5000 < $10000');
    expect((await run(own, { pct: 20, age: 120 })).action).toBe('skip');
    expect((await run(own, { pct: 80, age: 5 })).action).toBe('skip');
    expect((await run(own, { pct: 20 })).action).toBe('skip'); // age unknown
  });

  it('evaluateToken: ownPick lifts only the minimum age; the threshold table did not change', () => {
    expect(QUALITY_BY_TIER.full!.minPairAgeMinutes).toBe(10);
    expect(evaluateToken(MINT, 'full', mkt({ age: 5 }), RUG, { ownPick: true }).ok).toBe(true);
    expect(evaluateToken(MINT, 'full', mkt({ age: 5 }), RUG).reasons).toEqual(['quality: pair age 5 min < 10']);
    expect(evaluateToken(MINT, 'full', mkt({ age: 5, liq: 5_000 }), RUG, { ownPick: true }).reasons).toEqual(['quality: liquidity $5000 < $10000']);
  });

  it('review: own find with an unknown age (undefined, NaN) — refused even with the S-02 filter off; age 0 — passes', async () => {
    for (const age of [undefined, NaN])
      expect(evaluateToken(MINT, 'full', mkt({ age }), RUG, { ownPick: true }).reasons, String(age)).toEqual(['quality: pair age unknown (own pick needs a known pair age)']);
    expect(evaluateToken(MINT, 'full', mkt({ age: 0 }), RUG, { ownPick: true }).ok).toBe(true);
    // No memecoinEntry block — the S-02 filter is off: an own find without a pair date is still not bought
    const off = { ...CFG } as any; delete off.memecoinEntry;
    const market = { market: async () => mkt({ pct: 20 }), rug: async () => RUG };
    const dd = { cfg: off, risk: new RiskState(off, clock), market, clock, blacklist: new Blacklist(), ethUsd: () => 3000 };
    const d = await decide(intent, own, prefilter(`buy ${MINT}`), dd as any, { mainTextAddresses: new Set([MINT]), analyst: true } as any);
    expect(d.action).toBe('skip'); expect(d.reasons).toContain('quality: pair age unknown (own pick needs a known pair age)');
    // control: with a known age of 5 min and the filter off — a buy
    const ok = await decide(intent, own, prefilter(`buy ${MINT}`), { ...dd, market: { market: async () => mkt({ pct: 20, age: 5 }), rug: async () => RUG } } as any,
      { mainTextAddresses: new Set([MINT]), analyst: true } as any);
    expect(ok.action).toBe('buy_token');
  });
});
