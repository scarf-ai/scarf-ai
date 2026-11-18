// C-05: system-prompt cache keep-alive (fix 7) and caching the Opus analysis text from round 1 (fix 8).
// The owner's decision 2026-11-12 10:36 UTC: "Yes, do it now".
import { describe, it, expect, vi } from 'vitest';

const calls: any[] = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: async (p: any) => { calls.push(JSON.parse(JSON.stringify(p))); return { usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'v', name: 'emit_verdict', input: { verdict: 'ignore', thesis: 't', confidence: 0.9 } }] }; } }; },
}));

import { VirtualClock } from '../src/clock.js';
import { CacheKeepAlive, keepAliveRequest, setCachePrefixSink, KEEPALIVE_EVERY_MS, KEEPALIVE_MAX_IDLE_MS, type CachedPrefix } from '../src/llm/keepalive.js';
import { anthropicToolLoop, cacheCaseFromFirstRound } from '../src/llm/runner.js';
import { modelExtras } from '../src/llm/models.js';
import { ModelPause } from '../src/llm/pause.js';

const MIN = 60_000;
const prefix = (model = 'claude-opus-5-5'): CachedPrefix => ({ model, system: [{ type: 'text', text: 'BRIEF', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [{ name: 'emit_verdict', input_schema: { type: 'object' } }], extras: modelExtras(model) });
const mk = (opts: { paused?: () => boolean; fail?: () => unknown } = {}) => {
  const clock = new VirtualClock(Date.parse('2026-11-12T00:00:00Z'));
  const sent: any[] = []; const used: [string, unknown][] = []; const logs: string[] = []; const observed: unknown[] = [];
  const ka = new CacheKeepAlive({ clock, paused: opts.paused, log: l => logs.push(l), observe: e => observed.push(e), onUsage: (m, u) => used.push([m, u]),
    send: async body => { sent.push(body); if (opts.fail) throw opts.fail(); return { usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 8813 } }; } });
  const run = async (minutes: number) => { for (let i = 0; i < minutes; i++) { clock.advance(MIN); await ka.tick(); } };
  return { clock, ka, sent, used, logs, observed, run };
};

describe('C-05 fix 7: system-prompt cache keep-alive', () => {
  it('the ping is the same prefix (tools, brief with a 1 h mark, thinking and effort), max_tokens 0, tool_choice auto', () => {
    const b = keepAliveRequest(prefix());
    expect(b).toEqual({ model: 'claude-opus-5-5', max_tokens: 0, system: prefix().system, tools: prefix().tools, tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: '.' }], output_config: { effort: 'medium' }, thinking: { type: 'adaptive', display: 'summarized' } });
  });

  it('idle: first ping after 55 min, then every 55 min; spend goes to onUsage; after 6 h without real requests — silence', async () => {
    const t = mk();
    t.ka.seen(prefix());
    await t.run(54);
    expect(t.sent).toHaveLength(0);
    await t.run(1);
    expect(t.sent).toHaveLength(1);
    expect(t.used).toEqual([['claude-opus-5-5', { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 8813 }]]);
    await t.run(6 * 60);
    expect(t.sent).toHaveLength(Math.floor(KEEPALIVE_MAX_IDLE_MS / KEEPALIVE_EVERY_MS)); // 6 pings in 6 h, no more after that
    await t.run(120);
    expect(t.sent).toHaveLength(6);
  });

  it('a real request resets the countdown; each model has its own prefix', async () => {
    const t = mk();
    t.ka.seen(prefix()); t.ka.seen(prefix('claude-sonnet-5-5'));
    await t.run(50);
    t.ka.seen(prefix()); // an Opus analysis — the Opus cache is fresh
    await t.run(10); // minute 60: Sonnet idle for 55 min — ping; Opus — 10 min
    expect(t.sent.map(b => b.model)).toEqual(['claude-sonnet-5-5']);
    await t.run(45); // minute 105: Opus idle for 55 min — ping; Sonnet — 50 min after its ping
    expect(t.sent.map(b => b.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('no pings during a no-credits pause; a ping error goes to the pause; after 3 failures in a row the prefix is not kept alive', async () => {
    let paused = true;
    const p = mk({ paused: () => paused });
    p.ka.seen(prefix());
    await p.run(50);
    expect(p.sent).toHaveLength(0);
    paused = false; await p.run(5); // pause lifted, cache warm — scheduled ping at minute 55
    expect(p.sent).toHaveLength(1);

    // Anthropic is mocked in this file — an API error as the SDK returns it: status and response text
    const credit = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
    const f = mk({ fail: () => credit });
    f.ka.seen(prefix());
    await f.run(5 * 55);
    expect(f.sent).toHaveLength(3);
    expect(f.observed).toHaveLength(3);
    expect(f.logs[2]).toMatch(/failed \(3\/3\)/);
    // with the C-04 pause: a credits error turns the pause on
    const pause = new ModelPause({ clock: f.clock, probe: async () => {}, notify: async () => {} });
    pause.observe(f.observed[0]);
    expect(pause.paused()).toBe(true);
  });
});

describe('C-05 fix 7: ping only into a warm cache (review note #116)', () => {
  const err = () => Object.assign(new Error('529 overloaded'), { status: 529 });
  // fail(n) — whether the n-th ping fails; sentAt() — send minutes from the start
  const mkT = (fail: (n: number) => boolean, paused?: () => boolean) => {
    const clock = new VirtualClock(Date.parse('2026-11-12T00:00:00Z')); const t0 = clock.now();
    const at: number[] = []; const logs: string[] = []; let n = 0;
    const ka = new CacheKeepAlive({ clock, paused, log: l => logs.push(l),
      send: async () => { at.push(clock.now() - t0); if (fail(n++)) throw err(); return { usage: {} }; } });
    const run = async (minutes: number) => { for (let i = 0; i < minutes; i++) { clock.advance(MIN); await ka.tick(); } };
    return { clock, ka, logs, run, sentAt: () => at.map(x => x / MIN) };
  };

  it('failed ping at 55 min is retried after 2 min while the cache is warm, then the normal schedule resumes', async () => {
    const t = mkT(n => n === 0);
    t.ka.seen(prefix());
    await t.run(4 * 60);
    expect(t.sentAt()).toEqual([55, 57, 112, 167, 222]);
  });

  it('all retries fail: dropped after 3 fails, no ping on a cold cache at 110 min', async () => {
    const t = mkT(() => true);
    t.ka.seen(prefix());
    await t.run(4 * 60);
    expect(t.sentAt()).toEqual([55, 57, 59]);
    expect(t.logs.some(l => /failed \(3\/3\)/.test(l))).toBe(true);
  });

  it('cache goes cold between retries: no ping after 59 min since the last refresh, entry dropped', async () => {
    const t = mkT(n => n < 2);
    t.ka.seen(prefix());
    t.clock.advance(55 * MIN + 30_000); await t.ka.tick(); // ping at 55:30 — failure
    t.clock.advance(2 * MIN); await t.ka.tick(); // 57:30 — failure
    t.clock.advance(2 * MIN); await t.ka.tick(); // 59:30 — the cache went cold, no ping
    await t.run(120);
    expect(t.sentAt()).toEqual([55.5, 57.5]);
    expect(t.logs.some(l => /cache cold, dropped/.test(l))).toBe(true);
  });

  it('pause from 50 to 121 min: no ping when it lifts on a cold cache, entry dropped', async () => {
    let paused = false;
    const t = mkT(() => false, () => paused);
    t.ka.seen(prefix());
    await t.run(50); paused = true;
    await t.run(70); paused = false;
    await t.run(1);
    await t.run(6 * 60);
    expect(t.sentAt()).toEqual([]);
  });

  it('a failed ping is not retried on every 60 s tick', async () => {
    const t = mkT(() => true);
    t.ka.seen(prefix());
    await t.run(56);
    expect(t.sentAt()).toEqual([55]);
    await t.run(1);
    expect(t.sentAt()).toEqual([55, 57]);
  });

  it('real request: idle is measured from the request start, not its end', async () => {
    const t = mkT(() => false);
    t.clock.advance(3 * MIN);
    t.ka.seen(prefix(), 3 * MIN); // the request took 3 minutes: the cache was refreshed at t0
    await t.run(52);
    expect(t.sentAt()).toEqual([55]);
  });

  it('overlapping ticks while a ping is in flight send only one ping', async () => {
    const t = mk(); let release!: () => void; let sends = 0;
    const ka = new CacheKeepAlive({ clock: t.clock, send: () => { sends++; return new Promise(r => { release = () => r({ usage: {} }); }); } });
    ka.seen(prefix());
    t.clock.advance(55 * MIN);
    const a = ka.tick();
    t.clock.advance(MIN); const b = ka.tick();
    t.clock.advance(MIN); const c = ka.tick();
    release(); await Promise.all([a, b, c]);
    expect(sends).toBe(1);
  });
});

describe('C-05 fix 8 and the link to cache keep-alive in the model call loop', () => {
  it('Opus: a cache mark on the analysis text from round 1; Sonnet and Haiku — no; the loop reports the prefix to the cache keep-alive', async () => {
    expect([cacheCaseFromFirstRound('claude-opus-5-5'), cacheCaseFromFirstRound('claude-sonnet-5-5'), cacheCaseFromFirstRound('claude-haiku-5-5')]).toEqual([true, false, false]);
    const seen: CachedPrefix[] = [];
    setCachePrefixSink({ seen: p => seen.push(p) });
    const texts = { nudge: 'n', budgetExhausted: 'b', budgetUsedUp: 'u', wrapResult: (o: string) => o, noFinal: 'x' };
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      calls.length = 0;
      await anthropicToolLoop('k')({ model, system: 'BRIEF', user: 'CASE', tools: [{ name: 'emit_verdict', input_schema: { type: 'object' } } as any], finalTool: 'emit_verdict', exec: async () => '', maxToolCalls: 2, texts });
      const block = calls[0].messages[0].content[0];
      expect(block.cache_control).toEqual(model.includes('opus') ? { type: 'ephemeral' } : undefined);
    }
    setCachePrefixSink({ seen() {} });
    expect(seen.map(p => p.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(keepAliveRequest(seen[0]).system).toEqual(calls.length ? [{ type: 'text', text: 'BRIEF', cache_control: { type: 'ephemeral', ttl: '1h' } }] : []);
  });
});
