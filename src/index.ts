// Entry point. Default mode is paper. Live is enabled only by the AGENT_MODE=live variable
// after the owner's "yes"; live executors are wired separately (see docs/AGENT-LOGIC.md).
import { join, dirname } from 'node:path';
import { loadConfig } from './config.js';
import { SystemClock } from './clock.js';
import { meterX } from './cost/xmeter.js';
import { Store } from './store/db.js';
import { TrustTable } from './trust/trust.js';
import { RiskState } from './risk/risk.js';
import { Blacklist } from './decide/decide.js';
import { NoH1Watch } from './decide/entry.js';
import { httpMarketClient } from './checks/token.js';
import { telegramNotifier, verdictCard, esc } from './notify/telegram.js';
import { makeAnthropicCaller } from './extract/extract.js';
import { PaperExecutor } from './exec/paper.js';
import { BudgetMeter, serialHandler, actOutcome, actedForPost, thoughtCa, type HandleResult } from './pipeline.js';
import { startDiscord, fetchHistory, DiscordConfigError } from './intake/discordBot.js';
import { startJobs } from './jobs.js';
import { ContextWindows } from './context/window.js';
import { ProjectCards } from './intel/projects.js';
import { loadGateConfig } from './gate/triggers.js';
import { LlmBudget, DEFAULT_CAPS, costUsd, usageSummary } from './llm/budget.js';
import { CacheKeepAlive, anthropicKeepAliveSender, setCachePrefixSink } from './llm/keepalive.js';
import { ModelPause, anthropicProbe } from './llm/pause.js';
import { anthropicGateCaller, TRIAGE_TOOL } from './gate/chatGate.js';
import { anthropicAnalystRunner, loadBrief } from './analyst/analyst.js';
import { polymarketClient } from './checks/polymarket.js';
import { existsSync } from 'node:fs';
import { Wallets, keystorePassword, keystorePath, loadKeystore } from './live/keystore.js';
import { LiveTrader } from './live/trader.js';
import { Reconciler, reconcileText } from './live/reconcile.js';
import { BRIDGE_HOLD_MS, CONFIG_EXIT, ETH_CHAINS, ETH_PRICE_REFRESH_MS, FreshPrice, InFlight, LiveEntryGuard, NOTIFY_WAIT_MS, ReconcileScheduler, bounded,
  bridgeLegSent, bridgeSources, guardCall, guardedExecutor, isGoodPrice, paperLeftovers, paperLeftoversText, planFundHome, planLiveChains, reconcileChains,
  reconcileInFlight, refreshPrice, selfRescheduling, trackCalls, treasuryTxLine, awaitSweeps } from './liveWiring.js';
import { NftLive } from './live/nftLive.js';
import { openSeaTrade } from './live/openseaTrade.js';
import { chainConfigs } from './live/evm.js';
import { Publisher, pollWatch, cardVerdictLookup } from './posts/publisher.js';
import { cardRenderer } from './posts/cards.js';
import { BRAND } from './brand.js';
import { ReviewLog, setReviewSink, review } from './review/log.js';
import { smartAccounts } from './analyst/smart.js';
import { browserReader, probeBrowser } from './analyst/browser.js';
import { Funding, relayClient } from './live/bridge.js';
import { Connection } from '@solana/web3.js';
import { honeypotIs } from './checks/hardcheck.js';
import { xApiPoster } from './posts/x.js';
import { startTelegramControl } from './notify/telegramControl.js';
import { operatorCommands, dailyStopFigures, type OperatorDeps } from './notify/commands.js';
import { twitterApiIo, domainAgeDays, pageText, rhContractVerified, publicTrends } from './analyst/enrich.js';
import { openSeaClient } from './analyst/opensea.js';
import { hyperliquidClient } from './checks/perp.js';
import { liveGasGwei, ETH_ACTION_GAS, haltReason } from './risk/risk.js';
import { riskProblemsAlert, fatalRiskProblems, riskFatalAlert } from './risk/riskCheck.js';
import { MIN_VERDICT_CONFIDENCE, type IntelDeps } from './intel/router.js';
import { wireSiteSessions, siteSessionsNotice, siteSwitch } from './siteWiring.js';
import { anthropicToolLoop } from './llm/runner.js';

const cfg = loadConfig();
// Execution: paper (default) · shadow — alongside paper, builds and simulates real transactions without sending them ·
// live — real money: only AGENT_MODE=live + AGENT_EXECUTION=live + AGENT_LIVE_CONFIRM=yes (after the owner's "yes") and unlocked keys.
const execution = (process.env.AGENT_EXECUTION ?? 'paper') as 'paper' | 'shadow' | 'live';
if (!['paper', 'shadow', 'live'].includes(execution)) throw new Error('AGENT_EXECUTION must be paper|shadow|live');
if ((cfg.mode === 'live') !== (execution === 'live') || (execution === 'live' && process.env.AGENT_LIVE_CONFIRM !== 'yes'))
  throw new Error('live trading needs AGENT_MODE=live, AGENT_EXECUTION=live and AGENT_LIVE_CONFIRM=yes together (only after the owner says "yes")');

