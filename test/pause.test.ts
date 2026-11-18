// C-04: the agent without Anthropic credits — model pause, one notification, no queue (the owner's decision 2026-11-08 15:45 UTC).
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { parseTrustCsv, TrustTable } from '../src/trust/trust.js';
import { RiskState, liveGasGwei } from '../src/risk/risk.js';
import { Blacklist } from '../src/decide/decide.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { BudgetMeter, handleMessage, serialHandler, type PipelineDeps } from '../src/pipeline.js';
import { ContextWindows } from '../src/context/window.js';
import { ProjectCards } from '../src/intel/projects.js';
import { DEFAULT_GATE } from '../src/gate/triggers.js';
import { LlmBudget, DEFAULT_CAPS } from '../src/llm/budget.js';
import { ToolLoopError } from '../src/llm/runner.js';
import { ModelPause, ModelPausedError, isAccountBlocked, probeRequest, PAUSED_SKIP, PROBE_EVERY_MS, NOTIFY_EVERY_MS, NOTICE_KEY } from '../src/llm/pause.js';
import { modelExtras, maxTokensFor } from '../src/llm/models.js';
import { runScheduled } from '../src/intel/router.js';
import type { AnalystRunner } from '../src/analyst/analyst.js';
import type { GateCaller } from '../src/gate/chatGate.js';
import type { MarketClient } from '../src/checks/token.js';
import type { RawMessage } from '../src/types.js';

const MIN = 60_000;
// This is how the SDK builds an error from an API response (texts — as in Anthropic responses)
const apiError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());
const noCredits = () => apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');

describe('C-04 isAccountBlocked: credits and key — separate from network and 5xx', () => {
  it('credits: 400 credit balance, 402 billing; key: 401, 403', () => {
    expect(isAccountBlocked(noCredits())).toBe('credits');
    expect(isAccountBlocked(apiError(402, 'billing_error', 'Billing issue'))).toBe('credits');
    expect(isAccountBlocked(apiError(401, 'authentication_error', 'invalid x-api-key'))).toBe('auth');
    expect(isAccountBlocked(apiError(403, 'permission_error', 'not allowed'))).toBe('auth');
  });
  it('a wrapped tool loop error (ToolLoopError with cause) and plain text are recognized too', () => {
    const e = noCredits();
    expect(isAccountBlocked(new ToolLoopError(e.message, [], [], e))).toBe('credits');
    expect(isAccountBlocked(new Error(e.message))).toBe('credits');
    const k = apiError(401, 'authentication_error', 'invalid x-api-key');
    expect(isAccountBlocked(new ToolLoopError(k.message, [], [], k))).toBe('auth');
  });
  it('foreign text with an API error type — not a pause: only the status and type of the API error itself (review #52, round 1)', () => {
    expect(isAccountBlocked(new Error('tool page_text returned: {"error":{"type":"permission_error"}}'))).toBeUndefined();
    expect(isAccountBlocked(new Error('401 {"type":"error","error":{"type":"authentication_error"}}'))).toBeUndefined();
    expect(isAccountBlocked({ type: 'permission_error', message: 'x' })).toBeUndefined();
  });
  it('not a pause: 5xx, overload, 429 limit, network, timeout, other 400s, parse errors', () => {
    for (const e of [apiError(500, 'api_error', 'Internal server error'), apiError(529, 'overloaded_error', 'Overloaded'), apiError(429, 'rate_limit_error', 'rate limited'),
      apiError(400, 'invalid_request_error', 'max_tokens: must be positive'), new Anthropic.APIConnectionError({ message: 'fetch failed' }),
      new Anthropic.APIConnectionTimeoutError(), new Error('analyst returned no verdict'), undefined, 'boom']) expect(isAccountBlocked(e)).toBeUndefined();
  });
});

