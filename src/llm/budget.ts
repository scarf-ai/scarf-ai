// Daily model budget (UTC day) and cost accounting from the actual tokens in the API response.
// Order for the analyst: Opus up to its limit → Sonnet up to its own → then no more analyses
// (channels scored ≥ 7 switch to cheap Haiku extraction, the rest — log only).
// Prices are per 1M tokens, USD, per platform.claude.com/docs/en/about-claude/pricing (check date — PRICES_CHECKED).
// Cache: a 5-min write = 1.25× input; a read = 0.05× for Opus/Sonnet 5.5 and 0.1× for Haiku 5.5. Haiku > 100k tokens costs more — our requests are shorter.
import type { Clock } from '../clock.js';

/** The spend label for chat batch reviews (a separate line in llm_spend, not included in the model sum). */
export const CHAT_TAG = 'tag:chat';

/** When PRICES was last checked against platform.claude.com/docs/en/about-claude/pricing (UTC). */
export const PRICES_CHECKED = '2026-10-29';

export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number; /** A 1-hour cache write = 2× input. */ cacheWrite1h?: number }
export const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
};

export interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null }

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5']; // unknown model — priced as the most expensive one
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output
    + (u.cache_read_input_tokens ?? 0) * p.cacheRead + w5m * p.cacheWrite + w1h * (p.cacheWrite1h ?? p.input * 2)) / 1e6;
}

/** Token summary over all analysis rounds — shows where the money went (2026-10-28). */
export function usageSummary(us: Usage[]): { rounds: number; input: number; cacheWrite: number; cacheRead: number; output: number } {
  return us.reduce((a, u) => ({ rounds: a.rounds + 1, input: a.input + (u.input_tokens ?? 0), cacheWrite: a.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    cacheRead: a.cacheRead + (u.cache_read_input_tokens ?? 0), output: a.output + (u.output_tokens ?? 0) }), { rounds: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
}

export interface BudgetStore { addSpend(day: string, model: string, usd: number): void; spendOn(day: string): [string, number][] }

export interface BudgetCaps {
  /** Opus limit per UTC day (the owner, 2026-10-22: these channels get 20–30 messages a day, spend < $5). */
  opusDailyUsd: number;
  /** Sonnet limit: memecoin scan analyses (scan-feed) + a reserve after Opus. */
  sonnetDailyUsd: number;
  /** Haiku limit: memecoin scan analyses (scan-feed) and fallback extraction. */
  gateDailyUsd: number;
  analystModel: string;
  fallbackModel: string;
  gateModel: string;
}

export const DEFAULT_CAPS: BudgetCaps = {
  opusDailyUsd: 5, sonnetDailyUsd: 3, gateDailyUsd: 1,
  analystModel: 'claude-opus-5-5', fallbackModel: 'claude-sonnet-5-5', gateModel: 'claude-haiku-5-5',
};

export class LlmBudget {
  constructor(public caps: BudgetCaps, private clock: Clock, private store?: BudgetStore) {
    if (store) for (const [m, usd] of store.spendOn(clock.utcDay())) this.mem.set(`${clock.utcDay()}|${m}`, usd);
  }
  private mem = new Map<string, number>();
  spent(model: string, day = this.clock.utcDay()) { return this.mem.get(`${day}|${model}`) ?? 0; }
  record(model: string, usd: number) {
    const day = this.clock.utcDay();
    this.mem.set(`${day}|${model}`, this.spent(model, day) + usd);
    this.store?.addSpend(day, model, usd);
  }
  /** Which analyst model can be called right now (or undefined — the budget is spent). */
  pickAnalyst(preferred?: string): string | undefined {
    // A channel with a simpler model (scan-feed → Sonnet): do not escalate to Opus, so as not to spend its limit
    // The cheapest model (scans): its own limit is the shared Haiku limit
    if (preferred === this.caps.gateModel) return this.spent(this.caps.gateModel) < this.caps.gateDailyUsd ? this.caps.gateModel : undefined;
    if (preferred === this.caps.fallbackModel) return this.spent(this.caps.fallbackModel) < this.caps.sonnetDailyUsd ? this.caps.fallbackModel : undefined;
    if (this.spent(this.caps.analystModel) < this.caps.opusDailyUsd) return this.caps.analystModel;
    if (this.spent(this.caps.fallbackModel) < this.caps.sonnetDailyUsd) return this.caps.fallbackModel;
    return undefined;
  }
  gateAvailable() { return this.spent(this.caps.gateModel) < this.caps.gateDailyUsd; }
  /** The model for chat batch review: its own daily limit (label tag:chat) within the model limit. */
  pickChatReview(model: string, chatDailyUsd: number): string | undefined {
    if (this.spent(CHAT_TAG) >= chatDailyUsd) return undefined;
    return this.pickAnalyst(model);
  }
  summary(day = this.clock.utcDay()) {
    const chat = this.spent(CHAT_TAG, day);
    return [this.caps.analystModel, this.caps.fallbackModel, this.caps.gateModel].map(m => `${m.replace('claude-', '')} $${this.spent(m, day).toFixed(2)}`).join(' · ')
      + (chat ? ` (of which chat reviews $${chat.toFixed(2)})` : '');
  }
}