const clock = new SystemClock();
const store = new Store(join(cfg.dataDir, 'agent.sqlite'));
const { table: trust, errors } = TrustTable.fromFile(cfg.trustCsvPath);
trust.restoreDowngrades(store.downgrades());
if (errors.length) console.warn('trust csv:', errors.join('; '));
const blacklist = new Blacklist();
store.blacklistItems().forEach(b => blacklist.add(b));
const risk = new RiskState(cfg.risk, clock);
const saved = store.loadRiskState();
if (saved) risk.restore(saved); // capital, cash, the daily result and the hard stop survive a restart
risk.onChange = (s) => store.saveRiskState(s, clock.iso());
const market = httpMarketClient(() => clock.now());
// Review log (the owner 2026-10-28): everything the agent does and thinks goes to server/data/review/<day>.jsonl
setReviewSink(new ReviewLog(join(cfg.dataDir, 'review'), () => Date.now()));
const tgRaw = telegramNotifier(cfg.telegram.botToken, cfg.telegram.chatId);
// Everything sent to the owner in Telegram also goes to the review log (trades, shadow checks, posts, errors)
const notifier: typeof tgRaw = {
  ...tgRaw,
  send: async (t: string) => { review.write('telegram', { text: t }); return tgRaw.send(t); },
  ...(tgRaw.sendPhoto ? { sendPhoto: async (png: Buffer, caption: string, buttons?: any) => { review.write('telegram', { text: caption, photo: true }); return tgRaw.sendPhoto!(png, caption, buttons); } } : {}),
};
// S-06: invalid risk.json numbers — "exits only" mode: fields replaced by approved values, new entries closed (RiskState.halted),
// the exit monitor and reconciliation work. The owner gets one message at startup (like the memecoinEntry / noPrice blocks in paper.ts)
// Invalid initialCapitalUsd (O2) — there is no safe default: no start, code 78 (the service does not restart), no risk snapshot is written
const fatalRisk = fatalRiskProblems(cfg.risk.riskProblems ?? []);
if (fatalRisk.length) {
  console.error(`FATAL: [risk.json] ${fatalRisk.join('; ')} — agent not started (exit ${CONFIG_EXIT})`);
  review.write('config', { file: 'risk.json', problems: cfg.risk.riskProblems, fatal: true });
  await bounded(notifier.send(riskFatalAlert(fatalRisk)).catch(e => console.error(`[risk.json] alert not sent: ${String((e as Error)?.message ?? e).slice(0, 200)}`)), NOTIFY_WAIT_MS);
  process.exit(CONFIG_EXIT);
}
if (cfg.risk.riskProblems?.length) {
  console.error(`[risk.json] ${cfg.risk.riskProblems.join('; ')} — invalid fields replaced by approved numbers`);
  review.write('config', { file: 'risk.json', problems: cfg.risk.riskProblems });
  void notifier.send(riskProblemsAlert(cfg.risk.riskProblems))
    .catch(e => console.error(`[risk.json] alert not sent: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
}
// ETH price (#47, T-08). For live — only a fresh one: received no more than 10 min ago, finite and > 0 (freshEthUsd; otherwise undefined —
// buys, bridges and mints on ETH chains do not run). Every new valid price goes to the trader (noteNativePrice): a stop sale knows the last
// real price even after a restart. ethUsd — the last received price of any age (2500 before the first one) — only for paper estimates,
// gas in decide and accounting of live mints / NFT sales in $ (PaperExecutor); it does not set the size or tolerance of a live buy.
const ethPrice = new FreshPrice(() => clock.now(), (px) => { for (const c of ETH_CHAINS) paper.trader?.noteNativePrice(c, px); });
const ethUsd = () => ethPrice.last() ?? 2500;
const freshEthUsd = () => ethPrice.fresh();
// Live (M-A1): decide gets the price through the guard — it remembers whether it was fresh, blocks ETH-chain entries on a stale price,
// and all entries until the startup reconciliation finishes. Paper and shadow — as before (ethUsd, no guard).
const liveGuard = execution === 'live' ? new LiveEntryGuard(ethPrice) : undefined;
// Live Ethereum gas price (eth_gasPrice) — instead of the constant 0.0015 ETH floor
async function refreshGas() {
  const r = await fetch(cfg.rpc.ethereum, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }), signal: AbortSignal.timeout(8000) });
  const j: any = await r.json();
  const gwei = Number(BigInt(j.result)) / 1e9;
  if (Number.isFinite(gwei) && gwei > 0) liveGasGwei.set('ethereum', { gwei, atMs: clock.now() });
}
const ethGasGwei = () => liveGasGwei.get('ethereum')?.gwei;
const opensea = cfg.intel.openseaApiKey ? openSeaClient(cfg.intel.openseaApiKey, () => (ethGasGwei() ?? 1) * 1e-9 * ETH_ACTION_GAS) : undefined;
// Source names for post checks: servers, channels, authors from the log (refreshed every 10 minutes)
let sourceNames: string[] = store.sourceNames();
setInterval(() => { sourceNames = store.sourceNames(); }, 10 * 60_000).unref();
const paper = new PaperExecutor(cfg.risk, risk, store, notifier, clock, ethUsd, opensea, ethGasGwei, () => sourceNames);
const perp = hyperliquidClient(); // perp prices for paper (Hyperliquid, public API)
paper.perp = perp;
const polymarket = polymarketClient(() => clock.now());
paper.pm = polymarket;
// X posts: card → buttons in Telegram (3 days) → X API. Without X keys — drafts with a card in Telegram.
// SCARF brand (2026-10-24): templates, fonts and mascot in brand/cards; the first card is rendered idle (cold start ~16 s)
let renderer: import('./posts/cards.js').CardRenderer | undefined;
try { renderer = cardRenderer(cfg.x.brandDir); } catch (e) { console.error(`cards: ${String((e as Error).message ?? e)} — posts will go without images`); }
if (renderer) void renderer.warmup().then(ms => console.log(`cards: warm-up ${ms} ms (${BRAND.name} ${BRAND.handle})`)).catch(e => console.error('cards warm-up', e));
// Telegram polling guard: the auto-publish timer does not fire while a "No" may not have reached the agent
const tgPoll = pollWatch(fetch, () => clock.now());
const publisher = new Publisher({ store, notifier, clock, dataDir: cfg.dataDir, renderer, x: cfg.x.keys ? xApiPoster(cfg.x.keys) : undefined, controlOkTimes: tgPoll.okTimes,
  mode: cfg.x.mode, autoAfterDays: cfg.x.autoAfterDays, autoApproveMinutes: cfg.x.autoApproveMinutes, dailyMax: cfg.x.dailyMax, paper: cfg.mode === 'paper',
  thoughtsDailyMax: cfg.x.thoughtsDailyMax, thoughtMinConfidence: cfg.x.thoughtMinConfidence,
  // T-11: the thought's project keys and their card verdicts — via own ProjectCards (only store is needed), not via intel below
  ...cardVerdictLookup(new ProjectCards(store), store) });
paper.poster = publisher;

// Keys (encrypted store on the server) and the live executor
let wallets: Wallets | undefined;
{
  const pass = keystorePassword();
  if (existsSync(keystorePath(cfg.dataDir)) && pass) {
    try { wallets = new Wallets(loadKeystore(cfg.dataDir, pass)); console.log(`keystore: unlocked (EVM ${wallets.evmTreasury.address}, Solana ${wallets.solTreasury.publicKey.toBase58()}, burners ${wallets.evmBurners.length})`); }
    catch (e) { console.error(`keystore: ${String((e as Error).message ?? e)}`); }
  } else console.log(`keystore: ${existsSync(keystorePath(cfg.dataDir)) ? 'locked (no password credential)' : 'not created yet'}`);
}
if (execution === 'live' && !wallets) { console.error('live execution without unlocked keystore — stopping'); process.exit(CONFIG_EXIT); }
// Live buy chains (#97, T-08): parsed in any mode so a typo is visible in paper/shadow too (a warning there)
const liveChains = planLiveChains(process.env.AGENT_LIVE_CHAINS, execution);
console.log(liveChains.line);
if (liveChains.warn) console.warn(liveChains.warn);
// Deposit chain (AGENT_FUND_HOME): an unknown name in live is a config error, as with AGENT_LIVE_CHAINS
const fundHome = planFundHome(process.env.AGENT_FUND_HOME, execution);
if (fundHome.warn) console.warn(fundHome.warn);
// Pre-live checks (T-08): an error in the chain list, paper leftovers in the ledger (E-09), a reconciliation tolerance without the owner's decision —
// not a start on a guess, but one message to the owner and code 78 (the service does not restart in a loop)
if (execution === 'live') {
  const problems: string[] = [];
  if (liveChains.fatal) problems.push(liveChains.fatal);
  if (fundHome.fatal) problems.push(fundHome.fatal);
  const leftovers = paperLeftovers(store.openPositions());
  if (leftovers) problems.push(paperLeftoversText(leftovers));
  if (!cfg.reconcileTolerance.ok) problems.push(`wallet reconciliation tolerance: ${cfg.reconcileTolerance.error} (live deployment guide, section 6)`);
  if (problems.length) {
    for (const p of problems) console.error(`FATAL (live): ${p}`);
    // The message takes no more than 10 s: a hung Telegram must not hold the process before exit
    await bounded(notifier.send(`❌ ${BRAND.name} did not start in live:\n${problems.map(p => `• ${esc(p)}`).join('\n')}\nAfter fixing: systemctl restart agent`), NOTIFY_WAIT_MS);
    process.exit(CONFIG_EXIT);
  }
}
let reconcileScheduler: ReconcileScheduler | undefined;
/** #140: sweeps of leftovers from burner wallets after a restart — the startup reconciliation waits for them (awaitSweeps). */
const startupSweeps: Promise<unknown>[] = [];
let reconcileCmd: OperatorDeps['reconcile'];
if (execution !== 'paper') {
  const nativeCache = new Map<string, { px: number; at: number }>();
  const NATIVE_REF: Partial<Record<import('./types.js').Chain, string>> = { bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', solana: 'So11111111111111111111111111111111111111112' };
  const nativeUsd = async (c: import('./types.js').Chain) => {
    if (ETH_CHAINS.includes(c)) return freshEthUsd();
    const ref = NATIVE_REF[c]; if (!ref) return undefined;
    const hit = nativeCache.get(c); if (hit && clock.now() - hit.at < 5 * 60_000) return hit.px;
    const px = (await market.market(ref).catch(() => undefined))?.priceUsd;
    if (!isGoodPrice(px)) return undefined; // NaN, 0, negative — not a price: do not cache or return it
    nativeCache.set(c, { px, at: clock.now() });
    return px;
  };
  paper.trader = new LiveTrader({ wallets, chains: chainConfigs(process.env, cfg.rpc), nativeUsd, slippageBps: cfg.risk.live.slippageBps, liveSwapChains: liveChains.traderList,
    solRpc: { rpc: cfg.rpc.solana, send: (process.env.RPC_SEND_SOLANA ?? '').split(',').map(x => x.trim()).filter(Boolean) } });
  paper.liveMode = execution;
  // Wallet reconciliation chains (live): live chains with RPC + the deposit chain; they are also the only bridge sources (#117 item 2, #134)
  const rc = reconcileChains(chainConfigs(process.env, cfg.rpc), liveChains.chains, fundHome.home);
  // Money on the right chain before a trade: the Relay bridge (key RELAY_API_KEY), default deposit chain is Base (AGENT_FUND_HOME)
  paper.trader.funding = new Funding({
    relay: process.env.RELAY_API_KEY ? relayClient(process.env.RELAY_API_KEY) : undefined,
    evm: (c) => paper.trader!.sender(c), sol: new Connection(cfg.rpc.solana, 'confirmed'),
    wallets, nativeUsd, notify: (t) => notifier.send(t), home: fundHome.home, sources: bridgeSources(rc),
    maxShareOfEquity: cfg.risk.live.bridgeMaxShareOfEquity, equityUsd: () => risk.equityUsd });
  console.log(`funding: ${process.env.RELAY_API_KEY ? 'Relay bridge on' : 'no RELAY_API_KEY — trades only with funds already on the trade chain'}, home ${fundHome.home}`);
  // Live NFT: the FCFS minter (wallet pool, fires at the public start) and buy/sell via OpenSea
  paper.nftLive = new NftLive({ trader: paper.trader, wallets, openseaKey: cfg.intel.openseaApiKey, trade: cfg.intel.openseaApiKey ? openSeaTrade(cfg.intel.openseaApiKey) : undefined,
    cfg: { maxWallets: cfg.risk.live.mintMaxWallets, maxShareOfEquity: cfg.risk.live.mintMaxShareOfEquity, minMultipleForMany: 1.5,
      pSuccess: Number(process.env.AGENT_MINT_P_SUCCESS ?? 0.6), gasPerMint: 250_000n, priorityMultiplier: Number(process.env.AGENT_MINT_PRIORITY_X ?? 3) },
    equityUsd: () => risk.equityUsd, ethUsd: () => freshEthUsd() ?? 0, notify: (t) => notifier.send(t), // 0 — "no fresh price": NFT mints and buys are not planned
    guard: (usd, token) => haltReason(cfg.risk, risk)
      ?? (usd > risk.cashUsd - (paper.nftLive?.reserved() ?? 0) ? `need $${usd.toFixed(2)}, free cash $${(risk.cashUsd - (paper.nftLive?.reserved() ?? 0)).toFixed(2)}` : undefined)
      ?? (token && risk.positions.length >= cfg.risk.maxOpenPositions ? 'max open positions' : undefined)
      ?? (token && risk.holds(token) ? 'already holds this collection' : undefined),
    // Mint budget by source score: 10 → the full share (mintMaxShareOfEquity), 7–9 → 75%, 4–6 → 50%, lower — 25%
    budgetUsd: (d) => risk.equityUsd * cfg.risk.live.mintMaxShareOfEquity * ({ follow: 1, fast: 0.75, full: 0.5 } as Record<string, number>)[d.trust.tier] || risk.equityUsd * cfg.risk.live.mintMaxShareOfEquity * 0.25,
    weth: Object.fromEntries(Object.values(chainConfigs(process.env, cfg.rpc)).filter(c => c?.wrapped).map(c => [c!.chain, c!.wrapped!])) });
  // After a restart: ETH from idle burner wallets goes home (a mint armed before the restart is cancelled)
  // #140: the startup reconciliation waits for these sweeps (startupSweeps → awaitSweeps), otherwise ETH moving to the treasury outside the ledger would give "failed"
  if (execution === 'live') for (const c of Object.keys(chainConfigs(process.env, cfg.rpc)))
    startupSweeps.push(paper.nftLive.sweepIdle(c as any).then(n => n && console.log(`sweep ${c}: ${n} wallet(s)`)).catch(() => {}));
  // Ledger reconciliation with the treasury wallet (E-03 #99, T-08) — live only: at startup (before accepting messages) and every 10 minutes
  if (execution === 'live' && wallets) {
    const tol = cfg.reconcileTolerance;
    if (!tol.ok) throw new Error('unreachable: tolerance checked above'); // checked above, code 78
    // "In flight" (money moving outside the ledger): trader/bridge/NFT-buy calls that have not returned yet (HQ's counter here),
    // PLUS the executor's paper.inFlight() list (#133, #134): buys/sells after the call returned, Solana, a bridge in motion;
    // a reserved mint; an unconfirmed treasury transaction at the sender (see inFlight below).
    const flying = new InFlight(() => clock.now());
    trackCalls(paper.trader, 'buyToken', 'buy', flying);
    trackCalls(paper.trader, 'sellToken', 'sell', flying);
    // The bridge returned not-ok with a sent leg (FundResult.legSent, #133) or crashed — money may have left and still be moving between chains: "bridge" is held
    // for the Funding pause (BRIDGE_COOLDOWN_MS) so reconciliation is postponed and /reconcile accept does not accept a base without this money
    trackCalls(paper.trader.funding, 'ensure', 'bridge', flying, { holdOnFailMs: BRIDGE_HOLD_MS, holdIf: bridgeLegSent }); // a refusal before sending — no hold
    trackCalls(paper.nftLive, 'buyFloor', 'NFT buy', flying);
    trackCalls(paper.nftLive, 'sellAll', 'NFT sell', flying);
    // Re-check of the guard inside the executor lock, right before money moves (round 2 review, M-A1): while waiting for the lock
    // (the monitor holds it during sales) the price may have gone stale or risen. A refusal takes the method's own form: buyFloor → {ok:false} (the executor
    // throws "live NFT buy failed" → skip, no position and no reserve); schedule → a reason string (the mint is not armed). Sales are not wrapped.
    if (liveGuard) {
      guardCall(paper.nftLive, 'buyFloor', liveGuard, (why) => ({ ok: false, holdings: [], spentEth: 0, note: `refused at execution: ${why}`, pending: false }));
      guardCall(paper.nftLive, 'schedule', liveGuard, (why) => `mint not planned: ${why}`);
    }
    if (rc.missing.length) console.warn(`reconcile: no RPC config for ${rc.missing.join(', ')} — these chains are not reconciled`);
    console.log(`reconcile: chains ${bridgeSources(rc).join(', ')} (bridge sources — the same); tolerance ${(tol.share * 100).toFixed(1)}% of cash, min $${tol.usd}`);
    const evmTreasury = wallets.evmTreasury.address;
    const ledger = () => ({ cashUsd: risk.cashUsd, equityUsd: risk.equityUsd, positionsCostUsd: risk.positions.reduce((a, p) => a + p.costUsd, 0), pendingBuyUsd: paper.pendingBuyUsd() });
    // #140: the whole NFT part (sweeping leftovers from burner wallets and the mint reserve) — NftLive.inFlight()
    const inFlight = reconcileInFlight({ tracked: flying, executor: paper, nft: { inFlight: () => paper.nftLive?.inFlight() ?? [] },
      treasuryTx: () => {
        const out: string[] = [];
        for (const c of Object.keys(rc.evm) as import('./types.js').Chain[]) {
          const tx = paper.trader?.sender(c)?.hasPending(evmTreasury);
          if (tx) out.push(treasuryTxLine(c, tx)); // #135 F3: a ghost gets its own label (the reconciliation stop reason)
        }
        return out;
      } });
    const halt = (reason: string) => {
      // #139: the reason goes to risk_state (visible in /status) and, as before, to the service log and the review log. If the stop is already on — the first reason stays
      if (!risk.operatorHalt) risk.setOperatorHalt(true, `reconcile: ${reason}`);
      console.warn(`[reconcile] new entries halted: ${reason}`);
      review.write('operator', { cmd: 'auto-halt', source: 'reconcile', reason });
    };
    const reconciler = new Reconciler({
      chains: rc.evm, evmAddress: evmTreasury,
      sol: rc.solana ? { address: wallets.solTreasury.publicKey.toBase58(), rpc: cfg.rpc.solana } : undefined,
      nativeUsd, ledger, inFlight, toleranceShare: tol.share, toleranceUsd: tol.usd,
    }, { notify: (t) => sched.relay(t), halt, halted: () => risk.operatorHalt });
    const sched: ReconcileScheduler = new ReconcileScheduler({ run: (ph) => reconciler.run(ph), halted: () => risk.operatorHalt, halt, notify: (t) => notifier.send(t) });
    reconcileScheduler = sched;
    reconcileCmd = { run: async () => reconcileText(await sched.runNow(), ledger()), accept: () => reconciler.acceptCurrent() };
  }
  console.log(`execution: ${execution}${execution === 'shadow' ? ' (paper fills + live route build & simulation, nothing is sent)' : ''}`);
}
// Live limits are read from risk.json (S-04 #33, #59): the old .env variables have no effect — warn instead of staying silent
for (const k of ['AGENT_SLIPPAGE_BPS', 'AGENT_BRIDGE_MAX_SHARE', 'AGENT_MINT_MAX_SHARE', 'AGENT_MINT_MAX_WALLETS'])
  if (process.env[k] !== undefined) console.warn(`${k} in .env is no longer read — the value comes from server/config/risk.json (live)`);
// Operator commands from Telegram (O-05 #44, #58): /stop closes new entries (a flag in risk_state), /resume lifts it, /status — summary
startTelegramControl(cfg.telegram.botToken, cfg.telegram.chatId, { onCallback: (data) => publisher.onCallback(data),
  onCommand: operatorCommands({
    status: () => ({ mode: execution, equityUsd: risk.equityUsd, markedEquityUsd: risk.markedEquityUsd, cashUsd: risk.cashUsd,
      positions: risk.positions.map(p => ({ chain: p.chain, token: p.token, costUsd: p.costUsd, openedAtUtc: p.openedAtUtc })),
      operatorHalted: risk.operatorHalt, operatorHaltReason: risk.operatorHaltReason, dailyStop: risk.dailyStopActive(),
      dailyStopPnlUsd: risk.dailyStopPnlUsd(), dailyStopLimitUsd: risk.dailyStopLimitUsd(), hardStopped: risk.hardStopped,
      holds: paper.holds().map(h => ({ tx: h.tx, text: h.text })) }), // #135 G1: pending holds and ghost blocks — with hashes
    setOperatorHalt: (on, reason) => risk.setOperatorHalt(on, reason), now: () => clock.now(), log: (k, d) => review.write(k, d),
    reconcile: reconcileCmd, sendLate: (t) => notifier.send(t), // /reconcile [accept] — live only (T-08)
    release: execution === 'live' ? (tx, v) => paper.release(tx, v) : undefined }) }, // #135 G1: /release <tx> sold|not-sold — live only
  { log: (k, d) => review.write(k, d), fetchImpl: tgPoll.fetch }); // rejected commands and polling failures go to the log; tgPoll — whether the button channel is alive
console.log(`X posts: ${publisher.mode()}${cfg.x.keys ? '' : ' (no X keys — drafts only)'}${cfg.x.keys && cfg.x.autoApproveMinutes > 0 ? `, no answer in ${cfg.x.autoApproveMinutes} min → posts itself` : ''}`);
// A post stuck in publishing (restart in the middle of an X request) — tell the owner, do not stay silent
// No more than 10 s on the startup path (the rest in the background): the exit monitor must not wait for X or Telegram
await bounded(publisher.recoverInterrupted().catch(e => console.error('publisher: recover', e)), NOTIFY_WAIT_MS);
paper.restore();
const budget = new BudgetMeter(cfg.anthropic.dailyBudgetUsd, () => clock.utcDay());

/** ETH price from DexScreener (WETH). A failure or an invalid value — the old price just ages; true — a valid one arrived. */
function refreshEth(): Promise<boolean> {
  return refreshPrice(ethPrice, async () => (await market.market('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'))?.priceUsd);
}

if (!cfg.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is missing in .env');
if (!cfg.discord.token) throw new Error('DISCORD_BOT_TOKEN is missing in .env');

const gateCfg = loadGateConfig(cfg.intel.gatePath);
const llmBudget = new LlmBudget({ ...DEFAULT_CAPS, opusDailyUsd: cfg.intel.opusDailyUsd, sonnetDailyUsd: cfg.intel.sonnetDailyUsd, gateDailyUsd: cfg.intel.gateDailyUsd }, clock, store);
const brief = loadBrief(cfg.intel.briefPath);
// Model pause without Anthropic credits (C-04, #49): the model is not called at all, a Haiku probe every 15 minutes,
// one notification on entry and one on exit; messages during the pause go only to the log (no queue)
const modelPause = new ModelPause({ clock, probe: anthropicProbe(cfg.anthropic.apiKey), notify: t => notifier.send(t),
  log: s => { console.log(`[${clock.iso()}] ${s}`); review.write('log', { text: s }); },
  remember: { get: k => store.kvGet(k), set: (k, v) => store.kvSet(k, v) } }); // "no more than once per 6 h" survives a restart
// Brief cache keep-alive (C-05, change 7; the owner's decision 2026-11-12 10:36 UTC): when idle, every 55 min a max_tokens 0 ping with the same
// prefix — the next analysis reads the cache instead of writing it again. Ping spend goes to the budget and the log. A finished Cost change (PR #116).
const keepAlive = new CacheKeepAlive({ clock, send: anthropicKeepAliveSender(cfg.anthropic.apiKey), paused: () => modelPause.paused(), observe: e => modelPause.observe(e),
  onUsage: (model, u) => { const usd = costUsd(model, u); llmBudget.record(model, usd); review.write('cache_keepalive', { model, costUsd: Number(usd.toFixed(5)), usage: usageSummary([u]) }); },
  log: s => { console.log(`[${clock.iso()}] ${s}`); review.write('log', { text: s }); } });
setCachePrefixSink(keepAlive);
setInterval(() => { keepAlive.tick().catch(e => console.error('cache keep-alive', e)); }, 60_000).unref();
// twitterapi.io spend counter (C-01): an xapi event in the review log for every call, does not change responses
const xProvider = cfg.intel.twitterApiKey ? meterX(twitterApiIo(cfg.intel.twitterApiKey, () => clock.now()), review) : undefined;
// Browser for app sites (headless Chromium): installed into /opt/agent/.pw-browsers (server deployment guide, "Browser")
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), '.pw-browsers');
const siteBrowser = browserReader();
const intel: IntelDeps | undefined = cfg.intel.enabled ? {
  windows: new ContextWindows(), cards: new ProjectCards(store), gateCfg, budget: llmBudget, brief,
  gateCall: undefined, // the per-message Haiku gatekeeper is off: chats go in batches (decision 2026-10-22)
  triageCall: modelPause.guard(anthropicGateCaller(cfg.anthropic.apiKey, DEFAULT_CAPS.gateModel, TRIAGE_TOOL)), // chat batch: Haiku first, Opus on its signal (2026-10-23)
  runAnalyst: modelPause.guard(anthropicAnalystRunner(cfg.anthropic.apiKey)),
  enrich: {
    market,
    x: xProvider,
    smart: xProvider ? smartAccounts(join(dirname(cfg.intel.briefPath), 'smart-accounts.csv'), xProvider, store, () => clock.now()) : undefined,
    honeypot: honeypotIs(),
    render: undefined as import('./analyst/enrich.js').EnrichDeps['render'],
    now: () => clock.now(),
    domainAge: (dm) => domainAgeDays(dm, clock.now()),
    page: (u) => pageText(u),
    rhVerified: (a) => rhContractVerified(a),
    opensea,
    perp,
    trends: publicTrends(() => clock.now()),
    polymarket,
  },
  channelModel: gateCfg.channelModels, ownPicks: cfg.intel.ownPicks,
  repeatHours: cfg.intel.repeatHours, watchRecheckMinutes: cfg.intel.watchRecheckMinutes,
  chatBatchSize: cfg.intel.chatBatchSize, chatMaxWaitMinutes: cfg.intel.chatMaxWaitMinutes,
  chatReviewModel: cfg.intel.chatReviewModel, chatDailyUsd: cfg.intel.chatDailyUsd,
  pause: modelPause,
} : undefined;
if (intel && !intel.enrich.x) console.warn('TWITTERAPI_IO_KEY is empty — analyst works without X data');
// Browser check — one for the analyst's reader and the task-site sessions (Chromium launch and close)
const siteSessionsAsked = siteSwitch(process.env, 'AGENT_SITE_SESSIONS').on;
const browserCheck: Promise<string | undefined> | undefined = intel || siteSessionsAsked ? probeBrowser() : undefined;
if (intel) void browserCheck!.then(errMsg => {
  if (errMsg) { console.warn(`browser: not available (${errMsg}) — JS sites are read without a browser`); return; }
  intel.enrich.render = (u, o) => siteBrowser.render(u, o);
  console.log('browser: Chromium ready (JS sites, task pages)');
});
// Task-site sessions (E-06, #16, #148): switches AGENT_SITE_SESSIONS / AGENT_SITE_WALLET / AGENT_SITE_MODEL (src/siteWiring.ts,
// the server deployment guide). Wired only after a successful browser check; no browser — a log line, Telegram stays silent.
// Before wiring, dapp_session gives only a card, as before. Discord starts after this wiring (no more than 20 s, see below).
const siteLog = (s: string) => { console.log(`[${clock.iso()}] ${s}`); review.write('log', { text: s }); };
let siteWiringDone = false;
const siteSessionsWired: Promise<void> = (siteSessionsAsked ? wireSiteSessions(browserCheck, process.env, {
  dataDir: cfg.dataDir, brand: BRAND, wallets,
  rpc: { evm: [cfg.rpc.ethereum, cfg.rpc.base, cfg.rpc.arbitrum, cfg.rpc.bsc, cfg.rpc.robinhood], solana: cfg.rpc.solana },
  model: cfg.anthropic.apiKey ? { loop: modelPause.guard(anthropicToolLoop(cfg.anthropic.apiKey)), budget: llmBudget } : undefined,
  log: siteLog, // a build failure goes here too: service log and review log
  review: (k, d) => review.write(k, d),
  halted: () => risk.halted(), // /stop, daily and hard stop — also for sessions already queued
}, (s) => { paper.siteSessions = s; }) : Promise.resolve()).finally(() => { siteWiringDone = true; });
if (intel && !opensea) console.warn('OPENSEA_API_KEY is empty — analyst works without NFT data');

const deps = {
  mode: cfg.mode, store, trust, budget, executor: liveGuard ? guardedExecutor(paper, liveGuard) : paper, intel, notifier,
  extract: { callModel: modelPause.guard(makeAnthropicCaller(cfg.anthropic.apiKey, cfg.anthropic.extractModel)) },
  // #128: memecoins skipped in a row with no rise within an hour — one message to the owner per day (entryWatch)
  decide: { cfg: cfg.risk, risk, market, clock, blacklist, ethUsd: liveGuard ? liveGuard.ethUsd : ethUsd, perp,
    entryWatch: new NoH1Watch({ notify: (t) => notifier.send(t), now: () => clock.now() }) },
  log: (s: string) => { console.log(`[${clock.iso()}] ${s}`); review.write('log', { text: s }); },
  // A scheduled re-check can also produce an X thought
  onRecheck: (r: HandleResult) => postThought(r, store.sourceNames(), { update: true }),
  // Live: until the startup reconciliation is over, deferred actions wait in the queue (they do not burn as skip)
  entriesOpen: liveGuard ? () => liveGuard.entriesOpen : undefined,
};

const handle = serialHandler(deps);
// The exit monitor for open positions and background jobs start BEFORE the price and reconciliation (M-B1): stops do not wait for reconciliation. New live entries
// are closed by the guard (liveGuard) until the startup reconciliation ends: deferred actions and timed analyses get a skip with a reason.
if (!cfg.noAutoEvents) {
  // A post without a reply in Telegram goes out on its own after an hour (the owner 2026-11-11 08:02 UTC)
  if (cfg.x.keys && cfg.x.autoApproveMinutes > 0) setInterval(() => { publisher.publishOverdue().catch(e => console.error('auto-publish', e)); }, 60_000);
  startJobs({ store, market, notifier, clock, paper, risk, trust, llmBudget, everyMinute: handle.tick, exclusive: handle.exclusive, poster: publisher, silenceHours: Number(process.env.AGENT_SILENCE_HOURS ?? 3) });
  setInterval(() => { refreshGas().catch(() => {}); }, 2 * 60_000);
}
// The first ETH price; in live — up to three attempts (each no longer than 8 s) 5 s apart: without it the startup reconciliation "failed" and ETH-chain entries do not run
let firstPrice = await refreshEth();
for (let i = 1; !firstPrice && execution === 'live' && i < 3; i++) { await new Promise(r => setTimeout(r, 5_000)); firstPrice = await refreshEth(); }
// Startup reconciliation (T-08, #99): after the first price and BEFORE accepting messages, no longer than 30 s (+ no longer than 10 s for the message). Timed out
// or "failed" — stop on new entries (only the owner's /resume lifts it): live does not trade without reconciliation. After the result the guard opens entries.
if (reconcileScheduler) {
  // #140: first wait for the burner-wallet sweeps (no longer than 60 s) — they move ETH to the treasury outside the ledger
  if (await awaitSweeps(startupSweeps) === 'timeout') console.warn('[reconcile] startup: burner sweep still running after 60 s — reconciliation will see it in flight');
  await reconcileScheduler.startup();
}
liveGuard?.openEntries();
if (!cfg.noAutoEvents) {
  // ETH price every 2 min (freshness window for live — 10 min); the next request starts after the previous one ends
  selfRescheduling('eth price', () => refreshEth(), ETH_PRICE_REFRESH_MS);
  // Wallet reconciliation every 10 min (live only): the timer is re-armed in finally, passes do not overlap
  reconcileScheduler?.start();
}
await refreshGas().catch(e => console.warn('gas price:', String(e)));
const onMessage = async (m: import('./types.js').RawMessage) => {
  const r = await handle(m);
  review.write('message', { msgId: m.id, source: `${m.sourceServer}/#${m.channel}/${m.author}`, posted: m.tsUtc, backfill: m.backfill || undefined, text: m.text.slice(0, 600),
    replyTo: m.replyToText?.slice(0, 200), skipped: r.skipped, analysis: r.analysis ? { model: r.analysis.model, verdict: r.analysis.verdict, confidence: r.analysis.confidence, thesis: r.analysis.thesis, costUsd: r.analysis.costUsd, batch: r.analysis.batch } : undefined,
    decisions: r.decisions.length ? r.decisions.map(x => ({ action: x.action, reasons: x.reasons, intent: { kind: x.intent.kind, chain: x.intent.chain, token: x.intent.tokenAddress ?? x.intent.contractAddress, summary: x.intent.summary } })) : undefined, exits: r.exits });
  if (r.analysis) deps.log(r.analysis.batch
    ? `${m.sourceServer}/#${m.channel}: CHAT BATCH of ${r.analysis.batch} messages → ${r.analysis.stage === 'triage' ? 'haiku triage: nothing for Opus' : r.analysis.model} → ${r.analysis.verdict} $${r.analysis.costUsd.toFixed(4)} — ${r.analysis.thesis.slice(0, 160)}`
    : `${m.sourceServer}/#${m.channel}/${m.author}: ${r.analysis.model.replace('claude-', '')} → ${r.analysis.verdict} (${r.analysis.confidence}) $${r.analysis.costUsd.toFixed(3)} — ${r.analysis.thesis.slice(0, 220)}`);
  // Skips are visible in the log too (the owner 2026-10-23: "I don't see chat buffered")
  if (r.skipped && r.skipped !== 'already processed') deps.log(`${m.sourceServer}/#${m.channel}/${m.author}${m.backfill ? ' (history)' : ''}: ${r.skipped}`);
  if (r.decisions.length) deps.log(`${m.sourceServer}/#${m.channel}/${m.author}: ${r.decisions.map(d => `${d.action}${d.action === 'skip' || d.action === 'journal_only' ? ` (${d.reasons.slice(-3).join('; ').slice(0, 200)})` : ''}`).join(', ')}`);
  if (r.analysis) {
    const card = verdictCard({ ...r.analysis, source: r.analysis.batch ? `${m.sourceServer} / #${m.channel} (batch of ${r.analysis.batch} messages)` : `${m.sourceServer} / #${m.channel} / ${m.author}${m.backfill ? ' (from history)' : ''}` });
    // Under "ACT" — why there is no action (T-06): before, the reason stayed only in the server log
    const noAction = card ? actOutcome(r, MIN_VERDICT_CONFIDENCE) : undefined;
    if (card) await notifier.send(noAction ? `${card}\n<b>Action:</b> none — ${esc(noAction)}` : card).catch(() => {});
    if (!m.backfill) await postThought(r, [m.sourceServer, m.channel, m.author, ...store.sourceNames()]);
  }
  return r;
};

