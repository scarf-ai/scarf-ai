// System-prompt cache keep-alive (C-05, change 7 from an internal cost document; the owner's decision 2026-11-12 10:36 UTC "Yes, do it now").
// The brief and the role (~8.8k tokens) are cached for 1 hour separately per model. If a model idles longer than an hour,
// the next analysis pays a cache write (2× input: $0.071 for Opus) instead of a read (0.05×: $0.0018). Per the 11.11 log this
// cost $0.86 a day on Opus and $0.25 on Sonnet.
// When idle, every 55 minutes a request is sent with the same tools, system prompt and thinking settings
// and max_tokens: 0: the API reads the cache (which extends it by an hour) and answers at once without output. Cost — one read.
// The model request in real analyses does not change, so the verdicts are the same.
//  - No ping during a no-credit pause (C-04) and after KEEPALIVE_MAX_IDLE_MS without real requests (night, idle).
//  - Ping spend goes to budget accounting and the review log (onUsage), like analyses.
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Usage } from './budget.js';
import { wellFormed } from './models.js';

export const KEEPALIVE_EVERY_MS = 55 * 60_000;
export const KEEPALIVE_MAX_IDLE_MS = 6 * 3600_000;
/** Consecutive failed pings of one prefix — after this it is not kept alive (until the next real request). */
export const KEEPALIVE_MAX_FAILS = 3;
/** The cache lives 1 hour. Ping only while no more than 59 minutes have passed since the last cache refresh (1 min margin):
 *  otherwise the cache has gone cold and a ping would pay a write (40× a read). Such a prefix is dropped until the next real request. */
export const KEEPALIVE_WARM_MS = 59 * 60_000;
/** After a failed ping, retry in 2 minutes while the cache is warm (not on every one-minute check). */
export const KEEPALIVE_RETRY_MS = 2 * 60_000;

/** A cached request prefix: model, tools, system prompt with the cache marker, thinking settings and effort. */
export interface CachedPrefix { model: string; system: unknown[]; tools: unknown[]; extras: Record<string, unknown> }

/** Where the model call loop reports a cached prefix (default — nowhere: tests and tools). */
/** tookMs — how long the request took: the cache refreshes at the start of the request, timing counts from the start. */
export interface PrefixSink { seen(p: CachedPrefix, tookMs?: number): void }
let sink: PrefixSink = { seen() {} };
export const cachedPrefixes: PrefixSink = { seen: (p, tookMs) => sink.seen(p, tookMs) };
export function setCachePrefixSink(s: PrefixSink) { sink = s; }

/** The ping body: the same prefix, max_tokens 0, tool_choice auto (changing tool_choice does not reset the tools and system cache). */
export function keepAliveRequest(p: CachedPrefix) {
  return wellFormed({ model: p.model, max_tokens: 0, system: p.system, tools: p.tools, tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: '.' }], ...p.extras });
}

export interface KeepAliveDeps {
  clock: Clock;
  send: (body: ReturnType<typeof keepAliveRequest>) => Promise<{ usage: Usage }>;
  /** Ping spend: into budget accounting and the review log. */ onUsage?: (model: string, usage: Usage) => void;
  /** The model is paused without credits — no pings. */ paused?: () => boolean;
  /** Show a ping error to the pause (credits ran out — the pause turns on). */ observe?: (e: unknown) => void;
  log?: (s: string) => void;
}

// lastOk — the start of the last request that refreshed the cache (a real one or a successful ping); next — when to ping
interface Entry { p: CachedPrefix; lastReal: number; lastOk: number; next: number; fails: number }

export class CacheKeepAlive implements PrefixSink {
  private entries = new Map<string, Entry>();
  private running = false;
  constructor(private d: KeepAliveDeps) {}

  /** A real request with this prefix just went through — the cache is fresh since its start. */
  seen(p: CachedPrefix, tookMs = 0) {
    const start = this.d.clock.now() - Math.max(0, tookMs);
    const k = createHash('sha256').update(JSON.stringify([p.model, p.system, p.tools, p.extras])).digest('hex');
    this.entries.set(k, { p, lastReal: start, lastOk: start, next: start + KEEPALIVE_EVERY_MS, fails: 0 });
  }

  /** Once a minute: ping prefixes idle for 55 minutes, but not longer than KEEPALIVE_MAX_IDLE_MS. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const [k, e] of this.entries) {
        const now = this.d.clock.now();
        if (now - e.lastReal > KEEPALIVE_MAX_IDLE_MS || e.fails >= KEEPALIVE_MAX_FAILS) { this.entries.delete(k); continue; }
        // The cache has gone cold (failed ping, long pause) — a ping would be a write; wait for the next real request
        if (now - e.lastOk > KEEPALIVE_WARM_MS) { this.entries.delete(k); this.d.log?.(`cache keep-alive ${e.p.model}: cache cold, dropped`); continue; }
        if (now < e.next || this.d.paused?.()) continue;
        try {
          const r = await this.d.send(keepAliveRequest(e.p));
          e.fails = 0; e.lastOk = now; e.next = now + KEEPALIVE_EVERY_MS;
          this.d.onUsage?.(e.p.model, r.usage);
        } catch (err) {
          e.fails++; e.next = now + KEEPALIVE_RETRY_MS;
          this.d.observe?.(err);
          this.d.log?.(`cache keep-alive ${e.p.model} failed (${e.fails}/${KEEPALIVE_MAX_FAILS}): ${String((err as Error)?.message ?? err).slice(0, 160)}`);
        }
      }
    } finally { this.running = false; }
  }
}

/** Sending a ping on the server: no SDK retries, 20 s timeout. */
export function anthropicKeepAliveSender(apiKey: string): KeepAliveDeps['send'] {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 20_000 });
  return async body => { const r = await client.messages.create(body as unknown as Anthropic.MessageCreateParamsNonStreaming); return { usage: r.usage as Usage }; };
}
