// The analyst layer: channel modes, the chat gatekeeper, project cards, OpenSea, watching, deferred actions,
// post drafts. Models, the market and OpenSea are mocked; time is virtual; background jobs are not started.
import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig, DEFAULT_RISK, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { parseTrustCsv, TrustTable } from '../src/trust/trust.js';
import { RiskState, liveGasGwei, estimateGasUsd } from '../src/risk/risk.js';
import { Blacklist } from '../src/decide/decide.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { BudgetMeter, handleMessage, serialHandler, type PipelineDeps } from '../src/pipeline.js';
import { ContextWindows } from '../src/context/window.js';
import { ProjectCards } from '../src/intel/projects.js';
import { DEFAULT_GATE } from '../src/gate/triggers.js';
import { LlmBudget, DEFAULT_CAPS, costUsd } from '../src/llm/budget.js';
import { parseOpenSea, nftRecheckTimes, type OpenSeaClient, type NftInfo } from '../src/analyst/opensea.js';
import { discordMarkupToText } from '../src/intake/normalize.js';
import { codeEntities, splitBlocks } from '../src/intel/entities.js';
import { prefilter } from '../src/extract/prefilter.js';
import { draftPost, leaks } from '../src/posts/drafts.js';
import { isPrivateIp } from '../src/analyst/enrich.js';
import type { AnalystRunner } from '../src/analyst/analyst.js';
import type { GateCaller } from '../src/gate/chatGate.js';
import type { MarketClient, MarketInfo } from '../src/checks/token.js';
import type { RawMessage } from '../src/types.js';
import { BARK_EMBED } from './fixtures.js';

// ---------- Fixtures: a synthetic message of the same shape and an OpenSea response for a made-up collection ----------
const NFT_SAMPLE_MSG = `https://opensea.io/collection/lanternfolk/overview - Lanternfolk was mentioned in <#1234567890>; the drop page is live. Phase one is a free allowlist with a modest wallet count. The allowlist runs for several hours, which gives time to see how the floor behaves before public mint.

Public - <t:1792711500:F>
Whitelist - <t:1792690200:F>

======

https://bramblebots.xyz/bots - Bramble Bots on Aptos. Not my usual chain, but the art is decent and a couple of bigger communities are following it. Free to enter, so the downside is small.

Mint Starts: <t:1792685700:F>

FCFS - first come, first served, but the site runs it like a draw.
GTD - guaranteed claim for listed wallets.
Public - register on the site; also drawn at random.

To get into the public round, hit Register Interest once the claim page opens. Only an X account is required for now; a wallet can be added later.

<@&714> Those are my two picks for tomorrow. More ideas in <#987>, but these two have the best odds.

will update if anything else moves`;

const VOT_CONTRACT = '0xe8f69891794a8c21377aafbbb0c31d1876e0a44f';
const OS_DROP = { collection_slug: 'lanternfolk', collection_name: 'Lanternfolk', chain: 'ethereum', contract_address: VOT_CONTRACT, drop_type: 'seadrop_v1_erc721', is_minting: false,
  stages: [
    { stage_type: 'public_sale', label: 'Public', price: '1000000000000000', start_time: '2026-10-22T23:25:00Z', end_time: '2026-10-25T23:25:00Z', max_per_wallet: '1', allowlist_wallet_count: null },
    { stage_type: 'signed_presale', label: 'Team', price: '0', start_time: '2026-10-22T17:15:00Z', end_time: '2026-10-22T17:30:00Z', max_per_wallet: '30', allowlist_wallet_count: 1 },
    { stage_type: 'signed_presale', label: 'Whitelist', price: '0', start_time: '2026-10-22T17:30:00Z', end_time: '2026-10-22T23:25:00Z', max_per_wallet: '1', allowlist_wallet_count: 2742 },
  ], total_supply: '0', max_supply: '4444', fee_bps: 500 };
const OS_COLL = { name: 'Lanternfolk', twitter_username: 'lanternfolkxyz', project_url: '', contracts: [{ address: VOT_CONTRACT, chain: 'ethereum' }],
  fees: [{ fee: 0.5, required: true }, { fee: 5.5, required: true }] };
const osStats = (floor: number, sales: number) => ({ total: { floor_price: floor, sales, num_owners: 2000 }, intervals: [{ interval: 'one_day', sales, volume: sales * floor }] });

const CSV = 'level,server,channel,author,score,mode,inherit\nchannel,ServerB,degen,,5,opus,careful\nserver,ServerA,,,9,\nchannel,ServerA,core-calls,,7,opus\nauthor,ServerA,,caller1,9,\nauthor,ServerA,,caller,9,\nchannel,ServerB,scan-feed,,7,opus\nchannel,ServerB,chat,,3,chat\nchannel,ServerC,chat,,2,chat\nchannel,ServerA,off-topic,,,ignore\n';
const MINT = '2qw313mavnLCGnz9L2GAsDvEvwJdWCuLyxv3vtM7pump';
const ETH_USD = 1904.56; // example: a 0.001 ETH mint ≈ $1.90 fits the fast share (0.2 × $10)

let currentClock: VirtualClock;
function setup(opts: { risk?: Partial<RiskConfig>; caps?: Partial<typeof DEFAULT_CAPS>; batch?: number; triage?: boolean } = {}) {
  const clock = new VirtualClock(Date.parse('2026-10-22T10:05:00Z'));
  currentClock = clock;
  const set = clock.set.bind(clock);
  clock.set = (t: number) => { set(t); liveGasGwei.set('ethereum', { gwei: 0.5, atMs: t }); }; // gas is refreshed every 2 min, as in index.ts
  liveGasGwei.set('ethereum', { gwei: 0.5, atMs: clock.now() });
  const store = new Store(':memory:');
  const trust = new TrustTable(parseTrustCsv(CSV).rows);
  const cfg: RiskConfig = { ...DEFAULT_RISK, ...(opts.risk ?? {}) };
  const risk = new RiskState(cfg, clock);
  const prices = new Map<string, number>([[MINT, 0.0001]]);
  const market: MarketClient = {
    async market(a): Promise<MarketInfo | undefined> { const p = prices.get(a); return p ? { chain: 'solana', priceUsd: p, liquidityUsd: 25_000, fdvUsd: 100_000, pairAgeMinutes: 30, buys24h: 400, sells24h: 300 } : undefined; },
    async rug() { return { risk: 'medium', freezeOrMintAuthority: false, reasons: [] }; },
  };
  const os = { floor: 0, sales: 0, calls: 0 };
  const opensea: OpenSeaClient = { async nft(slug) { os.calls++; return slug === 'lanternfolk' ? parseOpenSea(slug, OS_DROP, OS_COLL, osStats(os.floor, os.sales), 0.5e-9 * 180_000) : undefined; } };
  const sent: string[] = [];
  const notifier = { async send(t: string) { sent.push(t); } };
  const paper = new PaperExecutor(cfg, risk, store, notifier, clock, () => ETH_USD, opensea, () => 0.5);
  const perpPx: Record<string, number> = { BTC: 100_000, ETH: 4000 };
  const perp = { async mids() { return { ...perpPx }; }, async price(a: string) { return perpPx[a.toUpperCase()]; } };
  paper.perp = perp;
  // A mocked analyst: the test sets the answer; we record which model and which text went out
  const calls: { model: string; user: string; maxToolCalls?: number }[] = [];
  let analystReply: (user: string) => unknown = () => ({ verdict: 'ignore', thesis: 'nothing', confidence: 0.9 });
  const runAnalyst: AnalystRunner = async ({ model, user, exec, maxToolCalls }) => {
    calls.push({ model, user, maxToolCalls });
    const toolOut = await exec('fetch_page', { url: 'https://evil.example/steal' });
    expect(toolOut).toMatch(/refused/);
    return { verdict: analystReply(user), usage: [{ input_tokens: 6000, output_tokens: 700 }], toolCalls: ['fetch_page'] };
  };
  const gateCalls: string[] = [];
  let gateReply: (user: string) => unknown = () => ({ class: 'noise', escalate: false, confidence: 0.9 });
  const gateCall: GateCaller = async (_s, user) => { gateCalls.push(user); return { output: gateReply(user), usage: { input_tokens: 1500, output_tokens: 80 } }; };
  const triageCalls: string[] = [];
  let triageReply: (user: string) => unknown = () => ({ escalate: false, reason: 'banter' });
  const triageCall: GateCaller = async (_s, user) => { triageCalls.push(user); return { output: triageReply(user), usage: { input_tokens: 4000, output_tokens: 60 } }; };
  const budget = new LlmBudget({ ...DEFAULT_CAPS, ...(opts.caps ?? {}) }, clock, store);
  const legacyCalls: string[] = [];
  const deps: PipelineDeps = {
    mode: 'paper', store, trust, executor: paper, budget: new BudgetMeter(1, () => clock.utcDay()), notifier,
    extract: { callModel: async (_s, u) => { legacyCalls.push(u); return { intents: [] }; } },
    decide: { cfg, risk, market, clock, blacklist: new Blacklist(), ethUsd: () => ETH_USD, perp },
    intel: {
      windows: new ContextWindows(), cards: new ProjectCards(store), gateCfg: DEFAULT_GATE, budget, brief: 'BRIEF', gateCall, runAnalyst,
      enrich: { market, opensea, perp }, channelModel: DEFAULT_GATE.channelModels, ownPicks: 'paper', repeatHours: 24, watchRecheckMinutes: 60,
      chatBatchSize: opts.batch ?? 30, chatMaxWaitMinutes: 180, triageCall: opts.triage ? triageCall : undefined,
    },
  };
  return { clock, store, risk, paper, sent, deps, calls, gateCalls, legacyCalls, triageCalls, os, budget, prices, perpPx,
    setTriage: (f: (u: string) => unknown) => { triageReply = f; },
    setAnalyst: (f: (u: string) => unknown) => { analystReply = f; }, setGate: (f: (u: string) => unknown) => { gateReply = f; } };
}
let n = 0;
// Message time = the current virtual time (as with live Discord)
const msg = (over: Partial<RawMessage>): RawMessage => ({ id: `m${++n}`, sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', tsUtc: currentClock.iso(), text: '', ...over });

describe('channel modes and Discord markup', () => {
  it('mode column + defaults: alpha/calls → opus, chat/success → chat, ignore respected', () => {
    const t = new TrustTable(parseTrustCsv(CSV).rows);
    expect(t.channelMode('ServerA', 'core-calls')).toBe('opus');
    expect(t.channelMode('ServerB', 'chat')).toBe('chat');
    expect(t.channelMode('ServerA', 'off-topic')).toBe('ignore');
    expect(t.channelMode('ServerC', 'alpha')).toBe('opus');       // not in the table → by name
    expect(t.channelMode('ServerC', 'success')).toBe('chat');
    expect(t.channelMode('ServerA', 'token-chat')).toBe('chat');
    expect(parseTrustCsv('level,server,channel,author,score,mode\nchannel,A,b,,5,turbo\n').errors[0]).toMatch(/mode/);
  });
  it('Discord timestamps become UTC text; mentions become placeholders', () => {
    const t = discordMarkupToText('Public - <t:1792711500:F> in <#123> for <@&714> by <@!42> <:pepe:999>');
    expect(t).toBe('Public - 2026-10-22 23:25 UTC in #channel for @role by @user :pepe:');
  });
});

describe('project cards: two projects in one message stay separate', () => {
  it('Lanternfolk and Bramble get separate cards', () => {
    const store = new Store(':memory:');
    const cards = new ProjectCards(store);
    const text = discordMarkupToText(NFT_SAMPLE_MSG);
    expect(splitBlocks(text).length).toBeGreaterThan(3);
    const ents = codeEntities(text, prefilter(text));
    expect(ents.map(e => e.key).sort()).toEqual(['collection:lanternfolk', 'domain:bramblebots.xyz']);
    const ids = cards.observe(ents, { server: 'ServerA', channel: 'core-calls', author: 'caller', tsUtc: '2026-10-22T10:05:00Z', id: '1' }, 'mention', text);
    expect(ids.length).toBe(2);
    expect(cards.card(ids[0])!.keys).not.toEqual(cards.card(ids[1])!.keys);
  });
  it('one token block (address + ticker + site) is one project', () => {
    const store = new Store(':memory:');
    const cards = new ProjectCards(store);
    const text = `$INU ${MINT} https://pupkoi.xyz`;
    const ids = cards.observe(codeEntities(text, prefilter(text)), { server: 'ServerB', channel: 'degen', author: 'a', tsUtc: '2026-10-22T10:05:00Z', id: '1' }, 'mention', text);
    expect(ids.length).toBe(1);
    expect(cards.card(ids[0])!.keys.length).toBe(3);
  });
});

describe('OpenSea: Lanternfolk numbers computed by code', () => {
  const nft: NftInfo = parseOpenSea('lanternfolk', OS_DROP, OS_COLL, osStats(0, 0), 0.5e-9 * 180_000);
  it('allowlists, what is left for public, break-even', () => {
    expect(nft.chain).toBe('ethereum');
    expect(nft.contract).toBe(VOT_CONTRACT);
    expect(nft.derived.reservedByAllowlists).toBe(30 + 2742);
    expect(nft.derived.leftForPublicMin).toBe(4444 - 2772);
    expect(nft.derived.allowlistOverAllocated).toBe(false);
    expect(nft.derived.publicStage!.priceEth).toBe(0.001);
    expect(nft.derived.publicHours).toBe(72);
    expect(nft.sellFeesPct).toBe(6);
    expect(nft.derived.breakEvenFloorEth!).toBeCloseTo((0.001 + 0.00009) / 0.94, 6);
  });
  it('re-checks: 30 min after first phase and 30 min before public', () => {
    const t = nftRecheckTimes(nft, Date.parse('2026-10-22T10:05:00Z')).map(x => x.atUtc);
    expect(t).toEqual(['2026-10-22T22:55:00.000Z', '2026-10-22T17:45:00.000Z']);
  });
  it('live gas: Ethereum action at 0.5 gwei ≈ $0.26, not the old $3.6 floor', () => {
    liveGasGwei.set('ethereum', { gwei: 0.5, atMs: Date.now() });
    expect(estimateGasUsd('ethereum', ETH_USD)).toBeCloseTo(0.5e-9 * 180_000 * 1.3 * ETH_USD, 4);
    liveGasGwei.delete('ethereum');
    expect(estimateGasUsd('ethereum', ETH_USD)).toBeCloseTo(0.0015 * ETH_USD, 4);
  });
});

describe('alpha channel → analyst (the owner example 2026-10-22)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  const firstVerdict = {
    verdict: 'act', confidence: 0.75, thesis: 'Two NFT drops: Lanternfolk watch until public; Bramble raffle is free via X.',
    projects: [
      { ref: 'collection:lanternfolk', verdict: 'watch', category: 'nft', thesis: 'Free WL, 1672+ left for a 72h public at 0.001 ETH — only worth it if WL demand is strong.', publicNote: 'Lanternfolk public mint is on my list if WL demand stays strong.' },
      { ref: 'domain:bramblebots.xyz', verdict: 'act', category: 'nft', thesis: 'Free raffle on SUI, registration via X costs nothing.' },
    ],
    intents: [{ kind: 'social_task', chain: 'unknown', urls: ['https://bramblebots.xyz/bots'], summary: 'Register interest in the Bramble Bots raffle with the agent X account', stance: 'neutral', deadlineUtc: '2026-10-22T16:15:00Z', confidence: 0.8 }],
    publicNote: 'Free raffle, zero cost to enter.',
  };

  it('one Opus call; two cards with own verdicts; watch at 17:45 and 22:55; raffle scheduled at 16:15', async () => {
    s.setAnalyst(() => firstVerdict);
    const raw = msg({ text: discordMarkupToText(NFT_SAMPLE_MSG) });
    const r = await handleMessage(raw, s.deps);
    expect(s.calls.length).toBe(1);
    expect(s.calls[0].model).toBe('claude-opus-5-5');
    expect(s.calls[0].user).toContain('2026-10-22 23:25 UTC');          // the time is already in UTC
    expect(s.calls[0].user).toContain('"leftForPublicMin":1672');      // OpenSea dossier
    expect(r.decisions[0].action).toBe('scheduled');
    const verdicts = s.store.db.prepare('SELECT name, last_verdict FROM projects ORDER BY id').all() as any[];
    expect(verdicts.map(v => v.last_verdict)).toEqual(['watch', 'act']);
    const watch = (s.store.db.prepare('SELECT due_utc FROM watch ORDER BY due_utc').all() as any[]).map(w => w.due_utc);
    // 11:05 — "watch" without a time → recheck after 60 min (paper = hunting); 17:45 and 22:55 — by OpenSea phases
    expect(watch).toEqual(['2026-10-22T11:05:00.000Z', '2026-10-22T17:45:00.000Z', '2026-10-22T22:55:00.000Z']);
    expect(s.sent.some(t => t.includes('⏰'))).toBe(true);

    // 16:15 UTC — raffle: decide again, the agent's X account
    s.clock.set(Date.parse('2026-10-22T16:15:30Z'));
    await serialHandler(s.deps).tick();
    const last = s.store.db.prepare('SELECT action FROM decisions ORDER BY id DESC LIMIT 1').get() as any;
    expect(last.action).toBe('social_session');
    expect(s.sent.some(t => t.includes('X TASK'))).toBe(true);
  });

  it('repeat of the same message is not analyzed again', async () => {
    s.setAnalyst(() => firstVerdict);
    await handleMessage(msg({ text: discordMarkupToText(NFT_SAMPLE_MSG) }), s.deps);
    const r2 = await handleMessage(msg({ text: discordMarkupToText(NFT_SAMPLE_MSG), author: 'caller1' }), s.deps);
    expect(r2.skipped).toMatch(/repeat/);
    expect(s.calls.length).toBe(1);
  });

  it('22:55 re-check: strong WL demand → mint scheduled for 23:25 → at 23:25 skipped by tier cap (rule B)', async () => {
    s.setAnalyst(() => firstVerdict);
    await handleMessage(msg({ text: discordMarkupToText(NFT_SAMPLE_MSG) }), s.deps);
    s.os.floor = 0.004; s.os.sales = 120;
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, changeReason: 'WL floor rose to 0.004 vs break-even 0.00116 since the last check', thesis: 'WL demand strong: floor 0.004 vs break-even 0.00116.',
      projects: [{ ref: 'collection:lanternfolk', verdict: 'act', category: 'nft', thesis: 'Mint public, flip at floor.' }],
      intents: [{ kind: 'mint', chain: 'ethereum', contractAddress: VOT_CONTRACT, urls: [], summary: 'Mint 1 Lanternfolk in public', stance: 'buy', deadlineUtc: '2026-10-22T23:25:00Z', confidence: 0.8 }],
      nftPlan: { style: 'flip' }, publicNote: 'WL floor well above the public price.' }));
    s.clock.set(Date.parse('2026-10-22T17:45:10Z'));
    await serialHandler(s.deps).tick();          // 17:45 — the first recheck
    s.clock.set(Date.parse('2026-10-22T22:55:10Z'));
    await serialHandler(s.deps).tick();          // 22:55 — 30 minutes before public
    expect(s.calls.length).toBe(4);   // + the "watch" recheck after 60 min
    expect(s.calls[3].user).toContain('scheduled_recheck');
    s.clock.set(Date.parse('2026-10-22T23:25:20Z'));
    await serialHandler(s.deps).tick();
    const last = s.store.db.prepare('SELECT action, reasons FROM decisions ORDER BY id DESC LIMIT 1').get() as any;
    expect(last.action).toBe('skip');
    expect(last.reasons).toMatch(/exceeds tier cap \$2\.00/);
  });

  it('same flow with rule A (cap counts mint price, gas separately) → NFT position, flip at floor, post drafts', async () => {
    s = setup({ risk: { mintCapExcludesGas: true } });
    s.setAnalyst(() => firstVerdict);
    await handleMessage(msg({ text: discordMarkupToText(NFT_SAMPLE_MSG) }), s.deps);
    s.os.floor = 0.004; s.os.sales = 120;
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, changeReason: 'WL floor rose to 0.004 vs break-even 0.00116 since the last check', thesis: 'WL demand strong.',
      projects: [{ ref: 'collection:lanternfolk', verdict: 'act', category: 'nft', thesis: 'Mint public, flip.' }],
      intents: [{ kind: 'mint', chain: 'ethereum', contractAddress: VOT_CONTRACT, urls: [], summary: 'Mint 1 Lanternfolk in public', stance: 'buy', deadlineUtc: '2026-10-22T23:25:00Z', confidence: 0.8 }],
      nftPlan: { style: 'flip' }, publicNote: 'WL floor well above the public price.' }));
    s.clock.set(Date.parse('2026-10-22T22:55:10Z'));
    await serialHandler(s.deps).tick();
    s.clock.set(Date.parse('2026-10-22T23:25:20Z'));
    await serialHandler(s.deps).tick();
    expect(s.risk.positions.length).toBe(1);
    expect(s.risk.positions[0].token).toBe('nft:lanternfolk');
    expect(s.risk.positions[0].costUsd).toBeCloseTo(0.001 * ETH_USD + 0.5e-9 * 180_000 * 1.3 * ETH_USD, 2);
    expect(s.sent.some(t => t.includes('🐦') && t.includes('lanternfolk from the public mint') && t.includes('I hold this'))).toBe(true);
    // The post does not name the source
    expect(s.sent.filter(t => t.includes('🐦')).every(t => !/\bminted\b|core-calls|caller|discord/i.test(t))).toBe(true);
    await s.paper.monitor({ market: async () => undefined, rug: async () => undefined });
    expect(s.risk.positions.length).toBe(0);
    expect(s.risk.equityUsd).toBeGreaterThan(10);   // 0.004 × 0.94 ETH > costs
  });

  it('analyst cannot inject an address that is neither in the message nor from OpenSea', async () => {
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'mint now',
      intents: [{ kind: 'mint', chain: 'ethereum', contractAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', urls: [], summary: 'mint', stance: 'buy', confidence: 0.9 }] }));
    const r = await handleMessage(msg({ text: discordMarkupToText(NFT_SAMPLE_MSG) }), s.deps);
    expect(r.decisions[0].action).toBe('journal_only');
    expect(r.decisions[0].reasons.join(' ')).toMatch(/no contract address/);
  });

  it('watch with a public note → a thought for X ($TICKER, no source); no note → no thought (the owner 2026-10-24)', async () => {
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, thesis: 'fresh, needs a day', project: { name: 'PupKoi', category: 'memecoin' }, publicNote: 'Watching $PUPKOI: real flow, thin liquidity. One more day of range and I want in.' }));
    const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    expect(r.analysis?.thought).toMatchObject({ verdict: 'watch', holding: false, confidence: 0.7, note: 'Watching $PUPKOI: real flow, thin liquidity. One more day of range and I want in.' });
    expect(['PupKoi', '$PUPKOI']).toContain(r.analysis?.thought?.subject);
    expect(r.analysis?.thought?.chain).toBe('solana');
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, thesis: 'fresh' }));
    const r2 = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED.replace('PupKoi', 'PupKoa') + ' ' }), s.deps);
    expect(r2.analysis?.thought).toBeUndefined();
  });

  it('hard code check (2026-10-27): mint/freeze authority → avoid without the model; repeat of that is skipped for 7 days', async () => {
    const m0 = s.deps.intel!.enrich.market;
    s.deps.intel!.enrich.market = { ...m0, async rug() { return { risk: 'high', freezeOrMintAuthority: true, reasons: [] }; } } as any;
    const r = await handleMessage(msg({ text: `aping ${MINT}` }), s.deps);
    expect(s.calls.length).toBe(0);
    expect(r.analysis).toMatchObject({ model: 'code', verdict: 'avoid', costUsd: 0 });
    expect(r.analysis?.thesis).toMatch(/mint\/freeze authority/);
    s.clock.advance(30 * 3600_000);
    const r2 = await handleMessage(msg({ text: `again ${MINT}` }), s.deps);
    expect(r2.skipped).toMatch(/repeat/);
    s.deps.intel!.enrich.market = m0;
  });

  it('review journal (2026-10-28): every analysis is written with the case, thinking, tools, verdict and cost', async () => {
    const recs: { kind: string; data: any }[] = [];
    const { setReviewSink } = await import('../src/review/log.js');
    setReviewSink({ write: (kind, data) => recs.push({ kind, data }) });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, thesis: 'fresh, needs a day', publicNote: 'Watching it.' }));
    await handleMessage(msg({ text: `look ${MINT}` }), s.deps);
    setReviewSink({ write() {} });
    const a = recs.find(r => r.kind === 'analysis')!;
    expect(a.data).toMatchObject({ source: 'ServerA/#core-calls/caller', verdict: { verdict: 'watch', thesis: 'fresh, needs a day' } });
    expect(a.data.case).toContain('THE MESSAGE');
    expect(typeof a.data.costUsd).toBe('number');
  });

  it('scan-feed uses Haiku (cheapest); repeated scan of the same token is not re-analyzed', async () => {
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'fresh token with flow',
      intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy PupKoi', stance: 'buy', confidence: 0.8 }] }));
    const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    expect(s.calls[0].model).toBe('claude-haiku-5-5');
    expect(r.decisions[0].action).toBe('buy_token');
    expect(s.sent.some(t => t.includes('🐦') && t.includes('I hold this'))).toBe(true);
    const r2 = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    expect(r2.skipped).toMatch(/repeat/);
    expect(s.calls.length).toBe(1);
  });

  it('"gm" in an alpha channel is trivial: no model call', async () => {
    const r = await handleMessage(msg({ text: 'gm 🔥' }), s.deps);
    expect(r.skipped).toBe('trivial');
    expect(s.calls.length).toBe(0);
  });
});