/**
 * An X thought from an analysis: watching / on my list — without server, channel or author. If a trade is already open, the entry post covers it.
 * Called both for a message and for a scheduled re-check (update: project news, the owner 2026-11-11 17:30 UTC).
 */
async function postThought(r: HandleResult, sourceNames: string[], opts: { update?: boolean } = {}): Promise<void> {
  if (!r.analysis) return;
  const t = r.analysis.thought;
  // An "action" suppresses the thought only if a trade post will cover it. A social task, a request to the owner and a task-site session
  // produce no posts (NO_POST_ACTIONS in pipeline.ts) — the thought is published.
  const acted = actedForPost(r.decisions);
  if (!t && (r.analysis.verdict === 'watch' || r.analysis.verdict === 'act') && !acted) deps.log(`thought skipped: no public note or no public project name (${r.analysis.model})`);
  if (t && !acted) {
    // Contract address: from the thought (Analyst), otherwise the only address in the same project's card (thoughtCa)
    let th = t;
    if (!t.ca) {
      const id = /^p(\d+)$/.exec(t.key)?.[1];
      const card = id ? intel?.cards.card(Number(id)) : undefined;
      const found = card ? thoughtCa(r, card.keys, a => blacklist.has(a)) : undefined;
      th = { ...t, token: t.token ?? !!card?.keys.some(k => k.startsWith('ticker:')), ...(found ? { ca: found.ca, chain: found.chain } : {}) };
    }
    const why = await publisher.thought(th, sourceNames, opts).catch(e => `error: ${String(e)}`);
    deps.log(`thought ${t.subject} (${t.verdict}${opts.update ? ', recheck' : ''}): ${why}`);
  }
}

