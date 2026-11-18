import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState } from '../src/risk/risk.js';
import { Store } from '../src/store/db.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { Blacklist, decide } from '../src/decide/decide.js';
import { prefilter } from '../src/extract/prefilter.js';
import { ageRuleWaived, checkEntry, entryProblem, entryRules, runUp1h, type MemecoinEntry } from '../src/decide/entry.js';
import type { Intent, TrustResult } from '../src/types.js';

// S-02 option B: don't chase a pump, pair age, stake share. Numbers come from the example fixture test/fixtures/risk.example.json
const CFG: RiskConfig = loadConfig({ AGENT_ROOT: resolve(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk;
const B = (CFG as any).memecoinEntry as MemecoinEntry;
const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
const clock = new VirtualClock(Date.UTC(2026, 10, 14, 12));

function deps(cfg: RiskConfig, m: { runUpPct?: number; ageMin?: number }) {
  const market = {
    market: async () => ({ chain: 'solana' as const, symbol: 'X', priceUsd: 0.0003, liquidityUsd: 43_000, fdvUsd: 250_000, pairAgeMinutes: m.ageMin, buys24h: 2300, sells24h: 2000,
      ...(m.runUpPct === undefined ? {} : { priceChangeH1Pct: m.runUpPct }) }),
    rug: async () => ({ risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] }),
  };
  return { cfg, risk: new RiskState(cfg, clock), market, clock, blacklist: new Blacklist(), ethUsd: () => 3000 };
}
const intent: Intent = { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.7 } as Intent;
const tr = (score: number): TrustResult => ({ score, tier: score >= 10 ? 'follow' : score >= 7 ? 'fast' : 'full', basis: 'author', notes: [] });
const own: TrustResult = { score: 4, tier: 'full', basis: 'author', notes: [], ownPick: true, sourceScore: 0 };
const run = (m: { runUpPct?: number; ageMin?: number }, trust = tr(7), cfg = CFG) =>
  decide(intent, trust, prefilter(`buy ${MINT}`), deps(cfg, m), { mainTextAddresses: new Set([MINT]), analyst: true });

describe('S-02 B: risk.json', () => {
  it('holds the example values of the fixture', () => {
    expect(B).toEqual({ version: 1, maxRunUp1h: 1.8, freshPairMaxMinutes: 12, oldPairMinHours: 20, shareOfCapital: 0.08, ageRuleExemptMinTrust: null }); // S-02b off
    expect(entryProblem(CFG)).toBeUndefined();
    expect(entryRules(CFG).kind).toBe('on');
  });
});

describe('S-02 B rule 1: do not chase a pump (price ×maxRunUp1h or more in the hour before the signal; example ×1.8)', () => {
  it('×1.8 → skip with the reason; ×1.79 → buy (old pair)', async () => {
    const no = await run({ runUpPct: 80, ageMin: 30 * 60 });
    expect(no.action).toBe('skip');
    expect(no.reasons.join(' ')).toMatch(/entry: price ×1\.80 in the hour before the signal ≥ ×1\.8 — chasing a pump/);
    const yes = await run({ runUpPct: 79, ageMin: 30 * 60 });
    expect(yes.action).toBe('buy_token');
    expect(yes.reasons.join(' ')).toMatch(/entry ok: ×1\.79 in 1h < ×1\.8, pair 30\.0 h \(old\)/);
  });
  it('FOOD 13.11: ×18 in the hour before, pair 49 min → skip', async () => {
    expect((await run({ runUpPct: 1700, ageMin: 49 })).action).toBe('skip');
  });
  it('price fell before the signal (−40 %) is not a pump → allowed', async () => {
    expect((await run({ runUpPct: -40, ageMin: 5 })).action).toBe('buy_token');
  });
});

describe('S-02 B rule 2: pair age — fresh (< 12 min) or older than 20 h (example), the middle is skipped', () => {
  for (const [age, act] of [[5, 'buy_token'], [11.9, 'buy_token'], [12, 'skip'], [120, 'skip'], [20 * 60, 'skip'], [20 * 60 + 1, 'buy_token'], [72 * 60, 'buy_token']] as const) {
    it(`pair ${age} min → ${act}`, async () => {
      const d = await run({ runUpPct: 20, ageMin: age });
      expect(d.action).toBe(act);
      if (act === 'skip') expect(d.reasons.join(' ')).toMatch(/entry: pair .* between 12 min and 20 h, skip/);
    });
  }
  it('tobiq 28.10 (×1.5 in the hour, pair 3 days) and Wobblet 10.11 (×1.35, 33 h) pass', async () => {
    expect((await run({ runUpPct: 52, ageMin: 72 * 60 })).action).toBe('buy_token');
    expect((await run({ runUpPct: 35, ageMin: 33 * 60 })).action).toBe('buy_token');
  });
});

describe('S-02 B: no data → skip (as in the research)', () => {
  it('no 1h price change → skip', async () => {
    const d = await run({ ageMin: 30 * 60 });
    expect(d.action).toBe('skip');
    expect(d.reasons.join(' ')).toMatch(/entry: no 1h price change/);
  });
  it('no pair age → skip', async () => {
    const d = await run({ runUpPct: 10 });
    expect(d.action).toBe('skip');
    expect(d.reasons.join(' ')).toMatch(/entry: pair age unknown/);
  });
  it('runUp1h: percent → multiple; −100 % and non-numbers → no data', () => {
    expect(runUp1h({ chain: 'solana', priceChangeH1Pct: 66 })).toBeCloseTo(1.66, 9);
    expect(runUp1h({ chain: 'solana', priceChangeH1Pct: -50 })).toBeCloseTo(0.5, 9);
    expect(runUp1h({ chain: 'solana', priceChangeH1Pct: -100 })).toBeUndefined();
    expect(runUp1h({ chain: 'solana', priceChangeH1Pct: NaN })).toBeUndefined();
    expect(runUp1h(undefined)).toBeUndefined();
  });
});

describe('S-02 B rule 3: memecoin stake ≤ shareOfCapital of the bucket at any trust level (example 8 %)', () => {
  it('score 7 (fast 20 %) → $8 of $100; score 10 (follow 45 %) → $8; own pick (full 8 %) → $8', async () => {
    expect((await run({ runUpPct: 20, ageMin: 30 * 60 }, tr(7))).sizeUsd).toBe(8);
    expect((await run({ runUpPct: 20, ageMin: 30 * 60 }, tr(10))).sizeUsd).toBe(8);
    expect((await run({ runUpPct: 20, ageMin: 30 * 60 }, own)).sizeUsd).toBe(8);
  });
  it('the cap does not raise a smaller tier share', async () => {
    const cfg = { ...CFG, perActionShareByTier: { ...CFG.perActionShareByTier, full: 0.04 } } as RiskConfig;
    expect((await run({ runUpPct: 20, ageMin: 30 * 60 }, own, cfg)).sizeUsd).toBe(4);
  });
});

describe('S-02 B: the risk.json block', () => {
  const withBlock = (b: unknown) => ({ ...CFG, memecoinEntry: b }) as RiskConfig;
  it('no block → no filter and tier sizes as before (fast 20 %)', async () => {
    const { memecoinEntry: _drop, ...noBlock } = CFG as RiskConfig & { memecoinEntry?: unknown };
    const d = await run({ runUpPct: 400, ageMin: 120 }, tr(7), noBlock as RiskConfig);
    expect(d.action).toBe('buy_token');
    expect(d.sizeUsd).toBe(20);
  });
  it('invalid block → memecoins are not bought, the reason is in the decision', async () => {
    for (const [b, why] of [[{ ...B, version: 2 }, /version must be 1/], [{ ...B, maxRunUp1h: '1.8' }, /maxRunUp1h/], [{ ...B, shareOfCapital: 0 }, /shareOfCapital/],
      [{ ...B, oldPairMinHours: 0.1, freshPairMaxMinutes: 30 }, /oldPairMinHours must not be below/]] as const) {
      expect(entryProblem(withBlock(b))).toMatch(why);
      const d = await run({ runUpPct: 20, ageMin: 30 * 60 }, tr(7), withBlock(b));
      expect(d.action).toBe('skip');
      expect(d.reasons.join(' ')).toMatch(/entry rules invalid \(risk\.json memecoinEntry: .*\) — memecoins are not bought/);
    }
  });
  it('invalid block → the owner gets a message at startup; valid block → no message', () => {
    const sent: string[] = [];
    const bad = withBlock({ ...B, version: 2 });
    new PaperExecutor(bad, new RiskState(bad, clock), new Store(':memory:'), { async send(t: string) { sent.push(t); } }, clock).restore();
    expect(sent.join('\n')).toMatch(/the memecoinEntry block was rejected: version must be 1\. Memecoins are not bought/);
    const ok: string[] = [];
    new PaperExecutor(CFG, new RiskState(CFG, clock), new Store(':memory:'), { async send(t: string) { ok.push(t); } }, clock).restore();
    expect(ok).toEqual([]);
  });
  it('checkEntry is one rule: runUp < maxRunUp1h and (age < fresh or age > old); example 1.8 / 12 min / 20 h', () => {
    // run-up — in DexScreener percent (integers, no rounding error): 79 % → ×1.79, 80 % → ×1.8
    for (const pct of [-50, 0, 30, 79, 80, 200]) for (const age of [1, 11, 12, 60, 1200, 1201, 5000])
      expect(checkEntry(B, { chain: 'solana', priceChangeH1Pct: pct, pairAgeMinutes: age }).ok).toBe(pct < 80 && (age < 12 || age > 1200));
  });
});

// S-02b (#136): exemption from the pair-age rule for calls from strong sources. Off by default (null); the value comes after the owner's "yes".
describe('S-02b: age-rule exemption for strong sources (off by default)', () => {
  const H12 = 12 * 60;
  const ex = (t: number | null | undefined) => ({ ...CFG, memecoinEntry: { ...B, ageRuleExemptMinTrust: t } }) as RiskConfig;
  it('off in risk.json (null): call 7 on a 12 h pair → skip by the age rule, as in B', async () => {
    const d = await run({ runUpPct: 20, ageMin: H12 }, tr(7));
    expect(d.action).toBe('skip');
    expect(d.reasons.join(' ')).toMatch(/entry: pair 12\.0 h — between 12 min and 20 h, skip/);
  });
  it('on (≥ 7): call 7 on a 12 h pair → buy by the call profile, the reason names the waiver', async () => {
    const d = await run({ runUpPct: 20, ageMin: H12 }, tr(7), ex(7));
    expect(d.action).toBe('buy_token');
    expect(d.exitPlan?.tokenClass).toBe('call');
    expect(d.reasons.join(' ')).toMatch(/pair 12\.0 h — age rule waived: source 7\/10 ≥ 7 \(S-02b\)/);
  });
  it('on (≥ 7): own pick on a 12 h pair → skip (the waiver is for calls of sources, not own picks)', async () => {
    const d = await run({ runUpPct: 20, ageMin: H12 }, own, ex(7));
    expect(d.action).toBe('skip');
    expect(d.reasons.join(' ')).toMatch(/between 12 min and 20 h/);
    expect(ageRuleWaived({ ...B, ageRuleExemptMinTrust: 4 }, { score: 4, ownPick: true })).toBe(false);
  });
  it('on (≥ 7): call 7 with a pump ×1.8 in the hour on a 12 h pair → skip (the pump rule still applies)', async () => {
    const d = await run({ runUpPct: 80, ageMin: H12 }, tr(7), ex(7));
    expect(d.action).toBe('skip');
    expect(d.reasons.join(' ')).toMatch(/chasing a pump/);
  });
  it('threshold ≥ 8: call 7 → skip, call 8 → buy; threshold 10: call 9 → skip, call 10 → buy', async () => {
    expect((await run({ runUpPct: 20, ageMin: H12 }, tr(7), ex(8))).action).toBe('skip');
    expect((await run({ runUpPct: 20, ageMin: H12 }, tr(8), ex(8))).action).toBe('buy_token');
    expect((await run({ runUpPct: 20, ageMin: H12 }, tr(9), ex(10))).action).toBe('skip');
    expect((await run({ runUpPct: 20, ageMin: H12 }, tr(10), ex(10))).action).toBe('buy_token');
  });
  it('fresh and old pairs are not affected by the waiver; the stake stays ≤ shareOfCapital (example 8 %)', async () => {
    for (const age of [5, 30 * 60]) expect((await run({ runUpPct: 20, ageMin: age }, tr(7), ex(7))).action).toBe('buy_token');
    expect((await run({ runUpPct: 20, ageMin: H12 }, tr(10), ex(7))).sizeUsd).toBe(8);
  });
  it('the field: absent or null → off; 4..10 → on; 3, 11, a string → invalid block (memecoins not bought)', async () => {
    const { ageRuleExemptMinTrust: _drop, ...noField } = B;
    expect(entryProblem({ ...CFG, memecoinEntry: noField } as RiskConfig)).toBeUndefined();
    expect(ageRuleWaived(noField as MemecoinEntry, { score: 10 })).toBe(false);
    expect(ageRuleWaived(B, { score: 10 })).toBe(false);
    expect(ageRuleWaived({ ...B, ageRuleExemptMinTrust: 7 }, undefined)).toBe(false);
    for (const t of [4, 7, 10]) expect(entryProblem(ex(t))).toBeUndefined();
    for (const t of [3, 11, '7' as any]) {
      expect(entryProblem(ex(t))).toMatch(/ageRuleExemptMinTrust must be null \(off\) or 4\.\.10/);
      expect((await run({ runUpPct: 20, ageMin: 30 * 60 }, tr(7), ex(t))).action).toBe('skip');
    }
  });
});

// #136 item 4: check on decide() — an own find goes through the scan profile, fresh pairs are open for it
describe('S-02b check on decide(): own picks', () => {
  it('own pick on a 5-min pair without a pump → buy by the scan profile (example: floor −70 %, 2 rungs)', async () => {
    const d = await run({ runUpPct: 20, ageMin: 5 }, own);
    expect(d.action).toBe('buy_token');
    expect(d.exitPlan).toMatchObject({ tokenClass: 'scan', stopPct: 70, ladder: [[1.2, 0.4], [1.44, 0.4]] });
  });
  it('own pick on a 30 h pair → scan; call 7 on the same pair → call', async () => {
    expect((await run({ runUpPct: 20, ageMin: 30 * 60 }, own)).exitPlan?.tokenClass).toBe('scan');
    expect((await run({ runUpPct: 20, ageMin: 30 * 60 }, tr(7))).exitPlan?.tokenClass).toBe('call');
  });
});
