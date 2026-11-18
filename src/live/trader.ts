// Live token trading: buy/sell on EVM (Kyber, Pons) and Solana (Jupiter).
// Modes: shadow — build and simulate the transaction, do NOT send (a check during the paper week);
// live — send (only with AGENT_MODE=live, AGENT_LIVE_CONFIRM=yes and unlocked keys).
// Order for every transaction: route → signature filter (target — only the pinned router / a verified curve) →
// simulation with a balance-change check → send. In live we do not send without a simulation (fail-closed).
import { encodeFunctionData, parseAbi, formatUnits, parseUnits } from 'viem';
import type { Chain } from '../types.js';
import { Wallets, newKeyMaterial } from './keystore.js';
import { EvmSender, receivedFromReceipt, jsonRpc, type ChainCfg } from './evm.js';
import { kyberClient, NATIVE, type KyberClient } from './kyber.js';
import { ponsBuyRoute, ponsSellRoute, ponsCurveOf } from './pons.js';
import { jupiterClient, SolSender, SOL_MINT } from './jupiter.js';
import { checkTransaction, checkSimulationDiff } from '../safety/firewall.js';
import { simulateEvmCalls } from '../safety/simulate.js';

/** KyberSwap router (MetaAggregationRouterV2, one address on all EVM chains). Any other address from the API — refusal. */
export const KYBER_ROUTERS = ['0x6131b5fae19ea4f9d964eac0408e4408b66337b5'];
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)']);

export type LiveMode = 'shadow' | 'live';
/**
 * Chains where live token BUYS are allowed by default (E-02 audit): a sequencer or Jupiter, cheap gas.
 * Ethereum mainnet and BNB Chain — a public mempool, with 8 % slippage a sandwich is real: only after the owner's "yes" (AGENT_LIVE_CHAINS).
 * This list does not restrict sales of open positions or NFT mints. In shadow everything is checked — to see what would be refused.
 */
export const DEFAULT_LIVE_SWAP_CHAINS: Chain[] = ['base', 'robinhood', 'arbitrum', 'solana'];
/** pending: the transaction was accepted by a node but there is no receipt yet — the outcome will come later via settleBuy(). */
export interface BuyResult { ok: boolean; mode: LiveMode; qty: number; raw: bigint; decimals: number; spentUsd: number; tx?: string; note: string; pending?: boolean;
  /**
   * #137 (Solana): the swap amount itself, $. The entry price (floor, ladder, breakeven) — from it; spentUsd (with the rent of a new token account and
   * the fee) — the cost basis. Absent — the entry price from spentUsd, as before (EVM).
   */
  swapUsd?: number }
/** tx / pending — only about the swap itself. approveTx — a separate approval step: its hash is never counted as a sale. */
export interface SellResult { ok: boolean; mode: LiveMode; proceedsUsd: number; soldRaw?: bigint; tx?: string; note: string; pending?: boolean; approveTx?: string;
  /** EVM, a sale "in flight": the transaction nonce and the sender address (to decide the outcome after a restart, #135 F3). */
  nonce?: number; from?: string }
/**
 * A late outcome — one the caller no longer waits for (the wait limit passed, or the transaction was deemed dropped / rejected).
 * state: mined — a receipt (receipt); dropped / replaced — after the wait limit the transaction will definitely not execute.
 * treasury: the sender address is the treasury (false — a minter burner wallet: a block on it does not stop the treasury).
 */
export interface LateOutcome { chain: Chain; hash: `0x${string}`; addr: string; nonce: number; kind: 'expired' | 'ghost';
  state?: 'mined' | 'dropped' | 'replaced'; receipt?: any; treasury?: boolean }
export interface TraderDeps {
  wallets?: Wallets; chains: Partial<Record<Chain, ChainCfg>>; solRpc?: { rpc: string; send: string[] };
  nativeUsd: (chain: Chain) => Promise<number | undefined>;
  slippageBps: number; kyber?: KyberClient; fetchImpl?: typeof fetch;
  /** Live buy chains (AGENT_LIVE_CHAINS); unset — DEFAULT_LIVE_SWAP_CHAINS. */
  liveSwapChains?: Chain[];
}

const hexBig = (v: bigint) => `0x${v.toString(16)}`;
const err = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 180);