// Exit code 78 (CONFIG_EXIT, src/liveWiring.ts) = config error: the service does not restart in a loop (RestartPreventExitStatus=78), the owner gets one message
// Site sessions (E-06) are wired before accepting messages: a task from the last day's history will not get "card only" because of a race
// with the browser check. No longer than 20 s — a hung Chromium launch does not hold the agent (the wiring then finishes in the background).
// If it times out — one line now; when the wiring finishes, buildSiteSessions itself writes "site sessions: on …" or the reason
if (siteSessionsAsked && await bounded(siteSessionsWired, 20_000) === 'timeout') siteLog('site sessions: browser check still running after 20 s — sessions will be connected when it finishes');
let discord: Awaited<ReturnType<typeof startDiscord>>;
try {
  discord = await startDiscord(cfg.discord.token, cfg.discord.guildId, async (m) => { await onMessage(m); });
} catch (e) {
  const reason = e instanceof DiscordConfigError ? e.message : `Discord: ${String((e as Error).message ?? e).slice(0, 200)}`;
  console.error(`FATAL: ${reason}`);
  await bounded(notifier.send(`❌ ${BRAND.name} did not start: ${reason}\nAfter fixing: systemctl restart agent`), NOTIFY_WAIT_MS);
  process.exit(e instanceof DiscordConfigError ? CONFIG_EXIT : 1);
}
// The startup message — no more than once per 10 minutes (if the service restarts after a crash, do not spam)
const lastStart = Number(store.kvGet('last_start_notice_ms') ?? 0);
store.kvSet('last_start_notice_ms', String(clock.now()));
if (clock.now() - lastStart > 10 * 60_000) await notifier.send(`🤖 ${BRAND.name} started (${cfg.mode}). Capital $${risk.equityUsd.toFixed(2)}, open positions ${risk.positions.length}${risk.hardStopped ? ', ⛔ HARD STOP active' : ''}${risk.operatorHalt ? ', ⛔ /stop active — no new entries' : ''}. Daily stop: ${risk.dailyStopActive() ? '⛔ on' : 'off'}, today ${dailyStopFigures(risk.dailyStopPnlUsd(), risk.dailyStopLimitUsd())}. Trust table: ${errors.length ? 'has errors' : 'loaded'}. Analyst: ${intel ? `on, limits Opus $${cfg.intel.opusDailyUsd} / Sonnet $${cfg.intel.sonnetDailyUsd} per day, X ${intel.enrich.x ? 'connected' : 'no key'}, OpenSea ${opensea ? 'connected' : 'no key'}` : 'off'}.${siteSessionsNotice(siteSessionsAsked, { done: siteWiringDone, connected: !!paper.siteSessions })}`);

