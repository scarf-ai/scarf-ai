// T-08 (#104): wiring of the live modules in src/index.ts — fresh ETH price (#47), the live chain list (#97), refusing to start with
// paper leftovers (E-09), wallet reconciliation (#99). Only small functions and factories without import side effects live here:
// index.ts is a top-level script that cannot be tested, so the logic is moved here (test/liveWiring.test.ts).
import type { Chain } from './types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChainCfg } from './live/evm.js';
import { GHOST_BLOCK_MARK, type ReconcileReport } from './live/reconcile.js';
import type { Decision, RawMessage } from './types.js';
import type { Executor } from './exec/paper.js';
import { DEFAULT_LIVE_SWAP_CHAINS, liveSwapChainsFromEnv } from './live/trader.js';
import { BRIDGE_COOLDOWN_MS, RELAY_CHAIN_IDS } from './live/bridge.js';

/** Exit code "config error": the service does not restart in a loop (RestartPreventExitStatus=78). */
export const CONFIG_EXIT = 78;

/** How long to wait for sending a message on the startup path and in reconciliation: a hung Telegram must not hold startup and timers. */
export const NOTIFY_WAIT_MS = 10_000;
/** Timeout of one ETH price request on the startup path and in the timer (market.market has no timeout of its own). */
export const PRICE_FETCH_TIMEOUT_MS = 8_000;

/** Wait for p no longer than ms. Never throws: 'done' — finished in time (success or failure), 'timeout' — not (p continues in the background). */
export function bounded(p: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<'timeout'>(res => { t = setTimeout(() => res('timeout'), ms); (t as { unref?: () => void }).unref?.(); });
  return Promise.race([p.then(() => 'done' as const, () => 'done' as const), timer]).finally(() => clearTimeout(t));
}

// ---------- 1. Fresh ETH price (#47) ----------

/** The price for buy sizing and tolerance — no older than 10 minutes. */
export const ETH_PRICE_MAX_AGE_MS = 10 * 60_000;
/** Refresh every 2 minutes: one or two failed DexScreener answers do not block trades, but an old price does not live longer than 10 min. */
export const ETH_PRICE_REFRESH_MS = 2 * 60_000;
/** Chains where the native coin is ETH. */
export const ETH_CHAINS: Chain[] = ['ethereum', 'base', 'arbitrum', 'robinhood'];

/** A valid price: a finite number above zero. NaN, Infinity, 0, negative, not a number — not a price. */
export const isGoodPrice = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * A price with its receive timestamp. Only a valid price is stored; fresh() returns it while it is no older than maxAgeMs, otherwise undefined
 * (buys on ETH chains are then refused). onFresh is called with every new valid price — index.ts passes it to the trader
 * (noteNativePrice) so sales (stop) know the last real price. The default value never gets here.
 */
export class FreshPrice {
  private px: number | undefined;
  private atMs: number | undefined;
  constructor(private now: () => number, private onFresh?: (px: number) => void, private maxAgeMs = ETH_PRICE_MAX_AGE_MS) {}
  /** Accept a received price; an invalid one is neither stored nor passed on. true — accepted. */
  accept(v: unknown): boolean {
    if (!isGoodPrice(v)) return false;
    this.px = v; this.atMs = this.now();
    try { this.onFresh?.(v); } catch (e) { console.error(`eth price: onFresh failed — ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
    return true;
  }
  /** A fresh price or undefined (not received yet or older than maxAgeMs). */
  fresh(): number | undefined {
    if (this.px === undefined || this.atMs === undefined) return undefined;
    return this.now() - this.atMs <= this.maxAgeMs ? this.px : undefined;
  }
  /** The last actually received price of any age — only for paper estimates (paper, gas), not for live buys. */
  last(): number | undefined { return this.px; }
  ageMs(): number | undefined { return this.atMs === undefined ? undefined : this.now() - this.atMs; }
}

/**
 * One price refresh: the request may fail or return junk — then the old price just ages (and after 10 min stops
 * being fresh). No exception escapes. true — a valid price arrived.
 */
export async function refreshPrice(price: FreshPrice, fetchPx: () => Promise<unknown>, log: (s: string) => void = console.warn,
  timeoutMs = PRICE_FETCH_TIMEOUT_MS): Promise<boolean> {
  let v: unknown; let t: NodeJS.Timeout | undefined;
  // Own timeout: an unanswered request must not hold startup (market.market has no timeout)
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${timeoutMs} ms`)), timeoutMs); (t as { unref?: () => void }).unref?.(); });
  try { v = await Promise.race([fetchPx(), timer]); }
  catch (e) { log(`eth price: refresh failed — ${String((e as Error)?.message ?? e).slice(0, 160)}`); return false; }
  finally { clearTimeout(t); }
  if (price.accept(v)) return true;
  const age = price.ageMs();
  log(`eth price: no usable price in the answer (${String(v).slice(0, 40)}); last good price ${age === undefined ? 'never received' : `${Math.round(age / 1000)} s old`}${price.fresh() === undefined ? ' — live buys in ETH chains are refused until a fresh price arrives' : ''}`);
  return false;
}