export class LiveTrader {
  private senders = new Map<Chain, EvmSender>();
  private kyber: KyberClient;
  private jup = jupiterClient();
  private sol?: SolSender;
  private curveCache = new Map<string, string | undefined>();
  /** Money on the right chain before a trade (Relay bridge), 2026-10-28. */
  funding?: import('./bridge.js').Funding;
  /** A late outcome (after the wait limit / ghost) — to the executor: apply it to the ledger and notify the owner. Subscription — via setLateOutcomeHandler. */
  setLateOutcomeHandler(h: (e: LateOutcome) => void) {
    for (const [c, s] of this.senders) s.onLateOutcome = (rec, o, kind) => {
      if (o.state !== 'mined' && o.state !== 'dropped' && o.state !== 'replaced') return;
      // approve: it has no pair in the ledger and must not have one — the sale will re-read the outcome and the allowance itself. The address block is lifted at once,
      // otherwise a late-landing approve would stop the very stop-loss it was sent for
      // Check against all sent approves, not only the one still pending: an approve deemed dropped and forgotten may also land later
      if (this.approveHashes.has(`${c}:${rec.hash.toLowerCase()}`)) {
        s.ackLate(rec.hash); console.log(`[live] late ${o.state} of approve ${rec.hash} on ${c}: not a ledger entry, the sell will re-check it`); return;
      }
      h({ chain: c, hash: rec.hash, addr: rec.addr, nonce: rec.nonce, kind, state: o.state, receipt: o.state === 'mined' ? o.receipt : undefined,
        treasury: rec.addr === this.d.wallets?.evmTreasury.address.toLowerCase() });
    };
  }
  /** A late buy receipt: the position as per the receipt (called by the executor from the late-outcome handler). */
  async buyFromLateReceipt(p: { chain: Chain; token: string; sizeUsd: number; tx: string; decimals: number; receipt: any }): Promise<BuyResult> {
    const me = this.d.wallets?.evmTreasury.address;
    // "reverted" — only an explicit status 0x0; any other non-0x1 (no field, null, '0x01') — the receipt is unreadable, we don't call it a revert
    const st = p.receipt?.status;
    if (!me || st !== '0x1') return { ok: false, mode: 'live', qty: 0, raw: 0n, decimals: 0, spentUsd: 0, note: st === '0x1' ? 'no wallet' : st === '0x0' ? 'reverted' : 'receipt status unreadable', tx: p.tx };
    return this.buyFromReceipt(p.receipt, p.token, me, p.decimals, p.sizeUsd, (await this.nativeUsd(p.chain, 'sell')) ?? 0, 'late', p.tx);
  }
  /** The late outcome of this transaction was applied to the ledger (or does not concern it): lift the address block for exactly this one, not others. */
  clearGhost(chain: Chain, hash: string) { this.senders.get(chain)?.ackLate(hash); }
  /**
   * #135 F3: chains where the treasury address is blocked by a ghost (a transaction outcome not in the ledger): buys and sells from the address — including
   * stops on that chain's positions — are refused until the block is lifted. For the reminder to the owner.
   */
  /**
   * #135 F3: the outcome of a sale sent before a restart. The sender does not remember it — the "in flight" record is restored from the saved
   * address and nonce, and the outcome is decided by the usual rules (hash AND nonce): receipt → ok/failed; the nonce slot taken by another transaction
   * on all nodes → dropped; otherwise unknown — and the record is handed to the background (last): the final outcome will come via the late-outcome subscription.
   */
  async settleRestored(chain: Chain, tx: string, from: string, nonce: number): Promise<'ok' | 'failed' | 'unknown' | 'dropped'> {
    const s = this.senders.get(chain);
    if (!s) return 'unknown';
    if (!s.pendingTx.has(tx.toLowerCase()) && !s.outcomes.has(tx.toLowerCase())) s.trackPending(from, nonce, tx as `0x${string}`);
    return this.settleTx(chain, tx, { last: true });
  }
  /**
   * #135 R1: the transaction is still on the network — it may land in a block: the sender holds it "in flight" or a node knows it, but there is no receipt. 'no' —
   * the outcome is known (in a block, dropped) or no node knows it; 'unknown' — a node did not answer. Solana: there is no "in flight" sender here — 'no'.
   */
  async stillInNetwork(chain: Chain, tx: string): Promise<'yes' | 'no' | 'unknown'> {
    const s = this.senders.get(chain);
    if (!s) return 'no';
    const h = tx.toLowerCase();
    if (s.pendingTx.has(h)) return 'yes';
    if (s.outcomes.has(h)) return 'no'; // the outcome was already decided by the sender (in a block — including a ghost with an unreadable status; dropped; replaced)
    const k = await s.txKnown(tx).catch(() => 'noanswer' as const);
    if (k === 'noanswer') return 'unknown';
    if (k === 'dropped') return 'no';
    return (await s.raceReceipt(tx, 2_000, 500).catch(() => undefined)) ? 'no' : 'yes';
  }
  ghostBlocks(): { chain: Chain; hash: string }[] {
    const me = this.d.wallets?.evmTreasury.address;
    if (!me) return [];
    const out: { chain: Chain; hash: string }[] = [];
    for (const [c, s] of this.senders) { const g = s.hasPending(me); if (g?.ghost) out.push({ chain: c, hash: g.hash }); }
    return out;
  }
  constructor(private d: TraderDeps) {
    this.kyber = d.kyber ?? kyberClient(d.fetchImpl);
    // The senders call RPC with the same fetch as the trader: in tests no node call goes outside
    for (const [c, cfg] of Object.entries(d.chains)) if (cfg) this.senders.set(c as Chain, new EvmSender(cfg, d.fetchImpl ? jsonRpc(d.fetchImpl) : undefined));
    if (d.solRpc) this.sol = new SolSender(d.solRpc.rpc, d.solRpc.send);
  }
  private eph?: Wallets;
  /** The last received native coin price per chain: a sale (stop) needs it only for $ accounting, freshness is not required. */
  private lastNativeUsd = new Map<Chain, number>();
  /**
   * The last real native coin price for sale accounting — of any age (item 7 of the #48 acceptance). index.ts calls it on every
   * successful price update (DexScreener): after a restart with an open position the stop must not wait for the trader's first trade
   * or a fresh price. Do not pass the default value (2500) here: only an actually received price.
   */
  noteNativePrice(chain: Chain, usd: number) { if (Number.isFinite(usd) && usd > 0) this.lastNativeUsd.set(chain, usd); }
  private async nativeUsd(chain: Chain, purpose: 'buy' | 'sell'): Promise<number | undefined> {
    const fresh = await this.d.nativeUsd(chain).catch(() => undefined);
    // Only a finite positive number: a negative, infinite or NaN "fresh" price would set the buy size (leftover from the #48 acceptance)
    if (fresh !== undefined && Number.isFinite(fresh) && fresh > 0) { this.lastNativeUsd.set(chain, fresh); return fresh; }
    return purpose === 'sell' ? this.lastNativeUsd.get(chain) : undefined;
  }
  /** The wallet for the calculation: the real one, and in shadow without a keystore — a burner in memory (never funded). */
  private w(mode: LiveMode): Wallets | undefined { return this.d.wallets ?? (mode === 'shadow' ? (this.eph ??= new Wallets(newKeyMaterial(0))) : undefined); }
  supports(chain: Chain) { return chain === 'solana' ? !!this.sol : this.senders.has(chain); }
  sender(chain: Chain) { return this.senders.get(chain); }
  private fetch() { return this.d.fetchImpl ?? fetch; }

  /** Robinhood: the token's curve is confirmed by a Pons factory event, not only by DexScreener. */
  private async verifiedCurve(s: EvmSender, token: string, pair?: string): Promise<string | undefined> {
    const k = token.toLowerCase();
    let c = this.curveCache.get(k);
    if (!c) {
      const rpc = jsonRpc(this.fetch());
      c = await ponsCurveOf(token, (f) => rpc(s.cfg.rpc, 'eth_getLogs', [f]), async () => BigInt(await rpc(s.cfg.rpc, 'eth_blockNumber', []))).catch(() => undefined);
      if (c) this.curveCache.set(k, c); // cache only what was found: an RPC failure must not ban the token forever
    }
    return c && (!pair || pair.toLowerCase() === c) ? c : undefined;
  }