describe('chat channels → batches of 30 for the analyst (the owner 2026-10-22)', () => {
  it('chat messages are buffered without any model call until the batch is full; then one call sees all of them', async () => {
    const s = setup();
    for (let i = 0; i < 29; i++) {
      const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: `u${i}`, text: i === 3 ? `new one ${MINT} looks clean` : `message number ${i} about the market today` }), s.deps);
      expect(r.skipped).toMatch(/buffered/);
    }
    expect(s.calls.length).toBe(0);
    expect(s.gateCalls.length).toBe(0);
    s.setAnalyst(() => ({ verdict: 'ignore', confidence: 0.8, thesis: 'noise' }));
    const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u29', text: 'last one' }), s.deps);
    expect(s.calls.length).toBe(1);
    expect(s.calls[0].user).toContain('CHAT DIGEST: 30 messages');
    expect(s.calls[0].user).toContain('[30]');
    expect(s.calls[0].user).toContain(MINT);
    expect(r.analysis?.verdict).toBe('ignore');
    expect((s.store.db.prepare('SELECT COUNT(*) n FROM chat_buffer').get() as any).n).toBe(0);
  });

  it('action from a batch: source message by sourceIdx, credited to its author (own pick in paper)', async () => {
    const s = setup({ batch: 4 });
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.85, thesis: 'people are buying, flow is real', projects: [{ ref: `sol:${MINT}`, verdict: 'act', category: 'memecoin', thesis: 'flow' }],
      intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8, sourceIdx: 1 }] }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'scout', text: `new one ${MINT} looks clean` }), s.deps);
    for (const a of ['u2', 'u3', 'u4']) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: a, text: 'aped this one, chart looks strong' }), s.deps);
    const d = s.store.db.prepare("SELECT author, action, reasons FROM decisions WHERE action='buy_token'").get() as any;
    expect(d?.author).toBe('scout');
    expect(d.reasons).toMatch(/analyst own pick/);
  });

  // A-13 (#105, the owner 2026-11-11 13:17 UTC): "let it trade on paper if it is 0.6+ confident". The trigger — $TOBIQ from a batch, 0.6.
  describe('own pick threshold OWN_PICK_CONFIDENCE (A-13)', () => {
    const ownPick = async (confidence: number, mode: 'paper' | 'live' = 'paper', ownPicks?: 'on') => {
      const s = setup({ batch: 2 });
      if (mode === 'live') (s.deps as any).mode = 'live';
      if (ownPicks) s.deps.intel!.ownPicks = ownPicks;
      s.setAnalyst(() => ({ verdict: 'act', confidence, thesis: 'people are buying, flow is real',
        intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence, sourceIdx: 1 }] }));
      await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'scout', text: `new one ${MINT} looks clean` }), s.deps);
      const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u2', text: 'aped this one, chart looks strong' }), s.deps);
      return r.decisions;
    };
    it('OWN_PICK_CONFIDENCE (example 0.65) → paper trade, trust treated as 4', async () => {
      const d = await ownPick(0.65);
      expect(d.map(x => x.action)).toEqual(['buy_token']);
      expect(d[0].reasons.join(' ')).toMatch(/analyst own pick \(source trust \d\) → treated as 4, full checks/);
    });
    it('S-07 V1: own pick opens the position with the «scan» exit profile (risk.json memecoinClasses)', async () => {
      const s = setup({ batch: 2 });
      const real = loadConfig({ AGENT_ROOT: resolve(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk as any;
      (s.deps.decide as any).cfg = { ...s.deps.decide.cfg, memecoinClasses: real.memecoinClasses };
      s.setAnalyst(() => ({ verdict: 'act', confidence: 0.7, thesis: 'people are buying, flow is real',
        intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.7, sourceIdx: 1 }] }));
      await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'scout', text: `new one ${MINT} looks clean` }), s.deps);
      await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u2', text: 'aped this one, chart looks strong' }), s.deps);
      const pos = [...s.paper.open.values()];
      expect(pos.length).toBe(1);
      expect(pos[0].tokenClass).toBe('scan');
      expect(pos[0].ladder?.length).toBe(2);
    });
    it('0.59 → no trade: below the common action floor MIN_VERDICT_CONFIDENCE 0.6, one skip decision with the reason', async () => {
      const d = await ownPick(0.59);
      expect(d.filter(x => x.action === 'buy_token')).toEqual([]);
      // after A-09 (#92) an ACT without an action leaves a skip decision with a reason; still no trade
      expect(d.some(x => x.reasons.join(' ').includes('own pick'))).toBe(false);
      expect(d.map(x => x.action)).toEqual(['skip']);
      expect(d[0].reasons.join(' ')).toContain('confidence 0.59 < 0.6 — no action');
    });
    it('live mode with AGENT_OWN_PICKS=paper → journal only', async () => {
      const d = await ownPick(0.9, 'live');
      expect(d.map(x => x.action)).toEqual(['journal_only']);
      expect(d[0].reasons.join(' ')).not.toMatch(/own pick/);
    });
    // Acceptance #112, round 1: the paper threshold is only for paper; AGENT_OWN_PICKS=on in live keeps its own threshold (example 0.85)
    for (const conf of [0.65, 0.84]) it(`live mode with AGENT_OWN_PICKS=on, confidence ${conf} → no buy (live threshold, example 0.85)`, async () => {
      const d = await ownPick(conf, 'live', 'on');
      expect(d.map(x => x.action)).not.toContain('buy_token');
      expect(d.map(x => x.reasons.join(' ')).join(' ')).not.toMatch(/own pick/);
    });
    it('live mode with AGENT_OWN_PICKS=on, confidence 0.85 → own pick as before A-13', async () => {
      const d = await ownPick(0.85, 'live', 'on');
      expect(d.map(x => x.action)).toEqual(['buy_token']);
      expect(d[0].reasons.join(' ')).toMatch(/analyst own pick \(source trust \d\) → treated as 4, full checks/);
    });
  });

  it('address that is not in the source message is dropped; a warning message cannot be a buy source', async () => {
    const s = setup({ batch: 2 });
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'x', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9, sourceIdx: 1 }] }));
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'chat', author: 'caller1', text: `${MINT} is a rug, avoid` }), s.deps);
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'chat', author: 'shill', text: 'ape the one above, 100x' }), s.deps);
    expect(s.risk.positions.length).toBe(0);
  });

  it('warning about a held token: flushed at once; unscored author → alert only; trusted author → exit', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'ok', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    expect(s.risk.positions.length).toBe(1);
    s.setAnalyst(() => ({ verdict: 'avoid', confidence: 0.8, thesis: 'dev sold', exits: [{ token: MINT, reason: 'dev dumped', sourceIdx: 1 }] }));
    // ServerC chat in the test table = 2 → an author without a score gets 0 → alert only
    const r = await handleMessage(msg({ sourceServer: 'ServerC', channel: 'chat', author: 'x', text: `dev sold everything on ${MINT}, rug` }), s.deps);
    expect(r.analysis).toBeDefined();               // did not wait for 30 messages
    expect(r.exits).toBeUndefined();
    expect(s.risk.positions.length).toBe(1);
    expect(s.sent.some(t => t.includes('⚠️ Alarm'))).toBe(true);
    // caller1 (9 in ServerA) — exit
    const r2 = await handleMessage(msg({ sourceServer: 'ServerA', channel: 'chat', author: 'caller1', text: `dev wallet dumped on ${MINT}, get out` }), s.deps);
    expect(r2.exits).toEqual([MINT]);
    expect(s.risk.positions.length).toBe(0);
  });

  it('triage (the owner 2026-10-23): Haiku reads the batch first; noise never reaches Opus', async () => {
    const s = setup({ batch: 5, triage: true });
    for (let i = 0; i < 5; i++) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: `u${i}`, text: `gm frens ${i}, market is slow` }), s.deps);
    expect(s.triageCalls.length).toBe(1);
    expect(s.triageCalls[0]).toContain('[5]');
    expect(s.calls.length).toBe(0);
    const a = s.store.db.prepare("SELECT model, trigger, verdict FROM analyses").get() as any;
    expect(a).toMatchObject({ model: 'claude-haiku-5-5', trigger: 'chat_triage(5)', verdict: 'ignore' });
    expect(s.budget.spent('claude-haiku-5-5')).toBeGreaterThan(0);
    expect(s.budget.spent('claude-opus-5-5')).toBe(0);
  });

  it('triage escalates → Sonnet sees only the flagged messages + context, 2 tools, chat cap; urgent warning skips triage', async () => {
    const s = setup({ batch: 4, triage: true });
    s.setTriage(() => ({ escalate: true, focus: [2, 99], names: ['BOBO', 'invented'], reason: 'fresh token with a buyer' }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, thesis: 'early', recheckAfterMinutes: 30 }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'a', text: 'gm' }), s.deps);
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'scout', text: `$BOBO ${MINT} just launched` }), s.deps);
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'c', text: 'in' }), s.deps);
    const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'd', text: 'me too' }), s.deps);
    expect(s.triageCalls.length).toBe(1);
    expect(s.calls.length).toBe(1);
    expect(s.calls[0].model).toBe('claude-sonnet-5-5');
    expect(s.calls[0].maxToolCalls).toBe(2);
    expect(s.calls[0].user).toContain('cheap triage flagged it: fresh token with a buyer — look first at messages [2]');
    expect(s.calls[0].user).not.toContain('[99]');
    expect(s.calls[0].user).toContain('picked out of 4');
    expect(s.calls[0].user).toContain('[1]');
    expect(s.calls[0].user).not.toContain('me too');
    expect(s.budget.spent('tag:chat')).toBeGreaterThan(0);
    expect(s.budget.spent('claude-opus-5-5')).toBe(0);
    expect(r.analysis?.verdict).toBe('watch');
    // An alarm about our position — straight to the analyst, without triage
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'ok', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    expect(s.risk.positions.length).toBe(1);
    s.setAnalyst(() => ({ verdict: 'avoid', confidence: 0.8, thesis: 'dev sold', exits: [{ token: MINT, reason: 'dev dumped', sourceIdx: 1 }] }));
    const callsBefore = s.calls.length;
    const r2 = await handleMessage(msg({ sourceServer: 'ServerA', channel: 'chat', author: 'caller1', text: `dev wallet dumped on ${MINT}, get out` }), s.deps);
    expect(s.triageCalls.length).toBe(1);
    expect(s.calls.length).toBe(callsBefore + 1);
    expect(r2.exits).toEqual([MINT]);
  });

  it('chat review cap reached → triage still runs, flagged batch goes to the journal only', async () => {
    const s = setup({ batch: 3, triage: true });
    s.deps.intel!.chatDailyUsd = 0.01;
    s.budget.record('tag:chat', 0.02);
    s.setTriage(() => ({ escalate: true, focus: [1], reason: 'token' }));
    for (const a of ['a', 'b', 'c']) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: a, text: `look ${MINT}` }), s.deps);
    expect(s.triageCalls.length).toBe(1);
    expect(s.calls.length).toBe(0);
  });

  it('focus window: flagged + up to 10 context messages, original numbering', async () => {
    const { focusWindow } = await import('../src/intel/router.js');
    expect(focusWindow(50, [30])).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(focusWindow(50, [5, 40])).toEqual([1, 2, 3, 4, 5, 38, 39, 40]);
    expect(focusWindow(50, [])).toEqual(Array.from({ length: 15 }, (_, i) => 36 + i));
    expect(focusWindow(50, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).length).toBe(12);
  });

  it('slow chat: a batch of ≥ 5 messages goes to the analyst after the wait time', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, thesis: 'slow chat' }));
    for (let i = 0; i < 5; i++) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: `a${i}`, text: `thinking about $BOBO ${i}` }), s.deps);
    expect(s.calls.length).toBe(0);
    s.clock.advance(181 * 60_000);
    await serialHandler(s.deps).tick();
    expect(s.calls.length).toBe(1);
    expect(s.calls[0].user).toMatch(/waited 181 min, 5 messages/);
  });
});

