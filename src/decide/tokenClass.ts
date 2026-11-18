// S-07 (#102), V2 — the owner's decision 2026-11-13: exit plan by source profile.
// Profile "call" — a call by a person or channel with trust score ≥ callMinTrust; "scan" — bot cards, unknown authors, own picks (lower score).
// Plan: a sell ladder (shares — of the whole position), after the first sale the remainder is at breakeven, trailing on the remainder,
// behaviour checks (after N minutes the price is below the threshold and there was no sale yet — exit the core part), emergency floor, core-part deadline,
// moonbag from the moment of entry (its own stop, trailing after a rise, deadline in days).
// Numbers — the memecoinClasses block in server/config/risk.json (changed only with the owner's "yes"). No block or an invalid one — the previous memecoinExit scheme.
// Analysis and "before — after" check: an internal document.
import type { RiskConfig } from '../config.js';

export const TOKEN_PROFILES = ['call', 'scan'] as const;
export type TokenProfile = typeof TOKEN_PROFILES[number];

export interface MoonbagPlan { share: number; stopPct: number; armX: number; trailingPct: number; maxHours: number }
/** Exit plan of one profile. */
export interface ProfileExit {
  /** Emergency floor of the core part from the entry price, %. */
  floorPct: number;
  /** Ladder: [price multiplier, share of the whole position]; multipliers ascending. */
  ladder: [number, number][];
  /** Trailing of the core remainder from the peak after the first sale, % (0 — none). */
  trailingPct: number;
  /** After the first sale the remainder's floor moves to the entry price. */
  breakevenAfterFirst: boolean;
  /** Behaviour checks: [minutes after entry, threshold ×]. Active until there has been any ladder sale. */
  checks: [number, number][];
  /** Core-part deadline, h: by then the core remainder is sold. */
  holdHours: number;
  moonbag: MoonbagPlan;
}

export interface MemecoinClasses {
  version: 2;
  /** Source trust score from which a trade follows the "call" profile. */
  callMinTrust: number;
  profiles: Record<TokenProfile, ProfileExit>;
  /** How many positions with a moonbag may live at once (counting open ones); reached — new trades open without a moonbag. */
  maxOpenMoonbags: number;
  /** The Analyst's "sell by" deadline: 'core' — core part only (the owner's decision 1b); 'all' — the whole position, no moonbag is opened. */
  analystSellByScope?: 'all' | 'core';
  /** The Analyst may tighten the floor (true) or the floor always comes from the profile (false, the owner's decision 2026-11-13). */
  analystStopTightens?: boolean;
}

const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Profile check: undefined — valid, otherwise — the reason (for the message to the owner). */
function profileProblem(x: any): string | undefined {
  if (!x || typeof x !== 'object') return 'no profile';
  if (!num(x.floorPct, 5, 95)) return 'floorPct must be 5..95';
  if (!num(x.trailingPct, 0, 80)) return 'trailingPct must be 0..80';
  if (typeof x.breakevenAfterFirst !== 'boolean') return 'breakevenAfterFirst must be true/false (not a string)';
  if (!num(x.holdHours, 0.25, 24 * 14)) return 'holdHours must be 0.25..336';
  if (!Array.isArray(x.ladder) || x.ladder.length < 1 || x.ladder.length > 100) return 'ladder must have 1..100 rungs';
  let prev = 1, sum = 0;
  for (const r of x.ladder) {
    if (!Array.isArray(r) || r.length !== 2 || !num(r[0], 1.02, 1000) || r[0] <= prev || !num(r[1], 0.001, 1)) return 'ladder rung must be [x > previous, share 0.001..1]';
    prev = r[0]; sum += r[1];
  }
  if (!Array.isArray(x.checks) || x.checks.length > 20) return 'checks must have 0..20 items';
  let prevMin = 0;
  for (const c of x.checks) { if (!Array.isArray(c) || c.length !== 2 || !num(c[0], 1, 24 * 60 * 14) || c[0] <= prevMin || !num(c[1], 0.05, 1)) return 'check must be [minutes > previous, threshold 0.05..1]'; prevMin = c[0]; }
  const m = x.moonbag;
  if (!m || !num(m.share, 0, 0.5) || !num(m.stopPct, 5, 95) || !num(m.armX, 1, 100) || !num(m.trailingPct, 10, 95) || !num(m.maxHours, 0, 24 * 30)) return 'moonbag fields out of range';
  if (m.share > 0 && m.stopPct < x.floorPct) return 'moonbag stop is narrower than the floor';
  if (m.share > 0 && m.maxHours < 1) return 'moonbag maxHours must be ≥ 1';
  // Ladder and moonbag are shares of the whole position: together no more than 100 %
  if (sum + m.share > 1 + 1e-9) return 'ladder + moonbag > 100 %';
  return undefined;
}