  async buyToken(p: { chain: Chain; token: string; sizeUsd: number; pairAddress?: string; dexId?: string }, mode: LiveMode): Promise<BuyResult> {
    const fail = (note: string, extra: Partial<BuyResult> = {}): BuyResult => ({ ok: false, mode, qty: 0, raw: 0n, decimals: 0, spentUsd: 0, note, ...extra });
    const W = this.w(mode);
    if (!W) return fail('keystore locked');
    if (mode === 'live' && !(this.d.liveSwapChains ?? DEFAULT_LIVE_SWAP_CHAINS).includes(p.chain)) return fail(`live buys on ${p.chain} are off (AGENT_LIVE_CHAINS; public mempool — needs the owner's "yes")`);
    const nUsd = await this.nativeUsd(p.chain, 'buy');
    if (!nUsd) return fail(`no fresh ${p.chain} native price`);
    // Money on the trade's chain (Relay bridge) — AFTER the cheap checks (route, filter, decimals) and before the simulation: the bridge is the most expensive
    // and irreversible action, we don't do it for a trade we would reject anyway. In shadow — only a bridge quote.
    let fundNote = '';
    const fund = async (): Promise<string | undefined> => {
      if (!this.funding) return undefined;
      const f = await this.funding.ensure(p.chain, p.sizeUsd, mode).catch(e => ({ ok: false, note: err(e) }));
      if (!f.ok) return `funding: ${f.note}`;
      fundNote = ` · ${f.note}`;
      return undefined;
    };
    if (p.chain === 'solana') { const r = await this.buySol(p, mode, nUsd, W, fund); return { ...r, note: `${r.note}${fundNote}` }; }
    const s = this.senders.get(p.chain);
    if (!s) return fail(`no RPC for ${p.chain}`);
    const me = W.evmTreasury;
    // While the treasury has an "in flight" transaction without an outcome on this chain, we send no new ones: they would queue behind the nonce "gap" (fail-closed)
    const pend = mode === 'live' ? s.hasPending(me.address) : undefined;
    if (pend?.ghost) return fail(`tx ${pend.hash} (nonce ${pend.nonce}) was declared dropped but later mined, or mined after the wait limit, on ${p.chain} and is not in the ledger yet — check the wallet (E-03); after checking: /release ${pend.hash} sold | not-sold`);
    if (pend) return fail(`a previous tx ${pend.hash} (nonce ${pend.nonce}) is still unresolved on ${p.chain}${pend.why ? ` (${pend.why})` : ''} — not sending more until it settles`);
    const amountIn = BigInt(Math.floor((p.sizeUsd / nUsd) * 1e18));
    const call = (to: string, data: string, from: string, value?: bigint) => this.callWithBalance(s, to, data, from, value);
    let route: { to: `0x${string}`; data: `0x${string}`; value: bigint; minOut: bigint; quotedOut: bigint; via: string; gas?: bigint };
    try {
      if (p.chain === 'robinhood') {
        const isPons = /pons/i.test(p.dexId ?? '');
        const curve = isPons ? await this.verifiedCurve(s, p.token, p.pairAddress) : undefined;
        if (isPons && !curve) return fail('pons: pair is not the token curve registered by the Pons factory');
        const r = await ponsBuyRoute({ token: p.token as `0x${string}`, pairAddress: curve, dexId: curve ? 'pons' : p.dexId, amountIn, from: me.address, slippageBps: this.d.slippageBps, call });
        route = { ...r, via: `pons ${r.kind}` };
      } else {
        const cfg = s.cfg;
        if (!cfg.kyber) return fail(`no aggregator for ${p.chain}`);
        const k = await this.kyber.swap({ chain: cfg.kyber, tokenIn: NATIVE, tokenOut: p.token, amountIn, from: me.address, slippageBps: this.d.slippageBps });
        if (!KYBER_ROUTERS.includes(k.router.toLowerCase()) || k.to.toLowerCase() !== k.router.toLowerCase()) return fail(`unexpected router ${k.router}`);
        route = { to: k.to, data: k.data, value: k.value, minOut: k.minOut, quotedOut: k.amountOut, via: 'kyber', gas: k.gas };
      }
    } catch (e) { return fail(`route: ${err(e)}`); }
    // Signature filter: target — only the router/curve, value ≤ trade size + 5%
    const fw = checkTransaction({ to: route.to, data: route.data, value: route.value, chainId: s.cfg.id },
      { self: me.address, treasury: me.address, chainId: s.cfg.id, expectedTargets: [route.to], maxValueWei: (amountIn * 105n) / 100n });
    if (!fw.allow) return fail(`firewall: ${fw.reason}`);
    // decimals() did not answer — the token is not traded (OVERRIDES for evm-token-decimals: a substituted 18 would break the quantity, entry price and stops)
    let decimals: number;
    try { decimals = await this.decimals(s, p.token); } catch (e) { return fail(`decimals: ${err(e)} — token not traded`); }
    const fundFail = await fund();
    if (fundFail) return fail(fundFail);
    // Simulation (in shadow — with an overridden balance): at least minOut tokens must arrive, no more ETH than value + gas must leave
    const sim = await simulateEvmCalls(s.cfg.rpc, me.address, [{ to: route.to, data: route.data, value: route.value }], this.fetch(),
      mode === 'shadow' ? { [me.address]: { balance: hexBig(10n ** 22n) } } : undefined);
    if (sim.supported && !sim.success) return fail(`simulation reverted: ${sim.error ?? ''}`.slice(0, 200));
    if (sim.supported && sim.diff) {
      const v = checkSimulationDiff(sim.diff, { maxNativeOutWei: route.value + (sim.gasCostWei ?? 0n) * 2n + 10n ** 15n, minReceive: { [p.token.toLowerCase()]: route.minOut }, mustReceiveSomething: true });
      if (!v.allow) return fail(v.reason);
    }
    if (mode === 'live' && !sim.supported) return fail(`live: simulation unavailable on this RPC (${sim.error ?? 'eth_simulateV1'}) — not sending blind`);
    const qtyQuoted = Number(formatUnits(route.quotedOut, decimals));
    const simNote = sim.supported ? 'simulated OK' : 'eth_simulateV1 not supported — live would refuse on this RPC';
    if (mode === 'shadow') return { ok: true, mode, qty: qtyQuoted, raw: route.quotedOut, decimals, spentUsd: p.sizeUsd, note: `${route.via}: would get ${qtyQuoted.toPrecision(6)} tokens (min ${formatUnits(route.minOut, decimals)}), ${simNote}${fundNote}` };
    const gas = sim.gasUsed ? (sim.gasUsed * 140n) / 100n : route.gas ? (route.gas * 140n) / 100n : undefined;
    const sent = await s.send(me, { to: route.to, data: route.data, value: route.value, gas });
    if (sent.pending) return fail(sent.receipt
      ? `tx mined, receipt status unreadable (${JSON.stringify(sent.receipt?.status ?? null).slice(0, 20)}): ${sent.hash} — outcome unknown, address blocked until the wallet is checked` // #135
      : `tx pending (no receipt yet): ${sent.hash}${sent.rejected?.length ? ` (nodes rejected: ${sent.rejected[0]})` : ''}`, { pending: true, tx: sent.hash, decimals });
    if (!sent.ok) return fail(`tx failed: ${sent.hash}`, { tx: sent.hash });
    return this.buyFromReceipt(sent.receipt, p.token, me.address, decimals, p.sizeUsd, nUsd, route.via, sent.hash, sent.ms.included);
  }

