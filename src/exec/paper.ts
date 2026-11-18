// Execution in paper mode: everything as in live, but instead of transactions — a journal entry
// at the real market price adjusted for slippage and gas (on entry AND on exit).
// Live executors (Solana/Jupiter, EVM/viem, browser) plug in through the same Executor interface.
import type { RiskConfig } from '../config.js';
import type { Clock } from '../clock.js';
import type { Chain, Decision, RawMessage } from '../types.js';
import type { Store } from '../store/db.js';
import type { Notifier } from '../notify/telegram.js';
import type { BuyResult, LateOutcome } from '../live/trader.js';
import { decisionCard, helpCard } from '../notify/telegram.js';
import { assertWithinLimits, estimateGasUsd, type RiskState } from '../risk/risk.js';
import { evaluateExit, moonbagFields, type OpenPos } from './exits.js';
import { classesFrom, classesProblem } from '../decide/tokenClass.js';
import { entryProblem } from '../decide/entry.js';
import type { MarketClient } from '../checks/token.js';
import type { NftPlan } from '../types.js';
import type { OpenSeaClient } from '../analyst/opensea.js';
import { draftPost, validCa, type PostEvent } from '../posts/drafts.js';
import { taskUrl, type SiteSessions } from './siteSessions.js';
import { escHtml } from './siteSession.js';
import type { CardExtras, PostQueue } from '../posts/publisher.js';
import { utcMs } from '../time.js';
import { pmFee } from '../checks/polymarket.js';

/** An NFT position (paper): cost in ETH, exit per the Analyst's plan, valued at the OpenSea floor. */
export interface NftPos {
  kind: 'nft'; id: string; slug: string; asset: string; chain: string; costUsd: number; costEth: number; sellFeesPct: number;
  openedAtMs: number; plan: NftPlan; publicEndMs?: number;
  /** A live mint: how many NFTs, on which wallets (token ids), the contract — for selling into OpenSea offers. */
  qty?: number; holdings?: import('../live/nftLive.js').NftHolding[]; contract?: string; live?: boolean;
}
/** A perp position (paper): Hyperliquid price, exit strictly by stop or take-profit (or by an Analyst alert). */
export interface PerpPos {
  kind: 'perp'; id: string; asset: string; side: 'long' | 'short'; entry: number; notionalUsd: number; leverage: number;
  marginUsd: number; stop: number; takeProfit: number; feePct: number; openedAtMs: number; entryFeeUsd: number;
}
/** A prediction market bet (paper): outcome shares at the book price; exit by target/stop/deadline or the result at resolution. */
export interface PredPos {
  kind: 'pred'; id: string; slug: string; question: string; outcome: string; tokenId: string; shares: number; entry: number; feeRate: number;
  costUsd: number; openedAtMs: number; endUtc?: string; stopPrice?: number; takeProfitPrice?: number; sellByMs?: number;
}
/** Gas for listing an NFT (a one-time approval to the marketplace), in gas units. The sale itself is paid by the buyer. */
const NFT_SELL_GAS = 60_000;
/**
 * #137: what the entry price of a live buy is divided by. Solana — the swap amount itself (swapUsd), without the new token account rent and the fee:
 * the floor, ladder and breakeven are computed from the real price. The cost basis (cost) is the whole spend: cash = capital is preserved.
 */
const entryUsd = (r: { spentUsd: number; swapUsd?: number }) => (typeof r.swapUsd === 'number' && r.swapUsd > 0 && Number.isFinite(r.swapUsd) ? r.swapUsd : r.spentUsd);
/** #135 G1: a hint for the owner on how to lift the hold or block for this transaction — after checking the wallet, with the /release command. */
export const releaseHint = (tx: string) => `after checking the wallet: /release ${tx} sold (the sale went through — count it) or /release ${tx} not-sold (it did not — lift the hold and the block)`;
/**
 * #135 F3/G1: what to do when an address is blocked because of an outcome without a pair in the ledger. A restart does not lift the block as a solution (the sale hold
 * survives it) — the owner's /release command lifts it after checking the wallet.
 */
export const ghostFix = (tx: string) => `while the block stands, stops on this chain's positions do not work. Check the wallet; ${releaseHint(tx)}`;
/** A block without a sale in the ledger (a late buy, a transaction without a pair, the position already closed): nothing to count — only lift the block. */
export const ghostFixNoSale = (tx: string) => `while the block stands, stops on this chain's positions do not work. Check the wallet; after checking: /release ${tx} not-sold (lift the block)`;

export interface Executor {
  execute(m: RawMessage, d: Decision, decisionId: number): Promise<void>;
  /** Close the whole token position (an Analyst alert). */
  exitToken?(token: string, reason: string, market: MarketClient): Promise<boolean>;
}

export const PAPER_SLIPPAGE = 0.01; // 1% on entry and on exit — conservative for memecoins

const POST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * The exit deadline in the plan line of the public entry post (#126 item 2): ", out by 14:30 UTC" if the deadline is today (UTC), otherwise with a date —
 * ", out by Nov 17 08:00 UTC". Previously the date was not written, and the configured deadline looked like today's. core — the position has a tail (moonbag)
 * that lives longer: the deadline applies to the core part only — ", core out by …". The deadline did not parse — an empty string.
 */
export function deadlineForPost(timeStopAtUtc: string, nowMs: number, core: boolean): string {
  const t = Date.parse(timeStopAtUtc);
  if (!Number.isFinite(t)) return '';
  const iso = new Date(t).toISOString();
  const today = iso.slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10);
  const date = today ? '' : `${POST_MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))} `;
  return `, ${core ? 'core ' : ''}out by ${date}${iso.slice(11, 16)} UTC`;
}

/**
 * The position's floor price. Exit plan V2 (S-07, the plan has tokenClass): the floor percent from the ACTUAL entry price — like the ladder,
 * behaviour checks and breakeven. The previous scheme (without tokenClass) and a plan without a percent — the price from the plan, as before.
 */
export function stopFromEntry(plan: { stopPrice: number; stopPct?: number; tokenClass?: string }, entry: number): number {
  const pct = plan.stopPct;
  return plan.tokenClass && typeof pct === 'number' && pct > 0 && pct < 100 && entry > 0 ? entry * (1 - pct / 100) : plan.stopPrice;
}

/** A position without a price (#126 item 3, #142): the rule's default numbers are examples, your own are set in risk.json. */
export const NO_PRICE_DEFAULT = { exitHours: 8, writeOffHours: 36, retryMinutes: 15 } as const; // example values — set your own in server/config/risk.json (noPrice)
/** The noPrice block in risk.json is set but invalid — the reason; no block or a valid one — undefined. */
export function noPriceProblem(cfg: RiskConfig): string | undefined {
  const raw = (cfg as RiskConfig & { noPrice?: unknown }).noPrice as any;
  if (raw === undefined) return undefined;
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!raw || typeof raw !== 'object') return 'must be an object';
  if (!num(raw.exitHours, 0.25, 168)) return 'exitHours must be 0.25..168';
  if (!num(raw.writeOffHours, 0.25, 720)) return 'writeOffHours must be 0.25..720';
  if (raw.writeOffHours < raw.exitHours) return 'writeOffHours must not be below exitHours';
  if (!num(raw.retryMinutes, 1, 1440)) return 'retryMinutes must be 1..1440';
  return undefined;
}
/** The rule's working numbers, ms: from the noPrice block; no block or an invalid one — the approved defaults (the rule is never switched off). */
export function noPriceRules(cfg: RiskConfig): { exitMs: number; writeOffMs: number; retryMs: number } {
  const raw = (cfg as RiskConfig & { noPrice?: { exitHours: number; writeOffHours: number; retryMinutes: number } }).noPrice;
  const r = raw !== undefined && !noPriceProblem(cfg) ? raw : NO_PRICE_DEFAULT;
  return { exitMs: r.exitHours * 3600_000, writeOffMs: r.writeOffHours * 3600_000, retryMs: r.retryMinutes * 60_000 };
}

export class PaperExecutor implements Executor {
  open = new Map<string, OpenPos>();
  nftOpen = new Map<string, NftPos>();
  perpOpen = new Map<string, PerpPos>();
  predOpen = new Map<string, PredPos>();
  /** Perp prices (Hyperliquid). */
  perp?: import('../checks/perp.js').PerpClient;
  /** Prediction markets (Polymarket). */
  pm?: import('../checks/polymarket.js').PolymarketClient;
  private returned = new Map<string, number>();
  constructor(private cfg: RiskConfig, private risk: RiskState, private store: Store, private notifier: Notifier, private clock: Clock,
    private ethUsd: () => number = () => 2500, private opensea?: OpenSeaClient, private ethGasGwei: () => number | undefined = () => undefined,
    /** All source names (servers, channels, authors) — for checking posts for leaks. */
    private sourceNames: () => string[] = () => []) {}

