// Shadow comparison of saving ideas (C-03, `scarf-cost-gate`): the old path works as is, the new one only writes
// to the review log what it would have done. Here — parsing of the cost_shadow event and the per-idea total. The event format is one
// table in an internal cost document, section 2; anything that does not match it is not silently lost but counted as "unrecognized".
//
// Counting rules (HQ review #80, round 1):
//  - an event with fields off-format → unrecognized, not in the sums, the report warns;
//  - the verdict is a string or an object { verdict } (as in the analysis event), case-insensitive; anything else is "not recognized"
//    and counts as a miss that needs review;
//  - a missed action: act or watch differing from prevVerdict (the verdict code would have kept), or
//    an unrecognized verdict;
//  - a duplicate (same idea, msgId and ts) counts once;
//  - compaction (batch-compact) does not skip the model: $ is estimated as inputUsd × (1 − charsAfter / charsBefore).

/** Ideas from an internal cost document, section 7: event id → idea number. */
export const SHADOW_IDEAS: Record<string, number> = { 'batch-dedup': 1, 'recheck-gate': 2, 'burst-merge': 3, 'batch-compact': 4 };
export const VERDICTS = ['act', 'watch', 'ignore', 'avoid'] as const;
export const UNKNOWN_VERDICT = 'not recognized';

export interface ShadowBucket {
  /** Recognized events (without duplicates). */ events: number;
  duplicates: number;
  /** Events with off-format fields — not in the sums. */ unrecognized: number;
  /** The new path would not have called the model. */ wouldSkip: number;
  /** $ of these analyses on the old path — this much would be saved. */ usdSaved: number;
  /** All verdicts of skipped calls, including "not recognized". */ skippedVerdicts: Record<string, number>;
  /** Missed action — the idea is not enabled until every case is reviewed. */ missed: number;
  /** Compaction: events with charsBefore, without charsAfter, characters, $ estimate. */
  compactEvents: number; compactNoAfter: number; charsBefore: number; charsAfter: number; compactUsd: number;
  /** The idea's first event (ISO) — shadow days are counted from it. */ firstTs?: string;
}

export const emptyShadow = (): ShadowBucket => ({ events: 0, duplicates: 0, unrecognized: 0, wouldSkip: 0, usdSaved: 0, skippedVerdicts: {}, missed: 0,
  compactEvents: 0, compactNoAfter: 0, charsBefore: 0, charsAfter: 0, compactUsd: 0 });

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Verdict from a string or an object { verdict }; anything else — undefined. */
export function verdictOf(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { verdict?: unknown }).verdict : undefined;
  const t = typeof s === 'string' ? s.trim().toLowerCase() : '';
  return (VERDICTS as readonly string[]).includes(t) ? t : undefined;
}

/** Duplicate key: idea + msgId + time. */
export const shadowKey = (r: Record<string, any>) => `${r.idea}|${r.msgId ?? ''}|${r.ts}`;

/** Adds a cost_shadow event to the idea total. seen — keys of already counted events (shared over the whole period). */
export function addShadow(b: ShadowBucket, r: Record<string, any>, seen: Set<string>) {
  if (typeof r.idea !== 'string' || !r.idea || typeof r.wouldSkip !== 'boolean' || !fin(r.costUsd) || r.costUsd < 0) { b.unrecognized++; return; }
  const key = shadowKey(r);
  if (seen.has(key)) { b.duplicates++; return; }
  seen.add(key);
  b.events++;
  if (!b.firstTs || String(r.ts) < b.firstTs) b.firstTs = String(r.ts);
  if (r.wouldSkip) {
    b.wouldSkip++; b.usdSaved += r.costUsd;
    const v = verdictOf(r.verdict), prev = verdictOf(r.prevVerdict);
    const name = v ?? UNKNOWN_VERDICT;
    b.skippedVerdicts[name] = (b.skippedVerdicts[name] ?? 0) + 1;
    if (!v || ((v === 'act' || v === 'watch') && v !== prev)) b.missed++;
  }
  if (fin(r.charsBefore) && r.charsBefore > 0) {
    b.compactEvents++; b.charsBefore += r.charsBefore;
    if (!fin(r.charsAfter)) b.compactNoAfter++;
    else {
      b.charsAfter += r.charsAfter;
      if (fin(r.inputUsd)) b.compactUsd += r.inputUsd * (1 - r.charsAfter / r.charsBefore);
    }
  }
}

/** Sums an idea's totals over several days. */
export function mergeBuckets(a: ShadowBucket, b: ShadowBucket): ShadowBucket {
  const o = emptyShadow();
  for (const k of ['events', 'duplicates', 'unrecognized', 'wouldSkip', 'usdSaved', 'missed', 'compactEvents', 'compactNoAfter', 'charsBefore', 'charsAfter', 'compactUsd'] as const) o[k] = a[k] + b[k];
  for (const s of [a.skippedVerdicts, b.skippedVerdicts]) for (const [v, n] of Object.entries(s)) o.skippedVerdicts[v] = (o.skippedVerdicts[v] ?? 0) + n;
  o.firstTs = [a.firstTs, b.firstTs].filter((x): x is string => !!x).sort()[0];
  return o;
}

/** An idea's saving in $: skipped calls plus the compaction estimate. */
export const shadowUsd = (b: ShadowBucket) => b.usdSaved + b.compactUsd;