  private buyFromReceipt(receipt: any, token: string, me: string, decimals: number, sizeUsd: number, nUsd: number, via: string, hash: string, ms?: number): BuyResult {
    const got = receivedFromReceipt(receipt, token, me);
    const gasUsd = Number(formatUnits(BigInt(receipt.gasUsed ?? 0) * BigInt(receipt.effectiveGasPrice ?? 0), 18)) * nUsd;
    return { ok: got > 0n, mode: 'live', qty: Number(formatUnits(got, decimals)), raw: got, decimals, spentUsd: sizeUsd + gasUsd, tx: hash, note: `${via}: got ${formatUnits(got, decimals)}${ms ? ` in ${ms} ms` : ''}` };
  }

  /** Outcome of a "stuck" buy: wait for a receipt up to 10 min. pending=true — still unknown. */
  /** Outcome of a sent transaction (EVM — receipt, Solana — signature status), up to 10 min. */
  /**
   * 'dropped' — the transaction is not on the network (nobody knows the hash, the nonce slot is free) or it was replaced (the slot is taken by another): the action
   * can be retried. 'unknown' — the outcome is unclear, including "the wait limit passed" (expired): must not be retried.
   * last — the caller's last poll: if there is no outcome, it is handed to the late-outcome subscriber (EvmSender.awaitOutcome).
   */
  async settleTx(chain: Chain, tx: string, opts: { last?: boolean } = {}): Promise<'ok' | 'failed' | 'unknown' | 'dropped'> {
    if (chain === 'solana') return this.sol ? this.sol.settle(tx) : 'unknown';
    const s = this.senders.get(chain);
    if (!s) return 'unknown';
    const res = await s.awaitOutcome(tx, undefined, opts).catch((e) => { console.error(`[live] awaitOutcome ${tx}: ${err(e)}`); return opts.last ? s.giveUp(tx) : { state: 'unknown' as const }; });
    // #135 (rule #114): 'failed' — only an explicit status 0x0; an unreadable or missing status — 'unknown' (keep "in flight")
    if (res.state === 'mined') return res.receipt?.status === '0x1' ? 'ok' : res.receipt?.status === '0x0' ? 'failed' : 'unknown';
    return res.state === 'dropped' || res.state === 'replaced' ? 'dropped' : 'unknown';
  }

  async settleBuy(p: { chain: Chain; token: string; sizeUsd: number; tx: string; decimals: number; /** the caller's last poll */ last?: boolean }): Promise<BuyResult> {
    const none = (note: string, pending = false): BuyResult => ({ ok: false, mode: 'live', qty: 0, raw: 0n, decimals: 0, spentUsd: 0, note, tx: p.tx, pending });
    if (p.chain === 'solana') {
      const owner = this.d.wallets?.solTreasury.publicKey.toBase58();
      if (!this.sol || !owner) return none('no Solana sender');
      const st = await this.sol.settle(p.tx);
      if (st !== 'ok') return none(st === 'failed' ? 'failed on chain' : 'still unconfirmed after 10 min', st === 'unknown');
      // Confirmed, so SOL left: we could not read the transaction (RPC) or the node does not serve it yet — this is "don't know yet", not "did not go through"
      let got: bigint | undefined;
      try { got = await this.sol.receivedInTx(p.tx, owner, p.token); } catch (e) { return none(`confirmed, but tx read failed (${err(e)}) — retrying`, true); }
      if (got === undefined) return none('confirmed, but the node does not return the tx yet — retrying', true);
      if (got <= 0n) return none(`confirmed ${p.tx}, but received 0 per tx meta — check the wallet manually`, true); // alert, the reserve stays
      const dec = await this.solDecimals(p.token);
      const spent = await this.solSpentUsd(p.tx, owner, p.sizeUsd, await this.nativeUsd('solana', 'sell'));
      // #137: the swap amount itself — the decision size (converted to lamports at sending); account rent and the fee — only in the spend
      return { ok: true, mode: 'live', qty: Number(formatUnits(got, dec)), raw: got, decimals: dec, spentUsd: spent.usd, swapUsd: Math.min(p.sizeUsd, spent.usd), tx: p.tx, note: `late: got ${formatUnits(got, dec)}${spent.note}` };
    }
    const s = this.senders.get(p.chain);
    const me = this.d.wallets?.evmTreasury.address;
    if (!s || !me) return none('no sender');
    const res = await s.awaitOutcome(p.tx, undefined, { last: p.last }).catch((e) => { console.error(`[live] awaitOutcome ${p.tx}: ${err(e)}`); return p.last ? s.giveUp(p.tx) : { state: 'unknown' as const }; });
    if (res.state === 'dropped') return none('dropped: no node knows the tx and the nonce slot is free — it did not reach the network');
    if (res.state === 'replaced') return none('replaced: the nonce slot was taken by another tx — this one will not execute');
    if (res.state === 'expired') return none(`stuck: no outcome within the wait limit (${Math.round(s.maxPendingMs / 60_000)} min) — not retrying; the background watcher delivers the final outcome`, true);
    if (res.state !== 'mined') return none('still no receipt after 10 min', true);
    const r = res.receipt;
    // #135 (rule #114): "reverted" — only an explicit 0x0; an unreadable status — the outcome is unknown: the reserve stays, the position is not a "failure"
    if (r?.status === '0x0') return none('reverted');
    if (r?.status !== '0x1') return none(`receipt status unreadable (${JSON.stringify(r?.status ?? null).slice(0, 20)}) — outcome unknown, kept in flight`, true);
    return this.buyFromReceipt(r, p.token, me, p.decimals, p.sizeUsd, (await this.nativeUsd(p.chain, 'sell')) ?? 0, 'late', p.tx);
  }