  /** Live trading: shadow — we build and simulate alongside paper (without sending); live — for real. Attaching the trader subscribes the executor to late outcomes. */
  private _trader?: import('../live/trader.js').LiveTrader;
  get trader() { return this._trader; }
  set trader(t: import('../live/trader.js').LiveTrader | undefined) { this._trader = t; if (t) this.attachLateOutcomes(); }
  /** Sessions on task sites without money (E-06). Not wired — dapp_session gives only a card, as before. */
  siteSessions?: SiteSessions;
  /** Live NFTs: the FCFS minter and sales into OpenSea offers. */
  nftLive?: import('../live/nftLive.js').NftLive;
  liveMode: 'paper' | 'shadow' | 'live' = 'paper';
  /**
   * Buys "in flight" (live): the transaction was accepted, no receipt. Until decided, cash is reserved for them, and a repeated signal
   * for the same token does not buy a second time (E-10 item 6).
   */
  private pendingBuys = new Map<string, { usd: number; tx: string; unresolved?: boolean }>();
  pendingBuyUsd() { let t = 0; for (const b of this.pendingBuys.values()) t += b.usd; return t; }
  /** The last reason a live sale of a position failed: the same reason (e.g. "approve still in flight") is not repeated in Telegram every 15 s. */
  private sellFailNotes = new Map<string, { note: string; sinceMs: number; toldMs: number }>();
  /** The same reason — a reminder every 30 min (with the duration since it first appeared), not every 15 s; a new reason — immediately. */
  private async sellFailed(id: string, text: string, rawNote: string) {
    // The same reason with a new hash/nonce is the same reason; "nodes rejected: X" and "previous tx not resolved (nodes rejected: X)" — also one
    const stripped = rawNote.replace(/0x[0-9a-fA-F]{64}/g, '0x…').replace(/\(nonce \d+\)/g, '');
    const note = stripped.match(/rejected(?: by all nodes)?: ([^()—]+)/)?.[1]?.trim() ?? stripped;
    const last = this.sellFailNotes.get(id); const now = this.clock.now();
    if (last && last.note === note && now - last.toldMs < 30 * 60_000) { console.log(`[live] sell retry ${id}: ${note}`); return; }
    const same = !!last && last.note === note;
    this.sellFailNotes.set(id, { note, sinceMs: same ? last!.sinceMs : now, toldMs: now });
    await this.notifier.send(same ? `${text} (the reason has persisted for ${Math.round((now - last!.sinceMs) / 60_000)} min)` : text);
  }
  /** A message to the owner that does not affect accounting: a Telegram failure goes to the log, not to an exception. */
  private say(t: string): Promise<void> { return this.notifier.send(t).catch(e => console.error(`[notify] not sent (${String(e).slice(0, 120)}): ${t.slice(0, 160)}`)); }
  /**
   * How many ~10 min polls the caller waits for the outcome of an "in flight" transaction. EVM — 3 (30 min; the owner's decision 2026-11-11 10:17 UTC: a transaction
   * does not hang longer): after that the sender's background resolves the outcome and delivers it via the subscription (onLateOutcome). Solana — as before, 18 (3 h):
   * there is no background watcher there, and the transaction itself lives ~1.5 min — a long "unknown" means an unreachable RPC.
   */
  private static settleSlices(chain: string) { return chain === 'solana' ? 18 : 3; }
  private static waitText(chain: string) { return chain === 'solana' ? '3 h' : '30 min'; }
  /** A buy "in flight": wait for the outcome while the trader answers "unknown"; the last poll hands the outcome to the sender's background (last). */
  private async settleBuyLong(args: { chain: Chain; token: string; sizeUsd: number; tx: string; decimals: number }, onStillPending: (i: number) => Promise<void>) {
    const n = PaperExecutor.settleSlices(args.chain);
    for (let i = 0; ; i++) {
      const late = await this.trader!.settleBuy({ ...args, last: i >= n - 1 });
      if (!late.pending || i >= n - 1) return late;
      await onStillPending(i);
    }
  }
  /** Sales "in flight" still waiting for an outcome or handed to the background after the wait limit: hash → position and sale parameters. */
  private pendingSells = new Map<string, { id: string; p: OpenPos; x: { tx: string; qty: number; proceeds: number; soldRaw?: bigint; reason: string; price: number; after?: Partial<OpenPos>; nonce?: number; from?: string; sentUtc?: string }; ctx?: { d: Decision; decisionId: number; m: RawMessage; entryGas: number };
    /** The caller stopped waiting for the outcome (time is up). EVM: the record holds the position until the late outcome (sellInFlight, #135) together with the address block. */
    givenUp?: boolean;
    /** #135 F3: the record was restored from the database after a restart — it holds the position (any chain) until the outcome is explicitly known. */
    restored?: boolean }>();
  /**
   * #135 R1: sales released with the /release not-sold command (hash → position and sale parameters) — 24 h in memory and in the database
   * (OpenPos.releasedSells). A late outcome for such a hash brings the "in flight" record back and is handled as an ordinary sale.
   */
  private released = new Map<string, { id: string; p: OpenPos; x: { tx: string; qty: number; proceeds: number; soldRaw?: bigint; reason: string; price: number; after?: Partial<OpenPos>; nonce?: number; from?: string; sentUtc?: string }; atMs: number }>();
  static readonly RELEASED_KEEP_MS = 24 * 3600_000;
  private rememberReleased(id: string, p: OpenPos, x: { tx: string; qty: number; proceeds: number; soldRaw?: bigint; reason: string; price: number; after?: Partial<OpenPos>; nonce?: number; from?: string; sentUtc?: string }) {
    const now = this.clock.now();
    this.released.set(x.tx.toLowerCase(), { id, p, x, atMs: now });
    const keep = (p.releasedSells ?? []).filter(s => s.tx.toLowerCase() !== x.tx.toLowerCase() && now - Date.parse(s.releasedUtc) < PaperExecutor.RELEASED_KEEP_MS);
    p.releasedSells = [...keep, { tx: x.tx, qty: x.qty, proceeds: x.proceeds, ...(x.soldRaw !== undefined ? { soldRaw: x.soldRaw.toString() } : {}), reason: x.reason, price: x.price,
      ...(x.after ? { after: x.after } : {}), sentUtc: x.sentUtc ?? this.clock.iso(), ...(x.nonce !== undefined && x.from ? { nonce: x.nonce, from: x.from } : {}), releasedUtc: this.clock.iso() }];
    if (this.open.has(id)) this.store.updatePosition(id, p.qtyLeft, 0, p);
  }
  /** A released sale by hash (no older than 24 h) — take it from memory and from the position state (the caller will write). */
  private takeReleased(h: string) {
    const r = this.released.get(h);
    if (!r) return undefined;
    this.released.delete(h);
    if (r.p.releasedSells) { r.p.releasedSells = r.p.releasedSells.filter(s => s.tx.toLowerCase() !== h); if (!r.p.releasedSells.length) delete r.p.releasedSells; }
    return this.clock.now() - r.atMs < PaperExecutor.RELEASED_KEEP_MS ? r : undefined;
  }
  /**
   * Money "in flight" outside the ledger — for wallet reconciliation (#117): buys and sales whose outcome is not recorded yet, and the bridge whose money may
   * be moving between chains. An empty list — nothing is pending in the executor.
   * What stays in the list after the wait limit: buys (EVM and Solana) and EVM sales — marked "outcome unknown", until the outcome.
   * What disappears from the list (#135 item 4): a Solana sale whose outcome is not known within 3 h — its record is removed, because Solana has no late
   * channel and the outcome will not come by itself; keeping it in the list would postpone wallet reconciliation forever. If such a sale
   * actually went through, reconciliation itself will show it (more SOL on the wallet than in the ledger), as will the message when the deadline fires.
   * The mint reserve and the minter's burner wallets are not included here (NftLive.reserved()).
   */
  inFlight(): string[] {
    const out: string[] = [];
    for (const [key, b] of this.pendingBuys) out.push(`buy ${key} ${b.tx.slice(0, 10)}… (reserve $${b.usd.toFixed(2)}${b.unresolved ? ', outcome unknown' : ''})`);
    // The hash as it came from the trader (o.x.tx), not the map key: the key is lowercase, while a Solana signature is case-sensitive
    for (const o of this.pendingSells.values()) out.push(`sale ${o.p.chain}:${o.p.token.toLowerCase()} ${o.x.tx.slice(0, 10)}…${o.givenUp ? ' (outcome unknown)' : ''}`);
    out.push(...(this.trader?.funding?.inTransit?.() ?? []));
    return out;
  }
  /**
   * #135: an EVM sale the caller stopped waiting for (givenUp) also holds the position: the sender's background resolves its outcome and delivers it
   * via the subscription (mined / dropped / replaced; an unreadable status — the record stays until the owner checks). Selling the same position again
   * before the outcome could sell it a second time. Solana: there is no late channel — after the deadline the record is removed by itself (watchPendingSell).
   */
  private sellInFlight(id: string): boolean { for (const o of this.pendingSells.values()) if (o.id === id && (!o.givenUp || o.p.chain !== 'solana' || o.restored)) return true; return false; }
  /** #135 F3: a sale "in flight" — into the position state in the database (survives a restart). */
  private persistSell(id: string, p: OpenPos, x: { tx: string; qty: number; proceeds: number; soldRaw?: bigint; reason: string; price: number; after?: Partial<OpenPos>; nonce?: number; from?: string; sentUtc?: string }) {
    const rest = (p.sellsInFlight ?? []).filter(s => s.tx.toLowerCase() !== x.tx.toLowerCase());
    p.sellsInFlight = [...rest, { tx: x.tx, qty: x.qty, proceeds: x.proceeds, ...(x.soldRaw !== undefined ? { soldRaw: x.soldRaw.toString() } : {}), reason: x.reason, price: x.price,
      ...(x.after ? { after: x.after } : {}), sentUtc: this.clock.iso(), ...(x.nonce !== undefined && x.from ? { nonce: x.nonce, from: x.from } : {}) }];
    this.store.updatePosition(id, p.qtyLeft, 0, p);
  }
  /** The sale outcome is recorded or the record removed — take it out of the position state. write: write to the database right away (otherwise the caller will). */
  private unpersistSell(id: string, p: OpenPos, tx: string, write: boolean) {
    if (!p.sellsInFlight?.length) return;
    p.sellsInFlight = p.sellsInFlight.filter(s => s.tx.toLowerCase() !== tx.toLowerCase());
    if (!p.sellsInFlight.length) delete p.sellsInFlight;
    if (write && this.open.has(id)) this.store.updatePosition(id, p.qtyLeft, 0, p);
  }
  /** Buys "in flight": hash → decision context for recording the position. An entry in this map = the outcome is NOT yet in the ledger. */
  private pendingBuyCtx = new Map<string, { d: Decision; decisionId: number; m: RawMessage; tokenKey: string; entryGas: number; decimals: number }>();
  /**
   * Hashes of transactions whose outcome is already recorded in the ledger (position opened / sale counted). A repeated delivery of the same outcome
   * (the caller and the late channel in any order) is neither a second entry nor an alert.
   */
  private appliedTx = new Map<string, number>();
  private markApplied(h: string) {
    this.appliedTx.set(h, this.clock.now());
    if (this.appliedTx.size > 1000) this.appliedTx.delete(this.appliedTx.keys().next().value!);
  }

  /**
   * The ONLY place where the outcome of a buy "in flight" enters the ledger. Both possible recipients come here — the caller (settleBuy)
   * and the late-outcome subscription — and always under the executor lock. The first takes the record by hash, the second does not find it
   * and does nothing: one transaction — one entry, in any order. onLedger is called right after the ledger changes,
   * before notifications. Returns undefined if the record has already been taken.
   */
  private async finishBuy(tx: string, late: BuyResult, onLedger?: () => void): Promise<'recorded' | 'released' | undefined> {
    const h = tx.toLowerCase();
    const ctx = this.pendingBuyCtx.get(h);
    if (!ctx) return undefined;
    this.pendingBuyCtx.delete(h); this.pendingBuys.delete(ctx.tokenKey);
    if (!(late.ok && late.qty > 0)) { onLedger?.(); await this.say(`ℹ️ Buy ${tx} did not go through: ${late.note}`); return 'released'; }
    const f = { qty: late.qty, entry: entryUsd(late) / late.qty, cost: late.spentUsd, tx, raw: late.raw, decimals: late.decimals };
    let pos: OpenPos;
    try { pos = this.recordTokenPosition(ctx.d, ctx.decisionId, f); }
    catch (e) {
      // The position did not enter the ledger: the reserve and the token block come back — the outcome stays unresolved, not lost
      if ([...this.open.values()].some(o => o.live?.tx === tx)) this.markApplied(h);
      else { this.pendingBuyCtx.set(h, ctx); this.pendingBuys.set(ctx.tokenKey, { usd: ctx.d.sizeUsd + ctx.entryGas, tx, unresolved: true }); }
      throw e;
    }
    this.markApplied(h);
    onLedger?.();
    await this.announceTokenPosition(ctx.d, ctx.m, pos, f).catch(e => console.error(`[live] buy ${tx} is recorded, but the notification failed: ${String(e).slice(0, 160)}`));
    return 'recorded';
  }

  /**
   * The ONLY place where the outcome of a sale "in flight" enters the ledger (the same rule as finishBuy): the record is taken by hash,
   * the second recipient does not find it. 'gone' — the position has already been closed otherwise by now; undefined — the record has already been taken.
   */
  private async finishSell(tx: string, st: 'ok' | 'failed' | 'dropped', tag: string, onLedger?: () => void): Promise<'applied' | 'released' | 'gone' | undefined> {
    const h = tx.toLowerCase();
    const s = this.pendingSells.get(h);
    if (!s) return undefined;
    this.pendingSells.delete(h);
    const { id, p, x } = s;
    // The freeze is lifted only if the position has no OTHER sale "in flight": after a final "dropped" the monitor may already have sent a new one
    if (!this.sellInFlight(id)) p.exitingUntilMs = undefined;
    // #135 F3: the sale record also leaves the database — on "ok" applyTokenSell writes it together with the sale, otherwise — now
    this.unpersistSell(id, p, tx, st !== 'ok');
    if (!this.open.has(id)) return 'gone';
    if (st !== 'ok') {
      onLedger?.();
      await this.say(`ℹ️ Sale ${tx} ${st === 'dropped' ? 'did not reach the network (no node knows it) or was replaced' : 'did not go through'} — the position is back under the monitor`);
      return 'released';
    }
    if (p.live?.raw && x.soldRaw !== undefined) p.live.raw = (BigInt(p.live.raw) - x.soldRaw > 0n ? BigInt(p.live.raw) - x.soldRaw : 0n).toString();
    if (/take-profit 1/.test(x.reason)) p.tp1Done = true;
    // S-07: the ladder, checks and breakeven state computed when deciding the sale — applied only after confirmation
    if (x.after) Object.assign(p, x.after);
    await this.applyTokenSell(id, p, Math.min(x.qty, p.qtyLeft), x.proceeds, `${x.reason} (${tag})`, x.price, () => { this.markApplied(h); onLedger?.(); });
    return 'applied';
  }