/** Block set but invalid — the reason; no block or a valid one — undefined. For the message to the owner at startup (nice-to-have 1, S-07 acceptance). */
export function classesProblem(cfg: RiskConfig): string | undefined {
  const raw = (cfg as RiskConfig & { memecoinClasses?: unknown }).memecoinClasses as any;
  if (raw === undefined) return undefined;
  if (!raw || raw.version !== 2) return 'version must be 2';
  if (!num(raw.callMinTrust, 0, 10)) return 'callMinTrust must be 0..10';
  if (!raw.profiles) return 'no profiles';
  for (const p of TOKEN_PROFILES) { const why = profileProblem(raw.profiles[p]); if (why) return `profiles.${p}: ${why}`; }
  if (!(Number.isInteger(raw.maxOpenMoonbags) && raw.maxOpenMoonbags >= 0 && raw.maxOpenMoonbags <= 20)) return 'maxOpenMoonbags must be an integer 0..20';
  if (!(raw.analystSellByScope === undefined || raw.analystSellByScope === 'all' || raw.analystSellByScope === 'core')) return "analystSellByScope must be 'all' or 'core'";
  if (!(raw.analystStopTightens === undefined || typeof raw.analystStopTightens === 'boolean')) return 'analystStopTightens must be true/false';
  return undefined;
}

/**
 * The memecoinClasses block from risk.json (loadRisk carries unknown keys over as is).
 * No block or an invalid one — undefined: decide() uses the previous single scheme. The error is logged once.
 */
let warned = false;
export function classesFrom(cfg: RiskConfig): MemecoinClasses | undefined {
  const raw = (cfg as RiskConfig & { memecoinClasses?: unknown }).memecoinClasses as any;
  if (raw === undefined) return undefined;
  const why = classesProblem(cfg);
  if (why) {
    if (!warned) { console.error(`risk.json memecoinClasses: invalid block (${why}) — using the single memecoinExit rule`); warned = true; }
    return undefined;
  }
  return raw as MemecoinClasses;
}

/**
 * Profile by source (V1, S-07 acceptance): the Analyst's own pick (the source score was below the trade tier and raised to 4 —
 * a bot card or an unknown author) → "scan"; otherwise source score ≥ callMinTrust → "call". Score not a number — "scan" (stricter).
 */
export function profileFor(c: MemecoinClasses, trust: { score: number; ownPick?: boolean; sourceScore?: number }): { profile: TokenProfile; why: string } {
  if (trust.ownPick) return { profile: 'scan', why: `own pick (source ${trust.sourceScore ?? '?'}/10)` };
  return Number.isFinite(trust.score) && trust.score >= c.callMinTrust
    ? { profile: 'call', why: `source ${trust.score}/10` }
    : { profile: 'scan', why: `source ${trust.score}/10 < ${c.callMinTrust}` };
}

/** Exit plan in the old form — for "careful" sources and when there is no block. */
export interface LegacyExit { stopLossPct: number; takeProfit1x: number; takeProfit1Share: number; trailingStopPct: number; timeStopHours: number; timeStopMinGainPct: number }
export function legacyExit(cfg: RiskConfig): LegacyExit {
  const e = cfg.memecoinExit;
  return { stopLossPct: e.stopLossPct, takeProfit1x: e.takeProfit1x, takeProfit1Share: e.takeProfit1Share, trailingStopPct: e.trailingStopPct, timeStopHours: e.timeStopHours, timeStopMinGainPct: e.timeStopMinGainPct };
}