// ---------- A timer re-armed in finally (not setInterval) ----------

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
export const realTimers: Timers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Repeats a task every everyMs: the next run is armed only after the current one ends (in finally) — passes do not overlap,
 * and an exception or task failure neither stops the timer nor crashes the process.
 */
export function selfRescheduling(name: string, task: () => Promise<unknown>, everyMs: number, timers: Timers = realTimers,
  log: (s: string) => void = console.error): { stop(): void } {
  let stopped = false; let handle: unknown;
  const tick = async () => {
    try { await task(); }
    catch (e) { log(`${name}: run failed — ${String((e as Error)?.message ?? e).slice(0, 200)}`); }
    finally { if (!stopped) handle = timers.set(() => void tick(), everyMs); }
  };
  handle = timers.set(() => void tick(), everyMs);
  return { stop() { stopped = true; timers.clear(handle); } };
}

// ---------- 2. Live buy chains (#97) ----------

export interface LiveChainsPlan {
  /** The list for the trader: undefined — its default list. */
  traderList: Chain[] | undefined;
  /** The effective list of live buy chains. */
  chains: Chain[];
  /** A log line: "live buy chains: …". */
  line: string;
  /** A warning (not live): the variable has an error, the default list is used. */
  warn?: string;
  /** A config error (live): startup is cancelled, code 78. */
  fatal?: string;
}

/**
 * AGENT_LIVE_CHAINS. Unset — the default list. Set but empty after parsing, or with an unknown chain name —
 * in live this is a config error (no silent fallback to the default list), in paper/shadow — a warning and the default list.
 */
export function planLiveChains(raw: string | undefined, execution: 'paper' | 'shadow' | 'live'): LiveChainsPlan {
  const defaults: LiveChainsPlan = { traderList: undefined, chains: [...DEFAULT_LIVE_SWAP_CHAINS], line: `live buy chains: ${DEFAULT_LIVE_SWAP_CHAINS.join(', ')} (default)` };
  if (raw === undefined) return defaults;
  let problem: string | undefined; let list: Chain[] | undefined;
  try { list = liveSwapChainsFromEnv(raw); if (!list) problem = `AGENT_LIVE_CHAINS is set but empty ("${raw.slice(0, 60)}")`; }
  catch (e) { problem = String((e as Error)?.message ?? e).slice(0, 300); }
  if (problem) return execution === 'live' ? { ...defaults, line: `live buy chains: — (${problem})`, fatal: problem } : { ...defaults, warn: `${problem} — using the default list` };
  return { traderList: list, chains: list!, line: `live buy chains: ${list!.join(', ')} (AGENT_LIVE_CHAINS)` };
}

/**
 * AGENT_FUND_HOME — the deposit chain the bridge moves money from. Unset — base. An unknown name or an empty string: in live — a config
 * error (code 78), as with AGENT_LIVE_CHAINS; in paper/shadow — a warning and base.
 */
export function planFundHome(raw: string | undefined, execution: 'paper' | 'shadow' | 'live'): { home: Chain; warn?: string; fatal?: string } {
  if (raw === undefined) return { home: 'base' };
  const v = raw.trim().toLowerCase();
  if (v && Object.prototype.hasOwnProperty.call(RELAY_CHAIN_IDS, v)) return { home: v as Chain };
  const problem = `AGENT_FUND_HOME: unknown chain "${raw.slice(0, 40)}" — allowed: ${Object.keys(RELAY_CHAIN_IDS).join(', ')}`;
  return execution === 'live' ? { home: 'base', fatal: problem } : { home: 'base', warn: `${problem} — using base` };
}