describe('budget', () => {
  it('Opus over its cap → Sonnet; both over → trusted source uses Haiku extraction, unknown → journal', async () => {
    const s = setup({ caps: { opusDailyUsd: 0.001, sonnetDailyUsd: 0.001 } });
    await handleMessage(msg({ text: 'Mint at 18:00 UTC, free, https://newproj.xyz' }), s.deps);
    expect(s.calls[0].model).toBe('claude-opus-5-5');
    await handleMessage(msg({ text: 'Another one at 19:00 UTC https://other.xyz mint' }), s.deps);
    expect(s.calls[1].model).toBe('claude-sonnet-5-5');
    await handleMessage(msg({ text: 'Third: mint https://third.xyz' }), s.deps);
    expect(s.legacyCalls.length).toBe(1);
    const r = await handleMessage(msg({ sourceServer: 'ServerC', channel: 'alpha', author: 'x', text: 'mint https://fourth.xyz' }), s.deps);
    expect(r.skipped).toMatch(/budget exhausted|journal/);
  });
  it('cost from usage: Opus 6k in + 700 out ≈ $0.038; cache reads are 20× cheaper', () => {
    expect(costUsd('claude-opus-5-5', { input_tokens: 6000, output_tokens: 700 })).toBeCloseTo(0.038, 3);
    expect(costUsd('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2, 6);
  });
});

describe('X post drafts and safety helpers', () => {
  it('drafts never name the source and always disclose', () => {
    const { text, problems } = draftPost({ kind: 'nft_mint', asset: 'lanternfolk', chain: 'ethereum', sizeUsd: 2.6, note: 'A caller in ServerA said so', holding: true }, ['ServerA', 'core-calls', 'caller']);
    expect(problems).toEqual([]);
    expect(text).not.toMatch(/ServerA|caller/);
    expect(text).toMatch(/I hold this/);
    expect(leaks('saw it in our discord', [])).not.toEqual([]);
  });
  it('page fetcher refuses private addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1']) expect(isPrivateIp(ip)).toBe(true);
    expect(isPrivateIp('104.16.0.1')).toBe(false);
  });
});

describe('regressions from the independent review (2026-10-22)', () => {
  it('#2 merge inside observe never returns a deleted project id', () => {
    const store = new Store(':memory:'); const cards = new ProjectCards(store);
    const m = { server: 'ServerA', channel: 'core-calls', author: 'a', tsUtc: '2026-10-22T10:00:00Z', id: '1' };
    cards.observe(codeEntities('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01 https://abc.xyz', prefilter('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01 https://abc.xyz')), m, 'mention', '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01 https://abc.xyz');
    cards.observe(codeEntities('$ABC', prefilter('$ABC')), m, 'mention', '$ABC');
    const t = '$ABC\n\n0xAbCdEf0123456789aBcDeF0123456789AbCdEf01 https://abc.xyz $ABC';
    const ids = cards.observe(codeEntities(t, prefilter(t)), m, 'mention', t);
    for (const id of ids) expect(cards.card(id)).toBeDefined();
  });

  it('#1 an unscored user cannot glue a collection onto a known card; rechecks use only the watched message', () => {
    const store = new Store(':memory:'); const cards = new ProjectCards(store);
    const m = (author: string) => ({ server: 'ServerA', channel: 'chat', author, tsUtc: '2026-10-22T10:00:00Z', id: author });
    const t1 = '$ABC https://abc.xyz';
    const [legit] = cards.observe(codeEntities(t1, prefilter(t1)), m('caller'), 'mention', t1, true, 9);
    const t2 = 'https://opensea.io/collection/evil $ABC https://abc.xyz';
    cards.observe(codeEntities(t2, prefilter(t2)), m('attacker'), 'mention', t2, true, 0);
    expect(cards.card(legit)!.keys).not.toContain('collection:evil');
  });

  it('#3 exit without a price does not book a 100% loss', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'ok', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    s.prices.delete(MINT);
    const closed = await s.paper.exitToken(MINT, 'test', s.deps.decide.market);
    expect(closed).toBe(false);
    expect(s.risk.positions.length).toBe(1);
  });

  it('#5 a trusted warning in the channel window does not lend its trust to a later shill', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'avoid', confidence: 0.9, thesis: 'rug' }));
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'chat', author: 'caller1', text: `${MINT} is a rug, avoid` }), s.deps);
    s.setGate(() => ({ class: 'action', escalate: true, refersTo: [], confidence: 0.9 }));
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.7, thesis: 'pump', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    s.clock.advance(25 * 3600_000);
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'chat', author: 'shill', text: 'this is going to 100x, ape the rug-proof one' }), s.deps);
    expect(s.risk.positions.length).toBe(0);
  });

  it('#6 the same scheduled action is stored once', async () => {
    const s = setup();
    const v = { verdict: 'act', confidence: 0.8, thesis: 'raffle', intents: [{ kind: 'social_task', chain: 'unknown', urls: ['https://bramblebots.xyz/bots'], summary: 'register', stance: 'neutral', deadlineUtc: '2026-10-22T16:15:00Z', confidence: 0.8 }] };
    s.setAnalyst(() => v);
    await handleMessage(msg({ text: 'Bramble raffle registration https://bramblebots.xyz/bots opens 16:15 UTC' }), s.deps);
    await handleMessage(msg({ author: 'caller1', text: 'Bramble raffle https://bramblebots.xyz/bots — register at 16:15 UTC, free mint' }), s.deps);
    expect((s.store.db.prepare('SELECT COUNT(*) n FROM scheduled').get() as any).n).toBe(1);
  });

  it('#7 times without a zone are UTC, not server-local', async () => {
    const { utcMs } = await import('../src/time.js');
    expect(utcMs('2026-10-22T23:25:00')).toBe(Date.parse('2026-10-22T23:25:00Z'));
    expect(utcMs('2026-10-22 23:25 UTC')).toBe(Date.parse('2026-10-22T23:25:00Z'));
    expect(utcMs('2026-10-22T23:25:00+07:00')).toBe(Date.parse('2026-10-22T16:25:00Z'));
    expect(Number.isNaN(utcMs('tomorrow evening'))).toBe(true);
  });

  it('#8 a trusted call is analyzed even if an unscored user posted the token first', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'ignore', confidence: 0.6, thesis: 'unknown source' }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'nobody', text: `${MINT}` }), s.deps);
    const r = await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller1', text: `buying ${MINT}` }), s.deps);
    expect(r.skipped).toBeUndefined();
    expect(s.calls.length).toBe(2);
  });

  it('#12 spend is recorded even when the analyst fails', async () => {
    const s = setup();
    const { AnalystError } = await import('../src/analyst/analyst.js');
    s.deps.intel!.runAnalyst = async () => { throw new AnalystError('no verdict', [{ input_tokens: 10000, output_tokens: 2000 }]); };
    await handleMessage(msg({ text: 'mint https://some.xyz free' }), s.deps);
    expect(s.budget.spent('claude-opus-5-5')).toBeCloseTo(0.08, 3);
  });

  it('#13 a tiny gas hint in the text cannot undercut the live gas price', () => {
    liveGasGwei.set('ethereum', { gwei: 20, atMs: Date.now() });
    expect(estimateGasUsd('ethereum', ETH_USD, { min: 0.00001, max: 0.00001 })).toBeCloseTo(20e-9 * 180_000 * 1.3 * ETH_USD, 3);
    liveGasGwei.delete('ethereum');
  });

  it('#14 leak check catches names that start with a symbol', () => {
    expect(leaks('thanks caller1 for this', ['caller1'])).not.toEqual([]);
    expect(leaks('saw it on serverb', ['ServerB'])).not.toEqual([]);
  });

  it('#16 a free mint can open an NFT position (gas only)', async () => {
    const s = setup({ risk: { mintCapExcludesGas: true } });
    const free = { ...OS_DROP, stages: OS_DROP.stages.map(x => x.stage_type === 'public_sale' ? { ...x, price: '0' } : x) };
    s.deps.intel!.enrich.opensea = { async nft(slug) { return slug === 'lanternfolk' ? parseOpenSea(slug, free, OS_COLL, osStats(0.002, 50), 0.00009) : undefined; } };
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'free', intents: [{ kind: 'mint', chain: 'ethereum', contractAddress: VOT_CONTRACT, urls: [], summary: 'mint', stance: 'buy', confidence: 0.8 }], nftPlan: { style: 'flip' } }));
    await handleMessage(msg({ text: 'free public mint https://opensea.io/collection/lanternfolk' }), s.deps);
    expect(s.risk.positions.map(p => p.token)).toEqual(['nft:lanternfolk']);
  });

  it('#17 Magic Eden links are not looked up on OpenSea', () => {
    const t = 'https://magiceden.io/marketplace/lanternfolk';
    expect(codeEntities(t, prefilter(t)).map(e => e.key)).toEqual(['me:lanternfolk']);
  });

  it('#11 more non-public ranges are refused', () => {
    for (const ip of ['198.18.0.1', '224.0.0.1', '240.0.0.1', '192.0.0.8', '64:ff9b::a9fe:a9fe', '::169.254.169.254', 'fec0::1']) expect(isPrivateIp(ip)).toBe(true);
  });
});

describe('team calls in channels rated ≤ 6: careful mode (the owner 2026-10-22)', () => {
  const strong = { verdict: 'act', confidence: 0.8, thesis: 'listing catalyst tonight, volume confirms', thesisStrength: 8, expectedHoldHours: 6,
    intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] };
  const call = () => msg({ sourceServer: 'ServerB', channel: 'degen', author: 'teammate', text: `entry here ${MINT} — listing tonight` });

  it('unscored author in a careful team channel inherits its score with the careful flag', () => {
    const t = new TrustTable(parseTrustCsv(CSV).rows);
    const r = t.resolve('ServerB', 'degen', 'teammate');
    expect(r.score).toBe(5); expect(r.careful).toBe(true); expect(r.tier).toBe('full');
    expect(t.resolve('ServerB', 'chat', 'teammate').score).toBe(0); // a regular channel ≤ 6 — still 0
  });

  it('weak thesis or long hold → skip', async () => {
    const s = setup();
    s.setAnalyst(() => ({ ...strong, thesisStrength: 5 }));
    const r1 = await handleMessage(call(), s.deps);
    expect(r1.decisions[0].action).toBe('skip');
    expect(r1.decisions[0].reasons.join(' ')).toMatch(/thesis 5 < 8/);
    const s2 = setup();
    s2.setAnalyst(() => ({ ...strong, expectedHoldHours: 72 }));
    const r2 = await handleMessage(call(), s2.deps);
    expect(r2.decisions[0].reasons.join(' ')).toMatch(/hold 72 h > 18 h/);
    expect(s2.risk.positions.length).toBe(0);
  });

  it('strong short thesis → half size, tighter exits', async () => {
    const s = setup();
    s.setAnalyst(() => strong);
    const r = await handleMessage(call(), s.deps);
    expect(r.decisions[0].action).toBe('buy_token');
    expect(s.risk.positions[0].costUsd).toBeCloseTo(0.32 + 0.01, 2);      // example: 8% × 0.4 of $10 + gas
    const pos = [...s.paper.open.values()][0];
    expect(pos.stopPrice).toBeCloseTo(pos.entryPrice / 1.01 * 0.8, 8);    // stop −20% from the call price (example)
    expect(pos.timeStopAtMs - pos.openedAtMs).toBe(10 * 3600_000);
  });

  it('careful source never trades without the analyst (budget exhausted path)', async () => {
    const { decide, Blacklist: BL } = await import('../src/decide/decide.js');
    const s = setup();
    const t = new TrustTable(parseTrustCsv(CSV).rows).resolve('ServerB', 'degen', 'teammate');
    const d = await decide({ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }, t, prefilter(MINT), { ...s.deps.decide, blacklist: new BL() }, { mainTextAddresses: new Set([MINT]) });
    expect(d.action).toBe('journal_only');
    expect(d.reasons.join(' ')).toMatch(/careful/);
  });
});

describe('startup: Discord errors and history check', () => {
  it('explains Discord errors in plain words', async () => {
    const { explainDiscordError } = await import('../src/intake/discordBot.js');
    expect(explainDiscordError(new Error('An invalid token was provided.'))).toMatch(/Invalid Discord bot token/);
    expect(explainDiscordError(new Error('Used disallowed intents'))).toMatch(/Message Content Intent/);
  });

  it('history messages: processed once, analyst told it is history, decisions marked and kept out of source stats', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'still open', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    const old = { ...msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), tsUtc: '2026-10-22T02:00:00.000Z', backfill: true };
    const r = await handleMessage(old, s.deps);
    expect(s.calls[0].user).toMatch(/HISTORY CHECK/);
    expect(s.calls[0].user).toMatch(/485 min ago/);
    expect(r.decisions[0].reasons[0]).toMatch(/^backfill:/);
    const again = await handleMessage({ ...old, backfill: false }, s.deps);
    expect(again.skipped).toBe('already processed');
  });
});

describe('scan-feed: code prefilter before any model (the owner 2026-10-22)', () => {
  it('a token without liquidity / sells never reaches a model, but its price is journaled', async () => {
    const s = setup();
    s.deps.decide.market = { async market() { return { chain: 'solana', priceUsd: 0.0001, liquidityUsd: 900, fdvUsd: 5000, pairAgeMinutes: 3, buys24h: 5, sells24h: 0 }; }, async rug() { return { risk: 'high', freezeOrMintAuthority: true, reasons: [] }; } };
    const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    expect(r.skipped).toMatch(/scan prefilter: liquidity \$900 < \$8000; buys 5 < 15; no sells/);
    expect(s.calls.length).toBe(0);
    const d = s.store.db.prepare('SELECT action, price_at_decision FROM decisions').get() as any;
    expect(d.action).toBe('journal_only'); expect(d.price_at_decision).toBe(0.0001);
  });
});

describe('perps: position calls on majors (the owner 2026-10-22)', () => {
  const longBtc = (over: Record<string, unknown> = {}) => ({ verdict: 'act', confidence: 0.8, thesis: 'trusted caller opened a low-leverage BTC long',
    intents: [{ kind: 'perp_trade', chain: 'unknown', asset: 'BTC', side: 'long', leverage: 3, stopPrice: 97_000, takeProfitPrice: 106_000, urls: [], summary: 'long BTC', stance: 'buy', confidence: 0.8, ...over }] });

  it('trusted caller "opened a long on BTC, low leverage" → paper perp with stop, take, risk ≤ 2%', async () => {
    const s = setup();
    s.setAnalyst(() => longBtc());
    const r = await handleMessage(msg({ author: 'caller1', text: 'Opened a long on BTC here with low leverage, invalidation below 97k' }), s.deps);
    expect(r.decisions[0].action).toBe('open_perp');
    expect(s.calls[0].user).toContain('"perps":{"BTC":100000}');
    const pos = [...s.paper.perpOpen.values()][0];
    expect(pos.side).toBe('long'); expect(pos.leverage).toBe(3); expect(pos.stop).toBe(97_000); expect(pos.takeProfit).toBe(106_000);
    const lossAtStop = pos.notionalUsd * 0.03 + pos.notionalUsd * 0.0005 * 2;
    expect(lossAtStop).toBeLessThanOrEqual(10 * 0.02 + 1e-6);
    expect(s.sent.some(t => t.includes('PERP LONG BTC 3x'))).toBe(true);
    // the price reached the take-profit → the position is closed in profit
    s.perpPx.BTC = 106_500;
    await s.paper.monitor({ market: async () => undefined, rug: async () => undefined });
    expect(s.paper.perpOpen.size).toBe(0);
    expect(s.risk.equityUsd).toBeGreaterThan(10);
  });

  it('stop hit → closed at a loss not bigger than ~2% of capital', async () => {
    const s = setup();
    s.setAnalyst(() => longBtc());
    await handleMessage(msg({ author: 'caller1', text: 'long BTC, small size' }), s.deps);
    s.perpPx.BTC = 96_900;
    await s.paper.monitor({ market: async () => undefined, rug: async () => undefined });
    expect(s.paper.perpOpen.size).toBe(0);
    expect(10 - s.risk.equityUsd).toBeLessThan(0.25);
  });

  it('missing or wrong-side stop → default stop (example 4%); leverage capped (example 4x); asset not in the text → no trade', async () => {
    const s = setup();
    s.setAnalyst(() => longBtc({ stopPrice: 101_000, takeProfitPrice: undefined, leverage: 50 }));
    await handleMessage(msg({ author: 'caller1', text: 'BTC long, sending it' }), s.deps);
    const pos = [...s.paper.perpOpen.values()][0];
    expect(pos.stop).toBeCloseTo(96_000, 0); expect(pos.leverage).toBe(4); expect(pos.takeProfit).toBeCloseTo(110_000, 0);
    const s2 = setup();
    s2.setAnalyst(() => longBtc({ asset: 'ETH' }));
    const r2 = await handleMessage(msg({ author: 'caller1', text: 'BTC long, sending it' }), s2.deps);
    expect(r2.decisions[0].action).toBe('journal_only');
  });
});

describe('ServerA token-chat works like scan-feed (the owner 2026-10-22)', () => {
  it('token in token-chat → code prefilter → Haiku; talk without a token → no model', async () => {
    const s = setup();
    const t = new TrustTable(parseTrustCsv('level,server,channel,author,score,mode\nchannel,ServerA,token-chat,,3,opus\n').rows);
    s.deps.trust = t;
    s.setAnalyst(() => ({ verdict: 'ignore', confidence: 0.8, thesis: 'meh' }));
    const r1 = await handleMessage(msg({ sourceServer: 'ServerA', channel: 'token-chat', author: 'caller4', text: 'this chart is going crazy guys, who is in?' }), s.deps);
    expect(r1.skipped).toMatch(/scan without a token/);
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'token-chat', author: 'caller4', text: `scanning ${MINT}` }), s.deps);
    expect(s.calls.length).toBe(1);
    expect(s.calls[0].model).toBe('claude-haiku-5-5');
  });
});