  /**
   * Subscription to the trader's late outcomes: an outcome the caller no longer waits for (the wait limit passed; a ghost after "dropped" or
   * a node rejection). The handler runs under the executor lock and writes to the ledger via the same finishBuy / finishSell as the caller.
   */
  attachLateOutcomes() {
    this.trader?.setLateOutcomeHandler?.((e) => void this.locked(() => this.onLateOutcome(e)).catch(err => console.error(`[live] late outcome ${e.hash}: ${String(err).slice(0, 200)}`)));
  }
  /**
   * Late outcome → ledger. Errors are not swallowed: log + a message to the owner; the address block (clearGhost) is lifted only after
   * the ledger agrees with the chain — right after the write, before notifications. An outcome without a pair in the ledger — an alert, the treasury block stays until reconciliation.
   */
  private async onLateOutcome(e: LateOutcome) {
    const h = e.hash.toLowerCase();
    const mined = (e.state ?? 'mined') === 'mined';
    const ack = () => this.trader!.clearGhost(e.chain, e.hash);
    const when = e.kind === 'ghost' ? 'after it was considered dropped or rejected by the nodes' : `after the wait limit (${PaperExecutor.waitText(e.chain)})`;
    const where = e.treasury === false ? `wallet ${e.addr} (a burner, not the treasury)` : `treasury on ${e.chain}`;
    // A revert is only an explicit status 0x0. The status is missing, null or written differently ('0x01') — the receipt is unreadable: such a transaction
    // could have moved money, so it is NOT counted as a revert — an alert and an address block, as for a successful one without a pair (acceptance #114)
    const status = e.receipt?.status;
    const reverted = mined && status === '0x0';
    const unreadable = mined && status !== '0x0' && status !== '0x1';
    const statusText = `the receipt status is unreadable (${status === undefined ? 'no field' : JSON.stringify(status)}) — money may have left`;
    try {
      if (this.appliedTx.has(h)) { ack(); console.log(`[live] late outcome ${e.hash}: already in the ledger — nothing to do`); return; }
      const buy = this.pendingBuyCtx.get(h);
      if (buy) {
        const res: BuyResult = mined
          ? await this.trader!.buyFromLateReceipt({ chain: e.chain, token: buy.d.intent.tokenAddress!, sizeUsd: buy.d.sizeUsd, tx: e.hash, decimals: buy.decimals, receipt: e.receipt })
          : { ok: false, mode: 'live', qty: 0, raw: 0n, decimals: 0, spentUsd: 0, tx: e.hash, note: e.state === 'replaced' ? 'replaced: the nonce slot was taken by another tx — this one will not execute' : 'dropped: no node knows the tx and the nonce slot is free' };
        // The receipt succeeded but its logs show no tokens — the ledger does not agree with the chain: the reserve is released (as for the caller), the address block stays
        const odd = mined && !res.ok && !reverted;
        const done = await this.finishBuy(e.hash, res, odd ? undefined : ack);
        if (done === 'recorded') await this.say(`✅ Late receipt (${when}): buy ${e.hash} landed in a block — position recorded, reserve and block lifted`);
        else if (odd) await this.say(`⚠️ Late buy receipt ${e.hash}: ${unreadable ? statusText : `the transaction succeeded, but ${res.note}`} — no position, check the wallet; ${where} — blocked until reconciliation (E-03): ${ghostFixNoSale(e.hash)}`);
        else await this.say(`ℹ️ Buy ${e.hash} ${when} finally did not happen (${mined ? 'reverted' : e.state === 'replaced' ? 'replaced' : 'dropped'}) — reserve and token block lifted`);
        return;
      }
      // #135 R1: a sale released by /release not-sold did get an outcome after all — it is "in flight" again and handled as an ordinary one:
      // landed — counted once (finishSell: no more than the position remainder, cash = capital), reverted/dropped — the record is simply removed
      const rel = this.pendingSells.has(h) ? undefined : this.takeReleased(h);
      if (rel) {
        this.pendingSells.set(h, { id: rel.id, p: rel.p, x: rel.x, givenUp: true });
        if (this.open.has(rel.id)) this.persistSell(rel.id, rel.p, rel.x);
        await this.say(`⚠️ Sale ${rel.p.symbol ?? rel.p.token.slice(0, 8)} tx ${e.hash}, released by /release not-sold, got a late outcome — handling it as a sale "in flight": if it landed, I will count it once (no more than the position remainder); check the wallet`);
      }
      if (this.pendingSells.has(h)) {
        if (unreadable) {
          // Whether the position was sold is unknown: the record and the address block stay (there will be no repeat sale), the owner decides by the wallet
          await this.say(`⚠️ Late sale receipt ${e.hash}: ${statusText} — the sale is neither recorded nor cancelled in the ledger, I am not touching the position; check the wallet; ${where} — blocked until reconciliation (E-03): ${ghostFix(e.hash)}`);
          return;
        }
        const done = await this.finishSell(e.hash, !mined ? 'dropped' : e.receipt?.status === '0x1' ? 'ok' : 'failed', 'confirmed very late', ack);
        if (done === 'applied') await this.say(`✅ Late sale receipt ${e.hash} (${when}) — counted, block lifted`);
        else if (done === 'gone' && mined && e.receipt?.status === '0x1') await this.say(`⚠️ Late sale receipt ${e.hash}: the position was already closed otherwise — check the wallet; ${where} — blocked until reconciliation (E-03): ${ghostFixNoSale(e.hash)}`);
        else if (done === 'gone') ack(); // reverted / dropped for an already closed position: nothing to change in the ledger
        return;
      }
      if (!mined) { console.log(`[live] late ${e.state} of ${e.hash} on ${e.chain}: no pending entry in the ledger — nothing to do`); return; }
      if (reverted) {
        // Reverted: no money left, only gas — the ledger needs no pair. The block lifts itself: otherwise buys and stops on this chain
        // would stand until a manual restart because of a transaction that did nothing (leftover from the #48 acceptance)
        ack();
        await this.say(`ℹ️ Transaction ${e.hash} (${e.chain}, nonce ${e.nonce}) landed in a block reverted ${when} — no money left, only gas; it has no pair in the ledger and needs none, block lifted (${where})`);
        return;
      }
      if (e.treasury === false) {
        // A minter burner wallet: it does not block the treasury — we say it as it is
        ack();
        await this.say(`⚠️ Transaction ${e.hash} (${e.chain}, nonce ${e.nonce}) from burner wallet ${e.addr} landed in a block ${when}, it has no pair in the ledger — the treasury is NOT blocked; check the wallet and the mint manually`);
        return;
      }
      await this.say(`⚠️ Transaction ${e.hash} (${e.chain}, nonce ${e.nonce}) landed in a block ${when}, it has no pair in the ledger — the treasury on this chain is blocked until reconciliation (E-03): ${ghostFixNoSale(e.hash)}`);
    } catch (err) {
      console.error(`[live] late outcome ${e.hash} (${e.chain}) was NOT applied to the ledger: ${String((err as Error)?.stack ?? err).slice(0, 400)}`);
      await this.say(`⚠️ Late outcome ${e.hash} (${e.chain}): failure writing to the ledger (${String(err).slice(0, 120)}) — check the wallet${mined ? `; ${where} — block not lifted until reconciliation (E-03): ${ghostFix(e.hash)}` : ''}`);
    }
  }
  /** In live without a live executor the action is not written to the ledger — journal only (E-10 blocker 3). */
  private liveJournalOnly(what: string): never { throw new Error(`live: no live executor for ${what} — journal only (paper fills would distort the real risk ledger)`); }
  /** A check of the live route alongside a paper trade: does not delay paper, the result goes to Telegram and the journal. */
  private shadow(label: string, run: () => Promise<{ ok: boolean; note: string; qty?: number; proceedsUsd?: number }>, paperPrice?: number, sizeUsd?: number) {
    if (!this.trader) return;
    void run().then(async r => {
      const px = r.qty && sizeUsd ? sizeUsd / r.qty : undefined;
      const diff = px && paperPrice ? ` · route price ${((px / paperPrice - 1) * 100).toFixed(1)}% vs DexScreener` : '';
      console.log(`[shadow] ${label}: ${r.ok ? 'OK' : 'FAIL'} ${r.note}`);
      await this.notifier.send(`🔬 LIVE check (no sending) ${label}: ${r.ok ? '✅' : '❌'} ${r.note}${diff}`);
    }).catch(e => this.notifier.send(`🔬 LIVE check ${label}: error ${String(e).slice(0, 160)}`));
  }

  /** The X post queue (card, buttons in Telegram, X API). Without it — a text draft in Telegram. */
  poster?: PostQueue;
  private async publish(e: PostEvent & CardExtras, extraNames: string[] = []) {
    const names = [...extraNames, ...this.sourceNames()];
    // A post about a token trade without the address line does not go out (#135 item 2; the owner 2026-11-11 17:30 UTC: many tickers are the same, the CA is unique).
    // The executor passes the `ca` key only in token posts; if the address does not fit the post's chain (a Solana address on an EVM chain and vice versa),
    // the post composer would silently drop the CA line — so the refusal happens here, before the queue and before the draft
    if ('ca' in e && !validCa(e.ca, e.chain)) {
      console.error(`[post] ${e.kind} ${e.asset}: contract address "${e.ca ?? ''}" is not valid for chain ${e.chain} — post not created`);
      await this.say(`🐦 Trade post ${e.asset} (${e.kind === 'exit' ? 'exit' : 'entry'}) not created: contract address «${e.ca ?? ''}» does not fit chain ${e.chain}. A token post without a CA is not published — check the trade's chain.`);
      return;
    }
    if (this.poster) { await this.poster.queue(e, names).catch(err => console.error('post queue', err)); return; }
    const { text, problems } = draftPost(e, names);
    if (problems.length) { await this.notifier.send(`🐦 Post draft not created: ${problems.join('; ')}`); return; }
    this.store.addPostDraft(this.clock.iso(), e.kind, text);
    await this.notifier.send(`🐦 Post draft (published only after your "yes"):\n${text}`);
  }

  /** A post on X: only after the action, without sources, with the position disclosed. */
  private async draft(e: PostEvent & CardExtras, m: RawMessage) { return this.publish(e, [m.sourceServer, m.channel, m.author]); }


  /** Restoring open positions from the journal after a restart. */
  restore() {
    // Nice-to-have 1 (S-07 acceptance): an invalid exit block in risk.json — a message to the owner at startup, not just a log line
    const why = classesProblem(this.cfg);
    // The owner's decision 2026-11-18 ~00:00 UTC ("Don't buy new ones"): new memecoins are not bought (decide.ts), open ones follow the saved plan
    if (why) void this.notifier.send(`⚠️ risk.json, the memecoinClasses block was rejected: ${why}. New memecoins are not bought until fixed; open positions follow the exit plan saved at entry. Fix the block and restart the agent.`).catch(() => {});
    // S-02: an invalid entry block — memecoins are not bought until the block is fixed
    const whyEntry = entryProblem(this.cfg);
    // A send failure goes to the service journal: memecoins are not bought, and that must not be silent (#128)
    if (whyEntry) void this.notifier.send(`⚠️ risk.json, the memecoinEntry block was rejected: ${whyEntry}. Memecoins are not bought until the block is fixed. Fix the block and restart the agent.`)
      .catch(e => console.error(`[risk.json] memecoinEntry alert not sent (${whyEntry}): ${String((e as Error)?.message ?? e).slice(0, 200)}`));
    const whyNoPrice = noPriceProblem(this.cfg);
    if (whyNoPrice) void this.notifier.send(`⚠️ risk.json, the noPrice block was rejected: ${whyNoPrice}. The "position without a price" rule runs on the approved numbers: sell after ${NO_PRICE_DEFAULT.exitHours} h, write off after ${NO_PRICE_DEFAULT.writeOffHours} h, retry every ${NO_PRICE_DEFAULT.retryMinutes} min. Fix the block and restart the agent.`)
      .catch(e => console.error(`[risk.json] noPrice alert not sent (${whyNoPrice}): ${String((e as Error)?.message ?? e).slice(0, 200)}`));
    for (const row of this.store.openPositions()) {
      const any = JSON.parse(row.state);
      if (any.kind === 'nft') { this.nftOpen.set(row.id, any as NftPos); continue; }
      if (any.kind === 'perp') { this.perpOpen.set(row.id, any as PerpPos); continue; }
      if (any.kind === 'pred') { this.predOpen.set(row.id, any as PredPos); continue; }
      const st = any as OpenPos;
      st.qtyLeft = row.qty_left;
      this.open.set(row.id, st);
      if (row.proceeds_usd > 0) this.returned.set(row.id, row.proceeds_usd);
      // #135 F3: a sale "in flight" before the restart — the hold is restored from the database: neither the monitor nor exitToken touches the position
      for (const s of st.sellsInFlight ?? [])
        this.pendingSells.set(s.tx.toLowerCase(), { id: row.id, p: st, restored: true,
          x: { tx: s.tx, qty: s.qty, proceeds: s.proceeds, soldRaw: s.soldRaw !== undefined ? BigInt(s.soldRaw) : undefined, reason: s.reason, price: s.price, after: s.after, nonce: s.nonce, from: s.from, sentUtc: s.sentUtc } });
      // #135 R1: sales released by /release not-sold (no older than 24 h) — back in memory: a late outcome will be counted rather than become a ghost
      for (const s of st.releasedSells ?? []) {
        const at = Date.parse(s.releasedUtc);
        if (!(this.clock.now() - at < PaperExecutor.RELEASED_KEEP_MS)) continue;
        this.released.set(s.tx.toLowerCase(), { id: row.id, p: st, atMs: at,
          x: { tx: s.tx, qty: s.qty, proceeds: s.proceeds, soldRaw: s.soldRaw !== undefined ? BigInt(s.soldRaw) : undefined, reason: s.reason, price: s.price, after: s.after, nonce: s.nonce, from: s.from, sentUtc: s.sentUtc } });
      }
    }
    if ([...this.pendingSells.values()].some(o => o.restored)) void this.resolveRestoredSells();
  }

  /**
   * #135 F3: after a restart — query the outcome of every restored sale by hash once. ok — count the sale once (finishSell);
   * an explicit failure (0x0) or "dropped" — lift the hold; unknown — keep the position and tell the owner. Only an explicit outcome lifts the hold:
   * there is no command for it — the next restart, when the outcome becomes known, will check the hash again.
   * Solana is a special case (there is no "dropped" state): the running-process rule, 3 h from sending (resolveRestoredSell).
   */
  private async resolveRestoredSells() {
    // Each restored sale separately: waiting on Solana (up to 3 h) does not delay the outcome of EVM sales
    await Promise.all([...this.pendingSells].filter(([, o]) => o.restored).map(([h, o]) => this.resolveRestoredSell(h, o)));
  }
  private async resolveRestoredSell(h: string, o: { id: string; p: OpenPos; x: { tx: string; nonce?: number; from?: string; sentUtc?: string } }) {
    {
      let st: 'ok' | 'failed' | 'unknown' | 'dropped' = 'unknown';
      const fail = (e: unknown) => { console.error(`[live] restored sell ${o.x.tx}: ${String(e).slice(0, 160)}`); return 'unknown' as const; };
      const name = o.p.symbol ?? o.p.token.slice(0, 8);
      if (o.p.chain === 'solana') {
        // Solana (review F3, round 3): there is no "dropped" state — the same rule as in the running process (watchPendingSell): the signature
        // is checked (with a search through the chain history) up to 3 h from sending; found — the outcome by status; not found within 3 h — the hold is lifted
        const slice = 10 * 60_000, n = PaperExecutor.settleSlices('solana');
        const sentMs = Date.parse(o.x.sentUtc ?? '');
        const age = Number.isFinite(sentMs) ? Math.max(0, this.clock.now() - sentMs) : n * slice; // no send date — the deadline counts as passed
        const left = Math.max(1, n - Math.floor(age / slice));
        for (let i = 0; i < left && this.pendingSells.has(h); i++) {
          st = this.trader?.settleTx ? await this.trader.settleTx('solana', o.x.tx).catch(fail) : 'unknown';
          if (st !== 'unknown') break;
          if (i === 0 && left > 1) await this.say(`⏳ After restart: sale ${name} tx ${o.x.tx} — outcome still unknown, watching until ${new Date((Number.isFinite(sentMs) ? sentMs : this.clock.now()) + n * slice).toISOString().slice(11, 16)} UTC (3 h from sending); not touching the position`);
        }
        if (st === 'unknown') {
          await this.locked(async () => {
            if (!this.pendingSells.has(h)) return;
            this.pendingSells.delete(h);
            this.unpersistSell(o.id, o.p, o.x.tx, true);
            o.p.exitingUntilMs = this.clock.now() + 60 * 60_000;
            await this.say(`⚠️ After restart: sale ${name} tx ${o.x.tx} was not confirmed within 3 h of sending (not found in the chain history or the node did not answer) — `
              + 'check the wallet manually; I will not touch the position for an hour, then the monitor will sell again');
          });
          return;
        }
      } else if (o.x.nonce !== undefined && o.x.from && this.trader?.settleRestored) st = await this.trader.settleRestored(o.p.chain as Chain, o.x.tx, o.x.from, o.x.nonce).catch(fail);
      // EVM with a saved nonce (above): the sender restores the record and decides "dropped / replaced" (hash AND nonce); without a nonce — by hash only
      else if (this.trader?.settleTx) st = await this.trader.settleTx(o.p.chain as Chain, o.x.tx).catch(fail);
      await this.locked(async () => {
        if (!this.pendingSells.has(h)) return;
        if (st === 'unknown') {
          await this.say(`⚠️ After restart: sale ${name} tx ${o.x.tx} — outcome unknown, check the wallet; not touching the position (its stops do not work). `
            + `The hold will lift on an explicit outcome (the sender's background keeps watching) or on your command — ${releaseHint(o.x.tx)}.`);
          return;
        }
        const done = await this.finishSell(o.x.tx, st, 'confirmed after restart');
        if (done === 'applied') await this.say(`✅ After restart: sale ${name} tx ${o.x.tx} landed in a block — counted once`);
      });
    }
  }

