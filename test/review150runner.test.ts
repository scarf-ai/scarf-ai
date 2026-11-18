// Review #150 (O1), a narrow HQ fix in src/llm/runner.ts (the owner's decision 2026-11-16): optional maxRounds and effort.
// Without the fields — the requests are the same as before (8 rounds, default effort); the references of the other calls — test/llm-runner.test.ts.
import { describe, it, expect, vi } from 'vitest';

const calls: any[] = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: async (p: any) => { calls.push(JSON.parse(JSON.stringify(p))); return { usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn', content: [{ type: 'text', text: 'no tool' }] }; } }; },
}));

import { anthropicToolLoop, ToolLoopError, type ToolLoopArgs } from '../src/llm/runner.js';

const args = (model: string, o: Partial<ToolLoopArgs> = {}): ToolLoopArgs => ({
  model, system: 'S', user: 'U', tools: [{ name: 'choose_action', description: 'd', input_schema: { type: 'object', properties: {} } }], finalTool: 'choose_action',
  exec: async () => 'x', maxToolCalls: 0, texts: { nudge: 'call it', budgetExhausted: 'b', budgetUsedUp: 'u', wrapResult: (t) => t, noFinal: 'no final' }, ...o,
});
async function run(a: ToolLoopArgs) {
  calls.length = 0;
  const e = await anthropicToolLoop('k')(a).catch(err => err);
  return { e, calls: [...calls] };
}

describe('runner: maxRounds and effort', () => {
  it('without the fields — as before: 8 rounds (the model did not call the tool), default effort medium', async () => {
    const r = await run(args('claude-sonnet-5-5'));
    expect(r.e).toBeInstanceOf(ToolLoopError); expect((r.e as ToolLoopError).usage).toHaveLength(8);
    expect(r.calls).toHaveLength(8);
    expect(r.calls.every(c => c.output_config?.effort === 'medium')).toBe(true);
    // the last chance — from round 6 (LAST_ROUND = 5), as before
    expect(r.calls.map(c => c.messages.at(-1).content.at(-1).text === 'call it')).toEqual([false, true, true, true, true, true, true, true]);
  });

  it('maxRounds: 2 — no more than two requests; effort: low — for a thinking model; Haiku has no effort field at all', async () => {
    const s = await run(args('claude-sonnet-5-5', { maxRounds: 2, effort: 'low' }));
    expect(s.calls).toHaveLength(2); expect((s.e as ToolLoopError).message).toBe('no final');
    expect(s.calls.map(c => c.output_config?.effort)).toEqual(['low', 'low']);
    const h = await run(args('claude-haiku-5-5', { maxRounds: 2, effort: 'low' }));
    expect(h.calls).toHaveLength(2); expect(h.calls.every(c => c.output_config === undefined)).toBe(true);
    // Haiku with maxToolCalls 0 — a forced call of the final tool from round 1 (as before)
    expect(h.calls.map(c => c.tool_choice)).toEqual([{ type: 'tool', name: 'choose_action' }, { type: 'tool', name: 'choose_action' }]);
    // Sonnet with tools (maxToolCalls > 0): the last round with maxRounds 2 is the second, it has the "call it" request (nudge), not auto-first
    const t = await run(args('claude-sonnet-5-5', { maxRounds: 2, maxToolCalls: 3 }));
    expect(t.calls).toHaveLength(2);
  });

  it('maxTokens: set — max_tokens = it; without it — as before (8000 for Sonnet, 2000 for Haiku); the thinking shape does not change', async () => {
    const s = await run(args('claude-sonnet-5-5', { maxRounds: 1, maxTokens: 1500, effort: 'low' }));
    expect(s.calls.map(c => c.max_tokens)).toEqual([1500]);
    expect(s.calls[0].thinking).toEqual({ type: 'adaptive', display: 'summarized' }); // no budget_tokens: no "budget < max_tokens" constraint
    expect(s.calls[0].output_config).toEqual({ effort: 'low' });
    expect((await run(args('claude-haiku-5-5', { maxRounds: 2, maxTokens: 1000 }))).calls.map(c => c.max_tokens)).toEqual([1000, 1000]);
    expect((await run(args('claude-sonnet-5-5', { maxRounds: 1 }))).calls[0].max_tokens).toBe(8000);
    expect((await run(args('claude-haiku-5-5', { maxRounds: 1 }))).calls[0].max_tokens).toBe(2000);
    expect((await run(args('claude-haiku-5-5', { maxRounds: 1, maxTokens: 0 }))).calls[0].max_tokens).toBe(1);
  });

  it('maxRounds out of bounds: 0 → 1 round; 99 → no more than 8', async () => {
    expect((await run(args('claude-haiku-5-5', { maxRounds: 0 }))).calls).toHaveLength(1);
    expect((await run(args('claude-haiku-5-5', { maxRounds: 99 }))).calls).toHaveLength(8);
  });
});