describe('low-trust source → own research, not a dismissal (the owner 2026-10-23, KEG)', () => {
  it('trust ≤ 3 with a token: research note, trends in the dossier, bigger tool budget; trusted source: none of that', async () => {
    const s = setup();
    s.deps.trust = new TrustTable(parseTrustCsv('level,server,channel,author,score,mode\nchannel,ServerA,token-chat,,0,opus\nchannel,ServerA,core-calls,,9,opus\n').rows);
    const trendCalls: string[] = [];
    s.deps.intel!.enrich.trends = { async trends(chain) { trendCalls.push(String(chain)); return { chain: String(chain), trendingPools: [{ name: 'AGENTPAD / SOL', change24hPct: 120 }], boosted: [] }; } };
    s.store.addMention('ticker:bobo', { server: 'ServerB', channel: 'chat', author: 'a', tsUtc: s.clock.iso(), id: 'z1' });
    s.store.addMention('ticker:bobo', { server: 'ServerC', channel: 'chat', author: 'b', tsUtc: s.clock.iso(), id: 'z2' });
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'token-chat', author: 'Rick', text: `scan ${MINT}` }), s.deps);
    expect(s.calls.length).toBe(1);
    expect(s.calls[0].user).toContain('LOW-TRUST RESEARCH');
    expect(s.calls[0].user).toContain('AGENTPAD / SOL');
    expect(s.calls[0].user).toContain('ticker:bobo');
    expect(s.calls[0].maxToolCalls).toBe(3);
    expect(trendCalls).toEqual(['solana']);
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', text: `new ${MINT} aping` }), s.deps);
    expect(s.calls.length).toBe(2);
    expect(s.calls[1].user).not.toContain('LOW-TRUST RESEARCH');
    expect(s.calls[1].maxToolCalls).toBe(2);
  });

  it('the trends tool answers with market and community trends', async () => {
    const s = setup();
    s.deps.trust = new TrustTable(parseTrustCsv('level,server,channel,author,score,mode\nchannel,ServerA,token-chat,,0,opus\n').rows);
    s.deps.intel!.enrich.trends = { async trends(chain) { return { chain: String(chain), trendingPools: [{ name: 'KEG / WBNB' }], boosted: [] }; } };
    let out = '';
    s.deps.intel!.runAnalyst = async ({ exec }) => { out = await exec('trends', { chain: 'bsc' }); return { verdict: { verdict: 'ignore', thesis: 'x', confidence: 0.5 }, usage: [], toolCalls: ['trends'] }; };
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'token-chat', author: 'Rick', text: `scan ${MINT}` }), s.deps);
    expect(JSON.parse(out).trendingPools[0].name).toBe('KEG / WBNB');
    expect(JSON.parse(out).chain).toBe('bsc');
  });
});

describe('analyst exit plan reaches the position (SWARMX fix)', () => {
  it('stop −20%, full exit at 1.5x, sell by 4h', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'quick flip', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8,
      stopLossPct: 20, takeProfitX: 1.5, takeProfitShare: 1, sellByHours: 4 }] }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    const row = s.store.db.prepare('SELECT state FROM positions').get() as any;
    const st = JSON.parse(row.state);
    expect(st.stopPrice).toBeCloseTo(0.0001 * 0.8, 10);
    expect(st.tp1Price).toBeCloseTo(0.00015, 10);
    expect(st.tp1Share).toBe(1);
    expect(st.hardTimeStop).toBe(true);
    expect(st.timeStopAtMs - st.openedAtMs).toBe(4 * 3600_000);
  });
});

describe('Polymarket calls → paper bets (the owner 2026-10-23)', () => {
  const PM_URL = 'https://polymarket.com/event/btc-150k-2026/will-btc-hit-150k';
  const mkMarket = (over: Partial<import('../src/checks/polymarket.js').PmMarket> = {}): import('../src/checks/polymarket.js').PmMarket => ({
    slug: 'will-btc-hit-150k', eventSlug: 'btc-150k-2026', question: 'Will BTC hit $150k in 2026?', closed: false, active: true, endUtc: '2026-12-31T23:59:00.000Z',
    outcomes: [{ name: 'Yes', tokenId: 'Y1', ask: 0.2, bid: 0.19 }, { name: 'No', tokenId: 'N1', ask: 0.81, bid: 0.8 }], feeRate: 0.07, minOrderShares: 5, category: 'crypto', ...over });
  const wire = (s: ReturnType<typeof setup>, m: () => import('../src/checks/polymarket.js').PmMarket) => {
    const client = { async markets() { return [m()]; }, async market() { return m(); } };
    s.deps.intel!.enrich.polymarket = client; s.paper.pm = client;
  };

  it('trusted call with a link → dossier with prices → bet sized by code → resolved win pays $1 per share', async () => {
    const s = setup();
    let mk = mkMarket(); wire(s, () => mk);
    s.setAnalyst((u) => { expect(u).toContain('"predictions"'); expect(u).toContain('Y1'); return { verdict: 'act', confidence: 0.75, thesis: 'market underprices yes',
      intents: [{ kind: 'prediction_bet', chain: 'polygon', marketSlug: 'will-btc-hit-150k', outcome: 'Yes', limitPrice: 0.25, urls: [], summary: 'bet yes', stance: 'buy', confidence: 0.75 }] }; });
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', text: `yes is cheap here ${PM_URL}` }), s.deps);
    const d = s.store.db.prepare("SELECT action, reasons, size_usd FROM decisions WHERE action='prediction_buy'").get() as any;
    expect(d).toBeDefined();
    expect(s.paper.predOpen.size).toBe(1);
    const pos = [...s.paper.predOpen.values()][0];
    expect(pos.entry).toBe(0.2);
    expect(pos.shares).toBeGreaterThanOrEqual(5);
    mk = mkMarket({ closed: true, winner: 'Yes' });
    await s.paper.monitor(s.prices as any);
    expect(s.paper.predOpen.size).toBe(0);
    expect(s.sent.some(t => t.includes('PREDICTION CLOSE') && t.includes('resolved'))).toBe(true);
    const row = s.store.db.prepare('SELECT proceeds_usd FROM positions').get() as any;
    expect(row.proceeds_usd).toBeCloseTo(pos.shares, 6);
  });

  it('ask above the analyst limit → skip; tiny size below venue minimum → skip', async () => {
    const s = setup();
    wire(s, () => mkMarket({ outcomes: [{ name: 'Yes', tokenId: 'Y1', ask: 0.3, bid: 0.29 }, { name: 'No', tokenId: 'N1', ask: 0.71, bid: 0.7 }] }));
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.75, thesis: 'x', intents: [{ kind: 'prediction_bet', chain: 'polygon', marketSlug: 'will-btc-hit-150k', outcome: 'Yes', limitPrice: 0.25, urls: [], summary: 'bet', stance: 'buy', confidence: 0.75 }] }));
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', text: `yes ${PM_URL}` }), s.deps);
    expect((s.store.db.prepare("SELECT reasons FROM decisions WHERE action='skip'").get() as any).reasons).toMatch(/above analyst limit/);
    expect(s.paper.predOpen.size).toBe(0);
    // NO at 0.81: for $2.5 that is 3 shares < the minimum of 5 → skip with a reason (new run: a repeat of the same market within 24 h is not analysed)
    const s2 = setup(); wire(s2, () => mkMarket());
    s2.setAnalyst(() => ({ verdict: 'act', confidence: 0.75, thesis: 'x', intents: [{ kind: 'prediction_bet', chain: 'polygon', marketSlug: 'will-btc-hit-150k', outcome: 'No', urls: [], summary: 'bet', stance: 'buy', confidence: 0.75 }] }));
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', text: `no side ${PM_URL}` }), s2.deps);
    const all = (s2.store.db.prepare("SELECT action, reasons FROM decisions ORDER BY id").all() as any[]).map(r => `${r.action}: ${r.reasons}`);
    expect(all.join('\n')).toMatch(/venue minimum/);
  });
});

describe('Polymarket in a chat batch', () => {
  it('bet sourced from a message without the market link is dropped', async () => {
    const s = setup({ batch: 2 });
    const m = { slug: 'will-btc-hit-150k', eventSlug: 'btc-150k-2026', question: 'Q', closed: false, active: true, endUtc: '2026-12-31T23:59:00.000Z',
      outcomes: [{ name: 'Yes', tokenId: 'Y1', ask: 0.2, bid: 0.19 }, { name: 'No', tokenId: 'N1', ask: 0.81, bid: 0.8 }], feeRate: 0.07, minOrderShares: 5 };
    const client = { async markets() { return [m]; }, async market() { return m; } };
    s.deps.intel!.enrich.polymarket = client; s.paper.pm = client;
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'x', intents: [{ kind: 'prediction_bet', chain: 'polygon', marketSlug: 'will-btc-hit-150k', outcome: 'Yes', urls: [], summary: 'bet', stance: 'buy', confidence: 0.8, sourceIdx: 2 }] }));
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'chat', author: 'x', text: 'https://polymarket.com/event/btc-150k-2026/will-btc-hit-150k' }), s.deps);
    const logs: string[] = []; s.deps.log = (x: string) => logs.push(x);
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'chat', author: 'caller1', text: 'yes is free money' }), s.deps);
    expect(s.paper.predOpen.size).toBe(0);
    expect(logs.join('\n')).toMatch(/not linked in the source message/);
  });
});

describe('NFT secondary buy (paper) — collection only from the linked OpenSea page', () => {
  it('nft_buy at floor within size → NFT position; floor above the analyst limit → skip', async () => {
    const s = setup();
    s.os.floor = 0.0005; s.os.sales = 5;
    liveGasGwei.set('ethereum', { gwei: 0.1, atMs: s.clock.now() }); // cheap gas: the "gas ≤ 20% of the trade" rule does not interfere
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'floor is cheap vs offers', nftPlan: { style: 'hold', targetMultiple: 2 },
      intents: [{ kind: 'nft_buy', chain: 'ethereum', collection: 'lanternfolk', maxPriceEth: 0.001, urls: [], summary: 'buy floor', stance: 'buy', confidence: 0.8 }] }));
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', text: 'floor sweep https://opensea.io/collection/lanternfolk' }), s.deps);
    const d = s.store.db.prepare("SELECT action, reasons FROM decisions ORDER BY id DESC").get() as any;
    expect(d.action).toBe('nft_buy');
    expect(s.paper.nftOpen.size).toBe(1);
    const pos = [...s.paper.nftOpen.values()][0];
    expect(pos.plan).toEqual({ style: 'hold', targetMultiple: 2 });
    const s2 = setup(); s2.os.floor = 0.0009;
    s2.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'x', intents: [{ kind: 'nft_buy', chain: 'ethereum', collection: 'lanternfolk', maxPriceEth: 0.0008, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', text: 'https://opensea.io/collection/lanternfolk' }), s2.deps);
    expect((s2.store.db.prepare("SELECT reasons FROM decisions ORDER BY id DESC").get() as any).reasons).toMatch(/above limit/);
  });
});

describe('live execution plumbing (fake trader): pending sells settle exactly once', () => {
  it('stop hit → sell pending → monitor does not sell again → confirmed late → closed once', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'ok', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    let sells = 0; let settle: (v: 'ok' | 'failed' | 'unknown') => void = () => {};
    const trader: any = {
      async buyToken() { return { ok: true, mode: 'live', qty: 10_000, raw: 10_000n * 10n ** 6n, decimals: 6, spentUsd: 1.0, tx: '0xbuy', note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 0.5, soldRaw: 10_000n * 10n ** 6n, tx: '0xsell', note: 'pending', pending: true }; },
      settleTx: () => new Promise(r => { settle = r; }),
    };
    s.paper.trader = trader; s.paper.liveMode = 'live';
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'scan-feed', author: 'Bark tools', text: BARK_EMBED }), s.deps);
    expect(s.paper.open.size).toBe(1);
    const pos = [...s.paper.open.values()][0];
    expect(pos.live?.raw).toBe(String(10_000n * 10n ** 6n));
    await s.paper.monitor({ async market() { return { chain: 'solana', priceUsd: 0.00001 }; }, async rug() { return undefined; } } as any);
    expect(sells).toBe(1);
    await s.paper.monitor({ async market() { return { chain: 'solana', priceUsd: 0.00001 }; }, async rug() { return undefined; } } as any);
    expect(sells).toBe(1);                              // in flight — no second sale
    settle('ok');
    await new Promise(r => setTimeout(r, 20));
    expect(s.paper.open.size).toBe(0);
    expect(s.sent.some(t => t.includes('confirmed late'))).toBe(true);
  });
});

describe('CA from the official X of the project (the owner 2026-10-23, LARPCHECK)', () => {
  const mk = (over: Partial<MarketInfo> = {}) => ({ async market(a: string): Promise<MarketInfo | undefined> { return a === MINT ? { chain: 'solana', symbol: 'LARPCHECK', priceUsd: 0.0001, liquidityUsd: 60_000, fdvUsd: 300_000, pairAgeMinutes: 900, buys24h: 900, sells24h: 700, ...over } : undefined; },
    async rug() { return { risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] }; } });
  const xWith = (bio: string, posts: { author: string; text: string }[] = []) => ({
    async profile(h: string) { return { handle: h, followers: 5900, description: bio }; },
    async search() { return posts.map(p => ({ ...p, createdAt: '2026-10-23T10:00:00Z', likes: 1, retweets: 0 })); } });

  it('verifier: DexScreener links the X → ok; CA in the bio + ticker matches → ok; someone else\'s post or wrong ticker → refused', async () => {
    const { verifyOfficialCa } = await import('../src/analyst/enrich.js');
    expect((await verifyOfficialCa(MINT, { handles: ['larpcheck'], tickers: [] }, { market: mk({ twitter: 'LarpCheck' }) as any }))?.how).toMatch(/DexScreener profile/);
    expect((await verifyOfficialCa(MINT, { handles: ['larpcheck'], tickers: ['LARPCHECK'] }, { market: mk() as any, x: xWith(`CA: ${MINT}`) as any }))?.how).toMatch(/bio of @larpcheck/);
    expect(await verifyOfficialCa(MINT, { handles: ['larpcheck'], tickers: ['LARPCHECK'] }, { market: mk() as any, x: xWith('', [{ author: 'random_kol', text: `ape ${MINT}` }]) as any })).toBeUndefined();
    expect((await verifyOfficialCa(MINT, { handles: ['larpcheck'], tickers: ['LARPCHECK'] }, { market: mk() as any, x: xWith('', [{ author: 'larpcheck', text: `contract ${MINT}` }]) as any }))?.how).toMatch(/posted by @larpcheck/);
    expect(await verifyOfficialCa(MINT, { handles: ['larpcheck'], tickers: ['OTHER'] }, { market: mk() as any, x: xWith(`CA: ${MINT}`) as any })).toBeUndefined();
    expect(await verifyOfficialCa(MINT, { handles: [], tickers: [] }, { market: mk({ twitter: 'larpcheck' }) as any })).toBeUndefined();
  });

  it('message without a CA but with the project X: code finds the CA in its bio, the analyst can act on it', async () => {
    const s = setup();
    const market = mk();
    s.deps.decide.market = market as any;
    s.deps.intel!.enrich = { ...s.deps.intel!.enrich, market: market as any, x: xWith(`terminal live. CA: ${MINT}`) as any };
    s.setAnalyst((u) => { expect(u).toContain('officialCas'); return { verdict: 'act', confidence: 0.8, thesis: 'real product, revenue share',
      intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }; });
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', text: '$LARPCHECK ships its own terminal, 60% of revenue back to the token https://x.com/larpcheck' }), s.deps);
    const d = s.store.db.prepare("SELECT action, reasons FROM decisions ORDER BY id DESC").get() as any;
    expect(d.action).toBe('buy_token');
    expect(d.reasons).toMatch(/official X: in the bio of @larpcheck/);
  });

  it('CA only in a random X post (not the project account) → not acted on', async () => {
    const s = setup();
    const market = mk();
    s.deps.decide.market = market as any;
    s.deps.intel!.enrich = { ...s.deps.intel!.enrich, market: market as any, x: xWith('', [{ author: 'shill', text: `CA ${MINT}` }]) as any };
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'x', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    await handleMessage(msg({ sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', text: '$LARPCHECK update https://x.com/larpcheck' }), s.deps);
    expect(s.risk.positions.length).toBe(0);
  });
});

describe('trend parsers', () => {
  it('GeckoTerminal trending pools and DexScreener boosts', async () => {
    const { parseGeckoTrending, parseDexBoosts } = await import('../src/analyst/enrich.js');
    const now = Date.parse('2026-10-23T07:00:00Z');
    const pools = parseGeckoTrending({ data: [{ attributes: { name: 'KEG / WBNB', pool_created_at: '2026-10-23T01:00:00Z', fdv_usd: '1200000', volume_usd: { h24: '850000' }, price_change_percentage: { h1: '12.5', h24: '340' } } }, { attributes: {} }] }, now);
    expect(pools).toEqual([{ name: 'KEG / WBNB', ageHours: 6, fdvUsd: 1_200_000, volume24hUsd: 850_000, change1hPct: 12.5, change24hPct: 340 }]);
    const b = parseDexBoosts([{ chainId: 'bsc', tokenAddress: '0x5b2e', description: 'AI agent launchpad\n on BNB', totalAmount: 500 }, { chainId: 'solana' }]);
    expect(b).toEqual([{ chain: 'bsc', address: '0x5b2e', description: 'AI agent launchpad on BNB', boost: 500 }]);
  });
});

describe('verdict tolerance', () => {
  it('sourceIdx 0 from the model does not reject the whole verdict', async () => {
    const { parseVerdict } = await import('../src/analyst/analyst.js');
    const p = parseVerdict({ verdict: 'act', thesis: 'x', confidence: 0.8, intents: [{ kind: 'token_call', chain: 'solana', urls: [], summary: 's', stance: 'buy', confidence: 0.8, sourceIdx: 0 }], exits: [{ token: 'a', reason: 'r', sourceIdx: -1 }] });
    expect(p.verdict?.intents[0].sourceIdx).toBeUndefined();
    expect(p.verdict?.exits[0].sourceIdx).toBeUndefined();
  });
});

describe('NFT mint by numbers (2026-10-23, Lanternfolk)', () => {
  it('22:55 re-check: analyst still says watch, but OpenSea numbers show profit → code mints at public start', async () => {
    const s = setup({ risk: { mintCapExcludesGas: true } });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, thesis: 'wait for public',
      projects: [{ ref: 'collection:lanternfolk', verdict: 'watch', category: 'nft', thesis: 'wait', recheckAtUtc: ['2026-10-22T22:55:00Z'] }] }));
    await handleMessage(msg({ author: 'caller1', text: 'Lanternfolk mint today https://opensea.io/collection/lanternfolk free WL, public 0.001' }), s.deps);
    s.os.floor = 0.004; s.os.sales = 60;
    // 2350 of 2772 whitelist spots minted
    const drop = { ...OS_DROP, total_supply: '2350' };
    // fresh secondary sales (sale events) — the exit price is computed from them
    const recent = { n: 40, medianEth: 0.0035, minEth: 0.003, maxEth: 0.004, windowMin: 60 };
    s.deps.intel!.enrich.opensea = { async nft(slug) { return slug === 'lanternfolk' ? parseOpenSea(slug, drop, OS_COLL, osStats(s.os.floor, s.os.sales), 0.00009, { recent }) : undefined; } };
    s.clock.set(Date.parse('2026-10-22T22:55:10Z'));
    await serialHandler(s.deps).tick();
    expect((s.store.db.prepare("SELECT COUNT(*) n FROM scheduled").get() as any).n).toBe(1);
    s.clock.set(Date.parse('2026-10-22T23:25:20Z'));
    await serialHandler(s.deps).tick();
    expect(s.risk.positions.map(p => p.token)).toContain('nft:lanternfolk');
  });

  it('numbers bad (floor at break-even) → no mint; analyst "avoid" vetoes the rule', async () => {
    const { nftMintRule } = await import('../src/analyst/opensea.js');
    const bad = parseOpenSea('lanternfolk', { ...OS_DROP, total_supply: '2350' }, OS_COLL, osStats(0.0011, 60), 0.00009);
    const r = nftMintRule(bad, Date.parse('2026-10-22T22:55:00Z'), DEFAULT_RISK.nftAutoMint);
    expect(r.inWindow).toBe(true); expect(r.ok).toBe(false); expect(r.why.join(' ')).toMatch(/break-even/);
    const early = nftMintRule(bad, Date.parse('2026-10-22T12:00:00Z'), DEFAULT_RISK.nftAutoMint);
    expect(early.inWindow).toBe(false);
  });

  it('paper mode prompt pushes the analyst to act; live prompt does not', async () => {
    const { systemPrompt } = await import('../src/analyst/analyst.js');
    expect(systemPrompt('B', 'paper')).toMatch(/PAPER MODE/);
    expect(systemPrompt('B', 'live')).not.toMatch(/PAPER MODE/);
  });
});