  // Positions are changed only by execute / exitToken / monitor — one at a time (their own lock, not the shared message queue:
  // a stop must not wait while the Analyst spends a minute on someone else's message).
  private lockChain: Promise<unknown> = Promise.resolve();
  private locked<T>(f: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(f, f);
    this.lockChain = run.catch(() => undefined);
    return run;
  }
  private lastOtherUnrealized = 0;

  execute(m: RawMessage, d: Decision, decisionId: number) { return this.locked(() => this.executeInner(m, d, decisionId)); }
  exitToken(token: string, reason: string, market: MarketClient): Promise<boolean> { return this.locked(() => this.exitTokenInner(token, reason, market)); }
  /** tokensOnly: a fast pass over memecoins only (every 15 s); NFTs and perps — once a minute. */
  monitor(market: MarketClient, opts: { tokensOnly?: boolean } = {}) { return this.locked(() => this.monitorInner(market, opts)); }

  private async executeInner(m: RawMessage, d: Decision, decisionId: number) {
    const source = `${m.sourceServer} / #${m.channel} / ${m.author}`;
    switch (d.action) {
      case 'buy_token': {
        const entryGas = (d.estGasUsd ?? 0) / 2;
        assertWithinLimits(this.cfg, this.risk, d.trust.tier, d.sizeUsd, entryGas, { token: d.intent.tokenAddress, opensPosition: true });
        const entry0 = d.check!.priceUsd! * (1 + PAPER_SLIPPAGE);
        const tradeArgs = { chain: d.chain, token: d.intent.tokenAddress!, sizeUsd: d.sizeUsd, pairAddress: d.check?.pairAddress, dexId: d.check?.dexId };
        if (this.liveMode === 'live') {
          if (!this.trader) this.liveJournalOnly('buy_token');
          const tokenKey = `${d.chain}:${tradeArgs.token.toLowerCase()}`;
          if (this.pendingBuys.has(tokenKey)) throw new Error(`live buy of this token is still pending (${this.pendingBuys.get(tokenKey)!.tx}) — not buying twice`);
          if (d.sizeUsd + entryGas + this.pendingBuyUsd() > this.risk.cashUsd + 1e-9) throw new Error(`risk: cash reserved by pending buys ($${this.pendingBuyUsd().toFixed(2)})`);
          // A live buy: quantity and price — as per the receipt; a failure = no trade (the decision is marked skip)
          const r = await this.trader.buyToken(tradeArgs, 'live');
          if (r.pending && r.tx) {
            // The transaction was accepted but there is no receipt: the position will be recorded if it lands in a block (otherwise the tokens would be "unaccounted").
            // Until decided — the token and cash are reserved
            const tx = r.tx, decimals = r.decimals, h = tx.toLowerCase();
            const reserve = d.sizeUsd + entryGas, wait = PaperExecutor.waitText(d.chain);
            this.pendingBuys.set(tokenKey, { usd: reserve, tx });
            this.pendingBuyCtx.set(h, { d, decisionId, m, tokenKey, entryGas, decimals });
            void this.settleBuyLong({ chain: d.chain, token: tradeArgs.token, sizeUsd: d.sizeUsd, tx, decimals },
              async (i) => { if (i === 0) await this.say(`⏳ Buy ${tradeArgs.token.slice(0, 8)}… (${tx}) without a receipt for 10 min — watching for up to ${wait}; the token and $${reserve.toFixed(2)} are reserved`); })
              .then(late => this.locked(async () => {
                // The outcome was already recorded by the late-outcome subscription: we don't write it twice and don't return the reserve on top of the position
                if (!this.pendingBuyCtx.has(h)) return;
                if (late.pending) {
                  // The wait limit passed, the outcome is unknown: the reserve and the token block STAY — otherwise a second signal would buy again.
                  // The outcome now belongs to the sender's background: mined / dropped / replaced will come via the subscription and be recorded through finishBuy
                  this.pendingBuys.set(tokenKey, { usd: reserve, tx, unresolved: true });
                  // Solana: there is no background watcher or late channel — the outcome will not come by itself, the reserve holds until a restart and manual reconciliation
                  await this.say(d.chain === 'solana'
                    ? `⚠️ Buy ${tradeArgs.token.slice(0, 8)}… (${tx}) was not confirmed within ${wait} — check the wallet manually; until a restart this token is not bought, $${reserve.toFixed(2)} reserved`
                    : `⚠️ Buy ${tradeArgs.token.slice(0, 8)}… (${tx}) was not confirmed within ${wait} — check the wallet; until the outcome this token is not bought, $${reserve.toFixed(2)} reserved; when the outcome is known (mined / dropped / replaced), I will record it myself`);
                  return;
                }
                await this.finishBuy(tx, late);
              }))
              .catch(e => {
                console.error(`[live] pending buy ${tx}: ${String((e as Error)?.stack ?? e).slice(0, 300)}`);
                const open = this.pendingBuyCtx.has(h); // the record was not taken — the outcome is not in the ledger: the reserve stays
                if (open) this.pendingBuys.set(tokenKey, { usd: reserve, tx, unresolved: true });
                void this.say(`⚠️ Buy ${tx}: failure while handling the outcome (${String(e).slice(0, 120)}) — check the wallet${open ? `; the token and $${reserve.toFixed(2)} stay reserved` : ''}`);
              });
            throw new Error(`live buy pending ${tx} — position will be recorded when it lands`);
          }
          if (!r.ok || r.qty <= 0) throw new Error(`live buy failed: ${r.note}${r.tx ? ` (${r.tx})` : ''}`);
          await this.openTokenPosition(d, decisionId, m, { qty: r.qty, entry: entryUsd(r) / r.qty, cost: r.spentUsd, tx: r.tx, raw: r.raw, decimals: r.decimals });
          return;
        }
        if (this.liveMode === 'shadow') this.shadow(`BUY ${d.check?.symbol ?? d.intent.tokenAddress!.slice(0, 8)}`, () => this.trader!.buyToken(tradeArgs, 'shadow'), d.check!.priceUsd!, d.sizeUsd);
        await this.openTokenPosition(d, decisionId, m, { qty: d.sizeUsd / entry0, entry: entry0, cost: d.sizeUsd + entryGas });
        return;
      }
      case 'contract_call':

        if (d.nft && this.nftLive && this.liveMode !== 'paper') {
          // The live minter: "armed" for the public start. In live the position appears after firing; in shadow — a check alongside paper.
          const live = this.liveMode === 'live';
          const note = await this.nftLive.schedule(d, live ? 'live' : 'shadow', live ? (o) => this.locked(() => this.openLiveNft(d, decisionId, o, m)) : undefined);
          await this.notifier.send(`🎯 ${live ? 'LIVE' : 'SHADOW'} minter ${d.nft.slug}: ${note}`);
          if (live) return;
        }
        if (d.nft) {
          if (this.liveMode === 'live') this.liveJournalOnly('nft mint without live minter');
          // NFT mint → a position with an exit per the Analyst's plan
          const gas = d.estGasUsd ?? 0;
          const token = `nft:${d.nft.slug}`;
          assertWithinLimits(this.cfg, this.risk, d.trust.tier, d.sizeUsd, gas, { token, opensPosition: true, allowFree: true });
          const id = `${d.chain}:${token}:${this.clock.now()}`;
          const ethUsd = this.ethUsd();
          const pos: NftPos = { kind: 'nft', id, slug: d.nft.slug, asset: d.nft.slug, chain: d.chain, costUsd: d.sizeUsd + gas, costEth: (d.sizeUsd + gas) / ethUsd,
            sellFeesPct: d.nft.sellFeesPct, openedAtMs: this.clock.now(), plan: d.nft.plan, publicEndMs: d.nft.publicEndUtc ? utcMs(d.nft.publicEndUtc) : undefined };
          this.risk.openPosition({ id, chain: d.chain, token, costUsd: pos.costUsd, openedAtUtc: this.clock.iso() });
          this.nftOpen.set(id, pos);
          this.store.savePosition({ id, decisionId, chain: d.chain, token, costUsd: pos.costUsd, qty: 1, entryPrice: d.nft.priceEth, openedUtc: this.clock.iso(), mode: 'paper', state: pos });
          await this.notifier.send(decisionCard({ action: 'NFT MINT', summary: d.intent.summary, source, sizeUsd: d.sizeUsd, chain: d.chain, mode: 'paper', reasons: [...d.reasons, `exit: ${d.nft.plan.style}`] }));
          await this.draft({ kind: 'nft_mint', asset: d.nft.slug, chain: d.chain, sizeUsd: pos.costUsd, note: d.publicNote, holding: true,
            plan: d.nft.plan.style === 'flip' ? 'list near floor' : `hold for ${d.nft.plan.targetMultiple ?? 2}x` }, m);
          return;
        }
      // eslint-disable-next-line no-fallthrough
      case 'dapp_session': {
        if (d.action === 'dapp_session' && this.siteSessions) {
          // E-06 (#16): a session on a task site WITHOUT money — fill the application form with the agent's values. Works in any mode (paper, shadow,
          // live): there are no signatures or transactions in it. The entry stop (/stop, daily, hard) stops new sessions too.
          if (this.risk.halted()) throw new Error('risk: trading halted');
          const url = taskUrl(d.intent.urls);
          if (!url) { await this.notifier.send(decisionCard({ action: 'DAPP SESSION', summary: d.intent.summary, source, sizeUsd: 0, chain: d.chain, mode: 'paper', reasons: [...d.reasons, 'no task url in the message — nothing was done'] })); return; }
          await this.notifier.send(decisionCard({ action: 'DAPP SESSION', summary: d.intent.summary, source, sizeUsd: 0, chain: d.chain, mode: 'paper',
            reasons: [...d.reasons, `site session started (${this.siteSessions.walletOn ? 'no money; burner wallet: message signing only' : 'no money, no wallet'}): ${url}`] }));
          // A session lasts up to three minutes — outside the executor lock: stops and the position monitor do not wait for it. The result — in a separate message
          void this.siteSessions.run(url).then(o => this.say(o.summary), e => this.say(`⚠️ Session on the task site: failure (${escHtml(String(e).slice(0, 160))})`));
          return;
        }
        if (this.liveMode === 'live') this.liveJournalOnly(d.action);
        assertWithinLimits(this.cfg, this.risk, d.trust.tier, d.action === 'contract_call' ? d.sizeUsd : d.sizeUsd, d.estGasUsd ?? 0);
        if (d.action === 'dapp_session') {
          // There is no browser session executor yet (E-06 #16): the action is not performed, so there is no spend either — only a card.
          // Previously the gas estimate was written off as a daily loss for every task, and several tasks in a row triggered the daily stop (#95)
          await this.notifier.send(decisionCard({ action: 'DAPP SESSION', summary: d.intent.summary, source, sizeUsd: d.sizeUsd, chain: d.chain, mode: 'paper',
            reasons: [...d.reasons, 'no browser executor yet (E-06): nothing was done and nothing was spent'] }));
          return;
        }
        // In paper the real cost cannot be known without a simulation; we write off the gas estimate and the mint price as spend
        this.risk.spend(d.sizeUsd + (d.estGasUsd ?? 0));
        await this.notifier.send(decisionCard({ action: 'CONTRACT CALL', summary: d.intent.summary, source, sizeUsd: d.sizeUsd, chain: d.chain, mode: 'paper', reasons: d.reasons }));
        return;
      }
      case 'open_perp': {
        if (this.liveMode === 'live') this.liveJournalOnly('open_perp');
        const p = d.perp!;
        const token = `perp:${p.asset}`;
        const fee = p.notionalUsd * p.feePct / 100;
        assertWithinLimits(this.cfg, this.risk, d.trust.tier, p.marginUsd, fee, { token, opensPosition: true });
        const id = `perp:${p.asset}:${this.clock.now()}`;
        const pos: PerpPos = { kind: 'perp', id, asset: p.asset, side: p.side, entry: p.entry, notionalUsd: p.notionalUsd, leverage: p.leverage, marginUsd: p.marginUsd,
          stop: p.stop, takeProfit: p.takeProfit, feePct: p.feePct, openedAtMs: this.clock.now(), entryFeeUsd: fee };
        this.risk.openPosition({ id, chain: 'unknown', token, costUsd: p.marginUsd + fee, openedAtUtc: this.clock.iso() });
        this.perpOpen.set(id, pos);
        this.store.savePosition({ id, decisionId, chain: 'perp', token, costUsd: p.marginUsd + fee, qty: p.notionalUsd / p.entry, entryPrice: p.entry, openedUtc: this.clock.iso(), mode: 'paper', state: pos });
        await this.notifier.send(decisionCard({ action: `PERP ${p.side.toUpperCase()} ${p.asset} ${p.leverage}x`, summary: d.intent.summary, source, sizeUsd: p.marginUsd, chain: 'Hyperliquid (paper)', mode: 'paper',
          reasons: [...d.reasons.slice(-2), `entry ${p.entry}, stop ${p.stop.toPrecision(6)}, take ${p.takeProfit.toPrecision(6)}, notional $${p.notionalUsd}`] }));
        await this.draft({ kind: 'entry', asset: `${p.asset} ${p.side} ${p.leverage}x`, chain: 'perps', sizeUsd: p.marginUsd, note: d.publicNote, holding: true,
          plan: `stop ${p.stop.toPrecision(6)}, take profit ${p.takeProfit.toPrecision(6)}` }, m);
        return;
      }
      case 'nft_buy': {
        if (this.liveMode === 'live' && !this.nftLive) this.liveJournalOnly('nft_buy');
        const b = d.nftBuy!;
        const gas = (d.estGasUsd ?? 0) / 2;
        const token = `nft:${b.slug}`;
        assertWithinLimits(this.cfg, this.risk, d.trust.tier, d.sizeUsd, gas, { token, opensPosition: true });
        const ethUsd = this.ethUsd();
        let costEth = b.priceEth + gas / ethUsd; let holdings: import('../live/nftLive.js').NftHolding[] | undefined; let live = false;
        if (this.liveMode !== 'paper' && this.nftLive) {
          const r = await this.nftLive.buyFloor({ slug: b.slug, contract: b.contract, chain: d.chain, maxPriceEth: b.priceEth, maxUsd: d.sizeUsd }, this.liveMode === 'live' ? 'live' : 'shadow');
          if (this.liveMode === 'live') {
            if (r.pending) await this.notifier.send(`⚠️ NFT buy ${b.slug} was not confirmed in time: ${r.note}. Position not recorded — check the wallet.`);
            if (!r.ok) throw new Error(`live NFT buy failed: ${r.note}`);
            costEth = r.spentEth; holdings = r.holdings; live = true;
          }
          else await this.notifier.send(`🔬 LIVE check (no sending) NFT ${b.slug}: ${r.ok ? '✅' : '❌'} ${r.note}`);
        }
        const id = `${d.chain}:${token}:${this.clock.now()}`;
        const pos: NftPos = { kind: 'nft', id, slug: b.slug, asset: b.slug, chain: d.chain, costUsd: costEth * ethUsd, costEth, sellFeesPct: b.sellFeesPct, openedAtMs: this.clock.now(), plan: b.plan,
          qty: 1, holdings, contract: b.contract, live };
        this.risk.openPosition({ id, chain: d.chain, token, costUsd: pos.costUsd, openedAtUtc: this.clock.iso() });
        this.nftOpen.set(id, pos);
        this.store.savePosition({ id, decisionId, chain: d.chain, token, costUsd: pos.costUsd, qty: 1, entryPrice: b.priceEth, openedUtc: this.clock.iso(), mode: live ? 'live' : 'paper', state: pos });
        await this.notifier.send(decisionCard({ action: 'NFT BUY', summary: d.intent.summary, source, sizeUsd: pos.costUsd, chain: d.chain, mode: live ? 'live' : 'paper', reasons: d.reasons }));
        await this.draft({ kind: 'nft_buy', asset: `1 ${b.slug}`, chain: d.chain, sizeUsd: pos.costUsd, note: d.publicNote, holding: true, plan: b.plan.style === 'flip' ? 'quick flip' : `hold for ${b.plan.targetMultiple ?? 2}x` }, m);
        return;
      }
      case 'prediction_buy': {
        if (this.liveMode === 'live') this.liveJournalOnly('prediction_buy');
        const q = d.prediction!;
        const token = `pm:${q.slug}:${q.outcome.toLowerCase()}`;
        assertWithinLimits(this.cfg, this.risk, d.trust.tier, d.sizeUsd, 0, { token, opensPosition: true });
        const id = `${token}:${this.clock.now()}`;
        const pos: PredPos = { kind: 'pred', id, slug: q.slug, question: q.question, outcome: q.outcome, tokenId: q.tokenId, shares: q.shares, entry: q.price, feeRate: q.feeRate,
          costUsd: d.sizeUsd, openedAtMs: this.clock.now(), endUtc: q.endUtc, stopPrice: q.stopPrice, takeProfitPrice: q.takeProfitPrice, sellByMs: q.sellByUtc ? utcMs(q.sellByUtc) : undefined };
        this.risk.openPosition({ id, chain: 'polygon', token, costUsd: pos.costUsd, openedAtUtc: this.clock.iso() });
        this.predOpen.set(id, pos);
        this.store.savePosition({ id, decisionId, chain: 'polygon', token, costUsd: pos.costUsd, qty: q.shares, entryPrice: q.price, openedUtc: this.clock.iso(), mode: 'paper', state: pos });
        await this.notifier.send(decisionCard({ action: `PREDICTION "${q.outcome}"`, summary: q.question, source, sizeUsd: d.sizeUsd, chain: 'Polymarket (paper)', mode: 'paper',
          reasons: [...d.reasons.slice(-2), `${q.shares} shares at ${q.price}${q.takeProfitPrice ? `, take ${q.takeProfitPrice}` : ', hold to resolution'}${q.stopPrice ? `, stop ${q.stopPrice}` : ''}`] }));
        await this.draft({ kind: 'prediction', asset: q.question, chain: 'Polymarket', sizeUsd: d.sizeUsd, note: d.publicNote, holding: true,
          plan: `"${q.outcome}" at ${Math.round(q.price * 100)}¢${q.endUtc ? `, resolves ${q.endUtc.slice(0, 10)}` : ''}` }, m);
        return;
      }
      case 'scheduled':
        if (d.nft && this.nftLive && this.liveMode !== 'paper') {
          const live = this.liveMode === 'live';
          const note = await this.nftLive.schedule(d, live ? 'live' : 'shadow', live ? (o) => this.locked(() => this.openLiveNft(d, decisionId, o, m)) : undefined);
          await this.notifier.send(`🎯 ${live ? 'LIVE' : 'SHADOW'} minter ${d.nft.slug}: ${note}`);
        }
        await this.notifier.send(`⏰ PAPER scheduled: ${d.intent.summary} — ${d.reasons.at(-1) ?? ''}. The decision will be made again at the due time.`);
        return;
      case 'social_session':
        // The agent's X account (raffle, registration). A live executor via the browser is the next step; in paper — a card
        await this.notifier.send(decisionCard({ action: 'X TASK (agent account)', summary: d.intent.summary, source, sizeUsd: 0, chain: d.chain, mode: 'paper', reasons: [...d.reasons, ...d.intent.urls] }));
        return;
      case 'notify_human':
        await this.notifier.send(helpCard({ need: d.intent.needsHuman ?? 'social task', summary: d.intent.summary, source, urls: d.intent.urls, score: d.trust.score }));
        return;
      default:
        return; // journal_only / skip / scheduled — already in the journal
    }
  }

