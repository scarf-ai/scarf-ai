// S-02 (#30), option B — the owner's decision 2026-11-13 "We take option B": memecoin entry filter and stake share.
// 1. Don't chase the pump: the price rose maxRunUp1h times or more in the hour before the signal — don't enter.
// 2. Pair age: enter only a very fresh pair (< freshPairMaxMinutes) or a pair older than oldPairMinHours; the middle — skip.
// 3. A memecoin stake — no more than shareOfCapital of the bucket at any trust tier (a person's call — no more than an own pick).
// No data on the 1h change or on the pair age — skip (such tokens were not taken in the research either).
// Numbers — the memecoinEntry block in server/config/risk.json (changed only with the owner's "yes"). No block — no filter (previous behaviour);
// block set but invalid — memecoins are not bought, the reason goes into the decision (money first: an invalid block does not silently enable the old entry).
// Research and "before — after": an internal document.
// S-02b (#136): exemption from the pair-age rule for calls from a source with score ≥ ageRuleExemptMinTrust (not an own pick).
// "Don't chase the pump" applies to them too. No field or null — the exemption is off (the value — only with the owner's "yes").
import type { RiskConfig } from '../config.js';
import type { MarketInfo } from '../checks/token.js';

export interface MemecoinEntry {
  version: 1;
  /** Price rise in the hour before the signal at which entry is forbidden (× to the price an hour ago). */
  maxRunUp1h: number;
  /** A pair younger than this is "fresh", entry allowed, min. */
  freshPairMaxMinutes: number;
  /** A pair older than this is "old", entry allowed, h. Between fresh and old — skip. */
  oldPairMinHours: number;
  /** Bucket share per memecoin buy at any trust tier. */
  shareOfCapital: number;
  /**
   * S-02b: a call from a source with score ≥ this (not the Analyst's own pick) is bought on a "middle" pair too (between fresh and old).
   * The "don't chase the pump" rule applies. No field or null — the exemption is off.
   */
  ageRuleExemptMinTrust?: number | null;
}

/** Trade source for the S-02b exemption: source score and own-pick flag (TrustResult). */
export interface EntrySource { score: number; ownPick?: boolean }

/** Market data with the 1h change (the field is added by Execution in src/checks/token.ts — DexScreener priceChange.h1, %). */
export type MarketWithChange = MarketInfo & { priceChangeH1Pct?: number };

const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Block set but invalid — the reason; no block or a valid one — undefined. */
export function entryProblem(cfg: RiskConfig): string | undefined {
  const raw = (cfg as RiskConfig & { memecoinEntry?: unknown }).memecoinEntry as any;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return 'version must be 1';
  if (!num(raw.maxRunUp1h, 1.01, 100)) return 'maxRunUp1h must be 1.01..100';
  if (!num(raw.freshPairMaxMinutes, 0, 24 * 60)) return 'freshPairMaxMinutes must be 0..1440';
  if (!num(raw.oldPairMinHours, 0, 24 * 30)) return 'oldPairMinHours must be 0..720';
  if (raw.oldPairMinHours * 60 < raw.freshPairMaxMinutes) return 'oldPairMinHours must not be below freshPairMaxMinutes';
  if (!num(raw.shareOfCapital, 0.001, 1)) return 'shareOfCapital must be 0.001..1';
  // A score below 4 does not trade by score (only an own pick, to which the exemption does not apply)
  if (!(raw.ageRuleExemptMinTrust === undefined || raw.ageRuleExemptMinTrust === null || num(raw.ageRuleExemptMinTrust, 4, 10))) return 'ageRuleExemptMinTrust must be null (off) or 4..10';
  return undefined;
}

export type EntryRules = { kind: 'off' } | { kind: 'invalid'; why: string } | { kind: 'on'; rules: MemecoinEntry };
export function entryRules(cfg: RiskConfig): EntryRules {
  const raw = (cfg as RiskConfig & { memecoinEntry?: unknown }).memecoinEntry;
  if (raw === undefined) return { kind: 'off' };
  const why = entryProblem(cfg);
  return why ? { kind: 'invalid', why } : { kind: 'on', rules: raw as MemecoinEntry };
}

/** Rise in the hour before the signal (×) from the DexScreener percentage; no data — undefined. */
export function runUp1h(m: MarketWithChange | undefined): number | undefined {
  const pct = m?.priceChangeH1Pct;
  return typeof pct === 'number' && Number.isFinite(pct) && pct > -100 ? 1 + pct / 100 : undefined;
}

/** The S-02b exemption is on and the source qualifies: a call (not an own pick) with score ≥ the threshold. */
export function ageRuleWaived(r: MemecoinEntry, src: EntrySource | undefined): boolean {
  const t = r.ageRuleExemptMinTrust;
  return typeof t === 'number' && Number.isFinite(t) && !!src && src.ownPick !== true && Number.isFinite(src.score) && src.score >= t;
}