  /**
   * Sell a share of a position. amountRaw — how much this position bought (not the whole wallet balance: one token may have
   * several positions); we sell share of it, no more than the balance.
   */
  async sellToken(p: { chain: Chain; token: string; share: number; amountRaw?: bigint; pairAddress?: string; dexId?: string; shadowQty?: number }, mode: LiveMode): Promise<SellResult> {
    const fail = (note: string, extra: Partial<SellResult> = {}): SellResult => ({ ok: false, mode, proceedsUsd: 0, note, ...extra });
    const W = this.w(mode);
    if (!W) return fail('keystore locked');
    // A sale does not depend on price freshness: min-out in native units, the price — only for $ proceeds accounting (stops must work while the price is paused)
    const nUsd = await this.nativeUsd(p.chain, 'sell');
    if (!nUsd) return fail(`no ${p.chain} native price ever received — retry later`);
    if (p.chain === 'solana') return this.sellSol(p, mode, nUsd, W);
    const s = this.senders.get(p.chain);
    if (!s) return fail(`no RPC for ${p.chain}`);
    const me = W.evmTreasury;
    // The previous approve is not confirmed yet — we don't repeat the sale (and don't request a route) until it is decided:
    // receipt exists → go on; nodes don't know the hash (dropped) → forget it, nonce afresh; they know it and longer than the limit → alert, wait
    const paKey = `${s.cfg.chain}:${p.token.toLowerCase()}`;
    const pa = mode === 'live' ? this.pendingApprove.get(paKey) : undefined;
    if (pa) {
      // Under the monitor lock — no waiting: the background's ready outcome or a receipt within 2 s; the "dropped/replaced" resolution is done by the background
      const res = await s.quickOutcome(pa.hash).catch((e) => { console.error(`[live] quickOutcome ${pa.hash}: ${err(e)}`); return { state: 'unknown' as const }; });
      if (res.state === 'mined' || res.state === 'dropped' || res.state === 'replaced') this.pendingApprove.delete(paKey); // confirmed → the allowance below decides; dropped → the nonce is already re-read, approve again
      else if (res.state === 'expired') return fail(`approve ${pa.hash} stuck in a mempool for over ${Math.round(s.maxPendingMs / 60_000)} min — check the wallet (nonce gap?)`);
      else if (Date.now() - pa.atMs > LiveTrader.APPROVE_PENDING_MAX_MS) return fail(`approve ${pa.hash} pending for over ${Math.round(LiveTrader.APPROVE_PENDING_MAX_MS / 60_000)} min and still in a mempool — check the wallet (nonce gap?)`);
      else return fail(`approve ${pa.hash} still pending${pa.why ? ` (${pa.why})` : ''} — sell retried after it confirms`);
    }
    const pend = mode === 'live' ? s.hasPending(me.address) : undefined;
    if (pend?.ghost) return fail(`tx ${pend.hash} (nonce ${pend.nonce}) was declared dropped but later mined, or mined after the wait limit, on ${p.chain} and is not in the ledger yet — check the wallet (E-03); after checking: /release ${pend.hash} sold | not-sold`);
    if (pend) return fail(`a previous tx ${pend.hash} (nonce ${pend.nonce}) is still unresolved on ${p.chain}${pend.why ? ` (${pend.why})` : ''} — sell retried when it settles`);
    // A balance read error ≠ a zero balance: in live this is a refusal with a reason (otherwise "nothing to sell" every 15 s and a position without an exit)
    let bal: bigint;
    try { bal = BigInt(await s.call(p.token, encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [me.address] }))); }
    catch (e) { if (mode === 'live') return fail(`balance read failed: ${err(e)} — retry later`); bal = 0n; }
    const base = p.amountRaw !== undefined ? p.amountRaw : bal;
    let amount = p.share >= 0.999 ? base : (base * BigInt(Math.floor(p.share * 10_000))) / 10_000n;
    if (amount > bal && mode === 'live') amount = bal;
    try {
      if (mode === 'shadow' && amount === 0n && p.shadowQty) { const dec = await this.decimals(s, p.token); amount = parseUnits(p.shadowQty.toFixed(Math.min(18, dec)), dec); }
      if (amount <= 0n) return fail('nothing to sell (zero balance)');
      let route: { to: `0x${string}`; data: `0x${string}`; minOut: bigint; quotedOut: bigint; spender: `0x${string}`; via: string; gas?: bigint };
      if (p.chain === 'robinhood') {
        const curve = await this.verifiedCurve(s, p.token, p.pairAddress);
        if (!curve) return fail('robinhood sell: only a Pons curve verified by the factory is supported');
        if (mode === 'shadow' && bal === 0n) return { ok: true, mode, proceedsUsd: 0, note: 'shadow: curve verified; sell quote needs real tokens on the wallet — skipped' };
        const r = await ponsSellRoute({ curve: curve as `0x${string}`, tokensIn: amount, from: me.address, slippageBps: this.d.slippageBps, call: (to, data, from) => s.call(to, data, from) });
        route = { to: r.to, data: r.data, minOut: r.minOut, quotedOut: r.quotedOut, spender: r.to, via: 'pons curve' };
      } else {
        if (!s.cfg.kyber) return fail(`no aggregator for ${p.chain}`);
        const k = await this.kyber.swap({ chain: s.cfg.kyber, tokenIn: p.token, tokenOut: NATIVE, amountIn: amount, from: me.address, slippageBps: this.d.slippageBps });
        if (!KYBER_ROUTERS.includes(k.router.toLowerCase()) || k.to.toLowerCase() !== k.router.toLowerCase()) return fail(`unexpected router ${k.router}`);
        route = { to: k.to, data: k.data, minOut: k.minOut, quotedOut: k.amountOut, spender: k.router as `0x${string}`, via: 'kyber', gas: k.gas };
      }
      const outUsd = Number(formatUnits(route.quotedOut, 18)) * nUsd;
      if (mode === 'shadow') return { ok: true, mode, proceedsUsd: outUsd, note: `${route.via}: would get ~$${outUsd.toFixed(2)}` };
      // approve for the exact amount → swap; both through the signature filter and one shared simulation. If the approval already exists (a previous approve
      // was confirmed but the swap did not go out) — the approve is not repeated
      let allowance: bigint;
      try { allowance = BigInt(await s.call(p.token, encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [me.address, route.spender] }))); }
      catch (e) { return fail(`allowance read failed: ${err(e)} — retry later`); }
      const needApprove = allowance < amount;
      const approveData = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [route.spender, amount] });
      const ctxApprove = { self: me.address, treasury: me.address, chainId: s.cfg.id, expectedTargets: [route.spender], expectedTokens: [p.token], expectedApprovals: { [p.token.toLowerCase()]: amount }, maxValueWei: 0n };
      const ctxSwap = { self: me.address, treasury: me.address, chainId: s.cfg.id, expectedTargets: [route.to], maxValueWei: 0n };
      for (const [tx, ctx] of [[{ to: p.token, data: approveData }, ctxApprove], [{ to: route.to, data: route.data }, ctxSwap]] as const) {
        const fw = checkTransaction({ ...tx, value: 0n, chainId: s.cfg.id }, ctx);
        if (!fw.allow) return fail(`firewall: ${fw.reason}`);
      }
      const calls = needApprove ? [{ to: p.token, data: approveData }, { to: route.to, data: route.data }] : [{ to: route.to, data: route.data }];
      const sim = await simulateEvmCalls(s.cfg.rpc, me.address, calls, this.fetch());
      if (!sim.supported) return fail(`live: simulation unavailable (${sim.error ?? 'eth_simulateV1'}) — not selling blind`);
      if (!sim.success) return fail(`simulation reverted: ${sim.error}`);
      const v = checkSimulationDiff(sim.diff!, { maxNativeOutWei: 0n, allowedErc20Out: { [p.token.toLowerCase()]: amount }, minReceive: { native: route.minOut - (sim.gasCostWei ?? 0n) * 2n },
        allowedApprovals: { [p.token.toLowerCase()]: { spenders: [route.spender], max: amount } }, mustReceiveSomething: true });
      if (!v.allow) return fail(v.reason);
      // Proceeds — by the simulation of this very transaction (ETH received + gas), not by the API quote
      const simOut = sim.diff!.native + (sim.gasCostWei ?? 0n);
      const realUsd = simOut > 0n ? Number(formatUnits(simOut, 18)) * nUsd : outUsd;
      if (needApprove) {
        const a = await s.send(me, { to: p.token as `0x${string}`, data: approveData, gas: 120_000n });
        this.noteApprove(p.chain, a.hash);
        // an approve "in flight" is NOT a sale: pending is not set (otherwise the monitor would take it for the swap), we remember the hash and wait for confirmation
        if (a.pending) {
          const why = a.rejected?.length ? `nodes rejected: ${a.rejected[0]}` : a.unknown?.length ? 'no answer from nodes' : undefined;
          this.pendingApprove.set(paKey, { hash: a.hash, atMs: Date.now(), why });
          return fail(`approve pending ${a.hash}${why ? ` (${why})` : ''} — sell retried after it confirms`, { approveTx: a.hash });
        }
        if (!a.ok) return fail(`approve failed ${a.hash}`, { approveTx: a.hash });
      }
      // Swap gas — from the simulation (not estimateGas on a lagging node that does not see the approve yet)
      const gas = sim.gasUsed ? (sim.gasUsed * 150n) / 100n : (route.gas ?? 600_000n);
      const sent = await s.send(me, { to: route.to, data: route.data, gas });
      // All lanes rejected the swap (insufficient funds for gas, nonce too low…): this is not a "sale in flight" — a refusal with a reason; the transaction is already
      // registered in the background (in case a gateway forwarded it) and until it is resolved hasPending will not allow a retry
      // The caller gets a refusal, nobody will wait for the outcome: if a gateway did forward the swap and it lands in a block — that is a late outcome
      // (the address is blocked, an alert to the owner), not a silent sale without accounting
      if (sent.pending && !sent.acceptedBy.length && sent.unknown?.includes('rejected-by-all-lanes')) s.abandon(sent.hash);
      if (sent.pending && !sent.acceptedBy.length && sent.unknown?.includes('rejected-by-all-lanes')) return fail(`sell rejected by all nodes: ${sent.rejected?.[0] ?? 'unknown reason'} (tx ${sent.hash} watched in background)`, { tx: sent.hash });
      // nonce and sender address — so that after a restart the sender can decide "dropped / replaced" by hash AND nonce (#135 F3)
      if (sent.pending) return fail(`sell pending: ${sent.hash}`, { pending: true, tx: sent.hash, soldRaw: amount, proceedsUsd: realUsd, nonce: sent.nonce, from: me.address });
      if (!sent.ok) return fail('sell tx failed', { tx: sent.hash });
      return { ok: true, mode, proceedsUsd: realUsd, soldRaw: amount, tx: sent.hash, note: `${route.via}: sold ${amount}` };
    } catch (e) { return fail(`sell: ${err(e)}`); }
  }

  private async buySol(p: { token: string; sizeUsd: number }, mode: LiveMode, solUsd: number, W: Wallets, fund?: () => Promise<string | undefined>): Promise<BuyResult> {
    const fail = (note: string, extra: Partial<BuyResult> = {}): BuyResult => ({ ok: false, mode, qty: 0, raw: 0n, decimals: 0, spentUsd: 0, note, ...extra });
    if (!this.sol) return fail('no Solana RPC');
    const kp = W.solTreasury;
    const lamports = BigInt(Math.floor((p.sizeUsd / solUsd) * 1e9));
    try {
      const sw = await this.jup.build({ inputMint: SOL_MINT, outputMint: p.token, amount: lamports, user: kp.publicKey.toBase58(), slippageBps: this.d.slippageBps });
      // The static part of the filter (signer, programs, accounts) — before the bridge; the simulation with balance (live) — after
      const stat = await this.sol.verifySwap(sw.tx, kp.publicKey.toBase58(), SOL_MINT, p.token, sw.minOut, false);
      if (!stat.ok) return fail(`solana firewall: ${stat.reason}`);
      const decimals = await this.solDecimals(p.token);
      const fundFail = fund ? await fund() : undefined;
      if (fundFail) return fail(fundFail);
      const chk = mode === 'live' ? await this.sol.verifySwap(sw.tx, kp.publicKey.toBase58(), SOL_MINT, p.token, sw.minOut, true) : stat;
      if (!chk.ok) return fail(`solana firewall: ${chk.reason}`);
      const sim = await this.sol.simulate(sw.tx);
      const qty = Number(formatUnits(sw.outAmount, decimals));
      if (mode === 'shadow') return { ok: true, mode, qty, raw: sw.outAmount, decimals, spentUsd: p.sizeUsd,
        note: `jupiter: would get ${qty.toPrecision(6)} (impact ${sw.priceImpactPct ?? '?'}%), programs OK, simulation ${sim.ok ? 'OK' : `failed (${sim.error}) — expected with an empty wallet`}` };
      if (!sim.ok) return fail(`simulation failed: ${sim.error}`);
      let before: bigint;
      try { before = await this.sol.tokenBalance(kp.publicKey.toBase58(), p.token); } catch (e) { return fail(`balance read failed: ${err(e)} — retry later`); }
      const r = await this.sol.send(sw.tx, kp, sw.lastValidBlockHeight);
      if (!r.ok) return fail(`send: ${r.error}`, { tx: r.sig, pending: /may still land/.test(r.error ?? '') });
      // The send is confirmed: SOL left. The balance could not be read or did not grow (lagging node) — this is NOT a "failure without a position":
      // settleBuy will record the outcome from the transaction itself (receivedInTx)
      let got: bigint;
      try { got = (await this.sol.tokenBalance(kp.publicKey.toBase58(), p.token)) - before; } catch (e) { return fail(`confirmed ${r.sig}, balance read failed (${err(e)}) — settling by tx`, { tx: r.sig, pending: true, decimals }); }
      if (got <= 0n) return fail(`confirmed ${r.sig}, token balance not yet visible — settling by tx`, { tx: r.sig, pending: true, decimals });
      const spent = await this.solSpentUsd(r.sig!, kp.publicKey.toBase58(), p.sizeUsd, solUsd);
      // #137: the swap amount itself — exactly the lamports sent to Jupiter (ExactIn); the rent of a new token account and the fee — only in the spend
      const swapUsd = Math.min((Number(lamports) / 1e9) * solUsd, spent.usd);
      return { ok: true, mode, qty: Number(formatUnits(got, decimals)), raw: got, decimals, spentUsd: spent.usd, swapUsd, tx: r.sig, note: `jupiter: got ${formatUnits(got, decimals)}${spent.note}` };
    } catch (e) { return fail(`jupiter: ${err(e)}`); }
  }

  /**
   * The actual spend of a Solana buy, $ (#135 item 3): how much SOL left the treasury in the transaction itself — the swap, the fee and the rent of a new
   * token account — at the SOL price. The entry price, floor and ladder are computed from it; previously the decision size was used. The transaction is unreadable,
   * there is no price or the number is not positive — the decision size, as before, with a mark in note (the buy does not fail because of this).
   */
  private async solSpentUsd(sig: string, owner: string, sizeUsd: number, solUsd: number | undefined): Promise<{ usd: number; note: string }> {
    const fallback = (why: string) => ({ usd: sizeUsd, note: ` (spent: decision size, ${why})` });
    if (!this.sol || !(typeof solUsd === 'number' && Number.isFinite(solUsd) && solUsd > 0)) return fallback('no SOL price');
    let lamports: bigint | undefined;
    try { lamports = await this.sol.spentLamportsInTx(sig, owner); } catch (e) { return fallback(`tx read failed: ${err(e)}`); }
    if (lamports === undefined) return fallback('tx not readable yet');
    const sol = Number(lamports) / 1e9;
    return { usd: sol * solUsd, note: ` (spent ${sol.toFixed(6)} SOL)` };
  }

  private async sellSol(p: { token: string; share: number; amountRaw?: bigint; shadowQty?: number }, mode: LiveMode, solUsd: number, W: Wallets): Promise<SellResult> {
    const fail = (note: string, extra: Partial<SellResult> = {}): SellResult => ({ ok: false, mode, proceedsUsd: 0, note, ...extra });
    if (!this.sol) return fail('no Solana RPC');
    const kp = W.solTreasury;
    let bal: bigint;
    try { bal = await this.sol.tokenBalance(kp.publicKey.toBase58(), p.token); }
    catch (e) { if (mode === 'live') return fail(`balance read failed: ${err(e)} — retry later`); bal = 0n; }
    const base = p.amountRaw !== undefined ? p.amountRaw : bal;
    let amount = p.share >= 0.999 ? base : (base * BigInt(Math.floor(p.share * 10_000))) / 10_000n;
    if (amount > bal && mode === 'live') amount = bal;
    if (mode === 'shadow' && amount === 0n && p.shadowQty) { const dec = await this.solDecimals(p.token); amount = parseUnits(p.shadowQty.toFixed(dec), dec); }
    if (amount <= 0n) return fail('nothing to sell');
    try {
      const sw = await this.jup.build({ inputMint: p.token, outputMint: SOL_MINT, amount, user: kp.publicKey.toBase58(), slippageBps: this.d.slippageBps });
      const chk = await this.sol.verifySwap(sw.tx, kp.publicKey.toBase58(), p.token, SOL_MINT, sw.minOut, mode === 'live');
      if (!chk.ok) return fail(`solana firewall: ${chk.reason}`);
      const outUsd = Number(formatUnits(sw.outAmount, 9)) * solUsd;
      if (mode === 'shadow') return { ok: true, mode, proceedsUsd: outUsd, note: `jupiter: would get ~$${outUsd.toFixed(2)}, programs OK` };
      const sim = await this.sol.simulate(sw.tx);
      if (!sim.ok) return fail(`simulation failed: ${sim.error}`);
      const r = await this.sol.send(sw.tx, kp, sw.lastValidBlockHeight);
      if (!r.ok) return fail(`send: ${r.error}`, { tx: r.sig, pending: /may still land/.test(r.error ?? '') });
      // #145: a full sale is confirmed — close the empty token account and recover the deposit. In a separate transaction and only after the sale:
      // a close failure does not cancel the sale. The recovered deposit is part of the proceeds: at the buy it went into the position's spend (#135 item 3).
      let refundUsd = 0; let closeNote = '';
      if (p.share >= 0.999) {
        try {
          const c = await this.sol.closeEmptyTokenAccounts(kp, p.token, { dustLamports: (left) => (amount > 0n ? (left * sw.outAmount) / amount : undefined) });
          refundUsd = (Number(c.refundLamports) / 1e9) * solUsd; closeNote = `; ${c.note}`;
        } catch (e) { closeNote = `; token account not closed: ${err(e)}`; }
      }
      return { ok: true, mode, proceedsUsd: outUsd + refundUsd, soldRaw: amount, tx: r.sig, note: `jupiter sell${closeNote}` };
    } catch (e) { return fail(`jupiter sell: ${err(e)}`); }
  }

  /** An approve sent but without a receipt: `${chain}:${token}` → hash and time. Until it is decided, the sale of this token is not repeated. */
  private pendingApprove = new Map<string, { hash: `0x${string}`; atMs: number; why?: string }>();
  /** Hashes of all approves sent by this process (`${chain}:${hash}`): a late approve outcome is not a ledger entry, no address block is needed for it. */
  private approveHashes = new Set<string>();
  private noteApprove(chain: Chain, hash: string) {
    this.approveHashes.add(`${chain}:${hash.toLowerCase()}`);
    if (this.approveHashes.size > 2000) this.approveHashes.delete(this.approveHashes.values().next().value!);
  }
  /** We don't wait longer than this for an approve "in flight": if the nodes don't know it — forget it and sign again; if they do — alert, keep waiting. */
  static readonly APPROVE_PENDING_MAX_MS = 20 * 60_000;
  private decCache = new Map<string, number>();
  /** The token's decimals(). An RPC error or an answer outside 0…36 — an exception: 18 must not be substituted (only a successful answer is cached). */
  private async decimals(s: EvmSender, token: string): Promise<number> {
    const k = `${s.cfg.chain}:${token.toLowerCase()}`;
    const hit = this.decCache.get(k);
    if (hit !== undefined) return hit;
    const raw = await s.call(token, encodeFunctionData({ abi: ERC20, functionName: 'decimals' }));
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(String(raw)) || BigInt(raw) > 36n) throw new Error(`decimals() returned ${String(raw).slice(0, 20)}`);
    const d = Number(BigInt(raw));
    this.decCache.set(k, d);
    return d;
  }
  private async solDecimals(mint: string): Promise<number> {
    if (this.decCache.has(`sol:${mint}`)) return this.decCache.get(`sol:${mint}`)!;
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const c = new Connection(this.d.solRpc!.rpc);
    const d = (await c.getTokenSupply(new PublicKey(mint))).value.decimals;
    this.decCache.set(`sol:${mint}`, d);
    return d;
  }
  /** eth_call with an overridden sender balance (a buy-for-ETH quote from an empty wallet in shadow). */
  private async callWithBalance(s: EvmSender, to: string, data: string, from: string, value?: bigint): Promise<string> {
    const r = await this.fetch()(s.cfg.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to, data, value: hexBig(value ?? 0n) }, 'latest', { [from]: { balance: hexBig(10n ** 22n) } }] }) });
    const j: any = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
}

/**
 * The list of live buy chains from the AGENT_LIVE_CHAINS variable (comma-separated), E-08 (#43). Empty or unset — undefined:
 * DEFAULT_LIVE_SWAP_CHAINS applies. An unknown chain name is an error at startup, not a silent skip: a typo in the list
 * must neither quietly switch a chain off nor leave the owner believing a chain is on. The list only narrows or widens
 * token BUYS; it does not restrict sales of open positions (see DEFAULT_LIVE_SWAP_CHAINS).
 */
export const LIVE_SWAP_CHAIN_NAMES: Chain[] = ['base', 'robinhood', 'arbitrum', 'solana', 'ethereum', 'bsc'];
export function liveSwapChainsFromEnv(raw: string | undefined): Chain[] | undefined {
  const names = (raw ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return undefined;
  const bad = names.filter(n => !(LIVE_SWAP_CHAIN_NAMES as string[]).includes(n));
  if (bad.length) throw new Error(`AGENT_LIVE_CHAINS: unknown chain ${bad.map(b => `"${b}"`).join(', ')} — allowed: ${LIVE_SWAP_CHAIN_NAMES.join(', ')}`);
  return [...new Set(names)] as Chain[];
}