  /**
   * Close the whole token position (an Analyst alert). We do not close without a price — otherwise a 100% loss would go into the journal
   * and a stop could fire. Returns true if the position was closed.
   */
  private async exitTokenInner(token: string, reason: string, market: MarketClient): Promise<boolean> {
    let closedAny = false;
    if (token.startsWith('pm:')) {
      for (const [id, p] of this.predOpen) {
        if (!`pm:${p.slug}:${p.outcome.toLowerCase()}`.startsWith(token.toLowerCase())) continue;
        const m = await this.pm?.market(p.slug).catch(() => undefined);
        const bid = m?.outcomes.find(o => o.tokenId === p.tokenId)?.bid;
        if (!bid) { await this.notifier.send(`⚠️ Exit from the bet «${p.question.slice(0, 60)}» postponed: no buyer in the order book`); continue; }
        await this.closePred(id, p, bid, reason); closedAny = true;
      }
      return closedAny;
    }
    if (token.startsWith('perp:')) {
      for (const [id, p] of this.perpOpen) {
        if (`perp:${p.asset}` !== token) continue;
        const px = await this.perp?.price(p.asset).catch(() => undefined);
        if (!px) { await this.notifier.send(`⚠️ Exit from ${p.asset} postponed: no price, will retry at the next check`); continue; }
        await this.closePerp(id, p, px, reason); closedAny = true;
      }
      return closedAny;
    }
    if (token.startsWith('nft:')) {
      for (const [id, p] of this.nftOpen) {
        if (`nft:${p.slug}` !== token) continue;
        const info = this.opensea ? await this.opensea.nft(p.slug).catch(() => undefined) : undefined;
        if (!info?.floorEth) { await this.notifier.send(`⚠️ Exit from ${p.slug} postponed: no floor from OpenSea, will retry at the next check`); continue; }
        await this.closeNft(id, p, info.floorEth, reason);
        closedAny = true;
      }
      return closedAny;
    }
    for (const [id, p] of this.open) {
      if (p.token.toLowerCase() !== token.toLowerCase()) continue;
      const price = (await market.market(p.token).catch(() => undefined))?.priceUsd;
      if (!price) { await this.notifier.send(`⚠️ Exit from ${p.token.slice(0, 6)}… postponed: no price, will retry at the next check`); continue; }
      const exitGas = estimateGasUsd(p.chain as Chain, this.ethUsd(), undefined, this.clock.now());
      let proceeds = Math.max(0, p.qtyLeft * price * (1 - PAPER_SLIPPAGE) - exitGas);
      if (this.liveMode === 'live') {
        if (this.sellInFlight(id) || (p.exitingUntilMs && p.exitingUntilMs > this.clock.now())) continue;
        const r = await this.trader!.sellToken({ chain: p.chain as Chain, token: p.token, share: 1, amountRaw: p.live?.raw ? BigInt(p.live.raw) : undefined, pairAddress: p.pairAddress, dexId: p.dexId }, 'live');
        if (r.pending && r.tx) { this.watchPendingSell(id, p, { tx: r.tx, qty: p.qtyLeft, proceeds: r.proceedsUsd || proceeds, soldRaw: r.soldRaw, reason, price, nonce: r.nonce, from: r.from }); continue; }
        if (!r.ok) { await this.sellFailed(id, `⚠️ LIVE exit from ${p.symbol ?? p.token.slice(0, 8)} did not go through: ${r.note}. Will retry.`, r.note); continue; }
        this.sellFailNotes.delete(id);
        proceeds = r.proceedsUsd;
      }
      p.qtyLeft = 0;
      this.store.updatePosition(id, 0, proceeds, p, this.clock.iso(), reason);
      // N1 (S-07 acceptance): partial sales have already recorded the result and reduced the cost basis (realizePartial) — the close counts only the remainder
      this.risk.closePosition(id, proceeds, 0);
      this.open.delete(id); this.returned.delete(id);
      closedAny = true;
      await this.notifier.send(`📝 PAPER EXIT ${p.token.slice(0, 6)}… ${reason}, received $${proceeds.toFixed(2)}`);
    }
    return closedAny;
  }

  private perpPnl(p: PerpPos, px: number) { return p.notionalUsd * (px / p.entry - 1) * (p.side === 'long' ? 1 : -1); }

  private async closePerp(id: string, p: PerpPos, px: number, reason: string) {
    const exitFee = p.notionalUsd * (px / p.entry) * p.feePct / 100;
    const pnl = this.perpPnl(p, px);
    const proceeds = Math.max(0, p.marginUsd + pnl - exitFee);
    this.store.updatePosition(id, 0, proceeds, p, this.clock.iso(), reason);
    this.risk.closePosition(id, proceeds, 0);
    this.perpOpen.delete(id);
    const net = proceeds - p.marginUsd - p.entryFeeUsd;
    await this.notifier.send(`📝 PAPER PERP CLOSE ${p.asset} ${p.side}: ${reason}, price ${px}, result ${net >= 0 ? '+' : '−'}$${Math.abs(net).toFixed(2)}`);
    await this.publish({ kind: 'exit', asset: `${p.asset} ${p.side}`, chain: 'perps', pnlUsd: net, holding: false, entryPrice: p.entry, exitPrice: px, sizeUsd: p.marginUsd + p.entryFeeUsd, sizeOutUsd: proceeds,
      pnlPct: (net / (p.marginUsd + p.entryFeeUsd)) * 100, holdMinutes: (this.clock.now() - p.openedAtMs) / 60_000, reason, points: [p.entry, px] });
  }

