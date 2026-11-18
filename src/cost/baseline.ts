// Cost baseline (card C-01): what a day of agent work costs — from the review log
// (server/data/review/<day>.jsonl), the site database (site.sqlite, table asks) and budget accounting (agent.sqlite, llm_spend).
// Read and count only: does not affect agent behaviour.
//
// Where things come from:
//  - analyses (kind: analysis) — costUsd and tokens over all rounds (usage: input, cache write, cache read, output);
//  - chat batch triage (kind: triage) — costUsd only, no tokens in the log;
//  - site — asks.cost for each visitor question;
//  - Haiku extraction via the old path — no price in the log, only a service log line → an upper estimate by EST_EXTRACT_COST_USD
//    (after this line legacyExtract may not call the model at all: chat, suspicious, budget);
//  - twitterapi.io — events kind: xapi (counter src/cost/xmeter.ts); until it is wired — "no data".
// Cost shares: input, read and output are computed from tokens and PRICES, cache write is the remainder of costUsd within
// the 5-min and 1-h write price bounds (the log sums both writes; the remainder shows how many tokens went to the 1-h write).
// Whatever does not fit these bounds is "does not match prices" (prices were different at write time), not a cache write.
// Totals and the daily average — only over days with a log: days with only llm_spend or the site are shown separately.
import { PRICES } from '../llm/budget.js';
import { EST_EXTRACT_COST_USD } from '../pipeline.js';
import { X_PRICES, xCredits, type XEndpoint } from './xmeter.js';
import { addShadow, emptyShadow, mergeBuckets, type ShadowBucket } from './shadow.js';

export type { ShadowBucket } from './shadow.js';

export interface Tokens { input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number; output: number }
export interface Bucket extends Tokens {
  n: number; usd: number; errors: number; rounds: number;
  /** Spend of failed calls — to compute "$ per successful analysis". */ errorUsd: number;
  /** How many calls have tokens (usage) — the divisor for "rounds per analysis". */ split: number;
  /** $ by part: inUsd + writeUsd + readUsd + outUsd + unexplainedUsd + noSplitUsd = usd.
   *  unexplainedUsd — the remainder that does not fit prices; noSplitUsd — spend without tokens (no usage). */
  inUsd: number; writeUsd: number; readUsd: number; outUsd: number; unexplainedUsd: number; noSplitUsd: number;
}
export interface XBucket { calls: number; items: number; errors: number; usd: number; /** Records are an upper bound (ids()). */ upperBound: boolean }
export interface DayCost {
  day: string;
  /** Review log records for the day; 0 — no log (only llm_spend or the site). */ journalRows: number;
  /** Time of the day's first log record (ISO). */ firstTs?: string;
  messages: number; skipped: number; hardChecks: number;
  /** Analyses by model. */ analysis: Record<string, Bucket>;
  /** Analyses by kind: a single message or a chat batch. */ analysisKind: { message: Bucket; chat: Bucket };
  triage: Record<string, Bucket>;
  /** System-prompt cache keep-alive (C-05): max_tokens 0 pings, by model. */ keepalive: Record<string, Bucket>;
  site: Record<string, Bucket>;
  /** Haiku extraction via the old path: n — log lines, usdMax — upper estimate. */ extract: { n: number; usdMax: number };
  x: Record<string, XBucket> | undefined;
  /** Shadow comparisons of saving ideas: idea → result. */ shadow?: Record<string, ShadowBucket>;
  /** llm_spend from agent.sqlite (cross-check): model → $. */ spendDb?: Record<string, number>;
  /** How many $ did not fit prices (sum of absolute values) — PRICES differ from those at write time. */ priceMismatch: number;
}

export interface SiteAsk { ts: string; model: string; cost: number; reason?: string | null }
export interface SpendRow { day: string; model: string; usd: number }

const zero = (): Bucket => ({ n: 0, usd: 0, errors: 0, errorUsd: 0, rounds: 0, split: 0, input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0,
  inUsd: 0, writeUsd: 0, readUsd: 0, outUsd: 0, unexplainedUsd: 0, noSplitUsd: 0 });
const at = <T>(m: Record<string, T>, k: string, mk: () => T): T => (m[k] ??= mk());
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Price check tolerance: costUsd in the log is rounded to 1e-5, plus 1 % of the call amount. */
export const priceTolerance = (usd: number) => Math.max(2e-5, 0.01 * Math.abs(usd));

/**
 * Adds one model call to the bucket. usage — the summary from the log (rounds, input, cacheWrite, cacheRead, output).
 * Returns how many $ did not fit prices (beyond tolerance), 0 — it matches.
 */
