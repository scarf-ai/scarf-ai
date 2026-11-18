// A-08 test harness (taken from the HQ review repros, PR #69 round 1). A copy of setup()/msg() from test/intel.test.ts
// (they are not exported there), unchanged in meaning; only fields for overriding the market and OpenSea are added.
import { expect } from 'vitest';
import { DEFAULT_RISK, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { parseTrustCsv, TrustTable } from '../src/trust/trust.js';
import { RiskState, liveGasGwei } from '../src/risk/risk.js';
import { Blacklist } from '../src/decide/decide.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { BudgetMeter, type PipelineDeps } from '../src/pipeline.js';
import { ContextWindows } from '../src/context/window.js';
import { ProjectCards } from '../src/intel/projects.js';
import { DEFAULT_GATE } from '../src/gate/triggers.js';
import { LlmBudget, DEFAULT_CAPS } from '../src/llm/budget.js';
import type { OpenSeaClient, NftInfo } from '../src/analyst/opensea.js';
import type { AnalystRunner } from '../src/analyst/analyst.js';
import type { GateCaller } from '../src/gate/chatGate.js';
import type { MarketClient, MarketInfo } from '../src/checks/token.js';
import type { RawMessage } from '../src/types.js';

export const CSV = 'level,server,channel,author,score,mode,inherit\nchannel,ServerB,degen,,5,opus,careful\nserver,ServerA,,,9,\nchannel,ServerA,core-calls,,7,opus\nauthor,ServerA,,caller1,9,\nauthor,ServerA,,caller,9,\nchannel,ServerB,scan-feed,,7,opus\nchannel,ServerB,chat,,3,chat\nchannel,ServerC,chat,,2,chat\nchannel,ServerA,off-topic,,,ignore\n';
export const MINT = '2qw313mavnLCGnz9L2GAsDvEvwJdWCuLyxv3vtM7pump';
const ETH_USD = 2404.56;

let currentClock: VirtualClock;
export function setup(opts: { risk?: Partial<RiskConfig>; batch?: number; triage?: boolean } = {}) {
  const clock = new VirtualClock(Date.parse('2026-10-22T10:05:00Z'));
  currentClock = clock;
  liveGasGwei.set('ethereum', { gwei: 0.5, atMs: clock.now() });
  const store = new Store(':memory:');
  const trust = new TrustTable(parseTrustCsv(CSV).rows);
  const cfg: RiskConfig = { ...DEFAULT_RISK, ...(opts.risk ?? {}) };
  const risk = new RiskState(cfg, clock);
  /** Extra market fields by address (e.g. twitter from the DexScreener token profile). */
  const marketExtra = new Map<string, Partial<MarketInfo>>();
  const prices = new Map<string, number>([[MINT, 0.0001]]);
  const market: MarketClient = {
    async market(a): Promise<MarketInfo | undefined> { const p = prices.get(a); return p ? { chain: 'solana', priceUsd: p, liquidityUsd: 25_000, fdvUsd: 100_000, pairAgeMinutes: 30, buys24h: 400, sells24h: 300, ...(marketExtra.get(a) ?? {}) } : undefined; },
    async rug() { return { risk: 'medium', freezeOrMintAuthority: false, reasons: [] }; },
  };
  /** OpenSea responses by slug. */
  const nfts = new Map<string, NftInfo>();
  const opensea: OpenSeaClient = { async nft(slug) { return nfts.get(slug); } };
  const sent: string[] = [];
  const notifier = { async send(t: string) { sent.push(t); } };
  const paper = new PaperExecutor(cfg, risk, store, notifier, clock, () => ETH_USD, opensea, () => 0.5);
  const perpPx: Record<string, number> = { BTC: 100_000, ETH: 4000 };
  const perp = { async mids() { return { ...perpPx }; }, async price(a: string) { return perpPx[a.toUpperCase()]; } };
  paper.perp = perp;
  const calls: { model: string; user: string }[] = [];
  let analystReply: (user: string) => unknown = () => ({ verdict: 'ignore', thesis: 'nothing', confidence: 0.9 });
  const runAnalyst: AnalystRunner = async ({ model, user }) => {
    calls.push({ model, user });
    return { verdict: analystReply(user), usage: [{ input_tokens: 6000, output_tokens: 700 }], toolCalls: [] };
  };
  const gateCall: GateCaller = async () => ({ output: { class: 'noise', escalate: false, confidence: 0.9 }, usage: { input_tokens: 1500, output_tokens: 80 } });
  let triageReply: (user: string) => unknown = () => ({ escalate: false, reason: 'banter' });
  const triageCall: GateCaller = async (_s, user) => ({ output: triageReply(user), usage: { input_tokens: 4000, output_tokens: 60 } });
  const budget = new LlmBudget({ ...DEFAULT_CAPS }, clock, store);
  const logs: string[] = [];
  const deps: PipelineDeps = {
    mode: 'paper', store, trust, executor: paper, budget: new BudgetMeter(1, () => clock.utcDay()), notifier,
    extract: { callModel: async () => ({ intents: [] }) },
    decide: { cfg, risk, market, clock, blacklist: new Blacklist(), ethUsd: () => ETH_USD, perp },
    log: (s: string) => { logs.push(s); },
    intel: {
      windows: new ContextWindows(), cards: new ProjectCards(store), gateCfg: DEFAULT_GATE, budget, brief: 'BRIEF', gateCall, runAnalyst,
      enrich: { market, opensea, perp }, channelModel: DEFAULT_GATE.channelModels, ownPicks: 'paper', repeatHours: 24, watchRecheckMinutes: 60,
      chatBatchSize: opts.batch ?? 30, chatMaxWaitMinutes: 180, triageCall: opts.triage ? triageCall : undefined,
    },
  };
  void expect;
  return { clock, store, risk, paper, sent, deps, calls, logs, prices, marketExtra, nfts,
    setTriage: (f: (u: string) => unknown) => { triageReply = f; },
    setAnalyst: (f: (u: string) => unknown) => { analystReply = f; } };
}
let n = 0;
export const msg = (over: Partial<RawMessage>): RawMessage => ({ id: `r${++n}`, sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', tsUtc: currentClock.iso(), text: '', ...over });

/** twitterapi.io mock: the test sets search posts and profiles; all calls are written to seen. */
export const xMock = (posts: { author: string; text?: string }[], profiles: Record<string, Record<string, unknown>>, seen: string[] = []) => ({
  async search(q: string) { seen.push(`search ${q}`); return posts.map(p => ({ text: p.text ?? '', createdAt: '2026-11-10T12:00:00Z', likes: 1, retweets: 0, author: p.author })); },
  async profile(h: string) { seen.push(`profile ${h}`); return { handle: h, ...(profiles[h] ?? {}) }; },
});
