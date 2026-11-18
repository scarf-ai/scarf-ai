// Mechanics of a model call with tools (A-04, moved out of src/analyst/analyst.ts 2026-10-29 without changing the request):
// the round loop, round and call budget, cache markers, collecting usage and the trace, errors with tokens already spent.
// WHAT the model sees (role, tools, final tool, hint texts, answer wrapper) — belongs to the caller (Analyst).
// HOW MUCH it costs (rounds, cache, max_tokens, effort, answer trimming) — here (Cost).
import Anthropic from '@anthropic-ai/sdk';
import { toolChoice, modelExtras, maxTokensFor, wellFormed } from './models.js';
import { cachedPrefixes } from './keepalive.js';
import type { Usage } from './budget.js';

export type ToolExec = (name: string, input: any) => Promise<string>;
/** The analysis course for the review log: thinking (API summary), text, tool calls with answers. */
export interface TraceRound { thinking?: string[]; text?: string[]; tools?: { name: string; input: unknown; output?: string }[]; stop?: string }
/** A call error carrying the tokens already spent — so spend is counted on failure too. */
export class ToolLoopError extends Error {
  /** cause — the original API error (the no-credit pause needs status and type, src/llm/pause.ts). */
  constructor(msg: string, public usage: Usage[], public trace: TraceRound[] = [], cause?: unknown) { super(msg, cause === undefined ? undefined : { cause }); }
}

/** Texts the model sees from the loop. Written by whoever owns the prompt. */
export interface ToolLoopTexts {
  /** The model answered without tools. */
  nudge: string;
  /** The answer instead of a tool call beyond the budget. */
  budgetExhausted: string;
  /** Appended to tool answers when the budget is spent. */
  budgetUsedUp: string;
  /** A tool answer (already trimmed) → text for the model: the untrusted-data wrapper. */
  wrapResult: (out: string) => string;
  /** The error message if the final tool was never called. */
  noFinal: string;
}

export interface ToolLoopArgs {
  model: string; system: string; user: string;
  tools: Anthropic.Tool[];
  /** The final tool name: calling it ends the loop, input is the result. */
  finalTool: string;
  exec: ToolExec;
  maxToolCalls: number;
  texts: ToolLoopTexts;
  /**
   * No more rounds than this (1…MAX_ROUNDS); the last round is "call the final tool". Unset — MAX_ROUNDS, as before.
   * A narrow HQ change per the owner's decision 2026-11-16 (review #150, O1): a site-session call is limited to 2 rounds — its cost is known before the call.
   */
  maxRounds?: number;
  /** Thinking depth for thinking models (output_config.effort). Unset — the default level (medium), as before. */
  effort?: 'low' | 'medium' | 'high';
  /**
   * max_tokens of each round (≥ 1). Unset — maxTokensFor(model, MAX_TOKENS_BASE), as before. Thinking models think
   * adaptively (thinking: adaptive, no budget_tokens): max_tokens covers both thinking and the answer — there is no separate thinking budget
   * that must be below max_tokens in the request. Too few tokens — the model may not get to call the tool: that is "no final", not a format failure.
   */
  maxTokens?: number;
}
export interface ToolLoopResult { final: unknown; usage: Usage[]; toolCalls: string[]; trace: TraceRound[] }
export type ToolLoop = (a: ToolLoopArgs) => Promise<ToolLoopResult>;

const MAX_ROUNDS = 8;
/** Models whose analysis text is cached from the first round (C-05, change 8). */
export const cacheCaseFromFirstRound = (model: string) => /opus/i.test(model);
/** From this round (zero-based) — the last chance: tools are not executed, the final tool is requested/forced. */
const LAST_ROUND = 5;
export const MAX_TOKENS_BASE = 2000;
/** Trims a tool answer for the model and for the log trace. */
const RESULT_CHARS = 6000;
const TRACE_CHARS = 3000;