// Check of messages already posted on the intake server (history for AGENT_BACKFILL_HOURS hours, default 24).
// Already analysed messages are skipped; decisions are marked "backfill" and do not count in source statistics.
if (cfg.backfillHours > 0 && cfg.discord.guildId) {
  try {
    const { messages, skipped } = await fetchHistory(discord, cfg.discord.guildId, cfg.backfillHours, 300, deps.log);
    const fresh = messages.filter(m => !store.hasMessage(m.id));
    let analyses = 0, actions = 0;
    const verdicts = new Map<string, number>();
    for (const m of fresh) {
      const r = await onMessage({ ...m, backfill: true });
      if (r.analysis) { analyses++; verdicts.set(r.analysis.verdict, (verdicts.get(r.analysis.verdict) ?? 0) + 1); }
      actions += r.decisions.filter(d => !['journal_only', 'skip'].includes(d.action)).length;
    }
    await notifier.send(`📥 Checked messages for ${cfg.backfillHours} h: total ${messages.length}, new ${fresh.length}, analyst analyses ${analyses}${verdicts.size ? ` (${[...verdicts].map(([v, n]) => `${v} ${n}`).join(', ')})` : ''}, actions ${actions} (paper).${skipped.length ? `\nNo access to history: ${skipped.join('; ')}` : ''}`);
  } catch (e) { deps.log(`history check failed: ${String(e)}`); }
}
