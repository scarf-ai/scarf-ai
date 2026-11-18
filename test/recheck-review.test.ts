// Review of the hq/A-recheck branch (HQ, 2026-11-17): reproductions R1–R3, moved from /tmp/hq/repro-recheck. Green = the trade is not lost.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { parseTrustCsv, TrustTable } from '../src/trust/trust.js';
import { RiskState, liveGasGwei } from '../src/risk/risk.js';
import { Blacklist } from '../src/decide/decide.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { BudgetMeter, handleMessage, type PipelineDeps } from '../src/pipeline.js';
import { ContextWindows } from '../src/context/window.js';
import { ProjectCards } from '../src/intel/projects.js';
import { DEFAULT_GATE } from '../src/gate/triggers.js';
import { LlmBudget, DEFAULT_CAPS } from '../src/llm/budget.js';
import { recheckDue } from '../src/intel/router.js';
import { actOutcome } from '../src/intel/costShadow.js';

const MINT = '2qw313mavnLCGnz9L2GAsDvEvwJdWCuLyxv3vtM7pump';
const CSV = 'level,server,channel,author,score,mode,inherit\nchannel,ServerB,degen,,5,opus,careful\nserver,ServerA,,,9,\nauthor,ServerA,,caller,9,\n';

function setup(caps: Partial<typeof DEFAULT_CAPS> = {}) {
  const clock = new VirtualClock(Date.parse('2026-10-22T10:05:00Z'));
  liveGasGwei.set('ethereum', { gwei: 0.5, atMs: clock.now() });
  const store = new Store(':memory:');
  const trust = new TrustTable(parseTrustCsv(CSV).rows);
  const cfg = { ...DEFAULT_RISK };
  const risk = new RiskState(cfg, clock);
  const mk = { liq: 25_000, age: 30 };
  const market = {
    async market(a: string) { return a === MINT ? { chain: 'solana' as const, priceUsd: 0.0001, liquidityUsd: mk.liq, fdvUsd: 100_000, pairAgeMinutes: mk.age, buys24h: 400, sells24h: 300 } : undefined; },
    async rug() { return { risk: 'medium' as const, freezeOrMintAuthority: false, reasons: [] }; },
  };
  const notifier = { async send() {} };
  const paper = new PaperExecutor(cfg, risk, store, notifier, clock, () => 2400, undefined, () => 0.5);
  const calls: { model: string; user: string }[] = [];
  let reply: (u: string) => unknown = () => ({ verdict: 'ignore', thesis: 'x', confidence: 0.9 });
  const runAnalyst = async ({ model, user }: { model: string; user: string }) => { calls.push({ model, user }); return { verdict: reply(user), usage: [{ input_tokens: 6000, output_tokens: 700 }], toolCalls: [] }; };
  const budget = new LlmBudget({ ...DEFAULT_CAPS, ...caps }, clock, store);
  const logs: string[] = [];
  const deps = {
    mode: 'paper', store, trust, executor: paper, budget: new BudgetMeter(1, () => clock.utcDay()), notifier, log: (l: string) => logs.push(l),
    extract: { callModel: async () => ({ intents: [] }) },
    decide: { cfg, risk, market, clock, blacklist: new Blacklist(), ethUsd: () => 2400 },
    intel: { windows: new ContextWindows(), cards: new ProjectCards(store), gateCfg: DEFAULT_GATE, budget, brief: 'BRIEF', gateCall: async () => ({ output: { class: 'noise', escalate: false, confidence: 0.9 }, usage: { input_tokens: 1, output_tokens: 1 } }), runAnalyst,
      enrich: { market }, channelModel: DEFAULT_GATE.channelModels, ownPicks: 'paper', repeatHours: 24, watchRecheckMinutes: 60, chatBatchSize: 30, chatMaxWaitMinutes: 180 },
  } as unknown as PipelineDeps;
  return { clock, store, deps, calls, logs, mk, setAnalyst: (f: (u: string) => unknown) => { reply = f; } };
}

describe('A-recheck review repro', () => {
  it('R1: watch scheduled re-checks [+30 min, +2 h]; at +30 min the code (hard_check, liquidity) set ignore; by +2 h there is liquidity → the model is called', async () => {
    const s = setup();
    const t0 = s.clock.now();
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, thesis: 'LP not added yet — recheck', recheckAtUtc: [new Date(t0 + 30 * 60_000).toISOString(), new Date(t0 + 120 * 60_000).toISOString()] }));
    await handleMessage({ id: 'm1', sourceServer: 'ServerB', channel: 'degen', author: 'anon', tsUtc: s.clock.iso(), text: `new pair ${MINT}` }, s.deps);
    expect(s.calls.length).toBe(1);
    // +31 min: liquidity $1000 on a pair older than an hour, source score 5 → a hard cut by code, verdict ignore
    s.mk.liq = 1000; s.mk.age = 90;
    s.clock.set(t0 + 31 * 60_000);
    const r1 = await recheckDue(s.deps);
    expect(r1[0].analysis?.model).toBe('code');
    expect(r1[0].analysis?.verdict).toBe('ignore');
    // +2 h 1 min: liquidity added — the analyst re-check reaches the model
    s.mk.liq = 50_000;
    s.clock.set(t0 + 121 * 60_000);
    await recheckDue(s.deps);
    expect(s.calls.length).toBe(2);
  });

  it('R2: a scheduled re-check, the Sonnet budget is exhausted, Opus is free → analysis on Opus (as before)', async () => {
    const s = setup({ sonnetDailyUsd: 0 });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, thesis: 'needs a day', recheckAfterMinutes: 30 }));
    await handleMessage({ id: 'm2', sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', tsUtc: s.clock.iso(), text: `look ${MINT}` }, s.deps);
    s.clock.set(s.clock.now() + 31 * 60_000);
    const r = await recheckDue(s.deps);
    expect(s.calls.length).toBe(2);
    expect(s.calls[1].model).toBe(DEFAULT_CAPS.analystModel);
    expect(r[0].analysis?.model).toBe(DEFAULT_CAPS.analystModel);
  });

  it('R2b: both limits exhausted → journal only, as before', async () => {
    const s = setup({ sonnetDailyUsd: 0 });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, thesis: 'needs a day', recheckAfterMinutes: 30 }));
    await handleMessage({ id: 'm3', sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', tsUtc: s.clock.iso(), text: `look ${MINT}` }, s.deps);
    s.deps.intel!.budget.record(DEFAULT_CAPS.analystModel, 1000);
    s.clock.set(s.clock.now() + 31 * 60_000);
    const r = await recheckDue(s.deps);
    expect(s.calls.length).toBe(1);
    expect(r[0].skipped).toBe('analyst budget exhausted (journal only)');
  });

  it('R3: "E-13"/"no live executor" in the analyst thesis + a market refusal S-02 → open', () => {
    expect(actOutcome([{ action: 'skip', reasons: ['analyst (opus-5-5, conf 0.9): mint needs a wallet (E-13 later), buy the token now', 'chasing a pump, skip (S-02): ×2.00 in 1h ≥ ×1.8'] }])).toBe('open');
    expect(actOutcome([{ action: 'skip', reasons: ['analyst: no live executor for this, but the market is wrong anyway', 'size below minimum'] }])).toBe('open');
    // The code reason — still "no executor"
    expect(actOutcome([{ action: 'skip', reasons: ['analyst (opus-5-5, conf 0.9): do the quest', 'execution blocked: live: no live executor for dapp_session — journal only'] }])).toBe('no_executor');
  });
});
