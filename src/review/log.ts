// A log for reviewing the agent's work (the owner 2026-10-28: "keep logs of all your actions and reasoning so I
// can send them to you for review"). Written to server/data/review/<UTC-day>.jsonl, one JSON line per event:
//  - message   — every message from intake and what happened to it (skip and reason, analysis, decisions);
//  - analysis  — the whole model analysis: what the model saw (the analysis text), its reasoning (API summary),
//                tool calls with answers, the verdict, tokens and price;
//  - triage / hard_check — Haiku chat batch triage and code cuts;
//  - telegram  — everything the agent sent to the owner (trades, shadow checks, posts, errors);
//  - log       — service log lines.
// Kept for 30 days. Export for review — npm run review -- <day>.
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface ReviewSink { write(kind: string, data: Record<string, unknown>): void }

const MAX_STR = 16_000;
/** Long strings are trimmed so a single record does not bloat the file. */
function clip(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…[+${v.length - MAX_STR}]` : v;
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return depth > 6 ? '[…]' : v.slice(0, 200).map(x => clip(x, depth + 1));
  if (v && typeof v === 'object') { if (depth > 6) return '{…}'; const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = clip(x, depth + 1); return o; }
  return v;
}

export class ReviewLog implements ReviewSink {
  private lastPurgeDay = '';
  constructor(private dir: string, private now: () => number, private retainDays = 30) { mkdirSync(dir, { recursive: true }); }
  write(kind: string, data: Record<string, unknown>) {
    try {
      const iso = new Date(this.now()).toISOString();
      const day = iso.slice(0, 10);
      appendFileSync(join(this.dir, `${day}.jsonl`), `${JSON.stringify({ ts: iso, kind, ...(clip(data) as object) })}\n`);
      if (day !== this.lastPurgeDay) { this.lastPurgeDay = day; this.purge(); }
    } catch (e) { console.error('review log', e); } // the review log never crashes the agent
  }
  private purge() {
    const cutoff = new Date(this.now() - this.retainDays * 86400_000).toISOString().slice(0, 10);
    for (const f of readdirSync(this.dir)) { const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/); if (m && m[1] < cutoff) try { unlinkSync(join(this.dir, f)); } catch { /* ignore */ } }
  }
}

/** The shared log (default — nowhere: tests and tools). */
let sink: ReviewSink = { write() {} };
export const review: ReviewSink = { write: (k, d) => sink.write(k, d) };
export function setReviewSink(s: ReviewSink) { sink = s; }