/** Entry filter decision: ok — enter; otherwise the skip reason (goes into the decision and the journal). src — the source for the S-02b exemption. */
export function checkEntry(r: MemecoinEntry, m: MarketWithChange | undefined, src?: EntrySource): { ok: true; why: string } | { ok: false; why: string } {
  const ru = runUp1h(m);
  const age = m?.pairAgeMinutes;
  if (ru === undefined) return { ok: false, why: 'entry: no 1h price change — skip (S-02)' };
  if (typeof age !== 'number' || !Number.isFinite(age)) return { ok: false, why: 'entry: pair age unknown — skip (S-02)' };
  if (ru >= r.maxRunUp1h) return { ok: false, why: `entry: price ×${ru.toFixed(2)} in the hour before the signal ≥ ×${r.maxRunUp1h} — chasing a pump, skip (S-02)` };
  const fresh = age < r.freshPairMaxMinutes, old = age > r.oldPairMinHours * 60;
  if (!fresh && !old) {
    if (ageRuleWaived(r, src)) return { ok: true, why: `entry ok: ×${ru.toFixed(2)} in 1h < ×${r.maxRunUp1h}, pair ${fmtAge(age)} — age rule waived: source ${src!.score}/10 ≥ ${r.ageRuleExemptMinTrust} (S-02b)` };
    return { ok: false, why: `entry: pair ${fmtAge(age)} — between ${r.freshPairMaxMinutes} min and ${r.oldPairMinHours} h, skip (S-02)` };
  }
  return { ok: true, why: `entry ok: ×${ru.toFixed(2)} in 1h < ×${r.maxRunUp1h}, pair ${fmtAge(age)} (${fresh ? 'fresh' : 'old'})` };
}

function fmtAge(min: number): string {
  return min < 120 ? `${Math.round(min)} min` : `${(min / 60).toFixed(min < 48 * 60 ? 1 : 0)} h`;
}

/**
 * The "1h change unavailable" watchdog (#128 O1): if memecoins are skipped in a row for "no 1h price change", the S-02 filter has effectively
 * closed all memecoin buys — one Telegram message to the owner about it (no more than once a day), not just lines in the journal.
 * Fires: STREAK entry checks in a row without the 1h change, or all checks within WINDOW_MS without it, if there are at least MIN_IN_WINDOW.
 * A check with the 1h change resets the streak. A send failure goes to the service log (console.error), not an exception and not silence.
 * Separately (review 2026-11-16) — the same rules for fresh pairs only (age < FRESH_MIN): if fresh pairs systematically lack
 * the 1h change while old ones have it, old pairs reset the common streak and the fresh half of option B quietly stops working.
 * Each counter has its own "once a day"; if both fire at once, a single common message goes out (it covers fresh pairs too).
 */
export class NoH1Watch {
  static readonly STREAK = 5;
  static readonly WINDOW_MS = 6 * 3600_000;
  static readonly MIN_IN_WINDOW = 3;
  static readonly QUIET_MS = 24 * 3600_000;
  /** A pair younger than this (min) is "fresh" for the separate counter. */
  static readonly FRESH_MIN = 60;
  private all = new NoH1Series();
  private fresh = new NoH1Series();
  constructor(private o: { notify: (t: string) => Promise<unknown>; now: () => number }) {}

  /** One memecoin entry check; noH1 — the market data has no 1h change; pairAgeMinutes — the pair age, if known. */
  note(noH1: boolean, pairAgeMinutes?: number): void {
    const now = this.o.now();
    const isFresh = typeof pairAgeMinutes === 'number' && Number.isFinite(pairAgeMinutes) && pairAgeMinutes < NoH1Watch.FRESH_MIN;
    const nAll = this.all.note(noH1, now);
    const nFresh = isFresh ? this.fresh.note(noH1, now) : 0;
    const at = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
    let text: string | undefined;
    if (nAll) {
      if (nFresh) this.fresh.sent(now);
      text = `⚠️ 1h price change unavailable: ${nAll} memecoins in a row skipped for "no 1h price change" (last one — ${at} UTC). `
        + 'While this lasts, memecoins are not bought (S-02 filter). Check the DexScreener response (priceChange.h1). The next such message — no sooner than in 24 h.';
    } else if (nFresh) {
      text = `⚠️ For fresh pairs (younger than ${NoH1Watch.FRESH_MIN} min) the 1h price change is unavailable: ${nFresh} in a row skipped for "no 1h price change" (last one — ${at} UTC). `
        + 'The fresh half of option B (entry into a pair younger than 10 min) is not working now; old pairs are bought as usual. Check the DexScreener response (priceChange.h1) for new pairs. '
        + 'The next such message — no sooner than in 24 h.';
    }
    if (!text) return;
    const fail = (e: unknown) => console.error(`[entry] no-1h-change alert not sent: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    try { void Promise.resolve(this.o.notify(text)).catch(fail); } catch (e) { fail(e); }
  }
}

/** One watchdog counter: a streak in a row and a WINDOW_MS window. note → number of skips for the message (and a "sent" mark) or 0. */
class NoH1Series {
  private streak = 0;
  private seen: { at: number; noH1: boolean }[] = [];
  private lastSentAt = -Infinity;
  sent(now: number) { this.lastSentAt = now; }
  note(noH1: boolean, now: number): number {
    this.streak = noH1 ? this.streak + 1 : 0;
    this.seen = [...this.seen, { at: now, noH1 }].filter(s => now - s.at <= NoH1Watch.WINDOW_MS);
    if (!noH1) return 0;
    const allInWindow = this.seen.length >= NoH1Watch.MIN_IN_WINDOW && this.seen.every(s => s.noH1);
    if (this.streak < NoH1Watch.STREAK && !allInWindow) return 0;
    if (now - this.lastSentAt < NoH1Watch.QUIET_MS) return 0;
    this.lastSentAt = now;
    return Math.max(this.streak, this.seen.length);
  }
}
