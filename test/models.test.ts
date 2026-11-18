import { describe, it, expect, vi } from 'vitest';

const calls: any[] = [];
let script: ((p: any) => any)[] = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: async (p: any) => { calls.push(JSON.parse(JSON.stringify(p))); return script.shift()!(p); } }; },
}));

import { toolChoice, modelExtras, maxTokensFor } from '../src/llm/models.js';
import { anthropicAnalystRunner } from '../src/analyst/analyst.js';

const usage = { input_tokens: 100, output_tokens: 50 };
describe('5.5 models: no forced tool use (journal 2026-10-24: 400 tool_choice not supported)', () => {
  it('Opus/Sonnet 5.5 get auto + effort; Haiku keeps forced tool', () => {
    expect(toolChoice('claude-opus-5-5', 'x')).toEqual({ type: 'auto' });
    expect(toolChoice('claude-sonnet-5-5', 'x')).toEqual({ type: 'auto' });
    expect(toolChoice('claude-haiku-5-5', 'x')).toEqual({ type: 'tool', name: 'x' });
    expect(modelExtras('claude-sonnet-5-5')).toEqual({ output_config: { effort: 'medium' }, thinking: { type: 'adaptive', display: 'summarized' } });
    expect(modelExtras('claude-haiku-5-5')).toEqual({});
    expect(maxTokensFor('claude-opus-5-5', 2000)).toBe(8000);
  });
  it('analyst on Sonnet 5.5: never forces the tool; after the budget asks for the verdict in a message; keeps thinking blocks', async () => {
    calls.length = 0;
    script = [
      () => ({ usage, content: [{ type: 'thinking', thinking: '', signature: 's1' }, { type: 'tool_use', id: 't1', name: 'get_market', input: { address: 'a' } }] }),
      () => ({ usage, content: [{ type: 'tool_use', id: 't2', name: 'x_search', input: { query: 'q' } }] }),
      () => ({ usage, content: [{ type: 'tool_use', id: 't3', name: 'emit_verdict', input: { verdict: 'watch', thesis: 't', confidence: 0.7 } }] }),
    ];
    const run = anthropicAnalystRunner('k');
    const exec = vi.fn(async () => 'data');
    const r = await run({ model: 'claude-sonnet-5-5', system: 's', user: 'u', exec, maxToolCalls: 1 });
    expect(r.verdict).toEqual({ verdict: 'watch', thesis: 't', confidence: 0.7 });
    expect(calls.every(c => c.tool_choice.type === 'auto')).toBe(true);
    expect(calls[0].output_config).toEqual({ effort: 'medium' });
    expect(exec).toHaveBeenCalledTimes(1); // the second tool over the budget is not executed
    const second = calls[1].messages;
    expect(second[1].content[0]).toEqual({ type: 'thinking', thinking: '', signature: 's1' });
    expect(JSON.stringify(second[2].content)).toContain('Call emit_verdict now');
    expect(JSON.stringify(calls[2].messages.at(-1).content)).toContain('tool budget exhausted');
  });
});

import { wellFormed } from '../src/llm/models.js';
describe('half-emoji from .slice() (journal 2026-10-27: 400 unexpected end of hex escape)', () => {
  it('removes lone surrogates everywhere in the request, keeps whole emoji', () => {
    const cut = 'gm 🔥🔥'.slice(0, 4); // 'gm ' + half an emoji
    const req = wellFormed({ system: [{ type: 'text', text: cut }], messages: [{ role: 'user', content: `ok 🚀 ${cut}` }], max_tokens: 5 });
    expect(req.system[0].text).toBe('gm ');
    expect(req.messages[0].content).toBe('ok 🚀 gm ');
    expect(req.max_tokens).toBe(5);
    expect(JSON.stringify(req)).not.toMatch(/\\ud83d/i);
  });
  it('analyst request goes out well-formed', async () => {
    calls.length = 0;
    script = [() => ({ usage, content: [{ type: 'tool_use', id: 't', name: 'emit_verdict', input: { verdict: 'ignore', thesis: 'x', confidence: 1 } }] })];
    await anthropicAnalystRunner('k')({ model: 'claude-opus-5-5', system: 's', user: 'msg 🔥🔥'.slice(0, 5), exec: async () => '', maxToolCalls: 2 });
    expect(calls[0].messages[0].content[0].text).toBe('msg ');
  });
});

import { costUsd, usageSummary } from '../src/llm/budget.js';
describe('cost (2026-10-28, C-05 2026-11-12): 1-hour system cache; case cached from round 1 on Opus only', () => {
  it('prices 1h cache writes at 2× input and splits by TTL', () => {
    expect(costUsd('claude-opus-5-5', { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_1h_input_tokens: 3000, ephemeral_5m_input_tokens: 0 } }))
      .toBeCloseTo((1000 * 4 + 1000 * 20 + 3000 * 8) / 1e6, 8);
    expect(costUsd('claude-opus-5-5', { cache_creation_input_tokens: 1000 })).toBeCloseTo(5 / 1000, 8);
    expect(usageSummary([{ input_tokens: 5, output_tokens: 7 }, { cache_read_input_tokens: 9, output_tokens: 1 }])).toEqual({ rounds: 2, input: 5, cacheWrite: 0, cacheRead: 9, output: 8 });
  });
  // C-05, fix 8 (the owner's decision 2026-11-12): for Opus the analysis text is cached from round 1 — round 2 reads it at 0.05×.
  // For Sonnet and Haiku the analysis is usually one round — as before, the label from round 2.
  for (const [model, round1] of [['claude-opus-5-5', { type: 'ephemeral' }], ['claude-sonnet-5-5', undefined]] as const) {
    it(`${model}: system cached for 1 h; case text ${round1 ? 'cached' : 'uncached'} in round 1; round 2+: cache mark moves to the last message`, async () => {
      calls.length = 0;
      script = [
        () => ({ usage, content: [{ type: 'tool_use', id: 't1', name: 'get_market', input: { address: 'a' } }] }),
        () => ({ usage, content: [{ type: 'tool_use', id: 't2', name: 'emit_verdict', input: { verdict: 'ignore', thesis: 't', confidence: 0.9 } }] }),
      ];
      await anthropicAnalystRunner('k')({ model, system: 's', user: 'case', exec: async () => 'd', maxToolCalls: 2 });
      expect(calls[0].system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      expect(calls[0].messages[0].content[0].cache_control).toEqual(round1);
      const m2 = calls[1].messages;
      expect(m2[0].content[0].cache_control).toBeUndefined();
      expect(m2[m2.length - 1].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    });
  }
});

import { systemPrompt } from '../src/analyst/analyst.js';
import { triageSystem } from '../src/gate/chatGate.js';
describe('BSC is tradable (2026-10-28: Sonnet said "BSC, which we can\'t trade")', () => {
  it('analyst and triage prompts list BNB Chain and call old "BSC unsupported" theses outdated', () => {
    const sp = systemPrompt('brief');
    expect(sp).toMatch(/TRADABLE CHAINS[^\n]*BNB Chain \(BSC\)/);
    expect(sp).toMatch(/BSC is unsupported: that is outdated/);
    expect(triageSystem('brief')).toMatch(/BNB Chain \(BSC\)/);
  });
});
