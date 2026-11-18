// E-03 (#13), minimal version for the first live day (#28, item 4): reconciliation of the agent's ledger with the treasury wallet.
// What is reconciled:
//  1) native treasury balances on the live chains (ETH on EVM chains, SOL), converted to $ at the current price, against ledger cash
//     (risk.cashUsd — money not invested in positions). A mismatch above the tolerance → a problem;
//  2) at startup — a treasury nonce "gap" (the node's pending counter is above latest): a transaction sent before the restart is still in flight.
//     The agent keeps all "in flight" state in memory and does not remember it after a restart — such a transaction would land in a block without accounting.
// On a problem the caller (index.ts) turns on the stop for new entries (operatorHalt, E-08) and sends the owner a message with per-chain numbers.
// Reconciliation does not stop exits from open positions. Only the owner lifts the stop (/resume) — reconciliation itself does not lift it.
// Not here (after live): reconciling open positions' tokens with token balances; the minter's burner wallets.
// The ledger is kept in $, while the treasury holds ETH/SOL: native coin price moves alone create a mismatch, so the tolerance is a share of cash,
// and "accept the current balance as the baseline" (acceptCurrent) removes a price-driven mismatch the owner has already dealt with. The baseline is stored
// in native units per chain and valued at the current price: coins leaving the wallet are caught at any price, a price rebound does not "eat" the baseline.
// A stale balance (the node did not answer, the last known one is used) never yields "matches": only "mismatch" or "not done".
import type { Chain } from '../types.js';
import { jsonRpc, type ChainCfg } from './evm.js';

type Rpc = (url: string, method: string, params: unknown[]) => Promise<any>;

