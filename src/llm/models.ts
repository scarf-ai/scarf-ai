// Quirks of the 5.5 models (2026-10-27, per the log: "tool_choice: type "tool" and "any" are not supported for this model").
// Opus 5.5 and Sonnet 5.5 do not accept a forced tool call and always think (adaptive thinking):
//  - tool_choice is auto only, and what to call is said in the prompt;
//  - thinking depth is set by output_config.effort (Sonnet defaults to high — expensive), max_tokens covers thinking too;
//  - thinking blocks are returned unchanged in the next round, the history is only appended.
// Haiku 5.5 accepts a forced call (chat triage works).

/** The model always thinks and does not accept tool_choice tool/any. */
export const thinkingModel = (m: string) => /(opus|sonnet)-5-5|fable|mythos/i.test(m);

export function toolChoice(model: string, name: string): { type: 'tool'; name: string } | { type: 'auto' } {
  return thinkingModel(model) ? { type: 'auto' } : { type: 'tool', name };
}

/** Extra request params: thinking level for thinking models (medium — a balance of price and quality). */
export function modelExtras(model: string, effort: 'low' | 'medium' | 'high' = 'medium'): Record<string, unknown> {
  // display: summarized — the API returns a thinking summary (the price is the same as without it): needed for the review log
  return thinkingModel(model) ? { output_config: { effort }, thinking: { type: 'adaptive', display: 'summarized' } } : {};
}

/** max_tokens with headroom for thinking (only what the model actually wrote is billed). */
export const maxTokensFor = (model: string, base: number) => (thinkingModel(model) ? Math.max(base * 4, 8000) : base);

/**
 * Removes emoji "halves" (lone UTF-16 surrogates). They appear when text is cut by .slice() in the middle of
 * an emoji; the API answers 400 "unexpected end of hex escape" (log 2026-10-27, a ServerB batch). Applied to the whole request.
 */
export function wellFormed<T>(x: T): T {
  if (typeof x === 'string') return x.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') as T;
  if (Array.isArray(x)) return x.map(wellFormed) as T;
  if (x && typeof x === 'object' && !(x instanceof Uint8Array)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, wellFormed(v)])) as T;
  return x;
}