export function addCall(b: Bucket, model: string, usd: number, usage?: Record<string, unknown>, error?: boolean): number {
  b.n++; b.usd += usd; if (error) { b.errors++; b.errorUsd += usd; }
  if (!isObj(usage)) { b.noSplitUsd += usd; return 0; }
  const p = PRICES[model] ?? PRICES['claude-opus-5-5'];
  const t = { input: num(usage.input), cacheWrite: num(usage.cacheWrite), cacheRead: num(usage.cacheRead), output: num(usage.output) };
  const inUsd = (t.input * p.input) / 1e6, readUsd = (t.cacheRead * p.cacheRead) / 1e6, outUsd = (t.output * p.output) / 1e6;
  const rest = usd - inUsd - readUsd - outUsd;
  // Cache write: from all of it at 5 min (w5) to all at 1 h (w1); no write tokens — 0
  const p1h = p.cacheWrite1h ?? p.input * 2;
  const w5 = (t.cacheWrite * p.cacheWrite) / 1e6, w1 = (t.cacheWrite * p1h) / 1e6;
  const writeUsd = Math.min(w1, Math.max(w5, rest));
  const unexplained = rest - writeUsd;
  const per1h = (p1h - p.cacheWrite) / 1e6;
  const t1h = t.cacheWrite && per1h > 0 ? Math.min(t.cacheWrite, Math.max(0, Math.round((writeUsd - w5) / per1h))) : 0;
  b.split++; b.rounds += num(usage.rounds); b.input += t.input; b.cacheWrite += t.cacheWrite; b.cacheWrite1h += t1h; b.cacheRead += t.cacheRead; b.output += t.output;
  b.inUsd += inUsd; b.readUsd += readUsd; b.outUsd += outUsd; b.writeUsd += writeUsd; b.unexplainedUsd += unexplained;
  return Math.abs(unexplained) > priceTolerance(usd) ? Math.abs(unexplained) : 0;
}

/** The service log line after which the old path may call Haiku for extraction (pipeline.legacyExtract). */
const EXTRACT_LOG = /analyst budget exhausted → Haiku extraction/;

export function emptyDay(day: string): DayCost {
  return { day, journalRows: 0, messages: 0, skipped: 0, hardChecks: 0, analysis: {}, analysisKind: { message: zero(), chat: zero() }, triage: {}, keepalive: {}, site: {},
    extract: { n: 0, usdMax: 0 }, x: undefined, priceMismatch: 0 };
}

const DAY = /^\d{4}-\d{2}-\d{2}/;

