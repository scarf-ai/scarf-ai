import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { DEFAULT_RISK, loadConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState } from '../src/risk/risk.js';
import { Blacklist, decide } from '../src/decide/decide.js';
import { prefilter } from '../src/extract/prefilter.js';
import { classesFrom, profileFor, type MemecoinClasses } from '../src/decide/tokenClass.js';
import type { Intent, TrustResult } from '../src/types.js';
// S-02: the S-07 exit tests — without the memecoinEntry entry filter (the entry is checked in test/entry.test.ts)
function exitsOnly<T extends object>(r: T): T { const { memecoinEntry: _drop, ...x } = r as T & { memecoinEntry?: unknown }; return x as T; }

// S-07 V2 (the owner's decision 2026-11-13): source profile call / scan, ladder, behavior checks, floor, moonbag
const cfg = exitsOnly(loadConfig({ AGENT_ROOT: resolve(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk);
const V2 = (cfg as any).memecoinClasses as MemecoinClasses;
const withBlock = (b: any) => ({ ...DEFAULT_RISK, memecoinClasses: b }) as any;

describe('S-07 V2: profiles and the risk.json block', () => {
  it('the example fixture holds the documented example values', () => {
    const c = classesFrom(cfg)!;
    expect(c).toBeDefined();
    expect(c.callMinTrust).toBe(2);
    expect(c.analystSellByScope).toBe('core');      // question 1: "exactly 1b"
    expect(c.analystStopTightens).toBe(false);      // the floor is not tightened by the analyst
    expect(c.maxOpenMoonbags).toBe(3);
    expect(c.profiles.call).toMatchObject({ floorPct: 45, trailingPct: 35, breakevenAfterFirst: true, holdHours: 48,
      ladder: [[1.2, 0.2], [1.8, 0.2], [2.7, 0.2], [4.05, 0.2]], checks: [[20, 0.75], [45, 0.7], [90, 0.65], [300, 0.85]],
      moonbag: { share: 0.2, stopPct: 80, armX: 5, trailingPct: 50, maxHours: 336 } });
    expect(c.profiles.scan).toMatchObject({ floorPct: 70, trailingPct: 0, breakevenAfterFirst: true, holdHours: 48,
      ladder: [[1.2, 0.4], [1.44, 0.4]], checks: [[20, 0.75], [45, 0.7], [90, 0.65]], moonbag: { share: 0.2, stopPct: 80 } });
  });
  it('profile by source: own pick (score raised to 4) → scan; scored author → call; not a number → scan (V1)', () => {
    expect(profileFor(V2, { score: 8 }).profile).toBe('call');
    expect(profileFor(V2, { score: 4 }).profile).toBe('call');
    expect(profileFor(V2, { score: 4, ownPick: true, sourceScore: 0 }).profile).toBe('scan');
    expect(profileFor(V2, { score: 0 }).profile).toBe('scan');
    expect(profileFor(V2, { score: NaN }).profile).toBe('scan');
  });
  it('invalid block → undefined (old single rule): no version, ladder not increasing, shares > 100 %, moonbag stop narrower than floor, zero tail hold', () => {
    expect(classesFrom(DEFAULT_RISK)).toBeUndefined();
    const call = V2.profiles.call;
    const mk = (p: any) => withBlock({ ...V2, profiles: { ...V2.profiles, call: p } });
    expect(classesFrom(withBlock({ ...V2, version: undefined }))).toBeUndefined();
    expect(classesFrom(mk({ ...call, ladder: [[2, 0.2], [1.5, 0.2]] }))).toBeUndefined();
    expect(classesFrom(mk({ ...call, ladder: [[1.2, 0.5], [2, 0.5]] }))).toBeUndefined();           // 100 % + a 20 % tail
    expect(classesFrom(mk({ ...call, moonbag: { ...call.moonbag, stopPct: 40 } }))).toBeUndefined(); // tighter than the −45 % floor
    expect(classesFrom(mk({ ...call, moonbag: { ...call.moonbag, maxHours: 0 } }))).toBeUndefined();
    expect(classesFrom(mk({ ...call, checks: [[30, 0.7], [15, 0.6]] }))).toBeUndefined();
    expect(classesFrom(withBlock({ ...V2, analystSellByScope: 'everything' }))).toBeUndefined();
    expect(classesFrom(mk({ ...call }))).toBeDefined();
  });
});

describe('S-07 V2: decide() builds the plan from the profile', () => {
  const clock = new VirtualClock(Date.UTC(2026, 10, 13, 12));
  const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
  const market = { market: async () => ({ chain: 'solana' as const, symbol: 'tobiq', priceUsd: 0.00027, liquidityUsd: 43_000, fdvUsd: 252_000, pairAgeMinutes: 72 * 60, buys24h: 2313, sells24h: 2049 }),
    rug: async () => ({ risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] }) };
  const intent = (o: Partial<Intent> = {}): Intent => ({ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.62, ...o } as Intent);
  const tr = (score: number, careful?: boolean): TrustResult => ({ score, tier: score >= 7 ? 'fast' : 'follow', basis: careful ? 'channel_careful' : 'author', careful, notes: [] });
  const pre = prefilter(`buy ${MINT}`);
  const ctx = { mainTextAddresses: new Set([MINT]), analyst: true };
  const dd = () => ({ cfg, risk: new RiskState(cfg, clock), market, clock, blacklist: new Blacklist(), ethUsd: () => 3000 });

  it('call: ladder, checks, floor −45 %, moonbag 20 %, core by 48 h (example)', async () => {
    const a = await decide(intent(), tr(7), pre, dd(), ctx);
    expect(a.action).toBe('buy_token');
    expect(a.exitPlan).toMatchObject({ tokenClass: 'call', stopPct: 45, tpX: 1.2, tp1Share: 0.2, trailingPct: 35, hardTimeStop: true, breakevenAfterTp1: true,
      ladder: [[1.2, 0.2], [1.8, 0.2], [2.7, 0.2], [4.05, 0.2]], checks: [[20, 0.75], [45, 0.7], [90, 0.65], [300, 0.85]], moonbagShare: 0.2, moonbagStopPct: 80 });
    expect(Date.parse(a.exitPlan!.timeStopAtUtc) - clock.now()).toBe(48 * 3600_000);
    expect(a.reasons.join(' ')).toMatch(/call.*ladder 20%@1\.2x.*moonbag 20%/);
  });
  it('analyst stop 25 % does not narrow the floor; analyst sell-by 24 h shortens only the core (1b), moonbag kept', async () => {
    const b = await decide(intent({ stopLossPct: 25, sellByHours: 24 }), tr(7), pre, dd(), ctx);
    expect(b.exitPlan).toMatchObject({ stopPct: 45, moonbagShare: 0.2 });
    expect(Date.parse(b.exitPlan!.timeStopAtUtc) - clock.now()).toBe(24 * 3600_000);
  });
  it('own pick (router raised source 0 → 4) → scan: 40 % at ×1.2, 40 % at ×1.44, floor −70 %, no trailing, moonbag 20 % (example)', async () => {
    const own: TrustResult = { score: 4, tier: 'full', basis: 'author', notes: ['analyst own pick (source trust 0) → treated as 4, full checks'], ownPick: true, sourceScore: 0 };
    const s = await decide(intent(), own, pre, dd(), ctx);
    expect(s.exitPlan).toMatchObject({ tokenClass: 'scan', stopPct: 70, trailingPct: 0, ladder: [[1.2, 0.4], [1.44, 0.4]], moonbagShare: 0.2 });
  });
  it('careful channel keeps the old strict rules: no profile, no ladder, no moonbag', async () => {
    const c = await decide(intent({ confidence: 0.9 }), tr(6, true), pre, dd(), ctx);
    expect(c.action).toBe('buy_token');
    expect(c.exitPlan!.tokenClass).toBeUndefined();
    expect(c.exitPlan!.ladder).toBeUndefined();
    expect(c.exitPlan!.moonbagShare).toBeUndefined();
    expect(c.exitPlan!.stopPct).toBe(cfg.careful.exit.stopLossPct);
  });
  it('tail cap: maxOpenMoonbags (example 3) positions with moonbag → the next plan has no moonbag', async () => {
    const d = dd();
    for (let i = 0; i < 3; i++) { d.risk.openPosition({ id: `m${i}`, chain: 'solana', token: `T${i}`, costUsd: 0.5, openedAtUtc: clock.iso(), hasMoonbag: true }); }
    const full = await decide(intent(), tr(7), pre, d, ctx);
    expect(full.action).toBe('buy_token');
    expect(full.exitPlan!.moonbagShare).toBeUndefined();
    expect(full.exitPlan!.ladder?.length).toBe(4);
  });
});