describe('NFT exit price: recent sales and top offer, not the 24h average (Lanternfolk 2026-10-22)', () => {
  it('24h average distorted by free-mint dumps (0.00065) does not block; recent median 0.0025 and offer 0.0016 → mint', async () => {
    const { nftMintRule, recentSalesOf, bestOfferOf } = await import('../src/analyst/opensea.js');
    const events = { asset_events: [0.0025, 0.0024, 0.0027, 0.0018, 0.0026, 0.0025, 0.0022, 0.0021, 0.0026, 0.0025, 0.0023].map(p => ({ payment: { quantity: String(Math.round(p * 1e18)), decimals: 18 }, quantity: 1 })) };
    const offers = { offers: [{ price: { value: '1600000000000000', decimals: 18 }, protocol_data: { parameters: { consideration: [{ startAmount: '1' }], endTime: String(2e9) } } },
      { price: { value: '18200000000000000', decimals: 18 }, protocol_data: { parameters: { consideration: [{ startAmount: '13' }], endTime: String(2e9) } } }] };
    const n = parseOpenSea('lanternfolk', { ...OS_DROP, total_supply: '3517' }, OS_COLL, { total: { floor_price: 0.0031, sales: 3517 }, intervals: [{ interval: 'one_day', sales: 3517, volume: 2.24 }] }, 0.00009,
      { recent: recentSalesOf(events, 60), bestOfferEth: bestOfferOf(offers, Date.parse('2026-10-22T22:55:00Z')) });
    expect(n.bestOfferEth).toBeCloseTo(0.0016, 6);
    expect(n.recentSales!.medianEth).toBeCloseTo(0.0025, 6);
    const r = nftMintRule(n, Date.parse('2026-10-22T22:55:00Z'), DEFAULT_RISK.nftAutoMint);
    expect(r.ok).toBe(true);
    expect(n.derived.exitToBreakEven!).toBeGreaterThan(2);
  });
  it('tool domains (rick.bot, okx.com, padre.gg) are not projects', () => {
    const t = 'check https://rick.bot/x https://okx.com/trade https://padre.gg/t';
    expect(codeEntities(t, prefilter(t))).toEqual([]);
  });
});

describe('dossier follows the project links (DexScreener / OpenSea) when Discord has none (2026-10-23)', () => {
  it('token: X and website from the DexScreener profile; NFT: X from OpenSea', async () => {
    const { buildDossier } = await import('../src/analyst/enrich.js');
    const { parseDexScreener } = await import('../src/checks/token.js');
    const ds = { pairs: [{ chainId: 'solana', baseToken: { address: MINT }, priceUsd: '0.001', liquidity: { usd: 20000 }, txns: { h24: { buys: 100, sells: 50 } },
      info: { websites: [{ label: 'Website', url: 'https://pupkoi.xyz' }], socials: [{ type: 'twitter', url: 'https://x.com/pupkoi_sol' }, { type: 'telegram', url: 'https://t.me/pupkoi' }] } }] };
    const mi = parseDexScreener(ds, MINT, Date.now())!;
    expect(mi.twitter).toBe('pupkoi_sol'); expect(mi.websites).toEqual(['https://pupkoi.xyz']);
    const profiles: string[] = [], searches: string[] = [], pages: string[] = [];
    const dos = await buildDossier({ tokens: [MINT], domains: [], xHandles: [], urls: [], tickers: [], collections: ['lanternfolk'] }, {
      market: { async market() { return mi; }, async rug() { return { risk: 'low', freezeOrMintAuthority: false, reasons: [] }; } },
      opensea: { async nft(slug) { return parseOpenSea(slug, OS_DROP, OS_COLL, osStats(0.003, 0), 0.0001); } },
      x: { async profile(h) { profiles.push(h); return { handle: h, followers: 1000 }; }, async search(q) { searches.push(q); return []; } },
      page: async (u) => { pages.push(u); return { text: 'site' }; },
    });
    expect(profiles.sort()).toEqual(['pupkoi_sol', 'lanternfolkxyz'].sort());
    expect(searches.some(q => q.startsWith('from:'))).toBe(true);
    expect(searches.some(q => /^@\w+ -from:\w+$/.test(q))).toBe(true);
    expect(pages).toContain('https://pupkoi.xyz');
    expect(dos.nft[0]).not.toHaveProperty('sales1d');
  });
});

describe('scanner bots never take the X slot (A-06 acceptance round 1, 2026-11-09)', () => {
  it('triaged chat batch: @RickBurpBot mentioned twice, project X once → the project X is researched; the model tool refuses the bot', async () => {
    const s = setup({ batch: 3, triage: true });
    const profiles: string[] = [];
    s.deps.intel!.enrich.x = { async profile(h) { profiles.push(h); return { handle: h, followers: 1000 }; }, async search() { return []; } };
    let toolOut = '';
    s.deps.intel!.runAnalyst = async ({ exec }) => {
      toolOut = await exec('x_profile', { handle: '@RickBurpBot' });
      return { verdict: { verdict: 'ignore', thesis: 'x', confidence: 0.9 }, usage: [{ input_tokens: 100, output_tokens: 10 }], toolCalls: ['x_profile'] };
    };
    s.setTriage(() => ({ escalate: true, focus: [1, 2, 3], reason: 'token card' }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'a', text: `${MINT} card by @RickBurpBot` }), s.deps);
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'b', text: `again @RickBurpBot ${MINT}` }), s.deps);
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'c', text: 'their X is @tofu_proj' }), s.deps);
    expect(s.triageCalls.length).toBe(1);
    expect(profiles).toContain('tofu_proj');
    expect(profiles.some(h => /rick/i.test(h))).toBe(false);
    expect(toolOut).toMatch(/scanner bot account.*not looked up/);
  });
  it('codeEntities: bot handles are not entities (no mention keys, no project history)', async () => {
    const { codeEntities } = await import('../src/intel/entities.js');
    const { prefilter } = await import('../src/extract/prefilter.js');
    const text = 'via @RickBurpBot https://x.com/rick/status/1 and @proj';
    expect(codeEntities(text, prefilter(text)).filter(e => e.kind === 'x').map(e => e.key)).toEqual(['x:proj']);
  });
});

// A-05 (journal 29.10–10.11): 15 of 16 Opus analyses of Rick bot cards came right after a human call with the same address.
// The card was let through by the "new project" rule: holder wallets, the pair address, terminal links, the tweet's X author.
const HOLDER_A = 'HoLder1abcdefghijkmnopqrstuvwxyz23456789AB';
const HOLDER_B = 'HoLder2abcdefghijkmnopqrstuvwxyz23456789AB';
const DEV = '0x50c0c4cf11d271ecc359eb21c5b13cb6cc08ab1a';
const rickCard = (mint: string, replyTo: string) => `💊 **[WISP](https://pump.fun/${mint}) [129K/250%] - WISP/SOL**
---
Replied to: ${replyTo}
${mint}
---
https://dexscreener.com/solana/PaiR9xyzabcdefghijkmnopqrstuvwxyz23456789A
💎 FDV: \`129K\` 💦 Liq: \`15.7K\`
[👥](https://t.me/rick?start=nh_${mint}) TH: [3.7](https://solscan.io/account/${HOLDER_A})⋅[3.4](https://solscan.io/account/${HOLDER_B})
👨‍💻 [DEV](https://www.defined.fi/tokens?creatorAddress=${DEV}&sortBy=marketCap) · [Trojan](https://trojan.com/terminal?token=${mint})
🐦 [tweet](https://x.com/sometweeter/status/123)`;

describe('repeats without new information (A-05, journal 2026-10-29…11-10)', () => {
  it('a scanner-bot card right under a human call of the same token is a repeat — no second Opus run', async () => {
    const s = setup();
    await handleMessage(msg({ author: 'caller', text: `aping this one ${MINT}` }), s.deps);
    expect(s.calls.length).toBe(1);
    const r = await handleMessage(msg({ author: 'Rick', text: rickCard(MINT, 'caller') }), s.deps);
    expect(s.calls.length).toBe(1);
    expect(r.skipped).toMatch(/^repeat( \(weak keys only\))?: /);   // the card's service keys are no longer keys — the old rule is enough
  });
  it('the same card in ONE block (no «---»): the tweet author glued to the token card is still not new information', async () => {
    const s = setup();
    await handleMessage(msg({ author: 'caller', text: `aping this one ${MINT}` }), s.deps);
    const oneBlock = rickCard(MINT, 'caller').replace(/\n---\n/g, '\n');
    const r = await handleMessage(msg({ author: 'Rick', text: oneBlock }), s.deps);
    expect(s.calls.length).toBe(1);
    expect(r.skipped).toMatch(/^repeat( \(weak keys only\))?: /);
  });
  it('exceptions still go to the model: after 24 h, a higher-trust author (≥ 7), watch + buzz', async () => {
    const s = setup();
    await handleMessage(msg({ author: 'caller5', channel: 'degen', sourceServer: 'ServerB', text: `aping this one ${MINT}` }), s.deps);   // ServerB/degen — score 5
    const n0 = s.calls.length;
    await handleMessage(msg({ author: 'caller1', text: rickCard(MINT, 'x') }), s.deps);       // ServerA, caller1 = 9 > the previous one
    expect(s.calls.length).toBe(n0 + 1);
    s.clock.set(s.clock.now() + 25 * 3600_000);
    await handleMessage(msg({ author: 'Rick', text: rickCard(MINT, 'caller') }), s.deps);
    expect(s.calls.length).toBe(n0 + 2);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, thesis: 'w', recheckAfterMinutes: 30 }));
    s.clock.set(s.clock.now() + 25 * 3600_000);
    await handleMessage(msg({ author: 'caller', text: `still watching ${MINT}` }), s.deps);  // a watch verdict on the token card
    s.clock.set(s.clock.now() + 2 * 3600_000);
    for (const a of ['u1', 'u2', 'u3', 'u4', 'u5']) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: a, text: `${MINT} moving` }), s.deps);
    const before = s.calls.length;
    await handleMessage(msg({ author: 'Rick', text: rickCard(MINT, 'caller') }), s.deps);
    expect(s.calls.length).toBe(before + 1);
  });
  it('a bot card with a NEW contract is still analyzed', async () => {
    const s = setup();
    await handleMessage(msg({ author: 'caller', text: `aping this one ${MINT}` }), s.deps);
    const other = 'NewMint2abcdefghijkmnopqrstuvwxyz23456pump';
    s.prices.set(other, 0.0002);
    await handleMessage(msg({ author: 'Rick', text: rickCard(other, 'caller') }), s.deps);
    expect(s.calls.length).toBe(2);
  });
  it('holder and dev wallets, the DexScreener pair and terminal links are not project keys; a lone DexScreener link still is', async () => {
    const { codeEntities } = await import('../src/intel/entities.js');
    const { prefilter } = await import('../src/extract/prefilter.js');
    const card = rickCard(MINT, 'caller');
    const keys = codeEntities(card, prefilter(card)).map(e => e.key);
    expect(keys.filter(k => k.startsWith('sol:') || k.startsWith('evm:'))).toEqual([`sol:${MINT}`]);
    expect(keys.some(k => k.startsWith('domain:trojan'))).toBe(false);
    const lone = 'look https://dexscreener.com/base/0x8d505df3d93549f6e8f6855120977e4a6631ab6b';
    expect(codeEntities(lone, prefilter(lone)).map(e => e.key)).toContain('evm:0x8d505df3d93549f6e8f6855120977e4a6631ab6b');
    // A service link is the token's only trace: the address stays a key (acceptance #64, round 1)
    for (const t of [`check this https://solscan.io/account/${MINT}`, `pumping [1](https://pump.fun/${MINT})`, `dev https://www.defined.fi/tokens?creatorAddress=${DEV}`])
      expect(codeEntities(t, prefilter(t)).filter(e => e.kind === 'sol' || e.kind === 'evm').length).toBe(1);
  });
});

describe('A-05: repeat simulation over a review journal (numbers for the cost gate can be recomputed)', () => {
  it('counts analyses the rule would cut; scheduled rechecks and new contracts are not cut', async () => {
    const { simulateRepeats } = await import('../src/intel/repeatSim.js');
    const row = (ts: string, model: string, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ kind: 'analysis', ts, model, trust: 5, costUsd: 0.1, case: `THE MESSAGE:\n<DATA_ab>\n${text}\n</DATA_ab>`, ...extra });
    const other = 'NewMint2abcdefghijkmnopqrstuvwxyz23456pump';
    const j = [row('2026-11-01T10:00:00Z', 'claude-opus-5-5', `call ${MINT}`), row('2026-11-01T10:05:00Z', 'claude-opus-5-5', rickCard(MINT, 'caller')),
      row('2026-11-01T10:06:00Z', 'claude-opus-5-5', `call ${MINT}`, { trigger: 'scheduled_recheck' }), row('2026-11-01T10:07:00Z', 'claude-haiku-5-5', rickCard(other, 'x')),
      row('2026-11-02T11:00:00Z', 'claude-opus-5-5', `call ${MINT}`)].join('\n');
    expect(simulateRepeats(j)).toMatchObject({ total: { opus: 4, haiku: 1 }, cut: { opus: 1 }, cutUsd: { opus: 0.1 } });
  });
  it('lists every cut analysis with the verdict it really ended with and its actions; breakdown per verdict (acceptance #64, F64-3)', async () => {
    const { simulateRepeats } = await import('../src/intel/repeatSim.js');
    const an = (ts: string, msgId: string, v: string, extra: Record<string, unknown> = {}) => JSON.stringify({ kind: 'analysis', ts, msgId, model: 'claude-opus-5-5', trust: 5, costUsd: 0.2,
      source: 'ServerA/#core-calls/Rick', verdict: { verdict: v, project: { name: 'WISP' } }, case: `THE MESSAGE:\n<DATA_ab>\n${rickCard(MINT, 'caller')}\n</DATA_ab>`, ...extra });
    const mr = (msgId: string, v: string, actions: string[]) => JSON.stringify({ kind: 'message', msgId, analysis: { verdict: v }, decisions: actions.map(action => ({ action })) });
    const j = [
      JSON.stringify({ kind: 'analysis', ts: '2026-11-01T09:00:00Z', msgId: 'm0', model: 'claude-opus-5-5', trust: 5, costUsd: 0.2, source: 'ServerA/#core-calls/caller', case: `THE MESSAGE:\n<DATA_ab>\ncall ${MINT}\n</DATA_ab>` }),
      an('2026-11-01T09:10:00Z', 'm1', 'ignore'), mr('m1', 'ignore', []),
      an('2026-11-01T09:20:00Z', 'm2', 'act'), mr('m2', 'watch', ['skip']),             // the model said act, the code held watch (A-09)
      an('2026-11-01T09:30:00Z', 'm3', 'act'), mr('m3', 'act', ['buy_token', 'skip']),
      an('2026-11-01T09:40:00Z', 'm4', 'avoid'),                                         // no message row — the action is unknown
    ].join('\n');
    const r = simulateRepeats(j);
    expect(r.cut).toEqual({ opus: 4 });
    expect(r.cutByVerdict).toEqual({ ignore: 1, watch: 1, act: 1, avoid: 1 });
    expect(r.cutRows.map(x => [x.ts, x.verdict, x.actions, x.project])).toEqual([
      ['2026-11-01T09:10:00Z', 'ignore', [], 'WISP'], ['2026-11-01T09:20:00Z', 'watch', [], 'WISP'],
      ['2026-11-01T09:30:00Z', 'act', ['buy_token'], 'WISP'], ['2026-11-01T09:40:00Z', 'avoid', null, 'WISP']]);
  });
});