// ---------- 3. Paper leftovers in the ledger before live (E-09) ----------

/** Open positions whose mode is not 'live' (left over from the paper week): in live the monitor would "sell" them for real. */
export function paperLeftovers(openPositions: { mode?: string | null }[]): number {
  return openPositions.filter(p => p.mode !== 'live').length;
}
export function paperLeftoversText(n: number): string {
  return `the ledger has ${n} open ${n === 1 ? 'position' : n >= 2 && n <= 4 ? 'positions' : 'positions'} not in live mode (paper leftovers). In live the monitor would sell them for real. `
    + 'Reset the ledger first: live deployment guide, section 6, step 0 (src/exec/ledgerReset.ts)';
}

// ---------- 4. Wallet reconciliation (#99) ----------

/**
 * Chains to reconcile: EVM chains from the live list (that have an RPC) plus the deposit chain (AGENT_FUND_HOME) — money arrives there
 * and the bridge moves it from there to the trade chain; Solana — if it is in the live list. Live chains without an RPC go to missing (to the log).
 */
export function reconcileChains(all: Partial<Record<Chain, ChainCfg>>, live: Chain[], home?: Chain):
  { evm: Partial<Record<Chain, ChainCfg>>; solana: boolean; missing: Chain[] } {
  const want = new Set<Chain>(live);
  if (home) want.add(home);
  const evm: Partial<Record<Chain, ChainCfg>> = {}; const missing: Chain[] = [];
  for (const c of want) {
    if (c === 'solana') continue;
    if (all[c]) evm[c] = all[c]; else missing.push(c);
  }
  return { evm, solana: want.has('solana'), missing };
}

/**
 * Bridge source chains (#117 item 2, #134) — exactly those reconciled with the wallet (reconcileChains): a transfer from a chain outside reconciliation
 * would change a reconciled balance without a counterpart and give a false mismatch. Chains without an RPC (missing) are not included.
 */
export function bridgeSources(rc: { evm: Partial<Record<Chain, unknown>>; solana: boolean }): Chain[] {
  return [...(Object.keys(rc.evm) as Chain[]), ...(rc.solana ? ['solana' as Chain] : [])];
}

/**
 * What is moving money outside the ledger right now: labels of calls that have not returned yet (buy, sell, bridge…), and labels held
 * after a failure until a deadline (hold): a bridge that returned not-ok may already have sent money that is still moving between chains.
 */
export class InFlight {
  private n = new Map<string, number>();
  private held = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  begin(label: string) { this.n.set(label, (this.n.get(label) ?? 0) + 1); }
  end(label: string) { const k = (this.n.get(label) ?? 1) - 1; if (k <= 0) this.n.delete(label); else this.n.set(label, k); }
  /** Hold the label until now + ms (extended, never shortened). */
  hold(label: string, ms: number) { const until = this.now() + ms; if ((this.held.get(label) ?? 0) < until) this.held.set(label, until); }
  list(): string[] {
    const out = [...this.n.entries()].map(([l, k]) => (k > 1 ? `${l} ×${k}` : l));
    for (const [l, until] of [...this.held]) {
      if (until <= this.now()) { this.held.delete(l); continue; }
      if (!this.n.has(l)) out.push(`${l} (outcome unclear until ${new Date(until).toISOString().slice(11, 16)} UTC)`);
    }
    return out;
  }
}

/** The bridge returned not-ok or crashed: money may have left and not arrived yet — the "bridge" label is held as long as the Funding pause (BRIDGE_COOLDOWN_MS). */
export const BRIDGE_HOLD_MS = BRIDGE_COOLDOWN_MS;

/**
 * Wraps an object method with an "in flight" counter: until the call returns (or fails), the label is visible in InFlight. The method's behaviour
 * does not change (same arguments, this, result and exception). Complements the executor's list (PaperExecutor.inFlight(), #133):
 * that one sees buys/sells after the call returns and a bridge in motion, this one — the call itself while it runs (see reconcileInFlight).
 */