  /** Perps: stop and take-profit are checked at the Hyperliquid price every minute; without a price — a conservative estimate, no close. */
  /** Bets: resolution → a $1 payout per share of the winning outcome; before resolution — stop, target, deadline at the best buy price (bid). */
  async monitorPredictions(): Promise<number> {
    let unrealized = 0;
    for (const [id, p] of this.predOpen) {
      const m = await this.pm?.market(p.slug).catch(() => undefined);
      if (!m) { unrealized -= p.costUsd * 0.5; continue; }
      if (m.closed && m.winner) { await this.closePred(id, p, m.winner === p.outcome ? 1 : 0, `resolved: "${m.winner}"`, true); continue; }
      const bid = m.outcomes.find(o => o.tokenId === p.tokenId)?.bid;
      if (bid === undefined) { unrealized -= p.costUsd * 0.5; continue; }
      const now = this.clock.now();
      if (p.stopPrice !== undefined && bid <= p.stopPrice) { await this.closePred(id, p, bid, `stop ${p.stopPrice}`); continue; }
      if (p.takeProfitPrice !== undefined && bid >= p.takeProfitPrice) { await this.closePred(id, p, bid, `take-profit ${p.takeProfitPrice}`); continue; }
      if (p.sellByMs !== undefined && now >= p.sellByMs) { await this.closePred(id, p, bid, 'sell-by time reached'); continue; }
      unrealized += p.shares * bid - pmFee(p.shares, bid, p.feeRate) - p.costUsd;
    }
    return unrealized;
  }
  private async closePred(id: string, p: PredPos, price: number, reason: string, resolved = false) {
    // Resolution: a payout without a fee; a sale into the book — the taker fee
    const proceeds = Math.max(0, p.shares * price - (resolved ? 0 : pmFee(p.shares, price, p.feeRate)));
    this.store.updatePosition(id, 0, proceeds, p, this.clock.iso(), reason);
    this.risk.closePosition(id, proceeds, 0);
    this.predOpen.delete(id);
    const net = proceeds - p.costUsd;
    await this.notifier.send(`📝 PAPER PREDICTION CLOSE «${p.question.slice(0, 80)}» — "${p.outcome}": ${reason}, received $${proceeds.toFixed(2)}, net ${net >= 0 ? '+' : '−'}$${Math.abs(net).toFixed(2)}`);
    await this.publish({ kind: 'prediction_exit', asset: p.question, chain: 'Polymarket', pnlUsd: net, pnlPct: (net / p.costUsd) * 100, holding: false, plan: `"${p.outcome}" ${resolved ? reason : `sold at ${Math.round(price * 100)}¢`}` });
  }
  async monitorPerps(): Promise<number> {
    let unrealized = 0;
    for (const [id, p] of this.perpOpen) {
      const px = await this.perp?.price(p.asset).catch(() => undefined);
      if (!px) { unrealized -= p.marginUsd * 0.5; continue; }
      const long = p.side === 'long';
      const hitStop = long ? px <= p.stop : px >= p.stop;
      const hitTp = long ? px >= p.takeProfit : px <= p.takeProfit;
      if (hitStop || hitTp) { await this.closePerp(id, p, hitStop ? px : p.takeProfit, hitStop ? `stop-loss ${p.stop.toPrecision(6)}` : `take-profit ${p.takeProfit.toPrecision(6)}`); continue; }
      unrealized += this.perpPnl(p, px) - p.entryFeeUsd;
    }
    return unrealized;
  }

  /** A memecoin position: paper — at the DexScreener price, live — as per the receipt (including a "late" one). */
  private async openTokenPosition(d: Decision, decisionId: number, m: RawMessage, f: { qty: number; entry: number; cost: number; tx?: string; raw?: bigint; decimals?: number }) {
    const pos = this.recordTokenPosition(d, decisionId, f);
    await this.announceTokenPosition(d, m, pos, f);
  }
  /** Recording the position in the ledger: risk, memory, journal — synchronously, without the network (nobody can wedge in between the "already recorded" check and the write). */
  private recordTokenPosition(d: Decision, decisionId: number, f: { qty: number; entry: number; cost: number; tx?: string; raw?: bigint; decimals?: number }): OpenPos {
    const { qty, entry, cost } = f; const liveTx = f.tx;
    const id = `${d.chain}:${d.intent.tokenAddress}:${this.clock.now()}`;
    const pos: OpenPos = {
      id, token: d.intent.tokenAddress!, chain: d.chain, entryPrice: entry, qty, qtyLeft: qty, costUsd: cost,
      peakPrice: entry, tp1Done: false, openedAtMs: this.clock.now(),
      // V2: the floor — from the ACTUAL entry price, like the ladder, checks and breakeven (#126): in the plan it is computed from the decision price, and with
      // 8 % slippage "−50 %" turned out to be ≈ −54 % from entry. The fix does not touch the previous exit scheme
      stopPrice: stopFromEntry(d.exitPlan!, entry), tp1Price: d.exitPlan!.tp1Price, tp1Share: d.exitPlan!.tp1Share,
      trailingPct: d.exitPlan!.trailingPct, timeStopAtMs: Date.parse(d.exitPlan!.timeStopAtUtc),
      timeStopMinGainPct: d.exitPlan!.timeStopMinGainPct ?? this.cfg.memecoinExit.timeStopMinGainPct, hardTimeStop: d.exitPlan!.hardTimeStop,
      // S-07: class, breakeven, moonbag. The tail limit is checked once more at execution (the decision may have waited in the queue) — M2
      ...moonbagFields(this.risk.tailCount() < (classesFrom(this.cfg)?.maxOpenMoonbags ?? 0) ? d.exitPlan! : { ...d.exitPlan!, moonbagShare: 0 }, qty, entry, this.clock.now()),
      symbol: d.intent.ticker ?? d.check?.symbol, pairAddress: d.check?.pairAddress, dexId: d.check?.dexId, live: f.raw !== undefined ? { tx: liveTx, raw: f.raw.toString(), decimals: f.decimals } : undefined,
    };
    this.risk.openPosition({ id, chain: d.chain, token: pos.token, costUsd: cost, openedAtUtc: this.clock.iso(), ...((pos.moonbagQty ?? 0) > 0 ? { hasMoonbag: true } : {}) });
    this.open.set(id, pos);
    this.store.savePosition({ id, decisionId, chain: d.chain, token: pos.token, costUsd: cost, qty, entryPrice: entry, openedUtc: this.clock.iso(), mode: this.liveMode === 'live' ? 'live' : 'paper', state: pos });
    return pos;
  }
  /** A Telegram card and a post draft about the recorded position (they have nothing to do with the ledger). */
  private async announceTokenPosition(d: Decision, m: RawMessage, pos: OpenPos, f: { entry: number; tx?: string }) {
    const source = `${m.sourceServer} / #${m.channel} / ${m.author}`;
    await this.notifier.send(decisionCard({ action: 'BUY', summary: d.intent.summary, source, sizeUsd: d.sizeUsd, chain: d.chain, mode: this.liveMode === 'live' ? 'live' : 'paper', reasons: f.tx ? [...d.reasons, `tx ${f.tx}`] : d.reasons }));
    await this.draft({ kind: 'entry', asset: pos.symbol ? `$${pos.symbol.replace(/^\$/, '')}` : `${pos.token.slice(0, 6)}…`, chain: d.chain, ca: pos.token, sizeUsd: d.sizeUsd, note: d.publicNote, holding: true, entryPrice: f.entry,
      plan: `stop −${d.exitPlan!.stopPct ?? this.cfg.memecoinExit.stopLossPct}%, ${Math.round(d.exitPlan!.tp1Share * 100)}% off at ${(d.exitPlan!.tpX ?? this.cfg.memecoinExit.takeProfit1x).toFixed(2)}x${d.exitPlan!.hardTimeStop ? deadlineForPost(d.exitPlan!.timeStopAtUtc, this.clock.now(), (pos.moonbagQty ?? 0) > 0) : ''}` }, m);
  }

  /** A position after a live mint: the actual quantity, wallets and costs. */
  private async openLiveNft(d: Decision, decisionId: number, o: import('../live/nftLive.js').LiveMintOutcome, m: RawMessage) {
    if (!o.minted) {
      // Gas of reverted mints is a real spend: counted in capital and the daily result
      if (o.spentEth > 0) this.risk.spend(o.spentEth * this.ethUsd());
      await this.notifier.send(`🎯 ${d.nft!.slug}: nothing was minted — no position (gas spent: ${o.spentEth.toFixed(5)} ETH)`);
      return;
    }
    const ethUsd = this.ethUsd();
    const token = `nft:${d.nft!.slug}`;
    const id = `${d.chain}:${token}:${this.clock.now()}`;
    const pos: NftPos = { kind: 'nft', id, slug: d.nft!.slug, asset: d.nft!.slug, chain: d.chain, costUsd: o.spentEth * ethUsd, costEth: o.spentEth, sellFeesPct: d.nft!.sellFeesPct,
      openedAtMs: this.clock.now(), plan: d.nft!.plan, publicEndMs: d.nft!.publicEndUtc ? utcMs(d.nft!.publicEndUtc) : undefined, qty: o.minted, holdings: o.holdings, contract: d.nft!.contract, live: true };
    this.risk.openPosition({ id, chain: d.chain, token, costUsd: pos.costUsd, openedAtUtc: this.clock.iso() });
    this.nftOpen.set(id, pos);
    this.store.savePosition({ id, decisionId, chain: d.chain, token, costUsd: pos.costUsd, qty: o.minted, entryPrice: d.nft!.priceEth, openedUtc: this.clock.iso(), mode: 'live', state: pos });
    await this.draft({ kind: 'nft_mint', asset: `${o.minted}× ${d.nft!.slug}`, chain: d.chain, sizeUsd: pos.costUsd, note: d.publicNote, holding: true,
      plan: d.nft!.plan.style === 'flip' ? 'sell into best offers' : `hold for ${d.nft!.plan.targetMultiple ?? 2}x` }, m);
  }

  private async closeNft(id: string, p: NftPos, floorEth: number, reason: string) {
    const sellGasEth = (this.ethGasGwei() ?? 1) * 1e-9 * NFT_SELL_GAS;
    const q = p.qty ?? 1;
    let proceeds = Math.max(0, (floorEth * (1 - p.sellFeesPct / 100) - sellGasEth) * q * this.ethUsd());
    if (p.live && this.liveMode === 'live' && this.nftLive && p.holdings && p.contract) {
      // No lower than: 85% of floor for a take-profit, 50% of floor for a stop/deadline (protection against a "dust" offer)
      const minPriceEth = floorEth * (/stop|sell-by/.test(reason) ? 0.5 : 0.85);
      const r = await this.nftLive.sellAll({ slug: p.slug, contract: p.contract, chain: p.chain, holdings: p.holdings, minPriceEth }, 'live');
      if (!r.ok) { await this.notifier.send(`⚠️ LIVE sale ${p.slug} did not go through (${reason}): ${r.note}. Will retry.`); return; }
      proceeds = r.proceedsEth * (1 - p.sellFeesPct / 100) * this.ethUsd();
      const soldIds = new Set(r.sold.flatMap(h => h.tokenIds.map(t => `${h.wallet.toLowerCase()}:${t}`)));
      const left = p.holdings.map(h => ({ wallet: h.wallet, tokenIds: h.tokenIds.filter(t => !soldIds.has(`${h.wallet.toLowerCase()}:${t}`)) })).filter(h => h.tokenIds.length);
      const leftCount = left.reduce((a, h) => a + h.tokenIds.length, 0);
      if (leftCount > 0) {
        // A partial sale: we close only what was sold, the rest stays a position
        p.holdings = left; p.qty = leftCount;
        this.risk.partialReturn(proceeds);
        this.store.updatePosition(id, leftCount, proceeds, p, undefined, `${reason} (partial: ${soldIds.size} sold)`);
        await this.notifier.send(`📝 LIVE NFT ${p.slug}: sold ${soldIds.size}, left ${leftCount} — ${r.note}`);
        return;
      }
    }
    this.store.updatePosition(id, 0, proceeds, p, this.clock.iso(), reason);
    this.risk.closePosition(id, proceeds, 0);
    this.nftOpen.delete(id);
    await this.notifier.send(`📝 PAPER NFT SELL ${p.slug}: ${reason}, received $${proceeds.toFixed(2)} (cost $${p.costUsd.toFixed(2)})`);
    await this.publish({ kind: 'exit', asset: p.asset, chain: p.chain, pnlUsd: proceeds - p.costUsd, pnlPct: ((proceeds - p.costUsd) / p.costUsd) * 100, holding: false,
      sizeUsd: p.costUsd, sizeOutUsd: proceeds, holdMinutes: (this.clock.now() - p.openedAtMs) / 60_000, reason });
  }

