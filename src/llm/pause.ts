// Model pause without Anthropic credits (card C-04, the owner's decision 2026-11-08 15:45 UTC: "no point queueing
// messages, there will be very many of them and credits will be spent quickly without ever reaching the current messages").
//  - A "no credits" error (400 credit balance, 402 billing) or a key error (401, 403) is not a single-analysis failure but an account
//    state: the agent stops calling the model entirely (Opus, Sonnet, Haiku).
//  - Every 15 minutes — a probe with one cheapest call (Haiku, 1 token). Success — the pause is lifted.
//  - One notification on entering the pause and one on exit; the entry notification — no more than once per 6 hours.
//  - No queue: whatever arrives during the pause stays only in the review log (the caller does this via paused()).
// Network errors, timeouts, 429 and 5xx do not trigger the pause — those are ordinary single-call failures.
import Anthropic from '@anthropic-ai/sdk';
import type { Clock } from '../clock.js';
import { modelExtras, wellFormed } from './models.js';

/** The review-log mark for messages that arrived during the pause. */
export const PAUSED_SKIP = 'model paused (no API credits)';
export const PROBE_EVERY_MS = 15 * 60_000;
export const NOTIFY_EVERY_MS = 6 * 3600_000;
export const PROBE_MODEL = 'claude-haiku-5-5';

export type BlockReason = 'credits' | 'auth';

/** The HTTP status of an API error (for a wrapped one — of the original in cause, as with ToolLoopError). */
function apiStatus(e: unknown): number | undefined {
  for (let x: any = e, depth = 0; x && depth < 4; x = x.cause, depth++) if (typeof x.status === 'number') return x.status;
  return undefined;
}

/**
 * Does the error describe the account state (no credits, key rejected) rather than one call?
 * Only by an API error: HTTP status and type (for a wrapped one — of the original in cause). By text — only "credit balance is too low"
 * (it is a 400 invalid_request_error without its own type); foreign text with "permission_error" (a tool answer etc.) does not trigger the pause.
 */
export function isAccountBlocked(e: unknown): BlockReason | undefined {
  for (let x: any = e, depth = 0; x && depth < 4; x = x.cause, depth++) {
    const status = typeof x.status === 'number' ? x.status : undefined;
    const type = status === undefined ? '' : String(x.type ?? x.error?.error?.type ?? x.error?.type ?? '');
    if (/credit balance is too low/i.test(String(x.message ?? x)) || status === 402 || type === 'billing_error') return 'credits';
    if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') return 'auth';
  }
  return undefined;
}

/**
 * The probe was rejected for the request itself (4xx, not credits or key, not 408/409/429): the API considered it,
 * so the account is available — otherwise a bad probe parameter would hold the pause forever (HQ review #52, round 1).
 */
export function probeRejectedOnRequest(e: unknown): boolean {
  const st = apiStatus(e);
  return st !== undefined && st >= 400 && st < 500 && ![408, 409, 429].includes(st) && !isAccountBlocked(e);
}

/** The call was not made: the model is paused. */
export class ModelPausedError extends Error { constructor(since: string) { super(`${PAUSED_SKIP} since ${since}`); } }

export interface ModelPauseDeps {
  clock: Clock;
  /** Probe: the cheapest model call. Throws — there are still no credits (or key). */
  probe: () => Promise<void>;
  /** A notification to the owner (Telegram, same place as statuses). */
  notify: (text: string) => Promise<unknown>;
  log?: (s: string) => void;
  /** Memory across restarts (store.kvGet/kvSet): "no more than once per 6 hours" and the promised exit notification. */
  remember?: { get(k: string): string | undefined; set(k: string, v: string): void };
}

/** Memory key: the time of the last entry notification and whether it happened (exit not reported yet). */
export const NOTICE_KEY = 'model_pause_notice';

const REASON_TEXT: Record<BlockReason, string> = { credits: 'no API credits', auth: 'API key rejected' };

export class ModelPause {
  private since?: number;
  private reason?: BlockReason;
  private lastProbe = 0;
  private probing?: Promise<boolean>;
  private lastEnterNotice = -Infinity;
  /** The entry notification was sent, the exit one not yet. Then we report the exit even if there was a restart in between. */
  private noticed = false;

  constructor(private d: ModelPauseDeps) {
    try {
      const v = JSON.parse(d.remember?.get(NOTICE_KEY) ?? 'null');
      if (typeof v?.at === 'number') { this.lastEnterNotice = v.at; this.noticed = v.open === true; }
    } catch { /* missing or corrupt — as if there were no memory */ }
  }

  private saveNotice() {
    try { this.d.remember?.set(NOTICE_KEY, JSON.stringify({ at: this.lastEnterNotice, open: this.noticed })); }
    catch (e) { this.d.log?.(`model pause: notice state not saved: ${String(e)}`); }
  }