export interface ReconcileLedger { cashUsd: number; equityUsd: number; positionsCostUsd: number; pendingBuyUsd: number }
export interface ReconcileDeps {
  /** EVM chains where the treasury may hold money — the list of live chains (HQ passes the same one to the trader). */
  chains: Partial<Record<Chain, ChainCfg>>;
  /** EVM treasury address; without it EVM chains are not reconciled. */
  evmAddress?: string;
  /** Solana: treasury address and RPC for reading. */
  sol?: { address: string; rpc: string };
  /** The chain's native coin price, $ (the same function the trader uses). We wait no longer than priceTimeoutMs. */
  nativeUsd: (chain: Chain) => Promise<number | undefined>;
  /** Ledger: cash, capital, cost of open positions and the reserve for buys "in flight". */
  ledger: () => ReconcileLedger;
  /**
   * What is running now and moving money outside the ledger: a buy (Relay bridge, waiting for a receipt), a mint between arming and its result.
   * While the list is not empty, periodic reconciliation is postponed and a baseline is not accepted. Filled by the executor (HQ wires it).
   */
  inFlight?: () => string[];
  /**
   * Mismatch tolerance: a share of cash (0 ≤ share < 1) and a minimum in $ (finite, ≥ 0) — the larger is taken.
   * The number is the owner's decision, the module has no default; values that would switch reconciliation off are rejected with an exception.
   */
  toleranceShare: number;
  toleranceUsd: number;
  rpc?: Rpc;
  /** Confirming a mismatch with a second pass (periodic reconciliation): pause between passes, ms. 0 — no confirmation. */
  confirmMs?: number;
  /** Wait limit for the native coin price, ms (default 10 s): a hung price request must not hang reconciliation. */
  priceTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ChainLine { chain: Chain; native: number; usd: number;
  /** Native coin price used to value the line ($; 0 — the price was not requested, the balance and baseline are empty). */
  priceUsd: number;
  pendingNonce?: number; latestNonce?: number;
  /** The chain's node did not answer — the last known balance is used (may count toward a "mismatch" but not toward "matches"). */
  stale?: boolean }
/** Accepted baseline: native balances per chain and cash at the moment of acceptance (acceptCurrent). */
export interface ReconcileBaseline { native: Partial<Record<string, number>>; cashUsd: number; acceptedUtc: string }
export interface ReconcileReport {
  /** ok — reconciliation matched; mismatch — there is a problem (problems); skipped — could not reconcile or too early (why). */
  status: 'ok' | 'mismatch' | 'skipped';
  why?: string;
  problems: string[];
  walletUsd: number;
  ledgerCashUsd: number;
  /** Mismatch wallet − cash; with an accepted baseline — the wallet change (at today's prices) minus the cash change since the baseline. */
  diffUsd: number;
  toleranceUsd: number;
  lines: ChainLine[];
  /** Chains whose nodes did not answer this time. */
  unknownChains?: string[];
  /** Chains for which the last known balance was used: such a pass is never "matches". */
  staleChains?: string[];
  /** Accepted baseline at today's prices: the wallet at acceptance × the current price, and the cash at that time. */
  baselineWalletUsd?: number;
  baselineCashUsd?: number;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const err = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 120);
/** Texts go to Telegram with parse_mode HTML: angle brackets from a node response would break the message. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** jsonRpc returns a parsed node rejection as Error "<method>: <text>"; a timeout/network break — TypeError/TimeoutError: there was no response. */
const noAnswer = (e: unknown) => e instanceof TypeError || ['TimeoutError', 'AbortError'].includes((e as { name?: string })?.name ?? '') || /fetch failed|timeout|ECONN|network/i.test(String((e as Error)?.message ?? ''));
const nodeErr = (e: unknown) => `${noAnswer(e) ? 'node did not answer' : e instanceof Error && /^\w+: /.test(e.message) ? 'node answered with an error' : 'node response not parsed'}: ${err(e)}`;

/** A tolerance that switches reconciliation off (share ≥ 1, infinite or negative minimum) is a wiring error, not a "wide tolerance". */
export function checkTolerance(d: { toleranceShare: number; toleranceUsd: number }): void {
  if (!(Number.isFinite(d.toleranceShare) && d.toleranceShare >= 0 && d.toleranceShare < 1)) throw new Error(`reconcile: toleranceShare must be 0 ≤ x < 1, got ${d.toleranceShare}`);
  if (!(Number.isFinite(d.toleranceUsd) && d.toleranceUsd >= 0)) throw new Error(`reconcile: toleranceUsd must be finite and ≥ 0, got ${d.toleranceUsd}`);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms} ms`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t)) as Promise<T>;
}

export interface ReconcileOpts {
  /** Accepted baseline (acceptCurrent): changes since its moment are reconciled, not levels. */
  baseline?: ReconcileBaseline;
  /** Last known balances per chain — for a chain whose node did not answer now. */
  lastKnown?: Map<string, ChainLine>;
}

/**
 * One reconciliation. phase 'startup' — a nonce gap counts as a problem (a transaction from the previous run without accounting);
 * 'periodic' — a transaction in flight is normal work: reconciliation is postponed until its outcome (the money may have left while the ledger is not yet updated).
 * A node failure on one chain does not break reconciliation of the others: the last known balance of that chain is used — it can yield a "mismatch"
 * (an empty wallet on another chain is visible), but not "matches": without a node answer the pass counts as "not done". Without a known balance — too.
 * The ledger is re-read after polling the nodes: if cash changed meanwhile (a trade completed), reconciliation is postponed.
 */
export async function reconcile(d: ReconcileDeps, phase: 'startup' | 'periodic', o: ReconcileOpts = {}): Promise<ReconcileReport> {
  checkTolerance(d);
  const rpc = d.rpc ?? jsonRpc();
  const L = d.ledger();
  const lines: ChainLine[] = [];
  const unknownChains: string[] = []; const unknownWhy: string[] = [];
  const base = { problems: [] as string[], walletUsd: 0, ledgerCashUsd: L.cashUsd, diffUsd: 0, toleranceUsd: Math.max(d.toleranceUsd, d.toleranceShare * Math.max(0, L.cashUsd)), lines, unknownChains };
  const skipped = (why: string): ReconcileReport => ({ ...base, status: 'skipped', why });
  const gaps: string[] = [];
  // At startup too (#117 item 3): the position monitor is already running, and a sale during the startup reconciliation would give a false
  // mismatch and a stop that can only be lifted by hand. "Not done" clears itself with the next successful reconciliation
  const flying = d.inFlight?.() ?? [];
  if (flying.length) return skipped(`in flight: ${flying.join(', ')} — will reconcile after the outcome`);
  const price = (c: Chain) => withTimeout(d.nativeUsd(c), d.priceTimeoutMs ?? 10_000).catch(() => undefined);
  const read = async (c: Chain, fn: () => Promise<ChainLine | 'noprice'>): Promise<'ok' | 'noprice' | 'down'> => {
    try { const l = await fn(); if (l === 'noprice') return 'noprice'; lines.push(l); return 'ok'; }
    catch (e) {
      const last = o.lastKnown?.get(c);
      unknownChains.push(c); unknownWhy.push(`${c}: ${nodeErr(e)}`);
      if (last) lines.push({ ...last, stale: true });
      return 'down';
    }
  };
  let noPrice: string | undefined;
  for (const [c, cfg] of Object.entries(d.chains) as [Chain, ChainCfg | undefined][]) {
    if (!cfg || !d.evmAddress) continue;
    const st = await read(c, async () => {
      const [bal, pend, latest] = await Promise.all([
        rpc(cfg.rpc, 'eth_getBalance', [d.evmAddress, 'latest']),
        rpc(cfg.rpc, 'eth_getTransactionCount', [d.evmAddress, 'pending']),
        rpc(cfg.rpc, 'eth_getTransactionCount', [d.evmAddress, 'latest']),
      ]);
      const wei = BigInt(bal); const p = Number(BigInt(pend)); const l = Number(BigInt(latest));
      const native = Number(wei) / 1e18;
      // A price is needed only where there is something to value (balance or baseline): an empty chain without a price does not hinder reconciliation
      const need = wei > 0n || (o.baseline?.native[c] ?? 0) > 0;
      const px = need ? await price(c) : 0;
      if (need && !(px! > 0)) { noPrice = `no native coin price for ${c} — balance ${native.toFixed(6)} cannot be valued`; return 'noprice'; }
      if (p > l) gaps.push(`${c}: ${p - l} (nonce ${l}…${p - 1})`);
      return { chain: c, native, usd: native * (px ?? 0), priceUsd: px ?? 0, pendingNonce: p, latestNonce: l };
    });
    if (st === 'noprice') return skipped(noPrice!);
  }
  if (d.sol) {
    const st = await read('solana', async () => {
      const r = await rpc(d.sol!.rpc, 'getBalance', [d.sol!.address]);
      const lamports = BigInt(r?.value ?? r);
      const native = Number(lamports) / 1e9;
      const need = lamports > 0n || (o.baseline?.native.solana ?? 0) > 0;
      const px = need ? await price('solana') : 0;
      if (need && !(px! > 0)) { noPrice = `no SOL price — balance ${native.toFixed(6)} cannot be valued`; return 'noprice'; }
      return { chain: 'solana', native, usd: native * (px ?? 0), priceUsd: px ?? 0 };
    });
    if (st === 'noprice') return skipped(noPrice!);
  }
  if (!lines.length) return skipped(unknownWhy.length ? unknownWhy.join('; ') : 'no chain to reconcile (no treasury address or RPC)');
  // A chain did not answer and its balance was never known — there is nothing to value the wallet with
  if (unknownChains.some(c => !lines.some(l => l.chain === c))) return skipped(unknownWhy.join('; '));
  // The ledger changed while the nodes were polled (a trade completed): we would be comparing balances from one moment with cash from another
  const L2 = d.ledger();
  if (L2.cashUsd !== L.cashUsd || L2.pendingBuyUsd !== L.pendingBuyUsd) return skipped('the ledger changed during reconciliation (a trade completed) — will reconcile next time');
  // An operation started while the nodes were polled and is still running: some balances were read before it, some in the middle of it (#117 item 3)
  const started = d.inFlight?.() ?? [];
  if (started.length) return skipped(`an operation started during reconciliation (${started.join(', ')}) — will reconcile after the outcome`);
  const walletUsd = lines.reduce((a, x) => a + x.usd, 0);
  const staleChains = lines.filter(l => l.stale).map(l => l.chain);
  // Baseline: the wallet at acceptance at TODAY's prices (native units × current price) against the cash at that time.
  // Changes are reconciled: coins left without accounting → mismatch at any price; the price came back — this does not "eat" the baseline.
  const bl = o.baseline;
  const baselineWalletUsd = bl ? lines.reduce((a, l) => a + (bl.native[l.chain] ?? 0) * l.priceUsd, 0) : undefined;
  const diffRaw = bl ? (walletUsd - baselineWalletUsd!) - (L.cashUsd - bl.cashUsd) : walletUsd - L.cashUsd;
  const out: ReconcileReport = { ...base, status: 'ok', walletUsd, diffUsd: diffRaw, staleChains, baselineWalletUsd, baselineCashUsd: bl?.cashUsd };
  if (gaps.length) {
    if (phase === 'periodic') return { ...out, status: 'skipped', why: `the treasury has transactions in flight (${gaps.join('; ')}) — will reconcile after their outcome` };
    out.problems.push(`the treasury has transactions sent before the restart that are not yet in a block: ${gaps.join('; ')}. The agent does not remember them — they will land without accounting`);
  }
  // Reserve for a buy "in flight": the money may already have left the wallet while cash is not yet reduced — is the reserve-adjusted mismatch within tolerance? then ok.
  // (A reserve left hanging from before a restart does not switch reconciliation off: it will see an empty wallet even with the adjustment.)
  const diffAdj = diffRaw + L.pendingBuyUsd;
  const within = (x: number) => Math.abs(x) <= out.toleranceUsd;
  if (!within(diffRaw) && !(L.pendingBuyUsd > 0 && within(diffAdj))) {
    out.problems.push(`treasury wallet holds ${usd(walletUsd)}${staleChains.length ? ` (${staleChains.join(', ')}: by the last known balance, node did not answer)` : ''}, ledger cash ${usd(L.cashUsd)}${L.pendingBuyUsd > 0 ? ` (buy reserve ${usd(L.pendingBuyUsd)})` : ''} — mismatch ${diffRaw >= 0 ? '+' : '−'}${usd(Math.abs(diffRaw))} with tolerance ${usd(out.toleranceUsd)}${bl ? ` (against the accepted baseline: wallet then ${usd(baselineWalletUsd!)} at today's prices, cash ${usd(bl.cashUsd)})` : ''}`);
  }
  if (out.problems.length) return { ...out, status: 'mismatch' };
  // No mismatch, but some balances are stale: without a node answer this is not a reconciliation — counts as a skip (counter, message, stop after an hour)
  if (staleChains.length) return { ...out, status: 'skipped', why: `${unknownWhy.join('; ')} — by the last known balance (${staleChains.join(', ')}) there is no mismatch, but without a node answer this is not a reconciliation` };
  return out;
}

/** Text for Telegram: the result and per-chain numbers (HTML-escaped). */
export function reconcileText(r: ReconcileReport, ledger: { equityUsd: number; positionsCostUsd: number }): string {
  const head = r.status === 'ok' ? '✅ Wallet reconciliation: matches'
    : r.status === 'skipped' ? `ℹ️ Wallet reconciliation not done: ${esc(r.why ?? '')}`
      : `⛔ Wallet reconciliation does NOT match:\n${r.problems.map(p => `• ${esc(p)}`).join('\n')}`;
  const per = r.lines.map(l => `${l.chain}: ${l.native.toFixed(6)} ≈ ${usd(l.usd)}${l.stale ? ' (last known)' : ''}${l.pendingNonce !== undefined && l.pendingNonce > (l.latestNonce ?? 0) ? ` (in flight: ${l.pendingNonce - l.latestNonce!})` : ''}`).join(' · ');
  return [head, per ? `Treasury: ${per} — total ${usd(r.walletUsd)}` : undefined,
    `Ledger: cash ${usd(r.ledgerCashUsd)}, in positions ${usd(ledger.positionsCostUsd)}, capital ${usd(ledger.equityUsd)}; tolerance ${usd(r.toleranceUsd)}`,
    r.baselineWalletUsd !== undefined ? `Baseline accepted: wallet then ${usd(r.baselineWalletUsd)} at today's prices, cash ${usd(r.baselineCashUsd!)}` : undefined].filter(Boolean).join('\n');
}