export function anthropicToolLoop(apiKey: string): ToolLoop {
  const client = new Anthropic({ apiKey });
  return async ({ model, system, user, tools, finalTool, exec, maxToolCalls, texts, maxRounds, effort, maxTokens }) => {
    const maxTok = maxTokens !== undefined && Number.isFinite(maxTokens) ? Math.max(1, Math.floor(maxTokens)) : maxTokensFor(model, MAX_TOKENS_BASE);
    const rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.floor(maxRounds ?? MAX_ROUNDS)));
    const lastRound = Math.min(LAST_ROUND, rounds - 1);
    const extras = modelExtras(model, effort);
    const usage: Usage[] = []; const toolCalls: string[] = []; const trace: TraceRound[] = [];
    // The analysis is cached: every next tool round reads it from the cache (0.05× of the input price) instead of the full price.
    // The cache marker is on the last message. For Opus — from the first round (C-05, change 8): per the 11.11 log almost half of its
    // analyses take 2+ rounds, and the dossier was paid twice — as input in round 1 and as a cache write in round 2. A 1.25× write +
    // a 0.05× read is cheaper than 1× + 1.25× (11.11: −$0.17 a day). Sonnet and Haiku usually analyse in one round — a cache from round 1
    // would only be an extra write, so their marker starts from the second round, as before.
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: user }] }];
    const markLast = () => {
      for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content as any[]) delete b.cache_control;
      const last = messages[messages.length - 1];
      const blocks = Array.isArray(last.content) ? last.content as any[] : (last.content = [{ type: 'text', text: String(last.content) }] as any);
      if (blocks.length) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
    };
    if (cacheCaseFromFirstRound(model)) markLast();
    const system_ = [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral', ttl: '1h' } as any }];
    try {
    for (let round = 0; round < rounds; round++) {
      const last = round >= lastRound || toolCalls.length >= maxToolCalls;
      // Opus/Sonnet 5.5 do not accept a forced call: tool_choice auto, and in the last round — a direct request in the message
      const t0 = Date.now();
      const res = await client.messages.create(wellFormed({
        model, max_tokens: maxTok,
        // The brief and the role are shared by all analyses: a 1-hour cache (analyses are rarer than every 5 minutes — a 5-minute cache was rewritten every time)
        system: system_,
        tools, tool_choice: last ? toolChoice(model, finalTool) : { type: 'auto' },
        messages, ...extras,
      }) as Anthropic.MessageCreateParamsNonStreaming);
      usage.push(res.usage as Usage);
      // The tools and brief cache is fresh — the cache keep-alive (C-05, change 7) counts idle time from the start of this request
      cachedPrefixes.seen({ model, system: system_, tools, extras }, Date.now() - t0);
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const tr: TraceRound = { stop: (res as any).stop_reason,
        thinking: (res.content as any[]).filter(b => b.type === 'thinking' && b.thinking).map(b => String(b.thinking)),
        text: (res.content as any[]).filter(b => b.type === 'text' && b.text).map(b => String(b.text)),
        tools: uses.map(u => ({ name: u.name, input: u.input })) };
      trace.push(tr);
      const v = uses.find(u => u.name === finalTool);
      if (v) return { final: v.input, usage, toolCalls, trace };
      // The model answer (with thinking blocks) is returned as is: the history is only appended
      messages.push({ role: 'assistant', content: res.content });
      if (!uses.length) { messages.push({ role: 'user', content: [{ type: 'text', text: texts.nudge }] }); markLast(); continue; }
      const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
      for (const u of uses) {
        toolCalls.push(u.name);
        const out = last || toolCalls.length > maxToolCalls ? texts.budgetExhausted : await exec(u.name, u.input).catch(e => `error: ${String(e).slice(0, 200)}`);
        const t = tr.tools?.find(x => x.name === u.name && x.input === u.input); if (t) t.output = out.slice(0, TRACE_CHARS);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: texts.wrapResult(out.slice(0, RESULT_CHARS)) });
      }
      if (toolCalls.length >= maxToolCalls) results.push({ type: 'text', text: texts.budgetUsedUp });
      messages.push({ role: 'user', content: results });
      markLast();
    }
    } catch (e) { throw new ToolLoopError(String((e as Error).message ?? e), usage, trace, e); }
    throw new ToolLoopError(texts.noFinal, usage, trace);
  };
}