// Acceptance #64, round 2 (HQ repros R1–R5): a new token given as a DexScreener link is not lost; the "weak keys" rule is only
// for scanner-bot messages (the owner's decision 2026-11-10 12:19 UTC was about a bot repost).
describe('A-05 narrowed: DexScreener links of people stay keys; weak-keys rule only for scanner bots (acceptance #64, round 2)', () => {
  const NEW_T = 'NewTok3abcdefghijkmnopqrstuvwxyz23456pump';
  const WALLET = 'WaLLet1abcdefghijkmnopqrstuvwxyz23456789AB';
  it('R1 a wallet plus a token given only as a DexScreener link → the token stays a key', async () => {
    const { codeEntities } = await import('../src/intel/entities.js'); const { prefilter } = await import('../src/extract/prefilter.js');
    const t = `smart wallet ${WALLET} just bought https://dexscreener.com/solana/${NEW_T}`;
    expect(codeEntities(t, prefilter(t)).map(e => e.key)).toContain(`sol:${NEW_T}`);
  });
  it('R2/R3 a NEW token as a DexScreener link next to the analyzed one (same message or a reply) reaches the model', async () => {
    for (const second of [{ author: 'caller', text: `${MINT} is cooked, rotating into https://dexscreener.com/solana/${NEW_T}` },
      { author: 'caller1', text: `this one looks better https://dexscreener.com/solana/${NEW_T}`, replyToText: `aping this one ${MINT}` }]) {
      const s = setup(); s.prices.set(NEW_T, 0.0002);
      await handleMessage(msg({ author: 'caller', text: `aping this one ${MINT}` }), s.deps);
      await handleMessage(msg(second), s.deps);
      expect(s.calls.length).toBe(2);
    }
  });
  it('R4/R5 a person brings new facts (official X + site) or another project next to an analyzed address → the model', async () => {
    for (const text of [`${MINT} team just went public: @tofu_official https://tofuproject.xyz doxxed founders`,
      `${MINT} did nothing.\n\nNew one: free mint tomorrow https://glimmerbots.xyz @glimmerbots WL still open`]) {
      const s = setup();
      s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, thesis: 'no socials yet', recheckAfterMinutes: 600 }));
      await handleMessage(msg({ author: 'caller', text: `aping this one ${MINT}` }), s.deps);
      s.clock.set(s.clock.now() + 2 * 3600_000);
      await handleMessage(msg({ author: 'caller', text }), s.deps);
      expect(s.calls.length).toBe(2);
    }
  });
  it('a tweet link (x.com/<h>/status/<id>) in a scanner-bot message does not make its author a key; a profile link does', async () => {
    const { codeEntities } = await import('../src/intel/entities.js'); const { prefilter } = await import('../src/extract/prefilter.js');
    const t = 'see https://x.com/sometweeter/status/123 and https://x.com/tofu_official';
    expect(codeEntities(t, prefilter(t), { scannerBot: true }).filter(e => e.kind === 'x').map(e => e.key)).toEqual(['x:tofu_official']);
    const card = rickCard(MINT, 'caller');   // the bot card is recognized even without the author
    expect(codeEntities(card, prefilter(card)).some(e => e.key === 'x:sometweeter')).toBe(false);
  });
});

// Acceptance #64, round 3 (repros X1–X3, X6): a human's own links are their keys, even in a reply to a bot card; a tweet from
// a human is a new project or the official X, as before A-05. Bot repeats (tests above) remain repeats.
describe('A-05 narrowed: a person\'s own links stay keys next to a quoted bot card; tweets of people are keys (acceptance #64, round 3)', () => {
  const NEW_T = 'NewTok3abcdefghijkmnopqrstuvwxyz23456pump';
  const second = async (m: Partial<RawMessage>, watch = false) => {
    const s = setup(); s.prices.set(NEW_T, 0.0002);
    if (watch) s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, thesis: 'no socials yet', recheckAfterMinutes: 600 }));
    await handleMessage(msg({ author: 'caller', text: `aping this one ${MINT}` }), s.deps);
    s.clock.set(s.clock.now() + 2 * 3600_000);
    const r = await handleMessage(msg(m), s.deps);
    return { calls: s.calls.length, skipped: r.skipped };
  };
  it('X1 a person replies to a Rick card with a NEW token as a DexScreener link → the model', async () => {
    expect(await second({ author: 'caller1', text: `nah this one is better https://dexscreener.com/solana/${NEW_T}`, replyToText: rickCard(MINT, 'caller') }))
      .toEqual({ calls: 2, skipped: undefined });
  });
  it('X1b entities of a reply to a Rick card: the person\'s DexScreener token is a key; the card\'s pair and wallets are not', () => {
    const own = `nah this one is better https://dexscreener.com/solana/${NEW_T}`; const card = rickCard(MINT, 'caller');
    const t = `${own}\n${card}`;
    const addr = codeEntities(t, prefilter(t), { parts: [own, card] }).filter(e => e.kind === 'sol' || e.kind === 'evm').map(e => e.key).sort();
    expect(addr).toEqual([`sol:${MINT}`, `sol:${NEW_T}`].sort());
  });
  it('X2 a person: analyzed address + a NEW project given only as a tweet link → the model', async () => {
    expect((await second({ author: 'caller', text: `${MINT} did nothing.\n\nNew one: https://x.com/glimmerbots/status/1890000000000000001 stealth launch tonight` })).calls).toBe(2);
  });
  it('X3 a person after watch: same token, the official X only as a tweet link → the model', async () => {
    expect((await second({ author: 'caller', text: `${MINT} team just went public https://x.com/tofu_official/status/1890000000000000002 doxxed founders` }, true)).calls).toBe(2);
  });
  it('X6 a person: analyzed address + a NEW token as a numeric-label link [1](dexscreener) → the model', async () => {
    expect((await second({ author: 'caller', text: `${MINT} rugged, rotating [1](https://dexscreener.com/solana/${NEW_T})` })).calls).toBe(2);
    const t = `${MINT} rugged, rotating [1](https://dexscreener.com/solana/${NEW_T})`;
    expect(codeEntities(t, prefilter(t)).map(e => e.key)).toContain(`sol:${NEW_T}`);
  });
  it('X1 batch path: a person\'s NEW DexScreener token in a reply to a Rick card is in the chat-batch dossier', async () => {
    const s = setup({ batch: 2 }); s.prices.set(NEW_T, 0.0002);
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u1', text: 'what are we buying' }), s.deps);
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u2', text: `nah this one is better https://dexscreener.com/solana/${NEW_T}`, replyToText: rickCard(MINT, 'caller') }), s.deps);
    expect(s.calls.length).toBe(1);
    const user = s.calls[0].user;
    // the batch dossier: market data for the human's new token (not only for the quoted card's token)
    expect(user).toContain(`{"address":"${NEW_T}","chain":"solana","market":`);
  });
  it('X1 official-CA path: the tweet author of a person\'s reply to a Rick card stays a handle → the CA from its bio is accepted', async () => {
    const s = setup();
    const OTHER = 'NewMint2abcdefghijkmnopqrstuvwxyz23456pump';
    const market = { async market(a: string): Promise<MarketInfo | undefined> { return a === MINT ? { chain: 'solana', symbol: 'LARPCHECK', priceUsd: 0.0001, liquidityUsd: 60_000, fdvUsd: 300_000, pairAgeMinutes: 900, buys24h: 900, sells24h: 700 } : undefined; },
      async rug() { return { risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] }; } };
    s.deps.decide.market = market as any;
    s.deps.intel!.enrich = { ...s.deps.intel!.enrich, market: market as any,
      x: { async profile(h: string) { return { handle: h, followers: 5900, description: h === 'larpcheck' ? `terminal live. CA: ${MINT}` : '' }; }, async search() { return []; } } as any };
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'real product', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    await handleMessage(msg({ author: 'caller', text: '$LARPCHECK the real one, see https://x.com/larpcheck/status/1890000000000000003', replyToText: rickCard(OTHER, 'x') }), s.deps);
    const d = s.store.db.prepare("SELECT action, reasons FROM decisions ORDER BY id DESC").get() as any;
    expect(d.action).toBe('buy_token');
    expect(d.reasons).toMatch(/official X: in the bio of @larpcheck/);
  });
  it('the same bot card from the bot itself (or forwarded) is still a repeat', async () => {
    for (const author of ['Rick', 'caller']) {
      const r = await second({ author, text: rickCard(MINT, 'caller') });
      expect(r.calls).toBe(1);
      expect(r.skipped).toMatch(/^repeat/);
    }
  });
});

// A-09 (the owner 2026-11-11 08:02 UTC): "$BRIXO was checked 12 times… the verdicts changed every time… on the last ACT nothing happened".
describe('verdicts do not jump without a named new fact; ACT without an action is never silent (A-09)', () => {
  const BRIXO = 'TimMy1abcdefghijkmnopqrstuvwxyz23456789pump';
  const batchOf = async (s: ReturnType<typeof setup>, texts: string[]) => {
    let r!: Awaited<ReturnType<typeof handleMessage>>;
    for (const [i, t] of texts.entries()) r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: `u${i}`, text: t }), s.deps);
    return r;
  };
  const named = (v: string, extra: Record<string, unknown> = {}) => ({ verdict: v, confidence: 0.7, thesis: `${v} on BRIXO`, project: { name: 'BRIXO', category: 'memecoin' },
    projects: [{ ref: `sol:${BRIXO}`, name: 'BRIXO', verdict: v, thesis: 't' }], ...extra });
  it('watch → act without changeReason stays watch (no action, thesis says why); with a named new fact → act', async () => {
    const s = setup({ batch: 2 });
    s.prices.set(BRIXO, 0.0001);
    s.setAnalyst(() => named('watch'));
    await batchOf(s, [`$BRIXO ${BRIXO}`, 'brixo looks good']);
    const buy = { intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: BRIXO, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8, sourceIdx: 1 }] };
    s.setAnalyst(() => named('act', buy));
    const r = await batchOf(s, [`$BRIXO ${BRIXO} again`, 'brixo pumping']);
    expect(r.analysis?.verdict).toBe('watch');
    expect(r.analysis?.thesis).toMatch(/^BRIXO: kept watch \(was watch at \d\d:\d\d UTC; act without a named new reason\)/);
    expect(r.decisions).toEqual([]);
    s.setAnalyst(() => named('act', { ...buy, changeReason: 'FDV doubled to 210K with 3 new trusted buyers since the last check' }));
    const r2 = await batchOf(s, [`$BRIXO ${BRIXO} third`, 'brixo news']);
    expect(r2.analysis?.verdict).toBe('act');
    // A chat author without a score (journal tier), confidence 0.7 → an own find on paper (the paper own-find threshold is 0.6 (A-13))
    expect(r2.decisions.map(d => d.action)).toEqual(['buy_token']);
    expect(r2.decisions[0].reasons.join(' ')).toMatch(/analyst own pick/);
  });
  it('a lower verdict without a reason is allowed (more careful)', async () => {
    const s = setup({ batch: 2 });
    s.setAnalyst(() => named('watch'));
    await batchOf(s, [`$BRIXO ${BRIXO}`, 'brixo']);
    s.setAnalyst(() => named('avoid'));
    expect((await batchOf(s, [`$BRIXO ${BRIXO} rug?`, 'brixo dev sold'])).analysis?.verdict).toBe('avoid');
  });
  it('ACT without an action returns a skip decision with the reason: no intents, address not in the source, low confidence', async () => {
    const s = setup({ batch: 2 });
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.7, thesis: 'BRIXO is running' }));
    const r1 = await batchOf(s, [`$BRIXO ${BRIXO}`, 'brixo']);
    expect(r1.decisions.map(d => [d.action, d.reasons[1]])).toEqual([['skip', 'act verdict without an actionable intent (the analyst listed no action)']]);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.7, thesis: 'buy it', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: 'NotInText1abcdefghijkmnopqrstuvwxyz234pump', urls: [], summary: 'buy', stance: 'buy', confidence: 0.8, sourceIdx: 99 }] }));
    const r2 = await batchOf(s, ['$ZED zed is running', 'zed']);
    expect(r2.decisions.map(d => [d.action, d.reasons[1]])).toEqual([['skip', 'no source message for the action (address/link not found in the messages)']]);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.5, thesis: 'maybe' }));
    const r3 = await batchOf(s, ['$QQ qq', 'qq']);
    expect(r3.decisions.map(d => d.reasons[1])).toEqual(['act verdict with confidence 0.5 < 0.6 — no action']);
  });
  // Acceptance #92 (Y2): holding one project does not cancel a trade on another, new one (without a previous verdict)
  it('a held project does not cap ACT on a fresh project: BRIXO stays watch, ZED is bought (acceptance #92, Y2)', async () => {
    const s = setup({ batch: 2 });
    const ZED = 'ZeDzz1abcdefghijkmnopqrstuvwxyz23456789pump';
    s.prices.set(BRIXO, 0.0001); s.prices.set(ZED, 0.0002);
    s.setAnalyst(() => named('watch'));
    await batchOf(s, [`$BRIXO ${BRIXO}`, 'brixo']);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'ZED is the play; BRIXO also fine', project: { name: 'ZED', category: 'memecoin' },
      projects: [{ ref: `sol:${BRIXO}`, name: 'BRIXO', verdict: 'act', thesis: 't' }],
      intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: ZED, urls: [], summary: 'buy ZED', stance: 'buy', confidence: 0.8, sourceIdx: 2 }] }));
    const r = await batchOf(s, [`$BRIXO ${BRIXO} again`, `$ZED ${ZED} fresh launch`]);
    expect(r.analysis?.verdict).toBe('act');
    expect(r.analysis?.thesis).toMatch(/^BRIXO: kept watch \(was watch at \d\d:\d\d UTC; act without a named new reason\)/);
    expect(r.decisions.map(d => d.action)).toEqual(['buy_token']);
    expect(r.decisions[0].intent.tokenAddress).toBe(ZED);
    const brixo = s.store.db.prepare('SELECT last_verdict FROM projects WHERE id = ?').get(s.store.projectIdsForKeys([`sol:${BRIXO}`])[0]) as any;
    expect(brixo.last_verdict).toBe('watch');
  });
  // Acceptance #92, N1: a buy of the held project in the same analysis is not executed — skip with a reason; the buy of the new one goes through
  it('a held project\'s own buy intent is skipped with the held reason while the fresh project is bought (acceptance #92, N1)', async () => {
    const s = setup({ batch: 2 });
    const ZED = 'ZeDzz1abcdefghijkmnopqrstuvwxyz23456789pump';
    s.prices.set(BRIXO, 0.0001); s.prices.set(ZED, 0.0002);
    s.setAnalyst(() => named('watch'));
    await batchOf(s, [`$BRIXO ${BRIXO}`, 'brixo']);
    const buy = (a: string, i: number) => ({ kind: 'token_call', chain: 'solana', tokenAddress: a, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8, sourceIdx: i });
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'both run', project: { name: 'ZED', category: 'memecoin' },
      projects: [{ ref: `sol:${BRIXO}`, name: 'BRIXO', verdict: 'act', thesis: 't' }], intents: [buy(BRIXO, 1), buy(ZED, 2)] }));
    const r = await batchOf(s, [`$BRIXO ${BRIXO} again`, `$ZED ${ZED} fresh`]);
    expect(r.decisions.map(d => [d.action, d.intent.tokenAddress])).toEqual([['skip', BRIXO], ['buy_token', ZED]]);
    expect(r.decisions[0].reasons[1]).toBe('held at watch: no named new reason for act on this project — no action');
    expect(s.risk.holds(BRIXO)).toBe(false);
  });
  it('a held project\'s buy intent without an address (filled from its source message) is still skipped (acceptance #92, N1 round 2)', async () => {
    const s = setup({ batch: 2 });
    const ZED = 'ZeDzz1abcdefghijkmnopqrstuvwxyz23456789pump';
    s.prices.set(BRIXO, 0.0001); s.prices.set(ZED, 0.0002);
    s.setAnalyst(() => named('watch'));
    await batchOf(s, [`$BRIXO ${BRIXO}`, 'brixo']);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'both run', project: { name: 'ZED', category: 'memecoin' },
      projects: [{ ref: `sol:${BRIXO}`, name: 'BRIXO', verdict: 'act', thesis: 't' }],
      intents: [{ kind: 'token_call', chain: 'solana', urls: [], summary: 'buy brixo', stance: 'buy', confidence: 0.8, sourceIdx: 1 },
        { kind: 'token_call', chain: 'solana', tokenAddress: ZED, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8, sourceIdx: 2 }] }));
    const r = await batchOf(s, [`$BRIXO ${BRIXO} again`, `$ZED ${ZED} fresh`]);
    expect(r.decisions.map(d => [d.action, d.intent.tokenAddress])).toEqual([['skip', BRIXO], ['buy_token', ZED]]);
    expect(r.decisions[0].reasons[1]).toBe('held at watch: no named new reason for act on this project — no action');
    expect(s.risk.holds(BRIXO)).toBe(false);
  });
  // Acceptance #92 (Y1): the X note was written for act — after holding at watch it is gone (no thought), the code writes no replacement
  it('a held escalation drops the act-worded public note: no thought (acceptance #92, Y1)', async () => {
    const s = setup();
    s.prices.set(BRIXO, 0.0001);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.8, thesis: 'waiting for volume', publicNote: 'Watching $BRIXO, want to see volume hold first.' }));
    const r0 = await handleMessage(msg({ text: `$BRIXO ${BRIXO} launched` }), s.deps);
    expect(r0.analysis?.thought?.note).toMatch(/Watching \$BRIXO/);       // without a hold the note stays
    s.clock.set(s.clock.now() + 61 * 60_000);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'volume held, entering', publicNote: 'Planning to take a small position in $BRIXO now that volume held.',
      intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: BRIXO, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
    // An honest mock (finisher #69, round 2): the shared mock calls exec('fetch_page') and crashes the repeat note request (A-08), which
    // has no tools, — then the test is green by accident. Here the repeat request answers with a note; the hold must not make it
    const notesOnly: string[] = [];
    const base = s.deps.intel!.runAnalyst!;
    s.deps.intel!.runAnalyst = async (a) => {
      if (!a.user.startsWith('PUBLIC NOTES ONLY')) return base(a);
      notesOnly.push(a.user);
      return { verdict: { verdict: 'act', thesis: 'same', confidence: 0.8, publicNote: 'Planning to take a small position in $BRIXO now that volume held.' }, usage: [{ input_tokens: 400, output_tokens: 60 }], toolCalls: [] };
    };
    const { recheckDue } = await import('../src/intel/router.js');
    const r = await recheckDue(s.deps);
    expect(r[0].analysis?.verdict).toBe('watch');
    expect(r[0].analysis?.thought).toBeUndefined();
    expect(notesOnly).toEqual([]);                                         // we don't invent a replacement note
    expect(r[0].decisions).toEqual([]);
  });
});