describe('C-04 ModelPause: a probe every 15 minutes, notifications at most once in 6 hours', () => {
  const mk = () => {
    const clock = new VirtualClock(Date.parse('2026-11-08T15:00:00Z'));
    const sent: string[] = []; const logs: string[] = [];
    let probeOk = false; let probes = 0;
    const pause = new ModelPause({ clock, notify: async t => { sent.push(t); }, log: s => logs.push(s), probe: async () => { probes++; if (!probeOk) throw noCredits(); } });
    return { clock, sent, logs, pause, setProbe: (ok: boolean) => { probeOk = ok; }, probes: () => probes };
  };

  it('entry → one notification; no probes before 15 minutes; a failed probe — the pause stays; a successful one — lifted, one notification', async () => {
    const t = mk();
    expect(t.pause.observe(apiError(500, 'api_error', 'x'))).toBe(false);
    expect(t.pause.paused()).toBe(false);
    expect(t.pause.observe(noCredits())).toBe(true);
    expect(t.pause.observe(noCredits())).toBe(true); // a repeated error — no second notification
    expect(t.pause.status()).toBe('model: paused (no API credits since 2026-11-08T15:00:00.000Z)');
    await Promise.resolve();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatch(/Model paused: Anthropic API credits ran out/);
    for (let m = 1; m < 15; m++) { t.clock.advance(MIN); expect(await t.pause.ready()).toBe(false); }
    expect(t.probes()).toBe(0);
    t.clock.advance(MIN); // 15 minutes: a probe, no credits yet
    expect(await t.pause.ready()).toBe(false);
    expect(t.probes()).toBe(1);
    t.clock.advance(PROBE_EVERY_MS - MIN); expect(await t.pause.ready()).toBe(false); expect(t.probes()).toBe(1);
    t.setProbe(true); t.clock.advance(MIN);
    expect(await t.pause.ready()).toBe(true);
    expect(t.probes()).toBe(2);
    expect(t.pause.status()).toBe('model: ok');
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]).toMatch(/The model is working again \(pause 30 min\)/);
    expect(t.logs.some(l => l.startsWith('model: paused (no API credits since'))).toBe(true);
  });

  it('a second pause within 6 hours — no entry or exit notifications; after 6 hours — a notification again', async () => {
    const t = mk();
    t.pause.observe(noCredits()); t.setProbe(true); t.clock.advance(PROBE_EVERY_MS); await t.pause.ready();
    expect(t.sent).toHaveLength(2);
    t.setProbe(false); t.clock.advance(60 * MIN); t.pause.observe(noCredits());
    t.setProbe(true); t.clock.advance(PROBE_EVERY_MS); expect(await t.pause.ready()).toBe(true);
    expect(t.sent).toHaveLength(2);
    t.clock.set(Date.parse('2026-11-08T15:00:00Z') + NOTIFY_EVERY_MS); t.pause.observe(apiError(401, 'authentication_error', 'invalid x-api-key'));
    await Promise.resolve();
    expect(t.sent).toHaveLength(3);
    expect(t.sent[2]).toMatch(/Anthropic API key rejected/);
  });

  it('guard: no call while paused (ModelPausedError), a credits error turns the pause on; concurrent checks wait for one probe', async () => {
    const t = mk();
    let calls = 0;
    const f = t.pause.guard(async (x: number) => { calls++; if (x < 0) throw noCredits(); return x * 2; });
    expect(await f(2)).toBe(4);
    await expect(f(-1)).rejects.toThrow(/credit balance/);
    await expect(f(3)).rejects.toBeInstanceOf(ModelPausedError);
    expect(calls).toBe(2);
    t.setProbe(true); t.clock.advance(PROBE_EVERY_MS);
    const [a, b] = await Promise.all([t.pause.ready(), t.pause.ready()]);
    expect([a, b]).toEqual([true, true]);
    expect(t.probes()).toBe(1);
    expect(await f(5)).toBe(10);
  });
});

// ---- The card scenario on the pipeline with a substituted client ----
const CSV = 'level,server,channel,author,score,mode,inherit\nserver,ServerA,,,9,\nchannel,ServerA,core-calls,,7,opus\nauthor,ServerA,,caller,9,\nchannel,ServerB,chat,,3,chat\n';
const MINT = '2qw313mavnLCGnz9L2GAsDvEvwJdWCuLyxv3vtM7pump';

