// C-05 fix 7: the ping prefix (tools, brief, thinking and effort) matches the real analysis byte for byte (review #116).
import { describe, it, expect, vi } from 'vitest';

const calls: any[] = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: async (p: any) => { calls.push(JSON.parse(JSON.stringify(p))); return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'v', name: 'emit_verdict', input: { verdict: 'ignore', thesis: 't', confidence: 0.9 } }] }; } }; },
}));

import { keepAliveRequest, setCachePrefixSink, type CachedPrefix } from '../src/llm/keepalive.js';
import { anthropicAnalystRunner } from '../src/analyst/analyst.js';

describe('keep-alive ping prefix equals the real request prefix', () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    it(model, async () => {
      calls.length = 0; const seen: CachedPrefix[] = [];
      setCachePrefixSink({ seen: p => seen.push(p) });
      await anthropicAnalystRunner('k')({ model, system: 'SYSTEM brief 🔥', user: 'CASE', exec: async () => '', maxToolCalls: 2 });
      setCachePrefixSink({ seen() {} });
      const real = calls[0]; const ping = JSON.parse(JSON.stringify(keepAliveRequest(seen[0])));
      expect(JSON.stringify(ping.tools)).toBe(JSON.stringify(real.tools));
      expect(JSON.stringify(ping.system)).toBe(JSON.stringify(real.system));
      expect(ping.model).toBe(real.model);
      expect(ping.thinking).toEqual(real.thinking);
      expect(ping.output_config).toEqual(real.output_config);
      // no more than 4 cache marks in the real request (API limit)
      const marks = JSON.stringify(real).match(/cache_control/g)?.length ?? 0;
      expect(marks).toBeLessThanOrEqual(4);
    });
  }
});