export function trackCalls<T extends object, K extends keyof T>(obj: T, method: K, label: string, inFlight: InFlight,
  opts: { holdOnFailMs?: number; holdIf?: (result: unknown) => boolean } = {}): void {
  const orig = obj[method];
  if (typeof orig !== 'function') throw new Error(`trackCalls: ${String(method)} is not a method`);
  (obj as any)[method] = async function (this: unknown, ...args: unknown[]) {
    inFlight.begin(label);
    let failed = true; // an exception is a failure too
    try {
      const r = await (orig as any).apply(obj, args);
      failed = opts.holdIf ? opts.holdIf(r) : !!r && typeof r === 'object' && (r as { ok?: unknown }).ok === false;
      return r;
    } finally {
      if (failed && opts.holdOnFailMs) inFlight.hold(label, opts.holdOnFailMs);
      inFlight.end(label);
    }
  };
}

// ---------- M-A1: in live an ETH-chain entry only on a fresh ETH price at decision time; entries — after the startup reconciliation ----------

/** Actions that spend money (new entries). */
export const ENTRY_ACTIONS = new Set<string>(['buy_token', 'contract_call', 'dapp_session', 'nft_buy', 'open_perp', 'prediction_buy']);
/** Allowed ETH price rise between decision and execution: the $ cap was checked at the decision price. */
export const ETH_PRICE_MAX_RISE = 0.02;
/** The ETH price the decision was made at: px and whether it was fresh. */
export interface DecisionPrice { px: number; fresh: boolean }

/**
 * A guard between decision and execution (live only). decide() reads the ETH price exactly once before any entry (decide.ts: `const ethUsd = d.ethUsd()`),
 * and execution follows the decision right away in the same queue (pipeline / intel router → executor.execute). So ethUsd() remembers whether
 * the price decide used for size, gas and the $ cap was fresh, and check() refuses an entry if:
 *  - entries are still closed (the startup reconciliation is not over);
 *  - an entry on an ETH chain or in $ from an ETH amount (nft_buy, contract_call), while the price at decision time was not fresh
 *    (never received or older than 10 min — decide then used the last one or 2500);
 *  - there is no fresh price now or it rose more than 2 % since the decision (the $ cap no longer holds).
 */
export class LiveEntryGuard {
  private snap: DecisionPrice | undefined;
  private open = false;
  /** The price of the decision currently executing: carried through await and the executor lock to the money-method wrappers. */
  private ctx = new AsyncLocalStorage<DecisionPrice>();
  constructor(private price: FreshPrice, private fallbackUsd = 2500) {}
  /** For decide: a fresh price, otherwise the last/fallback one — check() will refuse a decision based on it. */
  readonly ethUsd = (): number => {
    const f = this.price.fresh();
    const px = f ?? this.price.last() ?? this.fallbackUsd;
    this.snap = { px, fresh: f !== undefined };
    return px;
  };
  openEntries() { this.open = true; }
  get entriesOpen() { return this.open; }
  /**
   * The price that belongs to the incoming decision. An entry (ENTRY_ACTIONS) — the price decide read for it (decide reads it before any
   * entry, and decision and execution go as a pair in one queue). Anything else (e.g. "scheduled" with a mint — decide never reaches the price) —
   * the fresh price when the decision arrives: the minter computes its budget from the fresh price itself, so that is the only thing to compare with.
   */
  priceFor(d: Pick<Decision, 'action'>): DecisionPrice | undefined {
    if (ENTRY_ACTIONS.has(d.action)) return this.snap;
    const f = this.price.fresh();
    return f === undefined ? undefined : { px: f, fresh: true };
  }
  /** A price error relative to the decision price s, or undefined. */
  priceProblem(s: DecisionPrice | undefined): string | undefined {
    if (!s?.fresh) return 'no fresh ETH price at decision time (live needs a price ≤ 10 min old) — not buying on a stale or default price';
    const now = this.price.fresh();
    if (now === undefined) return 'no fresh ETH price';
    if (now > s.px * (1 + ETH_PRICE_MAX_RISE)) return `ETH price rose ${((now / s.px - 1) * 100).toFixed(1)}% since the decision ($${s.px.toFixed(0)} → $${now.toFixed(0)}) — USD cap no longer holds`;
    return undefined;
  }
  /** Early check (before the executor lock). The entry refusal reason, or undefined. */
  check(d: Pick<Decision, 'action' | 'chain'>, s: DecisionPrice | undefined = this.priceFor(d)): string | undefined {
    if (!ENTRY_ACTIONS.has(d.action)) return undefined;
    if (!this.open) return 'startup wallet reconciliation not finished — new entries wait';
    const needsEth = (ETH_CHAINS as string[]).includes(d.chain) || d.action === 'nft_buy' || d.action === 'contract_call';
    if (!needsEth) return undefined;
    return this.priceProblem(s);
  }
  /** Run fn with this decision's price (visible in recheck() inside fn, including after waiting for the lock). */
  withDecision<T>(s: DecisionPrice | undefined, fn: () => Promise<T>): Promise<T> {
    return this.ctx.run(s ?? { px: 0, fresh: false }, fn);
  }
  /** Re-check right before money moves (inside the executor lock). Outside a decision execution — refusal. */
  recheck(): string | undefined {
    if (!this.open) return 'startup wallet reconciliation not finished — new entries wait';
    const s = this.ctx.getStore();
    if (!s) return 'no decision context — purchase outside a guarded decision is refused';
    return this.priceProblem(s);
  }
}