/** Summary by day. rows — review log records (as in .jsonl), asks and spend — from the databases (if any). Non-objects are skipped. */
export function baseline(rows: unknown[], asks: SiteAsk[] = [], spend?: SpendRow[]): DayCost[] {
  const days = new Map<string, DayCost>();
  const shadowSeen = new Set<string>();
  const day = (ts: unknown) => { const d = String(ts ?? '').slice(0, 10); let x = days.get(d); if (!x) days.set(d, x = emptyDay(d)); return x; };
  for (const r of rows) {
    if (!isObj(r) || !DAY.test(String(r.ts ?? ''))) continue;
    const d = day(r.ts);
    d.journalRows++;
    if (!d.firstTs || String(r.ts) < d.firstTs) d.firstTs = String(r.ts);
    switch (r.kind) {
      case 'message': d.messages++; if (r.skipped) d.skipped++; break;
      case 'hard_check': d.hardChecks++; break;
      case 'analysis': {
        const model = String(r.model ?? '?'), usd = num(r.costUsd);
        d.priceMismatch += addCall(at(d.analysis, model, zero), model, usd, r.usage, !!r.error);
        addCall(r.trigger === 'chat_batch' ? d.analysisKind.chat : d.analysisKind.message, model, usd, r.usage, !!r.error);
        break;
      }
      case 'cache_keepalive': addCall(at(d.keepalive, String(r.model ?? '?'), zero), String(r.model ?? '?'), num(r.costUsd), r.usage, !!r.error); break;
      case 'triage': addCall(at(d.triage, String(r.model ?? '?'), zero), String(r.model ?? '?'), num(r.costUsd), undefined, !!r.error); break;
      case 'log': if (EXTRACT_LOG.test(String(r.text ?? ''))) { d.extract.n++; d.extract.usdMax += EST_EXTRACT_COST_USD; } break;
      case 'cost_shadow': {
        // Format and rules — src/cost/shadow.ts; duplicates (idea + msgId + ts) count once over the whole period
        addShadow(at(d.shadow ??= {}, String(r.idea ?? '?'), emptyShadow), r, shadowSeen);
        break;
      }
      case 'xapi': {
        const xb = at(d.x ??= {}, String(r.endpoint ?? '?'), () => ({ calls: 0, items: 0, errors: 0, usd: 0, upperBound: false }));
        xb.calls++; xb.items += num(r.items); if (r.upperBound) xb.upperBound = true;
        // Whether a failed call is charged is unknown — errors are counted but not priced
        // Pages for followers, separate profile calls for ids() (upper bound), otherwise one call
        if (r.error) xb.errors++; else xb.usd += xUsd(String(r.endpoint) as XEndpoint, num(r.items), num(r.pages) || 1, r.upperBound ? Math.max(1, num(r.items)) : 1);
        break;
      }
    }
  }
  for (const a of asks) if (isObj(a) && DAY.test(String(a.ts ?? ''))) addCall(at(day(a.ts).site, String(a.model), zero), String(a.model), num(a.cost), undefined, /^error/.test(String(a.reason ?? '')));
  if (spend) for (const s of spend) if (isObj(s) && DAY.test(String(s.day ?? ''))) { const d = day(s.day); d.spendDb ??= {}; d.spendDb[s.model] = (d.spendDb[s.model] ?? 0) + num(s.usd); }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Price of a successful twitterapi.io call in $: credits per tariff (xCredits) / credits per $1. */
export function xUsd(endpoint: XEndpoint, items: number, pages = 1, requests = 1): number {
  return xCredits(endpoint, items, pages, requests) / X_PRICES.creditsPerUsd;
}

export const sumBuckets = (bs: Bucket[]): Bucket => bs.reduce((a, b) => {
  const o = zero(); for (const k of Object.keys(o) as (keyof Bucket)[]) o[k] = a[k] + b[k]; return o;
}, zero());

/** Shadow over several days: idea → sum. */
export function mergeShadow(days: DayCost[]): Record<string, ShadowBucket> {
  const out: Record<string, ShadowBucket> = {};
  for (const d of days) for (const [idea, b] of Object.entries(d.shadow ?? {})) out[idea] = mergeBuckets(out[idea] ?? emptyShadow(), b);
  return out;
}

/** A skipped action (act/watch differing from the earlier verdict, or an unparsed verdict) — see src/cost/shadow.ts. */
export const missedActions = (b: ShadowBucket) => b.missed;

/**
 * Full days of a shadow idea: full days of the period starting from the day of its first event. The first-event day is full
 * only if the event is before LATE_START_HOUR:00 UTC (like the first log day).
 */
export function ideaFullDays(full: DayCost[], b: ShadowBucket): DayCost[] {
  if (!b.firstTs) return [];
  const first = b.firstTs.slice(0, 10), lateStart = Number(b.firstTs.slice(11, 13)) >= LATE_START_HOUR;
  return full.filter(d => d.day > first || (d.day === first && !lateStart));
}

/** Day totals: models (analyses + triage), site, upper estimate of extraction, X. */
export function dayTotals(d: DayCost) {
  const analysis = sumBuckets(Object.values(d.analysis)), triage = sumBuckets(Object.values(d.triage)), site = sumBuckets(Object.values(d.site));
  const x = d.x ? Object.values(d.x).reduce((a, b) => a + b.usd, 0) : undefined;
  const keepalive = sumBuckets(Object.values(d.keepalive));
  const models = analysis.usd + triage.usd + keepalive.usd;
  return { analysis, triage, keepalive, site, models, x, total: models + site.usd + d.extract.usdMax + (x ?? 0) };
}

/** The first day's log started after this UTC hour — the day is incomplete. */
export const LATE_START_HOUR = 1;

/**
 * Which days go into totals and the daily average. Only full days with a review log count:
 *  - without a log (only llm_spend or the site) — separately, otherwise spend before the log would count as $0;
 *  - the current UTC day (today) — not over yet;
 *  - the first log day, if the first record is after LATE_START_HOUR:00 UTC.
 */
export function splitDays(list: DayCost[], today: string): { full: DayCost[]; excluded: { day: DayCost; why: string }[]; noJournal: DayCost[] } {
  const full: DayCost[] = [], excluded: { day: DayCost; why: string }[] = [], noJournal: DayCost[] = [];
  const firstJournal = list.find(d => d.journalRows)?.day;
  for (const d of list) {
    if (!d.journalRows) noJournal.push(d);
    else if (d.day >= today) excluded.push({ day: d, why: 'current UTC day' });
    else if (d.day === firstJournal && d.firstTs && Number(d.firstTs.slice(11, 13)) >= LATE_START_HOUR) excluded.push({ day: d, why: `log starts at ${d.firstTs.slice(11, 16)} UTC — incomplete day` });
    else full.push(d);
  }
  return { full, excluded, noJournal };
}

/**
 * Cross-check with llm_spend: review log vs budget accounting, by model. llm_spend includes the tag:chat label
 * (part of the model spend on chat batches) — it is left out of the comparison.
 */
export function reconcile(d: DayCost): { model: string; journal: number; db: number; diff: number }[] {
  if (!d.spendDb) return [];
  const journal: Record<string, number> = {};
  for (const [m, b] of [...Object.entries(d.analysis), ...Object.entries(d.triage), ...Object.entries(d.keepalive)]) journal[m] = (journal[m] ?? 0) + b.usd;
  const models = new Set([...Object.keys(journal), ...Object.keys(d.spendDb).filter(m => !m.startsWith('tag:'))]);
  // A triage failure is logged without a model and at $0 — nothing to compare such lines with
  return [...models].sort().map(m => ({ model: m, journal: journal[m] ?? 0, db: d.spendDb![m] ?? 0, diff: (journal[m] ?? 0) - (d.spendDb![m] ?? 0) }))
    .filter(r => r.journal || r.db);
}

/** llm_spend for the day without the tag:chat label (it is part of the model spend). */
export const spendTotal = (d: DayCost) => Object.entries(d.spendDb ?? {}).filter(([m]) => !m.startsWith('tag:')).reduce((a, [, v]) => a + v, 0);