export interface ReconcilerHooks {
  notify(text: string): Promise<void>;
  /** Turn on the stop for new entries (operatorHalt). Called on a mismatch; only the owner can lift it (/resume). */
  halt(reason: string): void;
  /** Whether the stop is on right now (risk.operatorHalt): to tell "the owner lifted the stop but the mismatch remained" from a repeat. Required. */
  halted(): boolean;
}

const EMPTY_LEDGER: ReconcileLedger = { cashUsd: 0, equityUsd: 0, positionsCostUsd: 0, pendingBuyUsd: 0 };
/** #135 F3: the ghost block mark in the "in flight" list (liveWiring.treasuryTxLine) — with it the reconciliation stop reason is different, not "check RPC". */
export const GHOST_BLOCK_MARK = 'ghost block';

/**
 * Reconciliation at startup and on a timer. Rules:
 *  - at startup — always one message with the numbers (if not done — the next successful reconciliation is reported too);
 *  - a mismatch during operation is confirmed by a second pass after confirmMs (money in flight usually arrives within a minute);
 *  - the stop is turned on at every mismatch; a repeat of the same mismatch — no new message, BUT if the owner lifted the stop (/resume)
 *    and the mismatch remained, the message comes again, with a hint on how to accept the current balance as the baseline (acceptCurrent);
 *  - reconciliation not done SKIP_ALERT_AFTER times in a row — a message; SKIP_HALT_AFTER times in a row (an hour) — stop for new entries and
 *    a reminder every hour; when it runs again — a "running again" message. Reconciliation does not lift the stop itself;
 *  - an exception inside a pass (ledger, flags, hooks) — not a process crash but a skip logged to the journal;
 *  - passes do not overlap: a call during a running pass returns its result.
 */