/** An executor with a guard: a refusal is an exception that pipeline and intel router turn into a skip with the reason "execution blocked: …". */
export function guardedExecutor(inner: Executor, guard: LiveEntryGuard, log: (s: string) => void = console.warn): Executor {
  return {
    async execute(m: RawMessage, d: Decision, id: number) {
      const price = guard.priceFor(d); // THIS decision's price — fixed at once, before waiting for the lock
      const why = guard.check(d, price);
      if (why) { log(`[live] entry refused (${d.action} ${d.chain}): ${why}`); throw new Error(why); }
      return guard.withDecision(price, () => inner.execute(m, d, id));
    },
    ...(inner.exitToken ? { exitToken: inner.exitToken.bind(inner) } : {}),
  };
}

/**
 * Guard re-check before a money method (called inside the executor lock): a refusal skips the original call and takes the form
 * the method itself uses to report a refusal (refuse), so the executor records a skip with no position and no reserve. Do not wrap exits this way.
 */
export function guardCall<T extends object, K extends keyof T>(obj: T, method: K, guard: LiveEntryGuard,
  refuse: (why: string) => unknown, log: (s: string) => void = console.warn): void {
  const orig = obj[method];
  if (typeof orig !== 'function') throw new Error(`guardCall: ${String(method)} is not a method`);
  (obj as any)[method] = async function (this: unknown, ...args: unknown[]) {
    const why = guard.recheck();
    if (why) { log(`[live] ${String(method)} refused at execution: ${why}`); return refuse(why); }
    return (orig as any).apply(obj, args);
  };
}

/**
 * Hold the "bridge" label after a Funding.ensure call (#117 item 1, #134)? By the FundResult.legSent flag, not the note text:
 * not-ok and a leg in this call was sent or may have been sent — yes. A refusal before sending (balance, limit, quote, simulation) — no;
 * a "pause after the previous leg" refusal carries no flag, but that bridge is visible in PaperExecutor.inFlight() (Funding.inTransit()).
 * ok — the money arrived, nothing to hold. Not an object (unknown result) — yes: the safe side.
 */
export function bridgeLegSent(r: unknown): boolean {
  const o = r as { ok?: unknown; legSent?: unknown } | undefined;
  if (!o || typeof o !== 'object') return true;
  if (o.ok !== false) return false;
  return o.legSent === true;
}

/**
 * An "in flight" line for a treasury transaction at the sender (#135 F3): a ghost (an outcome without a ledger counterpart, the address is blocked) — with what
 * the owner should do; an ordinary unconfirmed transaction — as before.
 */
export function treasuryTxLine(chain: Chain, tx: { hash: string; ghost?: boolean }): string {
  return tx.ghost ? `${GHOST_BLOCK_MARK} ${chain} ${tx.hash} (check the wallet; after checking — /release ${tx.hash} sold or not-sold)`
    : `treasury transaction ${chain} ${tx.hash.slice(0, 10)}…`;
}