// A-11 (#82, the owner 2026-11-11 ~08:00 UTC): shadow of saving ideas 1–4. Behaviour does NOT change (the number of model calls is the same),
// a cost_shadow event with the new path's decision is written to the log (format — #78).
describe('cost shadow (A-11): the old path runs as is, the new path decision is journaled', () => {
  const rickCard = (mint: string, replyTo: string) => `💊 **[WISP](https://pump.fun/${mint}) [129K/250%] - WISP/SOL**
---
Replied to: ${replyTo}
${mint}
---
https://dexscreener.com/solana/PaiR9xyzabcdefghijkmnopqrstuvwxyz23456789A
💎 FDV: \`129K\` 💦 Liq: \`15.7K\`
[👥](https://t.me/rick?start=nh_${mint}) TH: [3.7](https://solscan.io/account/HoLder1abcdefghijkmnopqrstuvwxyz23456789AB)`;
  const capture = async () => {
    const { setReviewSink } = await import('../src/review/log.js');
    const ev: Record<string, any>[] = [];
    setReviewSink({ write: (k, d) => { if (k === 'cost_shadow') ev.push(d); } });
    return { ev, done: () => setReviewSink({ write() {} }) };
  };
  it('batch-dedup: the second batch about the same coin would not go to the model — but still does now', async () => {
    const { ev, done } = await capture();
    const s = setup({ batch: 2 });
    for (const a of ['a', 'b']) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: a, text: `${MINT} pumping` }), s.deps);
    s.clock.set(s.clock.now() + 3600_000);
    for (const a of ['c', 'd']) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: a, text: `${MINT} still pumping` }), s.deps);
    done();
    expect(s.calls).toHaveLength(2);                                                     // the old path: both batches go to the model
    const dd = ev.filter(e => e.idea === 'batch-dedup');
    expect(dd.map(e => [e.wouldSkip, e.verdict])).toEqual([[false, 'ignore'], [true, 'ignore']]);
    expect(dd[0].reason).toBe(`new coin sol:${MINT}`);
    expect(dd[1].costUsd).toBeGreaterThan(0);
    // FDV ×2 — new data
    const { batchDedup } = await import('../src/intel/costShadow.js');
    expect(batchDedup([{ key: 'k', lastAnalysisMs: 0, lastTrust: 3, prevFdv: 100_000, fdv: 210_000 }], 3, 3600_000, 24).wouldSkip).toBe(false);
    expect(batchDedup([{ key: 'k', lastAnalysisMs: 0, lastTrust: 3 }], 7, 3600_000, 24).reason).toMatch(/new trusted author/);
  });
  it('batch-compact: bot cards become one data line, repeated cards of one coin are dropped; chars before and after are journaled', async () => {
    const { ev, done } = await capture();
    const s = setup({ batch: 3 });
    const card = rickCard(MINT, 'caller');
    for (const [a, t] of [['Rick', card], ['Rick', card], ['b', 'what is this']] as const) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: a, text: t }), s.deps);
    done();
    const c = ev.find(e => e.idea === 'batch-compact')!;
    expect(c.wouldSkip).toBe(false);
    expect(c.charsAfter).toBeLessThan(c.charsBefore - card.length);
    const { compactCard } = await import('../src/intel/costShadow.js');
    expect(compactCard(card)).toBe(`bot card: WISP ${MINT} FDV 129K Liq 15.7K`);
  });
  it('recheck-gate is ON (the owner 2026-11-17): no cost_shadow events for it any more; watch goes to the model', async () => {
    const { ev, done } = await capture();
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, thesis: 'needs a day', recheckAfterMinutes: 30 }));
    await handleMessage(msg({ text: `look ${MINT}` }), s.deps);
    s.clock.set(s.clock.now() + 31 * 60_000);
    const { recheckDue } = await import('../src/intel/router.js');
    const r = await recheckDue(s.deps);
    done();
    expect(r[0].analysis?.verdict).toBe('watch');
    expect(ev.filter(e => e.idea === 'recheck-gate')).toEqual([]);
    const { recheckGate } = await import('../src/intel/costShadow.js');
    expect(recheckGate('watch', 'analyst re-check').skip).toBe(false);
  });
  it('burst-merge: the same project again within 3 minutes (passed the repeat guard) would be merged', async () => {
    const { ev, done } = await capture();
    const s = setup();
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'degen', author: 'caller5', text: `aping ${MINT}` }), s.deps);
    s.clock.set(s.clock.now() + 60_000);
    await handleMessage(msg({ author: 'caller1', text: `me too ${MINT}` }), s.deps);           // score 9 > 5 — the repeat guard lets it through
    done();
    expect(s.calls).toHaveLength(2);
    expect(ev.filter(e => e.idea === 'burst-merge').map(e => [e.wouldSkip, e.reason])).toEqual([[false, 'no analysis of the same project in the window'], [true, 'same project analyzed 60 s ago (window 180 s)']]);
  });
});

// Acceptance #89, round 1 (HQ repros D1–D4): shadow accuracy.
describe('cost shadow accuracy (acceptance #89, round 1)', () => {
  const capture = async () => {
    const { setReviewSink } = await import('../src/review/log.js');
    const ev: Record<string, any>[] = [];
    setReviewSink({ write: (k, d) => { if (k === 'cost_shadow') ev.push(d); } });
    return { ev, done: () => setReviewSink({ write() {} }) };
  };
  const batchOf = async (s: ReturnType<typeof setup>, texts: string[]) => { for (const [i, t] of texts.entries()) await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: `u${i}`, text: t }), s.deps); };
  const dedup = (ev: Record<string, any>[]) => ev.filter(e => e.idea === 'batch-dedup').map(e => `${e.wouldSkip} — ${e.reason}`);
  it('D1 a batch the new path would skip does not refresh «last analyzed»', async () => {
    const { ev, done } = await capture();
    const s = setup({ batch: 2 });
    await batchOf(s, [`${MINT} pumping`, 'gm']);
    s.clock.set(s.clock.now() + 20 * 3600_000); await batchOf(s, [`${MINT} still here`, 'gm']);
    s.clock.set(s.clock.now() + 20 * 3600_000); await batchOf(s, [`${MINT} again`, 'gm']);
    done();
    const dd = dedup(ev);
    expect(dd[1]).toMatch(/^true/);
    expect(dd[2]).toMatch(/^false — sol:\S+ last analyzed ≥ 24 h ago/);
  });
  it('D2 the FDV base is the last analysis the new path would make: 100K → 150K → 220K is ×2.2', async () => {
    const { ev, done } = await capture();
    const s = setup({ batch: 2 });
    let fdv = 100_000;
    const m = s.deps.decide.market as any; const orig = m.market.bind(m);
    m.market = async (a: string) => { const x = await orig(a); return x ? { ...x, fdvUsd: fdv } : x; };
    await batchOf(s, [`${MINT} pumping`, 'gm']);
    s.clock.set(s.clock.now() + 3600_000); fdv = 150_000; await batchOf(s, [`${MINT} still here`, 'gm']);
    s.clock.set(s.clock.now() + 3600_000); fdv = 220_000; await batchOf(s, [`${MINT} again`, 'gm']);
    done();
    expect(dedup(ev)[2]).toMatch(/^false — FDV 100000 → 220000/);
    expect(ev.filter(e => e.idea === 'batch-dedup')[1].prevVerdict).toBeUndefined();   // the batch did not name a project — no previous verdict
  });
  it('D3 a top-holder wallet in a bot card is not a «new coin»', async () => {
    const { ev, done } = await capture();
    const s = setup({ batch: 2 });
    const card = (holder: string) => `💊 **[WISP](https://pump.fun/${MINT}) [129K/250%] - WISP/SOL**\n${MINT}\n💎 FDV: \`129K\` 💦 Liq: \`15.7K\`\n[👥](https://t.me/rick?start=nh_${MINT}) TH: [3.7](https://solscan.io/account/${holder})`;
    await batchOf(s, [card('HoLder1abcdefghijkmnopqrstuvwxyz23456789AB'), 'gm']);
    s.clock.set(s.clock.now() + 3600_000);
    await batchOf(s, [card('HoLder2abcdefghijkmnopqrstuvwxyz23456789AB'), 'gm']);
    done();
    expect(dedup(ev)[1]).toMatch(/^true/);
  });
  it('D4 a human call with MC and a DexScreener link is not a bot card: compaction keeps both calls', async () => {
    const { compactBatch } = await import('../src/intel/costShadow.js');
    const call = (who: string, why: string) => ({ msg: { author: who, text: `aping $WISP ${MINT} MC 40k — ${why} https://dexscreener.com/solana/${MINT}` } });
    const batch = [call('caller1', 'dev is the guy behind BONK, 3 KOLs in, target 2M'), call('caller5', 'CTO finished, new socials are live')];
    expect(compactBatch(batch)).toEqual(batch);
  });
  it('recheck-gate: an «ignore»/«act» recheck set by code (mint phase) is not skipped; analyst ones are', async () => {
    const { recheckGate } = await import('../src/intel/costShadow.js');
    expect(recheckGate('ignore', '30 min before public (2026-10-22T23:25:00Z)', { byModel: true }).skip).toBe(false);
    expect(recheckGate('act', '30 min before public (2026-10-22T23:25:00Z)').skip).toBe(false);
    expect(recheckGate('ignore', 'analyst re-check', { byModel: true }).skip).toBe(true);
    expect(recheckGate('ignore', 'watch without a time — default re-check in 60 min', { byModel: true }).skip).toBe(true);
    // ignore from the code (a hard cutoff) or an unknown source — the model (review R1)
    expect(recheckGate('ignore', 'analyst re-check').skip).toBe(false);
    expect(recheckGate('ignore', 'analyst re-check', { byModel: false }).skip).toBe(false);
    // act: only if the action was executed or there is no executor (actSettled), otherwise — the model
    expect(recheckGate('act', 'watch without a time — default re-check in 60 min').skip).toBe(false);
    expect(recheckGate('act', 'analyst re-check', { actSettled: 'position open (the monitor manages it)' }).skip).toBe(true);
    expect(recheckGate('act', '30 min before public (2026-10-22T23:25:00Z)', { actSettled: 'position open' }).skip).toBe(false);
    expect(recheckGate('avoid', 'analyst re-check').skip).toBe(false);
    expect(recheckGate(null, 'analyst re-check').skip).toBe(false);
  });
  it('actOutcome: any market/risk skip among the decisions → open (recheck needed)', async () => {
    const { actOutcome } = await import('../src/intel/costShadow.js');
    const d = (action: string, ...reasons: string[]) => ({ action, reasons });
    expect(actOutcome([])).toBe('open');
    expect(actOutcome([d('dapp_session')])).toBe('task');
    expect(actOutcome([d('notify_human')])).toBe('task');
    expect(actOutcome([d('buy_token')])).toBe('position');
    expect(actOutcome([d('skip', 'execution blocked: live: no live executor for dapp_session — journal only')])).toBe('no_executor');
    expect(actOutcome([d('journal_only', 'no browser executor yet (E-06)')])).toBe('no_executor');
    expect(actOutcome([d('skip', 'click needs a wallet — that is E-13')])).toBe('no_executor');
    expect(actOutcome([d('skip', 'entry: ×2.00 in 1h ≥ ×1.8')])).toBe('open');
    expect(actOutcome([d('skip', 'execution blocked: risk: trading halted')])).toBe('open');
    expect(actOutcome([d('scheduled')])).toBe('open');
    expect(actOutcome([d('dapp_session'), d('skip', 'size below minimum')])).toBe('open');
    expect(actOutcome([d('buy_token'), d('dapp_session')])).toBe('position');
  });
});