export class Reconciler {
  static readonly SKIP_ALERT_AFTER = 3;
  static readonly SKIP_HALT_AFTER = 6;
  private last: 'ok' | 'mismatch' | undefined;
  private lastProblems = '';
  private skips = 0;
  private startupSkipped = false;
  private haltedByUs = false;
  private haltedForSkips = false;
  private base: ReconcileBaseline | undefined;
  private lastKnown = new Map<string, ChainLine>();
  private running: Promise<ReconcileReport> | undefined;
  constructor(private d: ReconcileDeps, private hooks: ReconcilerHooks) {
    checkTolerance(d);
    for (const k of ['notify', 'halt', 'halted'] as const) if (typeof hooks?.[k] !== 'function') throw new Error(`Reconciler: hook ${k} is required`);
  }

  /** Accepted baseline (acceptCurrent) — for the report and the journal; undefined — not accepted. */
  get baseline(): ReconcileBaseline | undefined { return this.base; }

  private async once(phase: 'startup' | 'periodic') {
    const r = await reconcile(this.d, phase, { baseline: this.base, lastKnown: this.lastKnown });
    for (const l of r.lines) if (!l.stale) this.lastKnown.set(l.chain, l);
    return r;
  }

  private say(t: string) { return this.hooks.notify(t).catch(e => console.error(`[reconcile] notify failed: ${err(e)}`)); }
  private ledger(): ReconcileLedger { try { return this.d.ledger(); } catch (e) { console.error(`[reconcile] ledger() failed: ${err(e)}`); return EMPTY_LEDGER; } }
  private halt(why: string) { try { this.hooks.halt(why); } catch (e) { console.error(`[reconcile] halt() failed: ${err(e)}`); } }