/**
 * The "in flight" list for wallet reconciliation (Reconciler.inFlight): calls still running (trackCalls), PLUS the executor's list
 * (#133: sells/buys "in flight" after return, Solana, a bridge in motion), the mint reserve and unconfirmed treasury transactions.
 * Identical lines — once. An empty list — no money is moving outside the ledger.
 */
export function reconcileInFlight(d: { tracked: InFlight; executor?: { inFlight(): string[] }; mintReservedUsd?: () => number;
  treasuryTx?: () => string[];
  /** #140: the NFT part (NftLive.inFlight): sweeping leftovers from burner wallets and the reserved mint. */
  nft?: { inFlight(): string[] } }): () => string[] {
  return () => {
    const out = [...d.tracked.list(), ...(d.executor?.inFlight() ?? []), ...(d.nft?.inFlight() ?? [])];
    const minting = d.mintReservedUsd?.() ?? 0;
    if (minting > 0) out.push(`mint (reserve $${minting.toFixed(2)})`);
    out.push(...(d.treasuryTx?.() ?? []));
    return [...new Set(out)];
  };
}

/** #140: how long to wait for burner-wallet sweeps before the startup reconciliation (otherwise its "in flight" would give "failed"). */
export const STARTUP_SWEEP_WAIT_MS = 60_000;
/** Wait for leftover sweeps (sweepIdle) no longer than ms; sweep errors do not interfere. Result — 'done' or 'timeout' (then reconciliation sees "in flight"). */
export function awaitSweeps(sweeps: Promise<unknown>[], ms = STARTUP_SWEEP_WAIT_MS): Promise<'done' | 'timeout'> {
  return bounded(Promise.allSettled(sweeps), ms);
}

export const RECONCILE_EVERY_MS = 10 * 60_000;
export const RECONCILE_STARTUP_TIMEOUT_MS = 30_000;
/** The stop reason if the startup reconciliation did not pass: no trading without reconciliation. */
export const STARTUP_HALT_REASON = 'wallet reconciliation at startup failed — live does not trade without reconciliation';

export interface ReconcileSchedulerDeps {
  /** Reconciler.run — does not overlap passes, turns inner exceptions into "failed". */
  run(phase: 'startup' | 'periodic'): Promise<ReconcileReport>;
  halted(): boolean;
  halt(reason: string): void;
  notify(text: string): Promise<void>;
  log?(s: string): void;
  everyMs?: number;
  startupTimeoutMs?: number;
  /** Wait timeout for one message (default NOTIFY_WAIT_MS). */
  notifyWaitMs?: number;
  timers?: Timers;
}

export type StartupOutcome = 'ok' | 'mismatch' | 'skipped' | 'timeout' | 'error';

/**
 * Runs reconciliation at startup and on a timer.
 *  - Startup: no longer than startupTimeoutMs. "Failed", timed out or crashed — a stop on new entries (operatorHalt) with a reason and
 *    a message. On "failed" Reconciler itself writes that new entries are not stopped — so a clarification follows right away that in live
 *    they are stopped. A mismatch — Reconciler itself does the stop and the message.
 *  - A stop set here is not lifted by itself — only by the owner's /resume. When reconciliation finally passes, Reconciler reports it
 *    itself ("running again" or "matches"); here — one line saying the startup stop is still on (if the owner has not lifted it).
 *  - While this stop is in effect, a line about it is added to Reconciler messages (relay): its "entries not stopped yet" texts
 *    assume only Reconciler itself sets the stop.
 *  - On the timer: every everyMs, the next pass is armed in finally (not setInterval), passes do not overlap, an exception does not crash the process.
 */
export class ReconcileScheduler {
  private current: Promise<ReconcileReport> | undefined;
  /** A stop set at startup because of a failed reconciliation, not yet "reported" by a successful one. */
  private startupHaltPending = false;
  private loop: { stop(): void } | undefined;
  constructor(private d: ReconcileSchedulerDeps) {}