function setup(opts: { triage?: boolean; mode?: 'paper' | 'live' } = {}) {
  const clock = new VirtualClock(Date.parse('2026-11-08T15:00:00Z'));
  liveGasGwei.set('ethereum', { gwei: 0.5, atMs: clock.now() });
  const store = new Store(':memory:');
  const trust = new TrustTable(parseTrustCsv(CSV).rows);
  const cfg = { ...DEFAULT_RISK };
  const risk = new RiskState(cfg, clock);
  const market: MarketClient = {
    async market() { return { chain: 'solana', priceUsd: 0.0001, liquidityUsd: 25_000, fdvUsd: 100_000, pairAgeMinutes: 30, buys24h: 400, sells24h: 300 }; },
    async rug() { return { risk: 'medium', freezeOrMintAuthority: false, reasons: [] }; },
  };
  const sent: string[] = [];
  const notifier = { async send(t: string) { sent.push(t); } };
  const paper = new PaperExecutor(cfg, risk, store, notifier, clock, () => 2400, undefined, () => 0.5);
  const perpPx: Record<string, number> = { BTC: 100_000 };
  const perp = { async mids() { return { ...perpPx }; }, async price(a: string) { return perpPx[a.toUpperCase()]; } };
  paper.perp = perp;
  // Substituted model "client": every call goes to calls; the test sets the behaviour
  const calls: { kind: string; user: string }[] = [];
  let fail: (() => unknown) | undefined;
  let reply: () => unknown = () => ({ verdict: 'ignore', thesis: 'nothing', confidence: 0.9 });
  const runAnalyst: AnalystRunner = async ({ user }) => {
    calls.push({ kind: 'analyst', user });
    if (fail) { const e = fail(); throw new ToolLoopError(String((e as Error).message ?? e), [], [], e); }
    return { verdict: reply(), usage: [{ input_tokens: 1000, output_tokens: 100 }], toolCalls: [] };
  };
  const triageCall: GateCaller = async (_s, user) => { calls.push({ kind: 'triage', user }); if (fail) throw fail(); return { output: { escalate: false, reason: 'banter' }, usage: { input_tokens: 100, output_tokens: 10 } }; };
  let probeOk = false; let probes = 0;
  const logs: string[] = [];
  const pause = new ModelPause({ clock, notify: t => notifier.send(t), log: s => logs.push(s), probe: async () => { probes++; if (!probeOk) throw noCredits(); } });
  const deps: PipelineDeps = {
    mode: opts.mode ?? 'paper', store, trust, executor: paper, budget: new BudgetMeter(1, () => clock.utcDay()), notifier, log: s => logs.push(s),
    extract: { callModel: async () => { calls.push({ kind: 'extract', user: '' }); return { intents: [] }; } },
    decide: { cfg, risk, market, clock, blacklist: new Blacklist(), ethUsd: () => 2400, perp },
    intel: {
      windows: new ContextWindows(), cards: new ProjectCards(store), gateCfg: DEFAULT_GATE, budget: new LlmBudget({ ...DEFAULT_CAPS }, clock, store), brief: 'BRIEF', runAnalyst,
      enrich: { market, perp }, channelModel: DEFAULT_GATE.channelModels, ownPicks: 'paper', repeatHours: 24, watchRecheckMinutes: 60,
      chatBatchSize: 30, chatMaxWaitMinutes: 180, triageCall: opts.triage ? triageCall : undefined, pause,
    },
  };
  let n = 0;
  const msg = (over: Partial<RawMessage> = {}): RawMessage => ({ id: `m${++n}`, sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', tsUtc: clock.iso(), text: `alpha ${n}: ${MINT}`, ...over });
  return { clock, store, deps, paper, risk, perpPx, sent, calls, logs, pause, msg,
    setFail: (f?: () => unknown) => { fail = f; }, setReply: (f: () => unknown) => { reply = f; },
    setProbe: (ok: boolean) => { probeOk = ok; }, probes: () => probes };
}

describe('C-04 pipeline: 400 credit → pause, no model calls, no queue', () => {
  it('30 virtual minutes without calls; a probe; after lifting only the new message is analysed, the missed ones are not', async () => {
    const s = setup();
    const handle = serialHandler(s.deps);
    s.setFail(noCredits);
    const r0 = await handle(s.msg());
    expect(r0.skipped).toBe(PAUSED_SKIP); // this analysis failed because of credits — it is what turned the pause on
    expect(s.calls).toHaveLength(1);
    expect(s.pause.paused()).toBe(true);
    expect(s.sent.filter(t => t.includes('Model paused'))).toHaveLength(1);

    // 30 minutes: a tick every minute (re-checks, batches), a new message every 5 minutes
    const missed: string[] = [];
    for (let m = 1; m <= 30; m++) {
      s.clock.advance(MIN);
      if (m === 30) s.setProbe(true); // by minute 30 the owner topped up the credits
      await handle.tick();
      if (m % 5 === 0 && m < 30) {
        const raw = s.msg({ text: `missed call ${m}: ${MINT} going to moon` });
        missed.push(raw.text);
        const r = await handle(raw);
        expect(r.skipped).toBe(PAUSED_SKIP);
      }
    }
    expect(s.calls).toHaveLength(1); // not a single model call during the pause
    expect(s.probes()).toBe(2); // minute 15 (no credits) and minute 30 (credits)
    expect(s.pause.paused()).toBe(false);
    expect(s.sent.filter(t => t.includes('The model is working again'))).toHaveLength(1);

    s.setFail(undefined);
    const fresh = s.msg({ text: `fresh call after top-up: ${MINT}` });
    await handle(fresh);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1].user).toContain('fresh call after top-up');
    for (const t of missed) expect(s.calls[1].user).not.toContain(t); // the model does not see what was missed — not even as context
    expect(s.sent.filter(t => /Model paused|The model is working again/.test(t))).toHaveLength(2);
  });

  it('5xx and network do not turn the pause on: the next message goes to the model again', async () => {
    const s = setup();
    s.setFail(() => apiError(529, 'overloaded_error', 'Overloaded'));
    await handleMessage(s.msg(), s.deps);
    s.setFail(() => new Anthropic.APIConnectionError({ message: 'fetch failed' }));
    await handleMessage(s.msg(), s.deps);
    s.setFail(undefined);
    await handleMessage(s.msg(), s.deps);
    expect(s.pause.paused()).toBe(false);
    expect(s.calls).toHaveLength(3);
    expect(s.sent.some(t => t.includes('Model paused'))).toBe(false);
  });

  it('a chat batch collected before the pause does not go to Haiku or further while paused, and does not wait for the pause to end', async () => {
    const s = setup({ triage: true });
    const handle = serialHandler(s.deps);
    for (let i = 0; i < 6; i++) await handle(s.msg({ sourceServer: 'ServerB', channel: 'chat', author: `u${i}`, text: `gm ${i}` }));
    expect(s.store.chatBufferStats()).toHaveLength(1);
    s.pause.observe(noCredits());
    s.clock.advance(181 * MIN); // the batch "ripened" by the timer (chatMaxWaitMinutes 180)
    s.setProbe(false);
    await handle.tick();
    expect(s.calls).toHaveLength(0);
    expect(s.store.chatBufferStats()).toHaveLength(0); // dropped, not postponed
    expect(s.logs.some(l => l.includes(`dropped: ${PAUSED_SKIP}`))).toBe(true);
    // and chat messages during the pause do not get into a batch
    await handle(s.msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u9', text: 'gm 9' }));
    expect(s.store.chatBufferStats()).toHaveLength(0);
  });

  it('a Haiku sorting failure due to credits turns the pause on; Haiku is not called after that', async () => {
    const s = setup({ triage: true });
    const handle = serialHandler(s.deps);
    for (let i = 0; i < 6; i++) await handle(s.msg({ sourceServer: 'ServerB', channel: 'chat', author: `u${i}`, text: `gm ${i}` }));
    s.setFail(noCredits);
    s.clock.advance(181 * MIN);
    await handle.tick(); // batch by timer → sorting → 400 credit
    expect(s.calls.map(c => c.kind)).toEqual(['triage']);
    expect(s.pause.paused()).toBe(true);
    for (let i = 0; i < 6; i++) await handle(s.msg({ sourceServer: 'ServerB', channel: 'chat', author: `v${i}`, text: `hey ${i}` }));
    s.clock.advance(181 * MIN);
    await handle.tick();
    expect(s.calls).toHaveLength(1);
  });

  it('live while paused: deferred entries are dropped with a reason; exits by the code stop rules work', async () => {
    const s = setup({ mode: 'live' });
    // the position was opened before the pause (the paper executor — the same stop monitor as in live)
    s.setReply(() => ({ verdict: 'act', confidence: 0.8, thesis: 'trusted long', intents: [{ kind: 'perp_trade', chain: 'unknown', asset: 'BTC', side: 'long', leverage: 3, stopPrice: 97_000, takeProfitPrice: 106_000, urls: [], summary: 'long BTC', stance: 'buy', confidence: 0.8 }] }));
    s.deps.mode = 'paper';
    await handleMessage(s.msg({ text: 'Opened a long on BTC here with low leverage, invalidation below 97k' }), s.deps);
    expect(s.paper.perpOpen.size).toBe(1);
    s.deps.mode = 'live';
    s.pause.observe(noCredits());
    // a deferred action came due during the pause
    const origin = s.msg({ text: `mint later ${MINT}` });
    s.store.addScheduled(s.clock.iso(), origin, { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', confidence: 0.8 }, {}, {}, 'd1');
    const saved: { action: string; reasons: string[] }[] = [];
    const save = s.store.saveDecision.bind(s.store);
    s.store.saveDecision = (m, d, mode, iso) => { saved.push({ action: d.action, reasons: d.reasons }); return save(m, d, mode, iso); };
    const out = await runScheduled(s.deps);
    expect(out).toEqual([{ action: 'skip', reasons: [`scheduled action due ${s.clock.iso()}`, `no new entries: ${PAUSED_SKIP}`] }]);
    expect(saved[0].action).toBe('skip');
    // the price reached the stop — the position monitor (without the model) closes it
    s.perpPx.BTC = 96_900;
    await s.paper.monitor({ market: async () => undefined, rug: async () => undefined });
    expect(s.paper.perpOpen.size).toBe(0);
    expect(s.calls.filter(c => c.kind === 'analyst')).toHaveLength(1);
  });
});

describe('C-04 follow-up after HQ acceptance (#52, round 1)', () => {
  const mkPause = (clock: VirtualClock, probe: () => Promise<void>, kv?: Map<string, string>) => {
    const sent: string[] = []; const logs: string[] = [];
    const pause = new ModelPause({ clock, notify: async t => { sent.push(t); }, log: l => logs.push(l), probe,
      remember: kv ? { get: k => kv.get(k), set: (k, v) => { kv.set(k, v); } } : undefined });
    return { pause, sent, logs };
  };

  it('item 1a: the probe is built like working Haiku calls — wellFormed + modelExtras, no manual thinking', () => {
    const r = probeRequest();
    expect(r).toEqual({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }], ...modelExtras('claude-haiku-5-5') });
    expect(r).not.toHaveProperty('thinking');
    expect(maxTokensFor('claude-haiku-5-5', 1)).toBe(1); // Haiku is not a "thinking" model in models.ts — no thinking budget is added
  });

  it('item 1b: the probe is rejected by the request (400 not credits) — the account is available, the pause is lifted in one probe, the owner gets two notifications', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-08T15:00:00Z'));
    let probes = 0;
    const t = mkPause(clock, async () => { probes++; throw apiError(400, 'invalid_request_error', 'thinking.type: disabled is not supported for this model'); });
    t.pause.observe(noCredits());
    for (let m = 0; m < 24 * 60 && t.pause.paused(); m++) { clock.advance(MIN); await t.pause.ready(); }
    expect(t.pause.paused()).toBe(false);
    expect(probes).toBe(1);
    expect(t.logs.some(l => l.includes('probe rejected on request, account is reachable'))).toBe(true);
    await Promise.resolve();
    expect(t.sent).toEqual([expect.stringContaining('Model paused'), expect.stringContaining('The model is working again')]);
  });

  it('item 1b: 429, 5xx, 408, network, still no credits or key — the pause stays', async () => {
    for (const err of [apiError(429, 'rate_limit_error', 'x'), apiError(500, 'api_error', 'x'), apiError(408, 'timeout_error', 'x'),
      new Anthropic.APIConnectionError({ message: 'fetch failed' }), noCredits(), apiError(401, 'authentication_error', 'invalid x-api-key')]) {
      const clock = new VirtualClock(Date.parse('2026-11-08T15:00:00Z'));
      const t = mkPause(clock, async () => { throw err; });
      t.pause.observe(noCredits());
      clock.advance(PROBE_EVERY_MS);
      expect(await t.pause.ready()).toBe(false);
      expect(t.pause.paused()).toBe(true);
    }
  });

  it('item 2: "at most once in 6 h" survives a restart; the new instance reports the exit', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-08T15:00:00Z'));
    const kv = new Map<string, string>();
    let ok = false;
    const probe = async () => { if (!ok) throw noCredits(); };
    const a = mkPause(clock, probe, kv);
    a.pause.observe(apiError(402, 'billing_error', 'Billing issue'));
    await Promise.resolve();
    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(kv.get(NOTICE_KEY)!)).toEqual({ at: clock.now(), open: true });
    clock.advance(10 * MIN);
    const b = mkPause(clock, probe, kv); // service restart
    b.pause.observe(apiError(402, 'billing_error', 'Billing issue'));
    await Promise.resolve();
    expect(b.sent).toHaveLength(0); // no repeated "paused"
    ok = true; clock.advance(PROBE_EVERY_MS);
    expect(await b.pause.ready()).toBe(true);
    await Promise.resolve();
    expect(b.sent).toEqual([expect.stringContaining('The model is working again')]); // the exit was reported
    expect(JSON.parse(kv.get(NOTICE_KEY)!).open).toBe(false);
    // 6 hours after the previous notification — we report again
    clock.set(Date.parse('2026-11-08T15:00:00Z') + NOTIFY_EVERY_MS);
    const c = mkPause(clock, probe, kv);
    c.pause.observe(noCredits());
    await Promise.resolve();
    expect(c.sent).toEqual([expect.stringContaining('Model paused')]);
  });

  it('item 2: "paused" sent, restart, credits already there — the first successful call reports the exit once', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-08T15:00:00Z'));
    const kv = new Map<string, string>([[NOTICE_KEY, JSON.stringify({ at: clock.now() - 30 * MIN, open: true })]]);
    const t = mkPause(clock, async () => {}, kv);
    const f = t.pause.guard(async () => 'ok');
    await f(); await f();
    await Promise.resolve();
    expect(t.sent).toEqual([expect.stringContaining('after an agent restart')]);
  });

  it('corrupted memory — same as no memory', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-08T15:00:00Z'));
    const t = mkPause(clock, async () => {}, new Map([[NOTICE_KEY, '{oops']]));
    t.pause.observe(noCredits());
    await Promise.resolve();
    expect(t.sent).toHaveLength(1);
  });

  it('the old path (analyst off): while paused the Haiku extraction is not called', async () => {
    const s = setup();
    s.deps.intel = undefined;
    s.deps.extract = { callModel: s.pause.guard(async () => { s.calls.push({ kind: 'extract', user: '' }); return { intents: [] }; }) };
    await handleMessage(s.msg({ text: `buy ${MINT} now` }), s.deps);
    expect(s.calls).toHaveLength(1); // control: without a pause this message reaches extraction
    s.pause.observe(noCredits());
    const r = await handleMessage(s.msg({ text: `buy ${MINT} now, again` }), s.deps);
    expect(s.calls).toHaveLength(1);
    expect(r.skipped).toBeDefined(); // the mark will become "model paused …" with the pipeline.ts fix from #53
  });
});