  /** A reconciliation pass; overlapping passes (the timer during the one-minute confirmation) — the second call gets the first one's result. */
  run(phase: 'startup' | 'periodic'): Promise<ReconcileReport> {
    if (this.running) return this.running;
    this.running = this.cycle(phase).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async cycle(phase: 'startup' | 'periodic'): Promise<ReconcileReport> {
    try { return await this.pass(phase); }
    catch (e) {
      // An exception from the ledger, executor flags or price — not a process crash (unhandled rejection in a timer) but a skip
      console.error(`[reconcile] ${phase} failed: ${err(e)}`);
      const r: ReconcileReport = { status: 'skipped', why: `reconciliation failure: ${err(e)}`, problems: [], walletUsd: 0, ledgerCashUsd: NaN, diffUsd: 0, toleranceUsd: 0, lines: [] };
      try { await this.onSkipped(r, phase); } catch (e2) { console.error(`[reconcile] skip handling failed: ${err(e2)}`); }
      return r;
    }
  }

  private async onSkipped(r: ReconcileReport, phase: 'startup' | 'periodic') {
    const L = this.ledger();
    this.skips++;
    // #135 F3: reconciliation is held up by a ghost block (a transaction outcome without a pair in the ledger), not by the nodes — and the advice differs: the wallet, not RPC
    const ghost = (r.why ?? '').includes(GHOST_BLOCK_MARK);
    const fix = ghost ? `${GHOST_BLOCK_MARK}: check the wallet; after checking — /release <tx> sold or not-sold (hash — in /status), then /reconcile` : 'check RPC';
    if (phase === 'startup') { this.startupSkipped = true; await this.say(`${reconcileText(r, L)}\nNew entries are not stopped. Will retry in 10 minutes.`); }
    else if (this.skips === Reconciler.SKIP_ALERT_AFTER) await this.say(`${reconcileText(r, L)}\nFailed ${this.skips} times in a row. New entries are not stopped yet — ${fix}; if this lasts an hour, I will stop entries.`);
    else if (this.skips >= Reconciler.SKIP_HALT_AFTER && this.skips % Reconciler.SKIP_HALT_AFTER === 0) {
      this.haltedForSkips = true; this.haltedByUs = true;
      this.halt(`wallet reconciliation not done ${this.skips} times in a row${ghost ? ` (${fix})` : ''}`);
      // With a ghost the trader also refuses sales from the treasury address on that chain: "exits work" would be untrue
      const ghostChains = [...new Set([...(r.why ?? '').matchAll(new RegExp(`${GHOST_BLOCK_MARK} (\\S+)`, 'g'))].map(m => m[1]))];
      const exits = ghost ? `exits on ${ghostChains.join(', ') || 'the blocked chain'} do not work while the block stands (stops on that chain's positions will not fire)` : 'exits work';
      await this.say(`${reconcileText(r, L)}\n⛔ Reconciliation not done for ${this.skips * 10} minutes in a row — new entries stopped (like /stop), ${exits}. `
        + (ghost ? `Reason — ${fix}; when reconciliation passes again, lift the stop: /resume.` : 'Check the RPCs of the live chains; when reconciliation passes again, lift the stop: /resume.'));
    }
  }

  private async pass(phase: 'startup' | 'periodic'): Promise<ReconcileReport> {
    let r = await this.once(phase);
    // A mismatch during operation — confirmed by a second pass: a bridge, swap or mint arming usually reaches the ledger within a minute
    const confirmMs = this.d.confirmMs ?? 60_000;
    if (r.status === 'mismatch' && phase === 'periodic' && confirmMs > 0) {
      await (this.d.sleep ?? ((ms: number) => new Promise(res => setTimeout(res, ms))))(confirmMs);
      const r2 = await this.once(phase);
      console.log(`[reconcile] confirm: first ${r.status} (${r.problems[0] ?? ''}), second ${r2.status}`);
      r = r2;
    }
    console.log(`[reconcile] ${phase}: ${r.status}${r.why ? ` (${r.why})` : ''} wallet ${usd(r.walletUsd)} vs ledger cash ${usd(r.ledgerCashUsd)}${r.problems.length ? ` — ${r.problems.join(' | ')}` : ''}`);
    if (r.status === 'skipped') { await this.onSkipped(r, phase); return r; }
    const L = this.ledger();
    const recovered = this.skips > 0 && (this.startupSkipped || this.haltedForSkips);
    this.skips = 0;
    if (r.status === 'mismatch') {
      const resumed = this.haltedByUs && !this.hooks.halted();
      this.halt(r.problems[0]); this.haltedByUs = true;
      const key = r.problems.map(p => p.replace(/[\d.,]+/g, '#')).join('|'); // the same problems with different numbers — not a new message
      if (resumed) await this.say(`${reconcileText(r, L)}\n⛔ The stop was lifted (/resume), but the mismatch remained — new entries are stopped again. If the wallet is intact and the difference is only from the ETH/SOL price or from something already accounted for, accept the current balance as the baseline: /reconcile accept (the baseline lives until the agent restarts; lift the stop yourself afterwards: /resume). If money really is missing — check the wallet, see the live deployment guide, section 6.`);
      else if (this.last !== 'mismatch' || key !== this.lastProblems) await this.say(`${reconcileText(r, L)}\nNew entries stopped (like /stop), position exits work. Check the wallet; once sorted — /resume (if the mismatch is only from the price — first /reconcile accept).`);
      this.last = 'mismatch'; this.lastProblems = key; this.startupSkipped = false; this.haltedForSkips = false;
      return r;
    }
    if (phase === 'startup') await this.say(reconcileText(r, L));
    else if (this.last === 'mismatch') await this.say(`${reconcileText(r, L)}\nThe stop on new entries is NOT lifted — lift it yourself: /resume.`);
    else if (recovered) await this.say(`${reconcileText(r, L)}\nReconciliation is running again.${this.haltedForSkips ? ' The stop on new entries is NOT lifted — lift it yourself: /resume.' : ''}`);
    this.last = 'ok'; this.lastProblems = ''; this.startupSkipped = false; this.haltedForSkips = false;
    return r;
  }

  /**
   * Accept the current balance as the baseline (command /reconcile accept — wired by Ops/HQ): native balances per chain and cash at this
   * moment are remembered, and from then on changes relative to them are reconciled. Needed when the wallet is intact and the mismatch comes from the coin price.
   * Refused while money is moving outside the ledger: a buy/bridge/mint is running (inFlight), a buy reserve is pending, the treasury has a transaction in flight
   * (nonce gap), some chain's node did not answer, or the ledger changed during polling — otherwise "in flight" would enter the baseline as normal.
   * The baseline lives in memory until the agent restarts. Does not lift the stop.
   */
  async acceptCurrent(): Promise<string> {
    if (this.running) return 'Baseline not accepted: reconciliation is running now — retry in a minute.';
    const L = this.d.ledger();
    const flying = this.d.inFlight?.() ?? [];
    if (flying.length) return `Baseline not accepted: in flight ${esc(flying.join(', '))} — money is moving outside the ledger, the baseline would be wrong. Retry after the outcome.`;
    if (L.pendingBuyUsd > 0) return `Baseline not accepted: a buy reserve of ${usd(L.pendingBuyUsd)} is pending — the buy outcome is not recorded yet. Retry after the outcome (or a restart, if the reserve is stuck).`;
    // Phase 'periodic': a nonce gap and executor flags give "not done", not a problem — both are a refusal here
    const r = await reconcile(this.d, 'periodic', { lastKnown: this.lastKnown });
    if (r.status === 'skipped' || r.unknownChains?.length || r.staleChains?.length) return `Baseline not accepted: ${esc(r.why ?? `nodes did not answer (${(r.unknownChains ?? []).join(', ')})`)}. Retry when the nodes answer and everything in flight has arrived.`;
    if (r.ledgerCashUsd !== this.d.ledger().cashUsd) return 'Baseline not accepted: the ledger changed during reconciliation — retry.';
    // An operation may have started while the nodes were read (#117 item 4): balances were read before it or in the middle of it — such a baseline would be wrong
    const started = this.d.inFlight?.() ?? [];
    if (started.length || this.d.ledger().pendingBuyUsd > 0) return `Baseline not accepted: an operation started during reconciliation (${esc(started.join(', ') || 'a buy in flight')}) — balances were read before its outcome. Retry after the outcome.`;
    for (const l of r.lines) this.lastKnown.set(l.chain, l);
    this.base = { native: Object.fromEntries(r.lines.map(l => [l.chain, l.native])), cashUsd: r.ledgerCashUsd, acceptedUtc: new Date((this.d.now ?? Date.now)()).toISOString() };
    this.last = undefined; this.lastProblems = '';
    const diff = r.walletUsd - r.ledgerCashUsd;
    console.log(`[reconcile] baseline accepted: ${r.lines.map(l => `${l.chain} ${l.native.toFixed(6)}`).join(', ')}; wallet ${usd(r.walletUsd)}, cash ${usd(r.ledgerCashUsd)}`);
    return `Baseline accepted: wallet ${usd(r.walletUsd)} (${r.lines.map(l => `${l.chain} ${l.native.toFixed(6)}`).join(', ')}), cash ${usd(r.ledgerCashUsd)}, the difference of ${diff >= 0 ? '+' : '−'}${usd(Math.abs(diff))} now counts as normal. The baseline is in coins: coins leaving the wallet without accounting are caught at any price; it lives until the agent restarts. The stop on new entries is not lifted — if needed, /resume.`;
  }
}