  private log(s: string) { (this.d.log ?? console.log)(s); }
  /** The notify hook for Reconciler: its text + a line about the startup stop, if it is still in effect. */
  relay(text: string): Promise<void> {
    const note = this.startupHaltPending && this.d.halted() ? '\n⛔ New entries are stopped now: the stop set at startup (reconciliation failed then) stays until /resume.' : '';
    return this.say(text + note);
  }
  /** A message takes no longer than notifyWaitMs: a hung Telegram does not hold startup or the reconciliation timer (sending finishes in the background). */
  private async say(t: string): Promise<void> {
    const r = await bounded(this.d.notify(t).catch(e => console.error(`[reconcile] notify failed: ${String(e).slice(0, 120)}`)), this.d.notifyWaitMs ?? NOTIFY_WAIT_MS);
    if (r === 'timeout') console.error('[reconcile] notify still pending — not waiting for it');
  }

  /** One pass; if a pass is already running — its result (no second pass). */
  private guarded(phase: 'startup' | 'periodic'): Promise<ReconcileReport> {
    if (this.current) return this.current;
    const p = (async () => this.d.run(phase))().then(async r => { await this.after(r); return r; });
    const tracked: Promise<ReconcileReport> = p.finally(() => { if (this.current === tracked) this.current = undefined; });
    this.current = tracked;
    return tracked;
  }

  private async after(r: ReconcileReport) {
    if (!this.startupHaltPending) return;
    if (r.status === 'skipped') return;
    this.startupHaltPending = false;
    // Mismatch: the stop and a message with the /resume hint come from Reconciler. Matched and the stop is still on — remind that the owner lifts it.
    if (r.status === 'ok' && this.d.halted()) await this.say('ℹ️ Wallet reconciliation passed. The stop on new entries set at startup (reconciliation failed then) is not lifted automatically — lift it: /resume.');
  }

  private startupHalt(why: string): boolean {
    const was = this.d.halted();
    try { this.d.halt(`${STARTUP_HALT_REASON}: ${why}`); } catch (e) { console.error(`[reconcile] halt failed: ${String(e).slice(0, 120)}`); }
    this.startupHaltPending = !was;
    return was;
  }

  /** Reconciliation at startup (before accepting messages). Does not throw. */
  async startup(): Promise<StartupOutcome> {
    const ms = this.d.startupTimeoutMs ?? RECONCILE_STARTUP_TIMEOUT_MS;
    const timers = this.d.timers ?? realTimers;
    let th: unknown;
    const timeout = new Promise<'timeout'>(res => { th = timers.set(() => res('timeout'), ms); });
    const run = this.guarded('startup').then(r => r, (e: unknown) => ({ error: e }));
    const res = await Promise.race([run, timeout]);
    timers.clear(th);
    let outcome: StartupOutcome; let why: string | undefined;
    if (res === 'timeout') { outcome = 'timeout'; why = `did not finish within ${Math.round(ms / 1000)} s`; }
    else if ('error' in res) { outcome = 'error'; why = `crashed: ${String((res.error as Error)?.message ?? res.error).slice(0, 160)}`; }
    else if (res.status === 'skipped') { outcome = 'skipped'; why = res.why ?? 'no reason given'; }
    else outcome = res.status;
    this.log(`[reconcile] startup outcome: ${outcome}${why ? ` (${why})` : ''}`);
    if (why) {
      const was = this.startupHalt(why);
      const head = outcome === 'skipped' ? '⛔ Clarification to the message above: in live without reconciliation new entries are stopped (like /stop).' : `⛔ Wallet reconciliation at startup ${why}. New entries are stopped (like /stop).`;
      await this.say(`${head}${was ? ' The stop was already on.' : ''} Exits on open positions keep working. Reconciliation repeats every 10 minutes; I will report when it passes. It will not lift the stop itself: check the wallet and RPC, then /resume.`);
    }
    return outcome;
  }

  /** Timed reconciliation: every everyMs after the previous pass ends. */
  start(): void {
    if (this.loop) return;
    this.loop = selfRescheduling('reconcile periodic', () => this.guarded('periodic'), this.d.everyMs ?? RECONCILE_EVERY_MS, this.d.timers ?? realTimers);
  }
  stop(): void { this.loop?.stop(); this.loop = undefined; }

  /** Reconcile now (the /reconcile command): through the same lock as the timer. */
  runNow(): Promise<ReconcileReport> { return this.guarded('periodic'); }
}