  paused(): boolean { return this.since !== undefined; }

  /** A line for the log and /status: "model: paused (no API credits since …)" or "model: ok". */
  status(): string {
    return this.since === undefined ? 'model: ok' : `model: paused (${REASON_TEXT[this.reason!]} since ${new Date(this.since).toISOString()})`;
  }

  /** Inspect a model call error: if it is credits or the key — turn the pause on. true — the pause is on. */
  observe(e: unknown): boolean {
    const r = isAccountBlocked(e);
    if (!r) return false;
    if (this.since === undefined) this.enter(r, String((e as Error)?.message ?? e));
    return true;
  }

  /**
   * Whether the model may be called now. During a pause — a probe every PROBE_EVERY_MS; on success the pause is lifted and the answer is true.
   * Concurrent calls wait for the same probe.
   */
  async ready(): Promise<boolean> {
    if (this.since === undefined) return true;
    if (this.probing) return this.probing;
    if (this.d.clock.now() - this.lastProbe < PROBE_EVERY_MS) return false;
    this.lastProbe = this.d.clock.now();
    this.probing = this.d.probe().then(() => { this.leave(); return true; }, e => {
      const msg = String((e as Error)?.message ?? e).slice(0, 160);
      if (probeRejectedOnRequest(e)) {
        // The API disliked the probe request, but not because of credits or the key — the account is available. Lift the pause: if there are
        // no credits after all, the first real call will bring the pause back (without a repeat notification within 6 hours)
        this.d.log?.(`${this.status()} — probe rejected on request, account is reachable: ${msg}`);
        this.leave();
        return true;
      }
      // Still no credits (key), or network, 429, 5xx — stay paused until the next probe
      this.d.log?.(`${this.status()} — probe failed: ${msg}`);
      return false;
    }).finally(() => { this.probing = undefined; });
    return this.probing;
  }

  /** Model call wrapper: during a pause — ModelPausedError without a call; a credits/key error turns the pause on. */
  guard<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return async (...a: A) => {
      if (!(await this.ready())) throw new ModelPausedError(new Date(this.since!).toISOString());
      let r: R;
      try { r = await fn(...a); } catch (e) { this.observe(e); throw e; }
      // Before the restart we reported "paused", and after it there are credits and no pause — report the exit
      if (this.noticed && this.since === undefined) this.closeNotice('▶️ The model is working again (after an agent restart). Analysing only new messages.');
      return r;
    };
  }

  private enter(reason: BlockReason, detail: string) {
    const now = this.d.clock.now();
    this.since = now; this.reason = reason; this.lastProbe = now;
    this.d.log?.(`${this.status()} — ${detail.slice(0, 200)}`);
    // Already reported the entry and not yet the exit (a pause before the restart) — do not send again, but the exit will be reported
    if (this.noticed) return;
    this.noticed = now - this.lastEnterNotice >= NOTIFY_EVERY_MS;
    if (this.noticed) {
      this.lastEnterNotice = now;
      this.saveNotice();
      const what = reason === 'credits' ? 'Anthropic API credits ran out' : 'Anthropic API key rejected (401/403)';
      void this.send(`⏸ Model paused: ${what}. No analyses, messages go only to the log — after a top-up the agent analyses only new ones and does not look at what was missed. Check — every ${PROBE_EVERY_MS / 60_000} minutes.`);
    }
  }

  private leave() {
    const since = this.since!;
    const was = this.status();
    this.since = undefined; this.reason = undefined;
    const mins = Math.round((this.d.clock.now() - since) / 60_000);
    this.d.log?.(`model: ok — pause lifted after ${mins} min (${was})`);
    if (this.noticed) this.closeNotice(`▶️ The model is working again (pause ${mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`}). Analysing only new messages.`);
  }

  private closeNotice(text: string) {
    this.noticed = false;
    this.saveNotice();
    void this.send(text);
  }

  private async send(t: string) { try { await this.d.notify(t); } catch (e) { this.d.log?.(`model pause notice failed: ${String(e)}`); } }
}

/** The probe request: built like the real Haiku calls (chatGate, extract) — wellFormed and modelExtras, 1 output token. */
export const probeRequest = (model = PROBE_MODEL) => wellFormed({ model, max_tokens: 1, messages: [{ role: 'user' as const, content: '.' }], ...modelExtras(model) });

/** The probe on the server: no SDK retries, 20 s timeout. Passes the API error through as is. Cost — under $0.00001. */
export function anthropicProbe(apiKey: string, model = PROBE_MODEL): () => Promise<void> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 20_000 });
  return async () => { await client.messages.create(probeRequest(model) as Anthropic.MessageCreateParamsNonStreaming); };
}