// Recheck savings are on (the owner's decision 2026-11-17 ~22:20 UTC, "Everything at once"): previous verdict ignore/act —
// a recheck scheduled by the analyst goes without the model (with a log record, doneWatch); one scheduled by the code — as before;
// other rechecks — on Sonnet instead of Opus.
describe('recheck economy: ignore/act analyst re-checks are not run, the rest go to Sonnet', () => {
  const SONNET = DEFAULT_CAPS.fallbackModel, OPUS = DEFAULT_CAPS.analystModel;
  const journal = async () => {
    const { setReviewSink } = await import('../src/review/log.js');
    const ev: { kind: string; d: Record<string, any> }[] = [];
    setReviewSink({ write: (kind, d) => { ev.push({ kind, d }); } });
    return { ev, done: () => setReviewSink({ write() {} }) };
  };
  /** The first analysis with verdict v, then in the database — a recheck after 30 min with the reason `reason` (like an old record). */
  const prepare = async (v: Record<string, unknown>, reason: string, o: { opts?: Parameters<typeof setup>[0]; text?: string; before?: (s: ReturnType<typeof setup>) => void } = {}) => {
    const s = setup(o.opts);
    const logs: string[] = []; s.deps.log = (l: string) => { logs.push(l); };
    o.before?.(s);
    s.setAnalyst(() => v);
    const m0 = msg({ text: o.text ?? `look ${MINT}` });
    const r0 = await handleMessage(m0, s.deps);
    const pid = s.store.projectIdsForKeys([`sol:${MINT}`])[0];
    expect(pid).toBeDefined();
    expect(s.deps.intel!.cards.card(pid)!.lastVerdict).toBe(v.verdict);
    s.store.addWatch(pid, m0.id, new Date(s.clock.now() + 30 * 60_000).toISOString(), reason);
    s.clock.set(s.clock.now() + 31 * 60_000);
    return { s, logs, pid, r0, m0, calls0: s.calls.length };
  };
  const buy = { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 };
  const actBuy = { verdict: 'act', confidence: 0.9, thesis: 'flow is real', intents: [buy] };
  const QUEST = 'https://nebulix-quest.xyz/tasks';
  const actDapp = { verdict: 'act', confidence: 0.9, thesis: 'site task, no executor', intents: [{ kind: 'dapp_task', chain: 'ethereum', urls: [QUEST], summary: 'complete the quest', stance: 'neutral', confidence: 0.9 }] };
  const S02 = { version: 1, maxRunUp1h: 1.8, freshPairMaxMinutes: 12, oldPairMinHours: 20, shareOfCapital: 0.08, ageRuleExemptMinTrust: null }; // example numbers
  const due = (s: ReturnType<typeof setup>) => s.store.dueWatch(new Date(s.clock.now() + 30 * 86400_000).toISOString());

  it('ignore + analyst re-check → no model call, logged and journaled, marked done', async () => {
    const { s, logs, calls0 } = await prepare({ verdict: 'ignore', confidence: 0.9, thesis: 'nothing' }, 'analyst re-check');
    const { ev, done } = await journal();
    const { recheckDue } = await import('../src/intel/router.js');
    const r = await recheckDue(s.deps);
    done();
    expect(s.calls.length).toBe(calls0);
    expect(r).toEqual([expect.objectContaining({ skipped: 'recheck skipped: last verdict ignore: analyst re-check is not run' })]);
    expect(logs.some(l => /^scheduled recheck skipped \(no model\): project .+, last verdict ignore, reason «analyst re-check»/.test(l))).toBe(true);
    expect(ev.filter(e => e.kind === 'recheck_skipped').map(e => e.d)).toEqual([expect.objectContaining({ lastVerdict: 'ignore', watchReason: 'analyst re-check' })]);
    expect(ev.filter(e => e.kind === 'cost_shadow')).toEqual([]);
    expect(due(s)).toEqual([]);                                                          // doneWatch: does not pile up
    expect(await recheckDue(s.deps)).toEqual([]);
  });

  it('act + dapp_session (task card issued) → analyst re-check and default re-check skipped (Nebulix case)', async () => {
    for (const reason of ['analyst re-check', 'watch without a time — default re-check in 60 min']) {
      const { s, r0, calls0 } = await prepare(actDapp, reason, { text: `quest ${MINT} ${QUEST}` });
      expect(r0.decisions.map(d => d.action)).toEqual(['dapp_session']);
      const { recheckDue } = await import('../src/intel/router.js');
      const r = await recheckDue(s.deps);
      expect(s.calls.length).toBe(calls0);
      expect(r[0].skipped).toBe('recheck skipped: last verdict act, task action done (card issued / session started): analyst re-check is not run');
      expect(due(s)).toEqual([]);
    }
  });

  it('act + dapp_session blocked in live (no live executor) → skipped', async () => {
    const { s, r0, calls0 } = await prepare(actDapp, 'analyst re-check', { text: `quest ${MINT} ${QUEST}`, before: s => { s.paper.liveMode = 'live'; } });
    expect(r0.decisions[0]).toMatchObject({ action: 'skip', reasons: expect.arrayContaining([expect.stringMatching(/no live executor/)]) });
    const { recheckDue } = await import('../src/intel/router.js');
    const r = await recheckDue(s.deps);
    expect(s.calls.length).toBe(calls0);
    expect(r[0].skipped).toBe('recheck skipped: last verdict act, action blocked: no executor: analyst re-check is not run');
  });

  it('act + open position → skipped; after the position is closed → model (Sonnet)', async () => {
    const { s, r0, pid, m0, calls0 } = await prepare(actBuy, 'analyst re-check');
    expect(r0.decisions.map(d => d.action)).toEqual(['buy_token']);
    const { recheckDue } = await import('../src/intel/router.js');
    const r = await recheckDue(s.deps);
    expect(s.calls.length).toBe(calls0);
    expect(r[0].skipped).toBe('recheck skipped: last verdict act, position open (the monitor manages it): analyst re-check is not run');
    // The position is closed (stop) — the analyst's recheck is needed again: the analyst may have been waiting for a new entry
    expect(await s.paper.exitToken(MINT, 'stop', s.deps.decide.market)).toBe(true);
    s.store.addWatch(pid, m0.id, new Date(s.clock.now() + 60_000).toISOString(), 'analyst re-check');
    s.clock.set(s.clock.now() + 2 * 60_000);
    await recheckDue(s.deps);
    expect(s.calls.length).toBe(calls0 + 1);
    expect(s.calls[calls0].model).toBe(SONNET);
  });

  it('act + skip by the S-02 entry filter (pump ≥ ×1.8 in 1 h) → analyst re-check goes to the model, on Sonnet', async () => {
    const { s, r0, calls0 } = await prepare(actBuy, 'analyst re-check', { opts: { risk: { memecoinEntry: S02 } as any }, before: s => {
      const m = s.deps.decide.market as any; const orig = m.market.bind(m);
      m.market = async (a: string) => { const x = await orig(a); return x ? { ...x, pairAgeMinutes: 30 * 60, priceChangeH1Pct: 100 } : x; };
    } });
    expect(r0.decisions[0]).toMatchObject({ action: 'skip', reasons: expect.arrayContaining([expect.stringMatching(/chasing a pump, skip \(S-02\)/)]) });
    const { recheckDue } = await import('../src/intel/router.js');
    await recheckDue(s.deps);
    expect(s.calls.length).toBe(calls0 + 1);
    expect(s.calls[calls0].model).toBe(SONNET);
  });

  // Review item 4: two guards — the result record is checked against the card's verdict time, and is written only for a single-project analysis
  const MINT2 = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
  const pumped = (s: ReturnType<typeof setup>) => {
    const m = s.deps.decide.market as any; const orig = m.market.bind(m);
    m.market = async (a: string) => { const x = await orig(a); return x ? { ...x, pairAgeMinutes: 30 * 60, priceChangeH1Pct: 100 } : x; };
  };
  it('act+dapp_session (task) → later multi-project act with an S-02 skip → the analyst re-check reaches the model (stale outcome is not used)', async () => {
    const { s, pid, calls0 } = await prepare(actDapp, 'analyst re-check', { text: `quest ${MINT} ${QUEST}`, opts: { risk: { memecoinEntry: S02 } as any }, before: pumped });
    s.prices.set(MINT2, 0.0001);
    const iso0 = s.deps.intel!.cards.card(pid)!.lastAnalysisUtc;
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'both are moving', changeReason: 'second token from the same team launched',
      projects: [{ ref: `sol:${MINT}`, verdict: 'act', category: 'memecoin', thesis: 'buy' }, { ref: `sol:${MINT2}`, verdict: 'watch', category: 'memecoin', thesis: 'later' }], intents: [buy] }));
    const r1 = await handleMessage(msg({ text: `team launched ${MINT2}, still in ${MINT}` }), s.deps);
    expect(s.calls.length).toBe(calls0 + 1);
    expect(r1.decisions[0]).toMatchObject({ action: 'skip', reasons: expect.arrayContaining([expect.stringMatching(/\(S-02\)/)]) });
    const card = s.deps.intel!.cards.card(pid)!;
    expect(card.lastVerdict).toBe('act');
    expect(card.lastAnalysisUtc).not.toBe(iso0);                                   // the verdict of the new (multi-project) analysis
    const { recheckDue } = await import('../src/intel/router.js');
    const before = s.calls.length;
    const r = await recheckDue(s.deps);
    expect(r.filter(x => x.skipped?.startsWith('recheck skipped'))).toEqual([]);
    expect(s.calls.length).toBe(before + 1);
    expect(s.calls[before].model).toBe(SONNET);
  });

  it('multi-project act whose only action is a task → no outcome is recorded for the projects: their analyst re-checks go to the model', async () => {
    const s = setup();
    s.prices.set(MINT2, 0.0001);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'quest of the team behind both tokens',
      projects: [{ ref: `sol:${MINT}`, verdict: 'act', category: 'memecoin', thesis: 'quest' }, { ref: `sol:${MINT2}`, verdict: 'act', category: 'memecoin', thesis: 'quest' }],
      intents: actDapp.intents }));
    const m0 = msg({ text: `quest ${MINT} ${MINT2} ${QUEST}` });
    const r0 = await handleMessage(m0, s.deps);
    expect(r0.decisions.map(d => d.action)).toEqual(['dapp_session']);
    const ids = [MINT, MINT2].map(a => s.store.projectIdsForKeys([`sol:${a}`])[0]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(s.deps.intel!.cards.card(id)!.lastVerdict).toBe('act');
      s.store.addWatch(id, m0.id, new Date(s.clock.now() + 30 * 60_000).toISOString(), 'analyst re-check');
    }
    s.clock.set(s.clock.now() + 31 * 60_000);
    const calls0 = s.calls.length;
    const { recheckDue } = await import('../src/intel/router.js');
    const r = await recheckDue(s.deps);
    expect(r.filter(x => x.skipped?.startsWith('recheck skipped'))).toEqual([]);
    expect(s.calls.length).toBe(calls0 + 2);
  });

  it('act without a recorded outcome (older record, other analysis) → model, on Sonnet', async () => {
    const { s, calls0 } = await prepare({ verdict: 'act', confidence: 0.9, thesis: 'no intents' }, 'analyst re-check');
    const { recheckDue } = await import('../src/intel/router.js');
    await recheckDue(s.deps);
    expect(s.calls.length).toBe(calls0 + 1);
    expect(s.calls[calls0].model).toBe(SONNET);
  });

  it('ignore verdicts do not schedule analyst re-checks any more; act still does', async () => {
    for (const verdict of ['act', 'ignore']) {
      const s = setup();
      s.setAnalyst(() => ({ verdict, confidence: 0.9, thesis: 'x', recheckAtUtc: [new Date(s.clock.now() + 3600_000).toISOString()] }));
      await handleMessage(msg({ text: `look ${MINT}` }), s.deps);
      expect(due(s).map(w => w.reason)).toEqual(verdict === 'act' ? ['analyst re-check'] : []);
    }
  });

  it('act + recheck set by code (mint phase) → model runs, on Sonnet', async () => {
    const { s, calls0 } = await prepare({ verdict: 'act', confidence: 0.9, thesis: 'mint' }, '30 min before public (2026-10-22T23:25:00Z)');
    const { recheckDue } = await import('../src/intel/router.js');
    const r = await recheckDue(s.deps);
    expect(s.calls.length).toBe(calls0 + 1);
    expect(s.calls[calls0].model).toBe(SONNET);
    expect(r[0].analysis?.model).toBe(SONNET);
  });

  it('watch → model runs with Sonnet preferred (first analysis stays on Opus)', async () => {
    const { s, calls0 } = await prepare({ verdict: 'watch', confidence: 0.7, thesis: 'needs a day' }, 'analyst re-check');
    expect(s.calls[0].model).toBe(OPUS);
    const { recheckDue } = await import('../src/intel/router.js');
    await recheckDue(s.deps);
    expect(s.calls.length).toBeGreaterThan(calls0);
    expect(s.calls[calls0].model).toBe(SONNET);
    expect(s.calls[calls0].user).toContain('scheduled_recheck');
  });

  it('Sonnet budget exhausted → the usual channel path: Opus while it is free (review R2)', async () => {
    const s = setup({ caps: { sonnetDailyUsd: 0 } });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, thesis: 'needs a day', recheckAfterMinutes: 30 }));
    await handleMessage(msg({ text: `look ${MINT}` }), s.deps);
    const calls0 = s.calls.length;
    s.clock.set(s.clock.now() + 31 * 60_000);
    const { recheckDue } = await import('../src/intel/router.js');
    const r = await recheckDue(s.deps);
    expect(s.calls.length).toBe(calls0 + 1);
    expect(s.calls[calls0].model).toBe(OPUS);
    expect(r[0].analysis?.model).toBe(OPUS);
  });

  it('a new message about an «act» project is analyzed as before (not a recheck): model called, on Opus', async () => {
    const { s, calls0 } = await prepare({ verdict: 'act', confidence: 0.9, thesis: 'dapp session, no executor' }, 'analyst re-check');
    // The repeat guard is unchanged: the same address with nothing new after 31 min — a repeat; after a day — an analysis by the model
    expect((await handleMessage(msg({ author: 'caller1', text: `again ${MINT}` }), s.deps)).skipped).toMatch(/^repeat/);
    s.clock.set(s.clock.now() + 25 * 3600_000);
    const r = await handleMessage(msg({ author: 'caller1', text: `new: team announced a CEX listing ${MINT}` }), s.deps);
    expect(s.calls.length).toBe(calls0 + 1);
    expect(s.calls[calls0].model).toBe(OPUS);
    expect(r.analysis).toBeDefined();
  });
});

// A-16 (#121, the owner 2026-11-13 07:42 UTC): checking X followers against smart accounts is about half of the twitterapi.io credits.
// Right away: a token the code cuts off without the model is not checked. Plus a measurement: each check is a smart_check event in the log.
describe('A-16: no smart-follower check for tokens the code rejects anyway; every check is measured', () => {
  const wire = (s: ReturnType<typeof setup>, mintAuthority: boolean) => {
    const seen: string[] = [];
    s.deps.intel!.enrich.market = {
      async market() { return { chain: 'solana', symbol: 'PRJ', twitter: 'projx', priceUsd: 0.0001, liquidityUsd: 25_000, fdvUsd: 100_000, pairAgeMinutes: 30, buys24h: 400, sells24h: 300 }; },
      async rug() { return { risk: mintAuthority ? 'high' : 'medium', freezeOrMintAuthority: mintAuthority, reasons: [] }; },
    } as MarketClient;
    s.deps.intel!.enrich.x = {
      async profile(h: string) { seen.push(`profile ${h}`); return { handle: h, id: '9', followers: 3000 }; },
      async search(q: string) { seen.push(`search ${q}`); return []; }, async timeline() { return []; },
      async followers() { seen.push('followers'); return [{ handle: 'someone', followers: 5 }]; },
      async followerIds() { seen.push('followerIds'); return ['1', '7']; },
    } as any;
    s.deps.intel!.enrich.smart = { handles: new Map([['alpha_a', 'trader']]), ids: async () => new Map([['1', 'alpha_a']]) };
    return seen;
  };
  const capture = async () => {
    const ev: Record<string, unknown>[] = [];
    const { setReviewSink } = await import('../src/review/log.js');
    setReviewSink({ write: (k, d) => { if (k === 'smart_check') ev.push(d); } });
    return { ev, done: () => setReviewSink({ write() {} }) };
  };

  it('a token with mint authority (code verdict, no model): profile and talk are read, follower IDs and the sample are not', async () => {
    const s = setup(); const seen = wire(s, true); const c = await capture();
    try {
      const r = await handleMessage(msg({ text: `${MINT} new one` }), s.deps);
      expect(r.analysis?.model).toBe('code');
      expect(s.calls).toHaveLength(0);
      expect(seen).toContain('profile projx');
      expect(seen.filter(x => x === 'followerIds' || x === 'followers')).toEqual([]);
      expect(c.ev).toEqual([expect.objectContaining({ done: false, why: 'code check rejects the token', rejectedByCode: true, handle: 'projx', idsRecords: 0, sampleRecords: 0, smartFound: [] })]);
    } finally { c.done(); }
  });

  it('a clean token goes to the model with the full check; the check is logged with primary data and the msgId of the analysis', async () => {
    const s = setup(); const seen = wire(s, false); const c = await capture();
    try {
      const m = msg({ text: `${MINT} new one` });
      const r = await handleMessage(m, s.deps);
      expect(r.analysis?.model).not.toBe('code');
      expect(seen).toEqual(expect.arrayContaining(['followerIds', 'followers']));
      expect(s.calls[0].user).toContain('"smart":[{"handle":"alpha_a","note":"trader"}]');
      expect(c.ev).toEqual([expect.objectContaining({ msgId: m.id, source: 'ServerA/#core-calls/caller', trust: expect.any(Number), done: true, rejectedByCode: false,
        accountFollowers: 3000, idsRecords: 2, sampleRecords: 1, smartFound: ['alpha_a'],
        tokens: [{ address: MINT, chain: 'solana', liquidityUsd: 25_000, fdvUsd: 100_000, pairAgeMinutes: 30 }] })]);
    } finally { c.done(); }
  });

  it('a pack without the check (rejected token) is not reused when the same token later needs the check; a full pack is reused', async () => {
    const s = setup(); const seen = wire(s, true);
    const { buildDossier } = await import('../src/analyst/enrich.js');
    const input = { tokens: [MINT], domains: [], xHandles: [], urls: [], tickers: [], hardCheck: { strictLiquidity: true } };
    await buildDossier(input, s.deps.intel!.enrich);
    expect(seen.filter(x => x === 'followerIds')).toHaveLength(0);
    const rug = { v: false };
    s.deps.intel!.enrich.market = { ...s.deps.intel!.enrich.market, async rug() { return { risk: 'medium', freezeOrMintAuthority: rug.v, reasons: [] }; } } as MarketClient;
    const d2 = await buildDossier(input, s.deps.intel!.enrich);
    expect(seen.filter(x => x === 'followerIds')).toHaveLength(1);
    expect(d2.xResearch?.[0].followers?.smart).toEqual([{ handle: 'alpha_a', note: 'trader' }]);
    rug.v = true;                                            // the full package from the cache is fine for a cut-off token too
    await buildDossier(input, s.deps.intel!.enrich);
    expect(seen.filter(x => x === 'followerIds')).toHaveLength(1);
  });

  // Acceptance #124, round 1, item 3: the main risk — the check disappeared for a project that goes to the model.
  // Score ≥ 7: empty liquidity does not cut off (strictLiquidity only at score ≤ 6) — the check is there, the model is called.
  it('score ≥ 7, liquidity < $3k on a pair older than 1 h → not rejected: full check and the model; score ≤ 6 → code verdict, no check', async () => {
    const lowLiq = (s: ReturnType<typeof setup>) => {
      const seen = wire(s, false);
      s.deps.intel!.enrich.market = { ...s.deps.intel!.enrich.market,
        async market() { return { chain: 'solana', symbol: 'PRJ', twitter: 'projx', priceUsd: 0.0001, liquidityUsd: 2_000, fdvUsd: 50_000, pairAgeMinutes: 120, buys24h: 40, sells24h: 30 }; } } as MarketClient;
      return seen;
    };
    const hi = setup(); const seenHi = lowLiq(hi);
    const rHi = await handleMessage(msg({ text: `${MINT} still early` }), hi.deps);      // ServerA/#core-calls/caller — score 9
    expect(rHi.analysis?.model).not.toBe('code');
    expect(hi.calls).toHaveLength(1);
    expect(seenHi).toEqual(expect.arrayContaining(['followerIds', 'followers']));
    const lo = setup(); const seenLo = lowLiq(lo);
    const rLo = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'degen', author: 'someone', text: `${MINT} still early` }), lo.deps);   // score 5
    expect(rLo.analysis).toMatchObject({ model: 'code', verdict: 'ignore' });
    expect(seenLo.filter(x => x === 'followerIds' || x === 'followers')).toEqual([]);
  });
});

// Acceptance #124, round 1, item 1 (reviewer repro): smart_check must reflect what was really fetched and really found with X caches.
describe('A-16: smart_check vs. X caches', () => {
  const MINT2 = MINT;
  const mk = (now: { t: number }) => {
    const raw = { followerIds: 0, followers: 0 };
    const x = {
      async profile(h: string) { return { handle: h, id: '9', followers: 3000 }; },
      async search() { return []; }, async timeline() { return []; },
      async followers() { raw.followers++; return [{ handle: 'someone', followers: 5 }]; },
      async followerIds() { raw.followerIds++; return ['1', '7']; },
    } as any;
    const d = { now: () => now.t, x,
      market: { async market() { return { chain: 'solana', symbol: 'PRJ', twitter: 'projx', priceUsd: 0.0001, liquidityUsd: 25_000, fdvUsd: 100_000, pairAgeMinutes: 30, buys24h: 400, sells24h: 300 }; },
        async rug() { return { risk: 'medium', freezeOrMintAuthority: false, reasons: [] }; } },
      smart: { handles: new Map([['alpha_a', 'trader']]), ids: async () => new Map([['1', 'alpha_a']]) } } as any;
    return { d, raw };
  };
  const input = (msgId: string) => ({ tokens: [MINT2], domains: [], xHandles: [], urls: [], tickers: [], hardCheck: { strictLiquidity: false }, log: { msgId, source: 's', trust: 8 } });
  const capture = async () => {
    const ev: any[] = [];
    const { setReviewSink } = await import('../src/review/log.js');
    setReviewSink({ write: (k, e) => { if (k === 'smart_check') ev.push(e); } });
    return { ev, done: () => setReviewSink({ write() {} }) };
  };

  it('after 30 min (pack cache expired, call cache alive) the event counts only records really fetched and says «from the call cache»', async () => {
    const { buildDossier, X_CACHE_TTL_MS } = await import('../src/analyst/enrich.js');
    const c = await capture();
    try {
      const now = { t: Date.UTC(2026, 10, 13, 8) }; const { d, raw } = mk(now);
      await buildDossier(input('m1'), d);
      now.t += 31 * 60_000;
      expect(31 * 60_000).toBeLessThan(X_CACHE_TTL_MS.followerIds);
      await buildDossier(input('m2'), d);
      expect(raw).toEqual({ followerIds: 1, followers: 1 });
      expect({ ids: c.ev.reduce((a, e) => a + e.idsRecords, 0), sample: c.ev.reduce((a, e) => a + e.sampleRecords, 0) }).toEqual({ ids: 2, sample: 1 });
      expect(c.ev[0]).toMatchObject({ msgId: 'm1', idsRecords: 2, sampleRecords: 1, usedIds: 2, usedSample: 1, smartFound: ['alpha_a'] });
      expect(c.ev[0].cached).toBeUndefined();
      expect(c.ev[1]).toMatchObject({ msgId: 'm2', idsRecords: 0, sampleRecords: 0, usedIds: 2, usedSample: 1, cached: 'calls', smartFound: ['alpha_a'] });
    } finally { c.done(); }
  });

  it('a repeat within 30 min (pack cache) still writes the event for its msgId, with the finding from the pack and 0 records', async () => {
    const { buildDossier } = await import('../src/analyst/enrich.js');
    const c = await capture();
    try {
      const now = { t: Date.UTC(2026, 10, 13, 8) }; const { d } = mk(now);
      await buildDossier(input('m1'), d);
      now.t += 5 * 60_000;
      const d2 = await buildDossier(input('m2'), d);
      expect(d2.xResearch?.[0].followers?.smart.map(s => s.handle)).toEqual(['alpha_a']);
      expect(c.ev.map(e => e.msgId)).toEqual(['m1', 'm2']);
      expect(c.ev[1]).toMatchObject({ cached: 'pack', done: true, idsRecords: 0, sampleRecords: 0, smartFound: ['alpha_a'], accountFollowers: 3000 });
    } finally { c.done(); }
  });

  it('a failed check is told apart from «nothing found» (failed: the follower lines of pack.unchecked)', async () => {
    const { buildDossier } = await import('../src/analyst/enrich.js');
    const c = await capture();
    try {
      const now = { t: Date.UTC(2026, 10, 13, 8) }; const { d } = mk(now);
      d.x.followerIds = async () => { throw new Error('twitterapi.io HTTP 402: credits'); };
      await buildDossier(input('m1'), d);
      expect(c.ev[0]).toMatchObject({ done: true, idsRecords: 0, smartFound: [], failed: [expect.stringMatching(/^X follower ids \(smart check\): .*402/)] });
    } finally { c.done(); }
  });
});
