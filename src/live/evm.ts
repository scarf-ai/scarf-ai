// Fast EVM transaction sending (ideas from an earlier internal tool): local signing, gas and nonce in advance,
// the same signed transaction goes to all RPC lanes at once (sequencer/own RPC/fallbacks),
// the receipt — from whichever node answers first. The hash is known before sending: a lost RPC response
// never turns into a blind resend.
import { keccak256, type PrivateKeyAccount } from 'viem';
import type { Chain } from '../types.js';

export interface ChainCfg { chain: Chain; id: number; native: string; wrapped?: string; kyber?: string; rpc: string; send: string[]; explorer?: string;
  /** An L2 ordered by priority fee (OP stack) or L1 — priority matters; Arbitrum/Robinhood — FCFS by time. */
  priorityMatters: boolean }

export const CHAIN_IDS: Partial<Record<Chain, number>> = { ethereum: 1, base: 8453, arbitrum: 42161, bsc: 56, polygon: 137, robinhood: 4663 };

/** Chain config from .env: RPC_<CHAIN> (reading) and RPC_SEND_<CHAIN> (comma-separated — send lanes). */
export function chainConfigs(env: NodeJS.ProcessEnv, readRpc: Record<string, string>): Partial<Record<Chain, ChainCfg>> {
  const base: [Chain, Omit<ChainCfg, 'rpc' | 'send'>][] = [
    ['ethereum', { chain: 'ethereum', id: 1, native: 'ETH', wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', kyber: 'ethereum', explorer: 'https://etherscan.io/tx/', priorityMatters: true }],
    ['base', { chain: 'base', id: 8453, native: 'ETH', wrapped: '0x4200000000000000000000000000000000000006', kyber: 'base', explorer: 'https://basescan.org/tx/', priorityMatters: true }],
    ['arbitrum', { chain: 'arbitrum', id: 42161, native: 'ETH', wrapped: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', kyber: 'arbitrum', explorer: 'https://arbiscan.io/tx/', priorityMatters: false }],
    ['bsc', { chain: 'bsc', id: 56, native: 'BNB', wrapped: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', kyber: 'bsc', explorer: 'https://bscscan.com/tx/', priorityMatters: true }],
    ['robinhood', { chain: 'robinhood', id: 4663, native: 'ETH', wrapped: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', explorer: 'https://robinhoodchain.blockscout.com/tx/', priorityMatters: false }],
  ];
  const out: Partial<Record<Chain, ChainCfg>> = {};
  for (const [c, cfg] of base) {
    const rpc = env[`RPC_${c.toUpperCase()}`] || readRpc[c];
    if (!rpc) continue;
    const send = (env[`RPC_SEND_${c.toUpperCase()}`] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    out[c] = { ...cfg, rpc, send: send.length ? send : [rpc] };
  }
  return out;
}

export interface Fees { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; at: number }
export interface TxIn { to: `0x${string}`; data?: `0x${string}`; value?: bigint; gas?: bigint }
/** pending: the node accepted the transaction, but there is no receipt within the wait — it may still get into a block (decided later, by hash). */
export interface Sent { hash: `0x${string}`; receipt?: any; ok: boolean; pending: boolean; acceptedBy: string[];
  /** Lanes that did not answer (timeout, network): the transaction may have been accepted — counts as pending. */
  unknown?: string[]; /** nonce of the signed transaction (for resolving "in flight" by nonce). */ nonce?: number;
  /** Node rejection texts (insufficient funds, nonce too low …) — the reason must be visible in the journal and Telegram. */
  rejected?: string[];
  ms: { sign: number; firstAccept?: number; included?: number } }

type Rpc = (url: string, method: string, params: unknown[]) => Promise<any>;
/** There was no substantive node response: timeout, network break, gateway HTTP 5xx, non-JSON body. For a transaction send this is "in flight", not a rejection. */
export class NoAnswerError extends Error { override name = 'NoAnswerError'; }

export const jsonRpc = (fetchImpl: typeof fetch = fetch): Rpc => async (url, method, params) => {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  let j: any;
  try { j = await r.json(); } catch { throw new NoAnswerError(`${method}: HTTP ${r.status} with a non-JSON body (gateway?)`); }
  // A parsed JSON-RPC error is a node response (rejection), even with HTTP 4xx/5xx; without it, a non-2xx means no substantive response.
  // JSON without result and without error ({"message":"rate limited"}) — also not a node response
  if (j && typeof j === 'object' && j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  if (!r.ok) throw new NoAnswerError(`${method}: HTTP ${r.status}`);
  if (!j || typeof j !== 'object' || !('result' in j)) throw new NoAnswerError(`${method}: JSON without result/error`);
  return j.result;
};

const hex = (v: bigint | number) => `0x${v.toString(16)}`;

/**
 * There was no response from the node (fetch timeout, network break, DNS): the transaction may have been accepted. Any other error is a node response
 * with a rejection (jsonRpc throws an Error with the JSON-RPC error text).
 */
export function isNoAnswer(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  if (e instanceof NoAnswerError || e instanceof TypeError || e instanceof SyntaxError || name === 'NoAnswerError' || name === 'TimeoutError' || name === 'AbortError') return true;
  // A parsed node response (jsonRpc: `${method}: …`) is always a rejection, whatever the text says ("network error" from a malicious node is also a response)
  if (e instanceof Error && /^\w+: /.test(e.message)) return false;
  return /fetch failed|timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(String((e as Error)?.message ?? e));
}

/**
 * Wait limit for an "in flight" transaction (the owner's decision 2026-11-11 10:17 UTC: a transaction does not hang longer than 30 minutes). This is a WAIT limit,
 * not "did not happen": when it expires the outcome is handed to the background (handedOver) — the record lives, the address is blocked, the background
 * resolves the outcome to the end by hash and nonce (mined / dropped / replaced) and hands it to the onLateOutcome subscriber.
 */
export const PENDING_MAX_MS = 30 * 60_000;
/** How long after "dropped" we watch for a ghost receipt (op-geth keeps a transaction in the pool for up to ~3 h). */
export const GHOST_WATCH_MS = 3 * 60 * 60_000;
/** The "nobody knows the hash" check is repeated after this; dropped only on two matching checks in a row. */
export const DROPPED_RECHECK_MS = 30_000;
export interface PendingRec { addr: string; nonce: number; hash: `0x${string}`; atMs: number;
  /** All lanes rejected with this text (insufficient funds, nonce too low…): the reason is visible in the address block and in the journal. */
  why?: string;
  /**
   * The outcome was handed to the late-outcome subscriber — the caller will no longer get it: 'expired' — the wait limit passed; 'ghost' — the caller
   * already got a rejection (the swap was rejected by all lanes). Set once and never cleared: an outcome always has exactly one recipient.
   */
  handedOver?: 'expired' | 'ghost' }
/**
 * Transaction outcome to the outside: mined — receipt; dropped — it is not on the network (nonce re-read, the action can be retried);
 * replaced — the nonce slot is taken by another transaction on all nodes (this one will not execute); expired — the wait limit passed without an outcome
 * (for the caller = unknown: reserve and alert remain, nonce is NOT reset; the outcome will reach the onLateOutcome subscriber); unknown — waiting.
 */
export type TxOutcome = { state: 'mined'; receipt: any } | { state: 'dropped' | 'replaced' | 'expired' | 'unknown' };

export class EvmSender {
  private fees?: Fees;
  /** "In flight" transactions (accepted or unanswered): hash → address, nonce, time. Resolved in the background (watchPending) and on request (resolveLost). */
  readonly pendingTx = new Map<string, PendingRec>();
  /** How long "in flight" without an outcome counts as plain waiting; longer — expired (reduced in tests). */
  maxPendingMs = PENDING_MAX_MS;
  /** Outcomes of resolved transactions by hash (mined/dropped/replaced/expired): the background watchPending may have decided before the caller asked. */
  /** late: the outcome went to the onLateOutcome subscriber — waiting callers (awaitOutcome) get it as 'expired', not as a receipt. */
  readonly outcomes = new Map<string, { state: 'mined' | 'dropped' | 'replaced' | 'expired'; receipt?: any; atMs: number; late?: boolean }>();
  private remember(hash: string, state: 'mined' | 'dropped' | 'replaced' | 'expired', receipt?: any, late = false) {
    const h = hash.toLowerCase();
    this.outcomes.set(h, { state, receipt, atMs: Date.now(), ...(late ? { late } : {}) });
    if (this.outcomes.size > 500) for (const [k, v] of this.outcomes) { if (Date.now() - v.atMs > 6 * 60 * 60_000 || this.outcomes.size > 500) this.outcomes.delete(k); else break; }
  }
  private sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms));
  /** Next nonce per address. Initialization — one promise per address: parallel calls will not get the same nonce. */
  private nonces = new Map<string, Promise<{ next: number }>>();
  constructor(readonly cfg: ChainCfg, private rpc: Rpc = jsonRpc()) {}

  /** Fees are cached for 3 s; for a mint race — a priority multiplier. */
  async getFees(force = false): Promise<Fees> {
    if (!force && this.fees && Date.now() - this.fees.at < 3_000) return this.fees;
    const [block, tip] = await Promise.all([this.rpc(this.cfg.rpc, 'eth_getBlockByNumber', ['latest', false]), this.rpc(this.cfg.rpc, 'eth_maxPriorityFeePerGas', []).catch(() => '0x0')]);
    const baseFee = BigInt(block?.baseFeePerGas ?? '0x0');
    const prio = BigInt(tip);
    this.fees = { maxFeePerGas: baseFee * 2n + prio, maxPriorityFeePerGas: prio, at: Date.now() };
    return this.fees;
  }

  async nonce(addr: string, reserve = true): Promise<number> {
    const k = addr.toLowerCase();
    if (!this.nonces.has(k)) {
      const init = Promise.all([this.cfg.rpc, ...this.cfg.send].map(u => this.rpc(u, 'eth_getTransactionCount', [addr, 'pending']).then((x: string) => Number(BigInt(x))).catch(() => -1)))
        .then(ns => { const n = Math.max(...ns); if (n < 0) throw new Error('nonce: no RPC answered'); return { next: n }; }); // the largest across nodes: a lagging node will not return a taken nonce
      init.catch(() => this.nonces.delete(k));
      this.nonces.set(k, init);
    }
    const st = await this.nonces.get(k)!;
    const n = st.next; // read and reserve — synchronously after await: no race
    if (reserve) st.next = n + 1;
    return n;
  }
  resetNonce(addr: string) { this.nonces.delete(addr.toLowerCase()); }

  async estimateGas(from: string, tx: TxIn): Promise<bigint> {
    const g = BigInt(await this.rpc(this.cfg.rpc, 'eth_estimateGas', [{ from, to: tx.to, data: tx.data ?? '0x', value: hex(tx.value ?? 0n) }]));
    return (g * 125n) / 100n; // 25% margin
  }

  /** Time of the chain's latest block, ms. */
  async headTimeMs(): Promise<number> { const b = await this.rpc(this.cfg.rpc, 'eth_getBlockByNumber', ['latest', false]); return Number(BigInt(b.timestamp)) * 1000; }
  async balance(addr: string): Promise<bigint> { return BigInt(await this.rpc(this.cfg.rpc, 'eth_getBalance', [addr, 'latest'])); }
  async call(to: string, data: string, from?: string): Promise<string> { return this.rpc(this.cfg.rpc, 'eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']); }

  /** Sign in advance (mint at the public start): gas and nonce are fixed now. */
  async sign(account: PrivateKeyAccount, tx: TxIn & { gas: bigint }, opts: { priorityMultiplier?: number; nonce?: number; fees?: Fees } = {}): Promise<{ raw: `0x${string}`; hash: `0x${string}`; nonce: number }> {
    const f = opts.fees ?? await this.getFees();
    const m = BigInt(Math.round((opts.priorityMultiplier ?? 1) * 100));
    const prio = (f.maxPriorityFeePerGas * m) / 100n;
    const nonce = opts.nonce ?? await this.nonce(account.address);
    const raw = await account.signTransaction({ type: 'eip1559', chainId: this.cfg.id, nonce, to: tx.to, data: tx.data ?? '0x', value: tx.value ?? 0n, gas: tx.gas,
      maxPriorityFeePerGas: prio, maxFeePerGas: f.maxFeePerGas + prio });
    return { raw, hash: keccak256(raw), nonce };
  }

  /** Whether the address has "in flight" transactions without an outcome (better not to send new ones from it — they would queue behind the "gap"). */
  hasPending(addr: string): (PendingRec & { ghost?: boolean }) | undefined {
    const a = addr.toLowerCase();
    for (const g of this.ghostMined.values()) if (g.addr === a) return { addr: a, nonce: g.nonce, hash: g.hash, atMs: 0, ghost: true };
    for (const r of this.pendingTx.values()) if (r.addr === a) return r;
    return undefined;
  }

  /**
   * Resolving a transaction without a receipt — by hash AND by nonce (OVERRIDES): 'mined' — a receipt was found; 'dropped' — the transaction is not on the network
   * (all nodes answered, nobody knows the hash, no pending counter is above the nonce, the nonce slot on latest is free; and the same again after 30 s):
   * the nonce is re-read, the action can be retried; 'unknown' — a node knows the hash / did not answer / the slot is taken — keep waiting.
   */
  async resolveLost(hash: string, opts: { recheckMs?: number } = {}): Promise<TxOutcome> {
    const h = hash.toLowerCase();
    const rec = this.pendingTx.get(h);
    if (!rec) {
      // Already decided in the background (watchPending) — return the outcome as is (expired ≠ dropped!), otherwise the caller would wait on "unknown" forever
      const done = this.outcomes.get(h);
      if (done) return done.state === 'mined' ? { state: 'mined', receipt: done.receipt } : { state: done.state };
      // Without a record (nonce unknown — e.g. after a restart) "dropped" cannot be decided: by hash alone would violate OVERRIDES → unknown
      const rc0 = await this.raceReceipt(hash, 2_000, 500);
      if (rc0) this.settleMined(hash, rc0);
      return rc0 ? { state: 'mined', receipt: rc0 } : { state: 'unknown' };
    }
    const check = async (): Promise<'dropped' | 'replaced' | 'unknown'> => {
      const k = await this.txKnown(hash);
      if (k !== 'dropped') return 'unknown';
      const urls = [...new Set([this.cfg.rpc, ...this.cfg.send])];
      const polled = await Promise.all(urls.map(async u => {
        try { const [p, l] = await Promise.all([this.rpc(u, 'eth_getTransactionCount', [rec.addr, 'pending']), this.rpc(u, 'eth_getTransactionCount', [rec.addr, 'latest'])]); return { p: Number(BigInt(p)), l: Number(BigInt(l)) }; }
        catch (e) { return isNoAnswer(e) ? undefined : 'abstain' as const; } // a send-only node does not vote; "no answer" — we don't decide
      }));
      if (polled.some(c => c === undefined)) return 'unknown';
      const counts = polled.filter((c): c is { p: number; l: number } => typeof c === 'object');
      if (!counts.length) return 'unknown'; // not a single reading node
      // The nonce slot is taken in a block on ALL nodes, and nobody has a receipt for the hash: the transaction was replaced (manual cancel/replace from a wallet) — it will not execute
      if (counts.every(c => c!.l > rec.nonce)) return 'replaced';
      // Someone holds a transaction with this nonce or the slot is taken on some nodes — a receipt may still come
      if (counts.some(c => c!.p > rec.nonce || c!.l > rec.nonce)) return 'unknown';
      return 'dropped';
    };
    const rc = await this.raceReceipt(hash, 2_000, 500);
    if (rc) { this.settleMined(hash, rc, rec); return { state: 'mined', receipt: rc }; }
    const c1 = await check();
    if (c1 === 'unknown') return { state: 'unknown' };
    await this.sleep(opts.recheckMs ?? DROPPED_RECHECK_MS);
    const rc2 = await this.raceReceipt(hash, 2_000, 500);
    if (rc2) { this.settleMined(hash, rc2, rec); return { state: 'mined', receipt: rc2 }; }
    const c2 = await check();
    if (c2 === 'unknown' || c2 !== c1) return { state: 'unknown' };
    // While we were checking, another pass decided this same record (background and caller run in parallel): one outcome, not announced twice
    if (this.pendingTx.get(h) !== rec) { const done = this.outcomes.get(h); return !done ? { state: 'unknown' } : done.state === 'mined' ? { state: 'mined', receipt: done.receipt } : { state: done.state }; }
    this.pendingTx.delete(h);
    this.resetNonce(rec.addr);
    this.remember(hash, c2, undefined, !!rec.handedOver);
    if (c2 === 'dropped' && !rec.why) this.watchGhost(rec); // in case it still gets into a block (held by a node not on our list) — then a stop on the address until reconciliation; one rejected by all is not watched
    // The wait limit has already passed, the caller gave up: the final "will not execute" (by hash and nonce) also goes to the subscriber, otherwise the reserve would hang until a restart
    if (rec.handedOver === 'expired') this.deliverLate(rec, { state: c2 }, 'expired');
    return { state: c2 };
  }

  /**
   * The ONLY place where a receipt becomes a transaction's outcome. An outcome has exactly one recipient, and it is chosen here, synchronously,
   * once per hash: until the record is handed over (handedOver) — the caller (awaitOutcome will return mined); after the handover — only
   * the onLateOutcome subscriber (callers are left with 'expired'). Returns true if the outcome went (or had already gone) to the subscriber.
   */
  private settleMined(hash: string, receipt: any, holder?: PendingRec): boolean {
    const h = hash.toLowerCase();
    const rec = this.pendingTx.get(h);
    const done = this.outcomes.get(h);
    if (!rec && done?.state === 'mined') return !!done.late; // a second poll saw the same receipt: the recipient is already chosen
    if (!rec && (done?.state === 'dropped' || done?.state === 'replaced')) {
      // The transaction was already declared "will not execute" (the caller released the reserve / returned the position to the monitor), and a receipt came after —
      // a node not on our list held it. This is a ghost: accounting diverged, the address is blocked, the outcome goes to the subscriber. Silently rewriting
      // the outcome to "mined" is not allowed: the ghost watcher would see "not dropped" and quit, and the tokens would be left without accounting and a stop
      this.remember(hash, 'mined', receipt, true);
      const ghost = holder ?? this.lastRec.get(h);
      if (ghost) this.deliverLate(ghost, { state: 'mined', receipt }, 'ghost');
      else { this.ghostMined.set(h, { addr: '?', hash: hash as `0x${string}`, nonce: -1 }); console.error(`[evm] ghost receipt for ${hash} without a record — address unknown, outcome not delivered`); }
      return true;
    }
    this.pendingTx.delete(h);
    // #135 (rule #114): there is a receipt, but the status is unreadable (neither 0x1 nor 0x0) — the outcome is unknown, money may have left. For the caller
    // this is neither "mined" nor "reverted": the outcome goes to the subscriber as a ghost (address block, alert to the owner), the caller gets 'expired'
    const owner = rec ?? holder ?? this.lastRec.get(h);
    const unreadable = !!owner && receipt?.status !== '0x1' && receipt?.status !== '0x0';
    const kind = rec?.handedOver ?? (unreadable ? 'ghost' as const : undefined);
    this.remember(hash, 'mined', receipt, !!kind);
    if (owner && kind) this.deliverLate(owner, { state: 'mined', receipt }, kind);
    return !!kind;
  }
  /** The last record by hash (also after removal from pendingTx): so that a ghost receipt knows the address and nonce for delivery. */
  private lastRec = new Map<string, PendingRec>();

  /**
   * Hand the outcome to the subscriber. For a receipt the address is blocked (ghostMined) until accounting confirms the record (ackLate):
   * between "the 'in flight' record is removed" and "accounting is updated" there is no window in which the monitor would send the same action again.
   */
  private deliverLate(rec: PendingRec, o: TxOutcome, kind: 'expired' | 'ghost') {
    if (o.state === 'mined') this.ghostMined.set(rec.hash.toLowerCase(), { addr: rec.addr, hash: rec.hash, nonce: rec.nonce });
    try { this.onLateOutcome?.(rec, o, kind); }
    catch (e) { console.error(`[evm] late outcome handler ${rec.hash}: ${String(e).slice(0, 160)} — address stays blocked until reconciliation`); }
  }
  /** Accounting applied the late outcome (or it does not concern accounting): the address block for this transaction is lifted. */
  ackLate(hash: string) { this.ghostMined.delete(hash.toLowerCase()); }
  /** The caller got a rejection and will not wait for the outcome (the swap was rejected by all lanes): if it gets into a block, that is a late outcome, not silence. */
  abandon(hash: string) { const rec = this.pendingTx.get(hash.toLowerCase()); if (rec) rec.handedOver ??= 'ghost'; }
  /** What a caller waiting for the outcome sees: the ready outcome — or 'expired' if the outcome was handed to the subscriber (the caller then gets no receipt). */
  private callerView(h: string): TxOutcome | undefined {
    const done = this.outcomes.get(h);
    if (this.pendingTx.get(h)?.handedOver || done?.late || done?.state === 'expired') return { state: 'expired' };
    if (!done) return undefined;
    return done.state === 'mined' ? { state: 'mined', receipt: done.receipt } : { state: done.state };
  }

  /**
   * A quick look at the outcome without waiting and without the 30-second recheck (for a caller under the monitor lock):
   * the background's ready outcome, a receipt within 2 s, otherwise 'pending' (the "in flight" record is alive, the background will sort it out) or 'unknown' (neither record nor outcome).
   * Returns the fact as is (for an approve, which has no pair in accounting): ownership of the outcome for accounting is decided only by awaitOutcome.
   */
  async quickOutcome(hash: string): Promise<TxOutcome | { state: 'pending'; rec: PendingRec }> {
    const h = hash.toLowerCase();
    const done = this.outcomes.get(h);
    if (done) return done.state === 'mined' ? { state: 'mined', receipt: done.receipt } : { state: done.state };
    const rc = await this.raceReceipt(hash, 2_000, 500);
    if (rc) { this.settleMined(hash, rc); return { state: 'mined', receipt: rc }; }
    const rec = this.pendingTx.get(h);
    return rec ? { state: 'pending', rec } : { state: 'unknown' };
  }

  /**
   * Wait for the transaction outcome (for the caller): a receipt — or the background resolution's outcome as soon as the "in flight" record disappears
   * (don't wait 10 min if the background has already decided "dropped"). 'unknown' — time is up, the outcome is unclear (can be asked again).
   * 'expired' — the outcome was handed to the onLateOutcome subscriber: the caller will not get it, neither now nor on a repeated call.
   * last — this is the caller's last poll: if there is still no outcome at the end of the period, the record is handed to the subscriber right here, synchronously
   * (between "the caller stopped waiting" and "the background started delivering" there is no window in which the receipt would go to nobody or to both).
   */
  async awaitOutcome(hash: string, maxMs = 10 * 60_000, opts: { last?: boolean } = {}): Promise<TxOutcome> {
    const h = hash.toLowerCase();
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const seen = this.callerView(h);
      if (seen) return seen; // the outcome is ready or handed over: after the handover the caller does not poll for the receipt
      const r = await this.raceReceipt(hash, Math.min(5_000, Math.max(1, deadline - Date.now())), 1_000);
      if (r) return this.settleMined(hash, r) ? { state: 'expired' } : { state: 'mined', receipt: r };
      if (!this.pendingTx.has(h)) break; // no record: the background's outcome — or by receipt only (unknown if there is none)
    }
    const res = await this.resolveLost(hash);
    if (opts.last) return this.giveUp(hash);
    const seen = this.callerView(h);
    if (seen) return seen;
    return res.state === 'mined' ? res : { state: 'unknown' };
  }
  /**
   * The caller stops waiting for the outcome. A ready outcome goes to it; otherwise the record is handed, in the same synchronous step, to the
   * onLateOutcome subscriber ('expired'). 'unknown' — the sender does not know such a transaction (neither record nor outcome): nothing to hand over.
   */
  giveUp(hash: string): TxOutcome {
    const h = hash.toLowerCase();
    const seen = this.callerView(h);
    if (seen) return seen;
    const rec = this.pendingTx.get(h);
    if (!rec) return { state: 'unknown' };
    rec.handedOver = 'expired';
    return { state: 'expired' };
  }

  /**
   * "Ghost": a transaction declared dropped. If it still gets into a block within 3 h, accounting has diverged (the action was repeated):
   * the address is blocked for new buys/sells until a restart and reconciliation (E-03), the reason is visible in the refusals. The same block holds
   * the address after a late receipt — until accounting confirms the record (ackLate).
   */
  /** Key — the transaction hash (one address may have several outcomes not yet confirmed by accounting; each is lifted separately — ackLate). */
  readonly ghostMined = new Map<string, { addr: string; hash: `0x${string}`; nonce: number }>();
  private watchGhost(rec: PendingRec) {
    const h = rec.hash.toLowerCase();
    void (async () => {
      try {
        const deadline = Date.now() + GHOST_WATCH_MS;
        while (Date.now() < deadline) {
          await this.sleep(2 * 60_000);
          // A repeat of the action signed the same transaction (same nonce and fees → same hash) and registered it again,
          // or the outcome by hash is no longer "dropped": this is no longer a ghost — the receipt belongs to the legitimate repeat
          if (this.pendingTx.has(h) || this.outcomes.get(h)?.state !== 'dropped') return;
          const r = await this.raceReceipt(rec.hash, 2_000, 500);
          if (r) {
            if (this.pendingTx.has(h) || this.outcomes.get(h)?.state !== 'dropped') return;
            this.remember(rec.hash, 'mined', r, true);
            this.deliverLate(rec, { state: 'mined', receipt: r }, 'ghost');
            return;
          }
        }
      } catch (e) { console.error(`[evm] ghost watch ${rec.hash}: ${String(e).slice(0, 160)}`); }
    })();
  }

  /**
   * A transaction outcome the caller no longer waits for: a receipt or a final "dropped / replaced" after "expired" (wait limit),
   * a ghost receipt after "dropped" or after all lanes rejected. The executor applies it to accounting (position / sale), confirms it
   * (ackLate) and notifies the owner. Without a subscriber a receipt leaves the address blocked.
   */
  onLateOutcome?: (rec: PendingRec, outcome: TxOutcome, kind: 'expired' | 'ghost') => void;

  /** Register an "in flight" transaction sent outside send() (minter: broadcast of pre-signed ones). */
  trackPending(addr: string, nonce: number, hash: `0x${string}`, opts: { resolveNow?: boolean; why?: string } = {}) {
    const rec: PendingRec = { addr: addr.toLowerCase(), nonce, hash, atMs: Date.now(), why: opts.why };
    // The same transaction was signed again (same nonce → same hash): the old "dropped" outcome no longer applies to it
    this.outcomes.delete(hash.toLowerCase());
    this.pendingTx.set(hash.toLowerCase(), rec); this.lastRec.set(hash.toLowerCase(), rec); this.watchPending(rec, opts.resolveNow);
    if (this.lastRec.size > 500) for (const k of this.lastRec.keys()) { if (this.lastRec.size <= 500) break; if (!this.pendingTx.has(k)) this.lastRec.delete(k); }
  }

  /**
   * Background "in flight" resolution for ANY sender (treasury, burners): receipt → remember; dropped/replaced → nonce afresh.
   * Check by hash and nonce — from the first minute and then once a minute (not after 10 min): a stuck address must not wait on stops.
   * Beyond the wait limit (30 min) without an outcome — "expired": outcome expired for callers (= unknown, reserve and alert
   * remain), the record LIVES on and the nonce is NOT reset until the nodes stop knowing it (otherwise a new transaction would queue
   * behind the stuck one and both would land at once); the final outcome goes to the onLateOutcome subscriber. resolveNow — all lanes answered
   * with a rejection: resolve immediately, without waiting for a receipt.
   */
  private watchPending(rec: PendingRec, resolveNow = false) {
    const h = rec.hash.toLowerCase();
    void (async () => {
      let waitMs = resolveNow ? 0 : 45_000;
      while (this.pendingTx.get(h) === rec) {
        // A failure of one pass does not stop watching: the background is the only one that sees a handed-over outcome through to the end
        try {
          if (waitMs > 0) {
            const r = await this.raceReceipt(rec.hash, waitMs, 2_000);
            if (r) { this.settleMined(rec.hash, r, rec); return; } // the recipient (caller, subscriber or ghost) is chosen by settleMined
          }
          const res = await this.resolveLost(rec.hash);
          if (res.state !== 'unknown') return;
          const expired = Date.now() - rec.atMs > this.maxPendingMs;
          if (expired && this.pendingTx.get(h) === rec) {
            // The wait limit passed: callers get 'expired', from now on the outcome belongs to the onLateOutcome subscriber
            rec.handedOver ??= 'expired';
            if (this.outcomes.get(h)?.state !== 'expired') this.remember(rec.hash, 'expired');
          }
          waitMs = expired ? 5 * 60_000 : 60_000;
        } catch (e) { console.error(`[evm] pending watch ${rec.hash}: ${String(e).slice(0, 160)} — record kept, retry in 1 min`); waitMs = 60_000; }
      }
    })();
  }

  /** One signed transaction — to all lanes at once; the receipt — from the first node that answers. */
  async broadcast(raw: `0x${string}`, hash: `0x${string}`, opts: { waitMs?: number } = {}): Promise<Sent> {
    const t0 = Date.now();
    const accepted: string[] = []; const unknown: string[] = []; const rejected: string[] = [];
    let firstAccept: number | undefined;
    await Promise.allSettled(this.cfg.send.map(async (url, i) => {
      try { await this.rpc(url, 'eth_sendRawTransaction', [raw]); }
      catch (e) {
        // "already in the pool" — accepted. A node response with a rejection ("nonce too low", "insufficient funds" …) — NOT accepted: either the nonce is stale,
        // or it is already in a block — the receipt search below will decide. No response at all (timeout, network) — the node MAY have accepted: not counted as a rejection
        if (/already known|known transaction|already imported/i.test(String((e as Error).message))) { /* accepted */ }
        else if (!isNoAnswer(e)) { rejected.push(String((e as Error).message ?? e).replace(/^eth_sendRawTransaction: /, '').slice(0, 160)); throw e; }
        else { unknown.push(`lane${i}`); return; }
      }
      accepted.push(`lane${i}`); firstAccept ??= Date.now() - t0;
    }));
    // No node accepted and all answered with a rejection — nothing to wait for (previously we waited the full 45 s)
    const receipt = accepted.length || unknown.length ? await this.raceReceipt(hash, opts.waitMs ?? 45_000) : await this.raceReceipt(hash, 3_000);
    // #135 (rule #114): failure — only an explicit status 0x0. There is a receipt but the status is unreadable (no field, null, '0x01') — the outcome
    // is unknown: "in flight" (pending), not a failure — the caller does not roll back the position, does not sell again and does not release the reserve
    const unreadable = !!receipt && receipt.status !== '0x1' && receipt.status !== '0x0';
    return { hash, receipt, ok: receipt?.status === '0x1', pending: unreadable || (!receipt && (accepted.length > 0 || unknown.length > 0)), acceptedBy: accepted, unknown, rejected,
      ms: { sign: 0, firstAccept, included: receipt ? Date.now() - t0 : undefined } };
  }

  /** Wait for a "stuck" transaction (pending): a receipt or until the time runs out. To resolve the outcome — awaitOutcome(). */
  async waitLate(hash: string, ms = 10 * 60_000): Promise<any | undefined> { return this.raceReceipt(hash, ms, 2_000); }

  /**
   * Whether at least one node knows the transaction (mempool or block). 'known' — yes; 'dropped' — all nodes answered and nobody knows it
   * (the transaction is not on the network: the nonce can be re-read, the action retried); 'noanswer' — at least one node did not answer (we count it "in flight").
   */
  async txKnown(hash: string): Promise<'known' | 'dropped' | 'noanswer'> {
    const urls = [...new Set([this.cfg.rpc, ...this.cfg.send])];
    // A parsed node response with an error ("method not available" from a send-only sequencer) — the node cannot read: it does not vote.
    // "No answer" (timeout, network) — nobody may vote: the decision is postponed
    const rs = await Promise.all(urls.map(u => this.rpc(u, 'eth_getTransactionByHash', [hash]).then((t: any) => (t ? 'known' : 'none')).catch((e) => (isNoAnswer(e) ? 'noanswer' : 'abstain'))));
    if (rs.includes('known')) return 'known';
    if (rs.includes('noanswer')) return 'noanswer';
    return rs.includes('none') ? 'dropped' : 'noanswer'; // not a single reading node — cannot decide
  }

  async send(account: PrivateKeyAccount, tx: TxIn, opts: { priorityMultiplier?: number } = {}): Promise<Sent> {
    const t0 = Date.now();
    const gas = tx.gas ?? await this.estimateGas(account.address, tx);
    const s = await this.sign(account, { ...tx, gas }, opts);
    // A repeat of the same transaction (same nonce and fees → same hash): the old "dropped" outcome does not apply to this send
    // (otherwise its receipt in the same call would count as a ghost)
    this.outcomes.delete(s.hash.toLowerCase());
    const signMs = Date.now() - t0;
    let r = await this.broadcast(s.raw, s.hash);
    let resolveNow = false; let why: string | undefined;
    if (!r.receipt && !r.pending) {
      // All lanes answered with a rejection. A gateway may have forwarded the transaction and still answered with an error ("internal error", "upstream timeout"),
      // so this is not immediately "never happened": the transaction is "in flight", the nonce is taken, and the background resolves it by the rules (hash, nonce, recheck after 30 s) —
      // without the 10-minute wait for a receipt. Usually after ~35 s: "dropped" → nonce afresh, the caller gets the outcome via awaitOutcome
      r = { ...r, pending: true, unknown: [...(r.unknown ?? []), 'rejected-by-all-lanes'] };
      resolveNow = true; why = r.rejected?.[0] ? `nodes rejected: ${r.rejected[0]}` : 'nodes rejected';
    }
    // A receipt was received: the outcome by hash is "in a block". Otherwise a legitimate repeat with the same nonce and fees (same hash) would keep
    // the old "dropped" outcome, and the ghost watcher would block the address after 2 min
    // The record (address, nonce) is passed along: a receipt with an unreadable status goes to the subscriber as a ghost with an address block (#135)
    if (r.receipt) {
      this.settleMined(s.hash, r.receipt, { addr: account.address.toLowerCase(), nonce: s.nonce, hash: s.hash, atMs: Date.now() });
    } else if (r.pending) this.trackPending(account.address, s.nonce, s.hash, { resolveNow, why });
    return { ...r, nonce: s.nonce, ms: { ...r.ms, sign: signMs } };
  }

  /** Receipt from the first node that answers. We give up only on time: polling errors (RPC down) — a growing pause up to 5 s, not an exit. */
  async raceReceipt(hash: string, timeoutMs: number, pollMs = 120): Promise<any | undefined> {
    const deadline = Date.now() + timeoutMs;
    const urls = [...new Set([this.cfg.rpc, ...this.cfg.send])];
    return new Promise(resolve => {
      let done = false, active = urls.length;
      const finish = (v: any) => { if (!done) { done = true; resolve(v); } };
      for (const u of urls) (async () => {
        let errs = 0;
        while (!done && Date.now() < deadline) {
          try { const r = await this.rpc(u, 'eth_getTransactionReceipt', [hash]); if (r?.blockNumber) return finish(r); errs = 0; }
          catch { errs++; }
          const wait = errs ? Math.min(5_000, pollMs * 2 ** Math.min(errs, 6)) : pollMs;
          await new Promise(s => setTimeout(s, Math.min(wait, Math.max(0, deadline - Date.now()))));
        }
        if (--active === 0) finish(undefined);
      })();
    });
  }
}

/** How many tokens arrived at the address per the receipt logs (ERC-20 Transfer). */
export function receivedFromReceipt(receipt: any, token: string, to: string): bigint {
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  let sum = 0n;
  for (const l of receipt?.logs ?? []) {
    if (String(l.address).toLowerCase() !== token.toLowerCase() || String(l.topics?.[0]).toLowerCase() !== T || (l.topics?.length ?? 0) !== 3) continue;
    if (('0x' + String(l.topics[2]).slice(26)).toLowerCase() === to.toLowerCase()) sum += BigInt(l.data);
  }
  return sum;
}