  /** NFT: valued at the floor, exit per plan (flip / hold / deadline / floor stop). */
  async monitorNft(): Promise<number> {
    let unrealized = 0;
    for (const [id, p] of this.nftOpen) {
      const info = this.opensea ? await this.opensea.nft(p.slug).catch(() => undefined) : undefined;
      const ethUsd = this.ethUsd();
      const sellGasEth = (this.ethGasGwei() ?? 1) * 1e-9 * NFT_SELL_GAS;
      const floor = info?.floorEth;
      const netEth = floor ? (floor * (1 - p.sellFeesPct / 100) - sellGasEth) * (p.qty ?? 1) : 0;
      const now = this.clock.now();
      const sellBy = p.plan.sellByUtc && Number.isFinite(utcMs(p.plan.sellByUtc)) ? utcMs(p.plan.sellByUtc) : (p.publicEndMs ? p.publicEndMs - 3600_000 : p.openedAtMs + 72 * 3600_000);
      let reason: string | undefined;
      if (floor && p.plan.style === 'flip' && ((info?.recentSales?.n ?? 0) > 0 || info?.bestOfferEth)) reason = `flip at floor ${floor} ETH`;
      else if (floor && netEth >= p.costEth * (p.plan.targetMultiple ?? 2)) reason = `target ${p.plan.targetMultiple ?? 2}x reached (floor ${floor} ETH)`;
      else if (now >= sellBy) reason = `sell-by time ${new Date(sellBy).toISOString()}`;
      else if (floor && now - p.openedAtMs >= 6 * 3600_000 && netEth <= p.costEth * (p.plan.stopFloorMultiple ?? 0.7)) reason = `floor stop (floor ${floor} ETH)`;
      // No floor (OpenSea unavailable or no listings yet): we don't sell "for zero", we value conservatively and wait
      if (!reason || !floor) { unrealized += (floor ? Math.max(0, netEth) * ethUsd : 0) - p.costUsd; continue; }
      await this.closeNft(id, p, floor, reason);
    }
    return unrealized;
  }

  /** Checking open positions at current prices: stop, take-profit, trailing, time + a market valuation for the risk stops. */
  /** Apply a sale to a position (partial or full): cash, journal, notification, post. Returns the unrealized amount on the remainder. */
  /** settled — the outcome of a sale "in flight": called right after the ledger write; a notification failure after it goes to the log, not to an exception. */
  private async applyTokenSell(id: string, p: OpenPos, qty: number, proceeds: number, reason: string, price: number, settled?: () => void): Promise<number> {
    this.dropUnrealized(id, p.qtyLeft > 0 ? Math.min(1, qty / p.qtyLeft) : 1); // before recording the result: the loss is not counted twice (O1)
    p.qtyLeft = Math.max(0, p.qtyLeft - qty);
    const closed = p.qtyLeft <= p.qty * 1e-9;
    this.store.updatePosition(id, p.qtyLeft, proceeds, p, closed ? this.clock.iso() : undefined, reason);
    const returnedBefore = this.returned.get(id) ?? 0;
    let unreal = 0;
    // S-07 (M1): the result of every partial sale is recorded immediately — into the daily result, capital and stops;
    // the cost basis of the sold part — proportional to the quantity. The close accounts for the remainder only.
    const costPart = p.costUsd * (qty / p.qty);
    if (closed) {
      this.risk.closePosition(id, proceeds, 0);
      this.open.delete(id);
      this.returned.delete(id);
      this.unrealBy.delete(id);
    } else {
      this.risk.realizePartial(id, proceeds, costPart);
      this.returned.set(id, returnedBefore + proceeds);
      if (p.moonbagQty && p.qtyLeft <= p.moonbagQty * (1 + 1e-9)) this.risk.markMoonbagOnly(id); // S-07: only the moonbag is left — the slot is freed
      unreal = p.qtyLeft * price * (1 - PAPER_SLIPPAGE) - p.costUsd * (p.qtyLeft / p.qty);
    }
    const label = p.symbol ? `$${p.symbol.replace(/^\$/, '')}` : `${p.token.slice(0, 6)}…`;
    const announce = async () => {
      await this.notifier.send(`📝 ${this.liveMode === 'live' ? 'LIVE' : 'PAPER'} SELL ${label} ${reason}, received $${proceeds.toFixed(2)}${closed ? ` (position closed, net ${returnedBefore + proceeds - p.costUsd >= 0 ? '+' : '−'}$${Math.abs(returnedBefore + proceeds - p.costUsd).toFixed(2)})` : ''}`);
      if (closed) {
        const pnl = returnedBefore + proceeds - p.costUsd;
        const pts = p.points?.length ? [...p.points] : [p.entryPrice, p.peakPrice];
        if (pts[pts.length - 1] !== price) pts.push(price);
        await this.publish({ kind: 'exit', asset: label, chain: p.chain, ca: p.token, pnlUsd: pnl, pnlPct: (pnl / p.costUsd) * 100, holding: false, entryPrice: p.entryPrice, exitPrice: price,
          sizeUsd: p.costUsd, sizeOutUsd: returnedBefore + proceeds,
          holdMinutes: (this.clock.now() - p.openedAtMs) / 60_000, reason: reason.replace(/ at [\d.e-]+$/, ''), points: pts });
      }
    };
    if (settled) { settled(); await announce().catch(e => console.error(`[live] sell of ${id} is recorded, but the notification failed: ${String(e).slice(0, 160)}`)); }
    else await announce();
    return unreal;
  }

  /**
   * The sale was sent but not confirmed: the position is "in flight" (the monitor does not touch it), the outcome is checked by hash until the wait limit.
   * Landed — we apply the sale once (finishSell); reverted/dropped — we remove the mark, the monitor will sell again; time is up —
   * we tell the owner, the record stays: the sender's background will resolve the outcome and deliver it via the late-outcome subscription.
   */
  private watchPendingSell(id: string, p: OpenPos, x: { tx: string; qty: number; proceeds: number; soldRaw?: bigint; reason: string; price: number; after?: Partial<OpenPos>; nonce?: number; from?: string; sentUtc?: string }) {
    const h = x.tx.toLowerCase(), n = PaperExecutor.settleSlices(p.chain), wait = PaperExecutor.waitText(p.chain);
    p.exitingUntilMs = this.clock.now() + 15 * 60_000;
    this.pendingSells.set(h, { id, p, x });
    this.persistSell(id, p, x); // #135 F3: the hold survives a restart
    void this.say(`⏳ LIVE sale ${p.symbol ?? p.token.slice(0, 8)} sent (${x.tx}), waiting for confirmation — not touching the position for up to 15 min.`);
    // A receipt may come even after 10 min: while the trader answers "unknown", we wait until the deadline, extending the position freeze
    const settleLong = async () => {
      for (let i = 0; ; i++) {
        // The outcome was already applied by the late-outcome subscription (the sender's deadline passed before our polls): we don't extend the freeze
        if (!this.pendingSells.has(h)) return 'unknown' as const;
        // The freeze — BEFORE the poll and with a margin: settleTx lasts 10 min + node resolution (up to several minutes on timeouts)
        p.exitingUntilMs = this.clock.now() + 15 * 60_000;
        const st = await this.trader!.settleTx(p.chain as Chain, x.tx, { last: i >= n - 1 });
        if (st !== 'unknown' || i >= n - 1) return st;
        if (i === 0) await this.say(`⏳ Sale ${x.tx} without a receipt for 10 min — watching for up to ${wait}, not touching the position`);
      }
    };
    void settleLong().then(st => this.locked(async () => {
      // The outcome was already applied by the late-outcome subscription: we don't count it twice and don't touch the freeze
      if (!this.pendingSells.has(h)) return;
      if (st === 'unknown') {
        // The wait limit passed. I don't touch the position for an hour; after that a repeat is held back by the sender's address block (an unresolved transaction)
        p.exitingUntilMs = this.clock.now() + 60 * 60_000;
        if (p.chain === 'solana') {
          // Solana: there is no background watcher or late channel — the outcome will not come by itself; the record is removed, in an hour the monitor will sell again
          this.pendingSells.delete(h);
          this.unpersistSell(id, p, x.tx, true); // the database record — as in memory (the previous Solana rule)
          await this.say(`⚠️ Sale ${x.tx} was neither confirmed nor rejected within ${wait} — check the wallet manually; I will not touch the position for an hour, then the monitor will sell again`);
          return;
        }
        // EVM: the record stays for the late outcome — the sender's background will resolve it and deliver it via the subscription
        const kept = this.pendingSells.get(h); if (kept) kept.givenUp = true;
        await this.say(`⚠️ Sale ${x.tx} was neither confirmed nor rejected within ${wait} — check the wallet; not touching the position until the outcome (not selling again); when the outcome is known, I will count it myself`);
        return;
      }
      await this.finishSell(x.tx, st, 'confirmed late');
    })).catch(e => { console.error(`[live] pending sell ${x.tx}: ${String((e as Error)?.stack ?? e).slice(0, 300)}`); const kept = this.pendingSells.get(h); if (kept) kept.givenUp = true; p.exitingUntilMs = this.clock.now() + 60 * 60_000; void this.say(`⚠️ Sale ${x.tx}: failure while handling the outcome (${String(e).slice(0, 120)}) — check the wallet; I will not touch the position for an hour`); });
  }

  /** #135 F3: since when a hold of a sale with an unknown outcome or a ghost block has been pending, and when the last reminder was. */
  private holdSinceMs: number | undefined;
  private lastHoldReminderMs = 0;
  /**
   * Once an hour, while a hold (a sale with an unknown outcome) or a ghost block on the treasury address is pending — a reminder to the owner: stops on this
   * position / on this chain's positions do not work. The first one — an hour after it appeared (a message of its own already went out when it appeared).
   */
  private async holdReminder() {
    if (this.liveMode !== 'live') return;
    const list = this.holds();
    const now = this.clock.now();
    if (!list.length) { this.holdSinceMs = undefined; return; }
    if (this.holdSinceMs === undefined) { this.holdSinceMs = now; this.lastHoldReminderMs = now; return; }
    if (now - this.lastHoldReminderMs < 3600_000) return;
    this.lastHoldReminderMs = now;
    await this.say(`⏰ Reminder (hourly, ${new Date(now).toISOString().slice(11, 16)} UTC): ${list.map(x => x.text).join('; ')}. `
      + 'Check the wallet; after checking, for each: /release <tx> sold or /release <tx> not-sold.');
  }

  /**
   * #135 G1: pending holds — sales with an unknown outcome (the caller stopped waiting or they were restored after a restart) and ghost
   * blocks on the treasury address without a sale in the ledger. For /status, the reminder and /release.
   */
  holds(): { tx: string; chain: string; kind: 'sell' | 'ghost'; text: string }[] {
    const out: { tx: string; chain: string; kind: 'sell' | 'ghost'; text: string }[] = [];
    for (const o of this.pendingSells.values()) if (o.givenUp || o.restored)
      out.push({ tx: o.x.tx, chain: o.p.chain, kind: 'sell', text: `sale ${o.p.symbol ?? o.p.token.slice(0, 8)} (${o.p.chain}) tx ${o.x.tx} — outcome unknown, stops on this position do not work` });
    for (const g of this.trader?.ghostBlocks?.() ?? []) if (!out.some(x => x.tx.toLowerCase() === g.hash.toLowerCase()))
      out.push({ tx: g.hash, chain: g.chain, kind: 'ghost', text: `ghost block on ${g.chain} (tx ${g.hash}) — stops on this chain's positions do not work` });
    return out;
  }

  /**
   * #135 G1: the owner's command after checking the wallet — lift the hold by hash. sold — the sale went through: count it ONCE from the saved
   * record (quantity and proceeds estimate — as of sending, marked "on the owner's command"); not-sold — it did not: lift the hold and the address
   * block, the position is under the monitor again. Both — the database record is removed. Only for pending holds and ghost blocks; otherwise a refusal.
   */
  release(txArg: string, verdict: 'sold' | 'not-sold'): Promise<string> {
    return this.locked(async () => {
      const h = txArg.trim().toLowerCase();
      const list = this.holds();
      const hit = list.find(x => x.tx.toLowerCase() === h);
      const hint = list.length ? `Pending: ${list.map(x => x.tx).join(', ')}.` : 'No pending holds or blocks.';
      if (!hit) {
        const busy = this.pendingSells.get(h);
        if (busy) return `Sale ${busy.x.tx} is still waiting for an outcome (up to ${PaperExecutor.waitText(busy.p.chain)} from sending) — /release is only for holds with an unknown outcome. ${hint}`;
        return `No hold or block found with hash ${txArg.trim().slice(0, 100)}. ${hint} Format: /release <tx> sold | not-sold.`;
      }
      const ack = () => this.trader?.clearGhost(hit.chain as Chain, hit.tx);
      if (hit.kind === 'ghost') {
        if (verdict === 'sold') return `For ${hit.tx} there is no sale in the ledger — nothing to count. To lift the address block: /release ${hit.tx} not-sold.`;
        ack();
        console.warn(`[live] ghost block ${hit.tx} (${hit.chain}) released by the owner (/release not-sold)`);
        return `✅ Address block for ${hit.tx} (${hit.chain}) lifted on the owner's command. The ledger did not change. Reconcile cash: /reconcile.`;
      }
      const o = this.pendingSells.get(h)!;
      const name = o.p.symbol ?? o.p.token.slice(0, 8);
      if (verdict === 'sold') {
        const done = await this.finishSell(o.x.tx, 'ok', "on the owner's command (/release sold)", ack);
        if (done === 'applied') return `✅ Sale ${name} tx ${o.x.tx} counted on the owner's command: ${o.x.qty} units, proceeds estimated as of sending $${o.x.proceeds.toFixed(2)}. Hold and block lifted. Reconcile cash: /reconcile.`;
        ack(); // the owner checked the wallet: the address block for this transaction is lifted here too
        return `Position ${name} was already closed otherwise — not counting sale ${o.x.tx}; hold and block lifted. Reconcile cash: /reconcile.`;
      }
      // #135 R1 (1): while the transaction is still on the network (the sender holds it "in flight" or a node knows it without a block) — do not release:
      // it may land in a block, and the monitor would sell the same rung a second time
      const live = await this.trader?.stillInNetwork?.(hit.chain as Chain, o.x.tx).catch(() => 'unknown' as const);
      if (live === 'yes') return `Transaction ${o.x.tx} is still on the network (a node holds it without a block) — wait for the outcome; it cannot be released as "did not go through" now.`;
      if (live === 'unknown') return `Could not check whether ${o.x.tx} is still on the network (the node did not answer) — repeat /release later.`;
      this.pendingSells.delete(h);
      if (!this.sellInFlight(o.id)) o.p.exitingUntilMs = undefined;
      this.unpersistSell(o.id, o.p, o.x.tx, false);
      // #135 R1 (2): remember the released sale for 24 h (memory and database): if it does land in a block — counted once, not a ghost without a pair
      this.rememberReleased(o.id, o.p, o.x);
      ack();
      console.warn(`[live] held sell ${o.x.tx} released by the owner (/release not-sold)`);
      return `✅ Hold on sale ${name} tx ${o.x.tx} lifted on the owner's command (did not go through): the position is under the monitor again, the address block is lifted. If the transaction does land in a block within the next 24 h — I will count it once and tell you.`;
    });
  }

