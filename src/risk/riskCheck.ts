// S-06 (#87 item 1, review of branch hq/S-06-risk): check of the risk.json numbers that affect money.
// A string ("0,2"), null, NaN, Infinity or a number out of bounds is an error: a comparison with NaN is always false, and a stop or cap would silently switch off.
// loadRisk replaces an invalid field with the approved value from DEFAULT_RISK and turns on "exits only" mode: new entries are closed
// (RiskState.halted), the exit monitor and reconciliation run on approved numbers, the owner gets a message (src/index.ts).
// A file without side-effecting dependencies: it is read by config.ts (loading) and risk.ts (second line).
import type { RiskConfig } from '../config.js';
import { classesProblem } from '../decide/tokenClass.js';
import { entryProblem } from '../decide/entry.js';

type Check = (v: unknown) => boolean;
const num = (ok: (n: number) => boolean): Check => (v) => typeof v === 'number' && Number.isFinite(v) && ok(v);
const bool: Check = (v) => typeof v === 'boolean';
const share = num(n => n > 0 && n <= 1);
const share0 = num(n => n >= 0 && n <= 1);
const pct = num(n => n > 0 && n < 100);

/** Field path, check, what is needed (for the message to the owner). Fields not in DEFAULT_RISK are not included here. */
export const RISK_RULES: readonly [string, Check, string][] = [
  ['initialCapitalUsd', num(n => n > 0), 'number > 0'],
  ['huntBucketShare', share, 'share 0 < x ≤ 1'],
  ['perActionShareByTier.follow', share0, 'share 0 ≤ x ≤ 1'],
  ['perActionShareByTier.fast', share0, 'share 0 ≤ x ≤ 1'],
  ['perActionShareByTier.full', share0, 'share 0 ≤ x ≤ 1'],
  ['minActionUsd', num(n => n >= 0), 'number ≥ 0'],
  ['maxGasShareOfCapital', share, 'share 0 < x ≤ 1'],
  ['maxGasShareOfAction', share, 'share 0 < x ≤ 1'],
  ['maxOpenPositions', num(n => Number.isInteger(n) && n >= 0), 'integer ≥ 0'],
  ['dailyLossStopShareOfDayStart', share, 'share 0 < x ≤ 1'],
  ['hardStopEquityShare', share, 'share 0 < x ≤ 1'],
  ['mintCapExcludesGas', bool, 'true or false without quotes'],
  ['careful.minConfidence', share0, 'share 0 ≤ x ≤ 1'],
  ['careful.minThesisStrength', num(n => n >= 0 && n <= 10), 'number 0…10'],
  ['careful.maxHoldHours', num(n => n > 0 && n <= 24 * 30), 'hours 0 < x ≤ 720'],
  ['careful.sizeFactor', share, 'share 0 < x ≤ 1'],
  ['careful.minLiquidityUsd', num(n => n >= 0), 'number ≥ 0'],
  ['careful.minBuys24h', num(n => n >= 0), 'number ≥ 0'],
  ['careful.minSellBuyRatio', num(n => n >= 0), 'number ≥ 0'],
  ['careful.exit.stopLossPct', pct, 'percent 0 < x < 100'],
  ['careful.exit.takeProfit1x', num(n => n > 1 && n <= 1000), 'multiplier 1 < x ≤ 1000'],
  ['careful.exit.takeProfit1Share', share, 'share 0 < x ≤ 1'],
  ['careful.exit.trailingStopPct', pct, 'percent 0 < x < 100'],
  ['careful.exit.timeStopHours', num(n => n > 0 && n <= 24 * 30), 'hours 0 < x ≤ 720'],
  ['perp.maxLeverage', num(n => n >= 1 && n <= 50), 'leverage 1…50'],
  ['perp.defaultLeverage', num(n => n >= 1 && n <= 50), 'leverage 1…50'],
  ['perp.riskPerTradeShare', share, 'share 0 < x ≤ 1'],
  ['perp.defaultStopPct', pct, 'percent 0 < x < 100'],
  ['perp.defaultRewardRisk', num(n => n > 0 && n <= 100), 'number 0 < x ≤ 100'],
  ['perp.minStopPct', pct, 'percent 0 < x < 100'],
  ['perp.maxStopPct', pct, 'percent 0 < x < 100'],
  ['perp.feePct', num(n => n >= 0 && n <= 10), 'percent 0…10'],
  ['perp.liqBuffer', num(n => n >= 1 && n <= 10), 'number 1…10'],
  ['perp.venueMinNotionalUsd', num(n => n >= 0), 'number ≥ 0'],
  ['nftAutoMint.enabled', bool, 'true or false without quotes'],
  ['nftAutoMint.minFloorToBreakEven', num(n => n > 0 && n <= 1000), 'number 0 < x ≤ 1000'],
  ['nftAutoMint.minSales', num(n => n >= 0), 'number ≥ 0'],
  ['nftAutoMint.minWlMintedShare', share0, 'share 0 ≤ x ≤ 1'],
  ['nftAutoMint.windowMinutes', num(n => n >= 0 && n <= 24 * 60), 'minutes 0…1440'],
  ['memecoinExit.stopLossPct', pct, 'percent 0 < x < 100'],
  ['memecoinExit.takeProfit1x', num(n => n > 1 && n <= 1000), 'multiplier 1 < x ≤ 1000'],
  ['memecoinExit.takeProfit1Share', share, 'share 0 < x ≤ 1'],
  ['memecoinExit.trailingStopPct', pct, 'percent 0 < x < 100'],
  ['memecoinExit.timeStopHours', num(n => n > 0 && n <= 24 * 30), 'hours 0 < x ≤ 720'],
  ['memecoinExit.timeStopMinGainPct', num(n => n >= 0 && n <= 1000), 'percent 0…1000'],
  ['live.slippageBps', num(n => Number.isInteger(n) && n > 0 && n < 10000), 'integer 0 < x < 10000'],
  ['live.bridgeMaxShareOfEquity', share, 'share 0 < x ≤ 1'],
  ['live.mintMaxShareOfEquity', share, 'share 0 < x ≤ 1'],
  ['live.mintMaxWallets', num(n => Number.isInteger(n) && n >= 1 && n <= 1000), 'integer 1…1000'],
];

const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);
function set(o: Record<string, unknown>, path: string, v: unknown) {
  const ks = path.split('.'); let a = o;
  for (const k of ks.slice(0, -1)) { if (!a[k] || typeof a[k] !== 'object') a[k] = {}; a = a[k] as Record<string, unknown>; }
  a[ks[ks.length - 1]] = v;
}
const show = (v: unknown) => (typeof v === 'string' ? `"${v.slice(0, 40)}"` : String(v));

/** noPrice — same as noPriceProblem (src/exec/paper.ts; importing from there would create a risk.ts ↔ paper.ts cycle). The two copies are compared in test/riskS06.test.ts. */
export function noPriceBlockProblem(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!raw || typeof raw !== 'object') return 'must be an object';
  if (!n(r.exitHours, 0.25, 168)) return 'exitHours must be 0.25..168';
  if (!n(r.writeOffHours, 0.25, 720)) return 'writeOffHours must be 0.25..720';
  if ((r.writeOffHours as number) < (r.exitHours as number)) return 'writeOffHours must not be below exitHours';
  if (!n(r.retryMinutes, 1, 1440)) return 'retryMinutes must be 1..1440';
  return undefined;
}

/**
 * Problems that close all new entries. Invalid memecoinClasses, memecoinEntry and noPrice blocks do not (the owner's decisions
 * 2026-11-13, 2026-11-17 and 2026-11-18 ~00:00 "Don't buy new ones"): they have their own path — new memecoins are not bought (classes,
 * entry; src/decide/decide.ts) / approved "no price" numbers. A message to the owner — for all of them.
 */
const OWN_FALLBACK = ['memecoinClasses:', 'memecoinEntry:', 'noPrice:'];
export function haltingRiskProblems(problems: string[]): string[] {
  return problems.filter(p => !OWN_FALLBACK.some(b => p.startsWith(b)));
}

/**
 * A field with no safe default (S-06 review, O2): substituting initialCapitalUsd ($10 instead of your initialCapitalUsd) would write
 * accounting with someone else's capital into the snapshot — after the file is fixed, an immediate hard stop and a reconciliation mismatch. With such a file the agent does not start
 * (code 78, message to the owner), the risk snapshot is not written; unhalt refuses.
 */
export function fatalRiskProblems(problems: string[]): string[] {
  return problems.filter(p => p.startsWith('initialCapitalUsd='));
}
export function riskFatalAlert(problems: string[]): string {
  return `❌ Agent not started: risk.json is invalid — ${problems.join('; ').slice(0, 1500)}. The starting capital cannot be filled in by default: accounting would be written with someone else's capital. Fix the file and run systemctl restart agent`;
}

/**
 * All risk.json numbers that affect money: the RISK_RULES fields and the memecoinClasses, memecoinEntry, noPrice blocks
 * (checked by their own modules; they have their own fallback path). Empty — all valid. Strings — "field=value — what is needed".
 */
export function riskConfigProblems(r: RiskConfig): string[] {
  const out: string[] = [];
  for (const [path, ok, need] of RISK_RULES) { const v = get(r, path); if (!ok(v)) out.push(`${path}=${show(v)} — needs ${need}`); }
  const blocks: [string, string | undefined][] = [['memecoinClasses', classesProblem(r)], ['memecoinEntry', entryProblem(r)],
    ['noPrice', noPriceBlockProblem((r as RiskConfig & { noPrice?: unknown }).noPrice)]];
  for (const [b, why] of blocks) if (why) out.push(`${b}: ${why}`);
  return out;
}

/**
 * Replaces invalid fields with approved values (defaults = DEFAULT_RISK). Changes cfg in place, returns the list of problems.
 * The memecoinClasses / memecoinEntry / noPrice blocks are not replaced: their modules switch to the fallback path themselves (previous exits,
 * memecoins are not bought, approved "no price" numbers), and the problem still closes new entries.
 */
export function sanitizeRisk(cfg: RiskConfig, defaults: RiskConfig): string[] {
  const problems = riskConfigProblems(cfg);
  for (const [path, ok] of RISK_RULES) if (!ok(get(cfg, path))) set(cfg as unknown as Record<string, unknown>, path, get(defaults, path));
  return problems;
}

/** Message to the owner at startup (src/index.ts). */
export function riskProblemsAlert(problems: string[]): string {
  const what = haltingRiskProblems(problems).length
    ? 'New entries are closed, open positions are managed on approved numbers'
    : [problems.some(p => p.startsWith('memecoinClasses:')) && 'new memecoins are not bought until fixed; open positions follow the exit plan saved at entry',
      problems.some(p => p.startsWith('memecoinEntry:')) && 'memecoins are not bought', problems.some(p => p.startsWith('noPrice:')) && 'the "position without a price" rule runs on approved numbers']
      .filter(Boolean).join('; ').replace(/^./, c => c.toUpperCase()) + '; other entries work';
  return `⛔ risk.json is invalid: ${problems.join('; ').slice(0, 1500)}. ${what}. Fix the file and run systemctl restart agent`;
}