  // ── A position without a price (#126 item 3; the owner's decision 2026-11-17: "do it the way you see fit, for maximum safety of the assets") ──
  // Without a price neither the floor, nor behaviour checks, nor deadlines work: the position is "blind". The rule — get the money back first, write off last:
  //  1) the countdown runs only while the price source is alive: the chain's reference token (the wrapped native coin) returns a price. If it does not either —
  //     that is a data failure, not a dead token: the countdown resets, nothing is sold or written off;
  //  2) exitHours (example — 8 h) without a price → in live a market exit of the whole position via the ordinary sale path (route, signature filter, simulation,
  //     min-out) — it does not need the token price. Retries no more often than retryMinutes;
  //  3) writeOffHours without a price and the sale failed (in paper — there is nothing to sell with) → the position is written off in the ledger at zero. This is a record
  //     of the loss, not an action: in live the tokens stay on the treasury wallet, there is no public "Closed" post, the owner gets the address and quantity.
  // The rule's numbers — the noPrice block in server/config/risk.json (approved by the owner 2026-11-17 16:34 UTC; changed only with their "yes"):
  // exitHours — after how long without a price we exit the position at market (live); writeOffHours — after how long without a price and without a successful sale
  // we write it off in the ledger; retryMinutes — the pause between sale attempts. No block or an invalid one — the approved defaults.
  private get noPriceMs() { return noPriceRules(this.cfg); }
  /** The chain's reference token for the "price source alive" check — the wrapped native coin (checked on live DexScreener 2026-11-17). */
  static readonly PRICE_REF: Partial<Record<string, string>> = {
    solana: 'So11111111111111111111111111111111111111112', base: '0x4200000000000000000000000000000000000006',
    ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', robinhood: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  };
  private noPrice = new Map<string, { sinceMs: number; lastTryMs: number; told?: boolean }>();
  /**
   * The valuation of each token position from the monitor's last pass (its contribution to the unrealized result). Acceptance #142, O1: RiskState
   * checks the hard stop at the moment the sale or write-off result is recorded, while the unrealized loss of that same position is still there
   * from the previous pass — for an instant the loss was counted twice, and the hard stop (only the owner lifts it) fired falsely. So before recording
   * the result, the negative valuation of the sold part is removed from the unrealized amount. A positive one is left alone: deducting it before recording
   * the profit would itself give a false stop. The monitor's next pass sets the exact number.
   */
  private unrealBy = new Map<string, number>();
  private dropUnrealized(id: string, share = 1) {
    const u = this.unrealBy.get(id);
    if (!(u !== undefined && u < 0)) return;
    const part = u * Math.min(1, Math.max(0, share));
    this.unrealBy.set(id, u - part);
    this.risk.setUnrealized(this.risk.unrealizedUsd - part);
  }
  private priceSource = new Map<string, { ok: boolean; atMs: number }>();
  /** Does the price source answer for the chain's reference token? The answer is cached for a minute. Chains without a reference token — "don't know" = no. */
  private async priceSourceAlive(chain: string, market: MarketClient): Promise<boolean> {
    const hit = this.priceSource.get(chain); const now = this.clock.now();
    if (hit && now - hit.atMs < 60_000) return hit.ok;
    const ref = PaperExecutor.PRICE_REF[chain];
    const ok = ref ? !!((await market.market(ref).catch(() => undefined))?.priceUsd) : false;
    this.priceSource.set(chain, { ok, atMs: now });
    return ok;
  }
  private async handleNoPrice(id: string, p: OpenPos, market: MarketClient) {
    const now = this.clock.now();
    if (this.sellInFlight(id) || (p.exitingUntilMs && p.exitingUntilMs > now)) return; // a sale is already in flight — its outcome will settle everything
    if (!(await this.priceSourceAlive(p.chain, market))) { this.noPrice.delete(id); return; } // a data failure: the countdown restarts, no actions
    let st = this.noPrice.get(id);
    if (!st) { st = { sinceMs: now, lastTryMs: 0 }; this.noPrice.set(id, st); return; }
    const blind = now - st.sinceMs;
    const rule = this.noPriceMs;
    if (blind < rule.exitMs) return;
    const label = p.symbol ? `$${p.symbol.replace(/^\$/, '')}` : `${p.token.slice(0, 8)}…`;
    const hours = (ms: number) => Math.round(ms / 3600_000);
    const live = this.liveMode === 'live' && !!p.live;
    if (!st.told) {
      st.told = true;
      await this.say(`⚠️ ${label} (${p.chain}, ${p.token}): no price for ${hours(blind)} h while the price source works — the position's stop and deadlines do not act blind. ${live
        ? 'Exiting the position at market.' : `Nothing to sell with on paper; after ${hours(rule.writeOffMs - blind)} h without a price I will write it off at zero.`}`);
    }
    if (live && now - st.lastTryMs >= rule.retryMs) {
      st.lastTryMs = now;
      const reason = `no price for ${hours(blind)}h — exit at market`;
      const r = await this.trader!.sellToken({ chain: p.chain as Chain, token: p.token, share: 1, amountRaw: p.live?.raw ? BigInt(p.live.raw) : undefined, pairAddress: p.pairAddress, dexId: p.dexId }, 'live');
      const implied = r.proceedsUsd > 0 && p.qtyLeft > 0 ? r.proceedsUsd / p.qtyLeft : 0; // the price from the sale's own proceeds — there is no other
      if (r.pending && r.tx) { this.watchPendingSell(id, p, { tx: r.tx, qty: p.qtyLeft, proceeds: r.proceedsUsd, soldRaw: r.soldRaw, reason, price: implied, nonce: r.nonce, from: r.from }); return; }
      if (r.ok) {
        this.sellFailNotes.delete(id); this.noPrice.delete(id);
        if (p.live?.raw && r.soldRaw !== undefined) p.live.raw = (BigInt(p.live.raw) - r.soldRaw > 0n ? BigInt(p.live.raw) - r.soldRaw : 0n).toString();
        await this.applyTokenSell(id, p, p.qtyLeft, r.proceedsUsd, reason, implied);
        return;
      }
      await this.sellFailed(id, `⚠️ ${label}: market exit without a price did not go through: ${r.note}. Will retry in ${Math.round(rule.retryMs / 60_000)} min; after ${Math.max(0, hours(rule.writeOffMs - blind))} h without a price I will write it off in the ledger.`, r.note);
    }
    if (blind < rule.writeOffMs) return;
    // Write-off: only a loss record in the ledger. Tokens (live) stay on the wallet — there is no public close post
    const qty = p.qtyLeft; const lossUsd = p.costUsd * (qty / p.qty); // cost basis of the remainder (sold parts are already accounted for, S-07 M1)
    const reason = `no price for ${hours(blind)}h — written off at zero${live ? ' (tokens stay on the wallet)' : ''}`;
    p.qtyLeft = 0;
    this.store.updatePosition(id, 0, 0, p, this.clock.iso(), reason);
    this.dropUnrealized(id); // the remainder was already in the unrealized loss from the previous pass — it leaves there before the write-off (O1)
    this.unrealBy.delete(id);
    this.risk.closePosition(id, 0, 0); // like a close with zero proceeds: the day's result −(cost basis of the remainder), cash does not change
    this.open.delete(id); this.returned.delete(id); this.noPrice.delete(id); this.sellFailNotes.delete(id);
    await this.say(`⛔ ${label} (${p.chain}): no price for ${hours(blind)} h${live ? ', the sale failed' : ''} — the position is written off in the ledger at zero, loss $${lossUsd.toFixed(2)}.`
      + (live ? ` The tokens remain on the treasury wallet: ${qty} units, token address ${p.token}. The agent no longer watches them — if the price comes back, they must be sold manually.` : ''));
  }

  private async monitorInner(market: MarketClient, opts: { tokensOnly?: boolean }) {
    await this.holdReminder().catch(e => console.error(`[live] hold reminder: ${String(e).slice(0, 160)}`));
    if (!opts.tokensOnly) this.lastOtherUnrealized = (this.nftOpen.size ? await this.monitorNft() : 0) + (this.perpOpen.size ? await this.monitorPerps() : 0)
      + (this.predOpen.size ? await this.monitorPredictions() : 0);
    let unrealized = this.lastOtherUnrealized;
    for (const [id, p] of this.open) {
      const mark = (v: number) => { unrealized += v; this.unrealBy.set(id, v); }; // the position's valuation in this pass
      const info = await market.market(p.token).catch(() => undefined);
      const price = info?.priceUsd;
      if (!price) {
        await this.handleNoPrice(id, p, market).catch(e => console.error(`[no-price] ${id}: ${String((e as Error)?.stack ?? e).slice(0, 300)}`));
        // No price — we count the remainder as a loss (conservatively). Only for a position that stayed open: one written off or sold
        // in this pass is already in the realized result — a second deduction would give a false hard stop (acceptance #142, O1)
        if (this.open.has(id)) mark(-p.costUsd * (p.qtyLeft / p.qty));
        continue;
      }
      this.noPrice.delete(id); // there is a price — the "blind" countdown resets
      if (this.sellInFlight(id) || (p.exitingUntilMs && p.exitingUntilMs > this.clock.now())) { mark(p.qtyLeft * price - p.costUsd * (p.qtyLeft / p.qty)); continue; } // a sale in flight
      const tp1Before = p.tp1Done; const stopBefore = p.stopPrice; const peakBefore = p.peakPrice; const rungsBefore = p.rungsDone; const checksBefore = p.checksDone;
      // The sale failed or is in flight — the ladder and checks state is rolled back: the decision will be made again at the next check
      const rollback = () => { p.tp1Done = tp1Before; p.stopPrice = stopBefore; p.rungsDone = rungsBefore; p.checksDone = checksBefore; };
      const act = evaluateExit(p, price, this.clock.now());
      // S-07: a new peak of a position with a moonbag is saved at once — after a restart the tail's trailing is not "disarmed"
      if (act.kind !== 'sell' && (((p.moonbagQty ?? 0) > 0 && p.peakPrice > peakBefore) || p.checksDone !== checksBefore)) this.store.updatePosition(id, p.qtyLeft, 0, p);
      // V2 (S-07 acceptance): a passed behaviour check is saved at once — after a restart it does not fire again
      if (act.kind !== 'sell') {
        mark(p.qtyLeft * price * (1 - PAPER_SLIPPAGE) - p.costUsd * (p.qtyLeft / p.qty));
        continue;
      }
      const exitGas = estimateGasUsd(p.chain as Chain, this.ethUsd(), undefined, this.clock.now());
      let proceeds = Math.max(0, act.qty * price * (1 - PAPER_SLIPPAGE) - exitGas);
      const sellArgs = { chain: p.chain as Chain, token: p.token, share: Math.min(1, act.qty / p.qtyLeft), amountRaw: p.live?.raw ? BigInt(p.live.raw) : undefined,
        pairAddress: p.pairAddress, dexId: p.dexId, shadowQty: act.qty };
      if (this.liveMode === 'live') {
        const r = await this.trader!.sellToken(sellArgs, 'live');
        if (r.pending && r.tx) {
          // A sale in flight: we don't touch the position until the transaction is decided; the result is applied exactly once
          const after = { tp1Done: p.tp1Done, stopPrice: p.stopPrice, rungsDone: p.rungsDone, checksDone: p.checksDone };
          rollback(); // breakeven and rungs switch on when the sale is confirmed
          this.watchPendingSell(id, p, { tx: r.tx, qty: act.qty, proceeds: r.proceedsUsd || proceeds, soldRaw: r.soldRaw, reason: act.reason, price, after, nonce: r.nonce, from: r.from });
          continue;
        }
        if (!r.ok) { rollback(); await this.sellFailed(id, `⚠️ LIVE sale ${p.symbol ?? p.token.slice(0, 8)} did not go through (${act.reason}): ${r.note}. Will retry at the next check.`, r.note); continue; }
        this.sellFailNotes.delete(id);
        proceeds = r.proceedsUsd;
        if (p.live?.raw && r.soldRaw !== undefined) p.live.raw = (BigInt(p.live.raw) - r.soldRaw > 0n ? BigInt(p.live.raw) - r.soldRaw : 0n).toString();
      } else if (this.liveMode === 'shadow') this.shadow(`SELL ${p.symbol ?? p.token.slice(0, 8)}`, () => this.trader!.sellToken(sellArgs, 'shadow'));
      const rest = await this.applyTokenSell(id, p, act.qty, proceeds, act.reason, price);
      if (this.open.has(id)) mark(rest); else unrealized += rest;
    }
    this.risk.setUnrealized(unrealized);
  }
}
