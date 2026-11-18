// Money on the right chain before a trade (the owner 2026-10-28: "the bot must first swap funds into the right token or the right chain").
// The right token: a buy always goes from the chain's native coin (ETH/BNB/SOL) via an aggregator (Kyber, Jupiter, Pons curve) —
// that already existed. The right chain: if the trade's chain lacks the native coin, the agent moves it via the Relay bridge from the chain
// with the most money. Only native coin → native coin, the recipient is our own wallet on the target chain.
// Safeguards: amount ≤ capital share, simulation before sending (EVM: eth_simulateV1; Solana: balance after simulation),
// waiting for the Relay status and checking that the money arrived. In shadow — only a quote, nothing is sent.
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import type { PrivateKeyAccount } from 'viem';
import type { Chain } from '../types.js';
import type { EvmSender } from './evm.js';
import { simulateEvmCalls } from '../safety/simulate.js';
import { checkTransaction, checkSimulationDiff } from '../safety/firewall.js';

export const RELAY_CHAIN_IDS: Partial<Record<Chain, number>> = { ethereum: 1, base: 8453, arbitrum: 42161, bsc: 56, robinhood: 4663, solana: 792703809 };
const EVM_NATIVE = '0x0000000000000000000000000000000000000000';
const SOL_NATIVE = '11111111111111111111111111111111';
/** EVM sender/recipient placeholder for a shadow quote without wallets (Relay accepts it). */
const EVM_PLACEHOLDER = '0x000000000000000000000000000000000000dEaD';
const nativeOf = (c: Chain) => (c === 'solana' ? SOL_NATIVE : EVM_NATIVE);
const decimalsOf = (c: Chain) => (c === 'solana' ? 9 : 18);
const err = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 160);

export interface RelayItem { status?: string; data?: any; check?: { endpoint: string; method: string } }
export interface RelayStep { id: string; kind: 'transaction' | 'signature'; items: RelayItem[] }
export interface RelayQuote { requestId?: string; steps: RelayStep[]; details?: { currencyOut?: { amount?: string; amountUsd?: string }; currencyIn?: { amountUsd?: string }; timeEstimate?: number; recipient?: string }; fees?: any }

export interface RelayClient {
  quote(q: { user: string; recipient: string; from: Chain; to: Chain; amount: bigint }): Promise<RelayQuote>;
  status(endpoint: string): Promise<string>;
}

/** Relay API (since 2026-10-02 quote/v2 requires a key: RELAY_API_KEY, dashboard.relay.link → Apps → Create an App). */
export function relayClient(apiKey: string | undefined, fetchImpl: typeof fetch = fetch, base = 'https://api.relay.link'): RelayClient {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) };
  const origin = new URL(base).origin;
  return {
    async quote({ user, recipient, from, to, amount }) {
      const o = RELAY_CHAIN_IDS[from], d = RELAY_CHAIN_IDS[to];
      if (!o || !d) throw new Error(`relay: ${!o ? from : to} not supported`);
      const r = await fetchImpl(`${base}/quote/v2`, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(15_000), body: JSON.stringify({
        user, recipient, originChainId: o, destinationChainId: d, originCurrency: nativeOf(from), destinationCurrency: nativeOf(to), amount: amount.toString(), tradeType: 'EXACT_INPUT' }) });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`relay quote HTTP ${r.status}: ${String(j?.message ?? j?.errorCode ?? '').slice(0, 120)}`);
      if (!Array.isArray(j?.steps)) throw new Error('relay quote: no steps');
      return j as RelayQuote;
    },
    async status(endpoint) {
      // The status address comes from the Relay response: the API key goes only to the Relay host, a foreign address — refusal
      const url = endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`;
      if (new URL(url).origin !== origin) throw new Error(`relay status: endpoint origin ${new URL(url).origin} is not ${origin}`);
      const r = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) }); // a redirect would carry the key to a foreign host
      const j: any = await r.json().catch(() => ({}));
      return String(j?.status ?? 'unknown');
    },
  };
}

export interface FundingDeps {
  relay?: RelayClient;
  evm: (c: Chain) => EvmSender | undefined;
  sol?: Connection;
  /** Our wallet: in shadow without a keystore — undefined (balances unknown). */
  wallets?: { evmTreasury: PrivateKeyAccount; solTreasury: Keypair };
  nativeUsd: (c: Chain) => Promise<number | undefined>;
  notify?: (t: string) => Promise<void>;
  /** Where the deposit sits (for shadow without keys): AGENT_FUND_HOME, default base. */
  home: Chain;
  /**
   * Chains the bridge may take money from (#117 item 2). Without a list — any chain with an RPC, as before. HQ passes here the chains
   * that are reconciled with the wallet: a transfer from a chain outside reconciliation would change the reconciled balance without a pair and give a false mismatch.
   */
  sources?: Chain[];
  /** No more than this capital share per transfer. */
  maxShareOfEquity: number;
  equityUsd: () => number;
  /** Wait for the Relay status no longer than (ms). */
  waitMs?: number;
  /**
   * Solana as a bridge SOURCE: forbidden by default (E-10): a leg from Solana is checked more weakly than EVM (no program allowlist
   * and no check of our SPL accounts where Jupiter buys land). Turned on only explicitly after a separate decision by the owner.
   */
  allowSolanaSource?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/** Gas reserve on a chain (USD): stays on the chain and is not transferred. */
export const GAS_RESERVE_USD: Partial<Record<Chain, number>> = { ethereum: 5, base: 0.3, arbitrum: 0.3, bsc: 0.3, robinhood: 0.3, solana: 0.5 };
const reserveOf = (c: Chain) => GAS_RESERVE_USD[c] ?? 0.5;

export interface FundResult { ok: boolean; note: string; bridged?: { from: Chain; usd: number; requestId?: string };
  /**
   * In THIS call a bridge leg left or may have left the source wallet: sent, "in flight" without a receipt, or the send broke off
   * with an error. For wallet reconciliation (#117): this flag, not the note text, shows that money is moving between chains.
   * A refusal before sending (balance, limit, quote, signature filter, simulation, pause after the previous leg) — no flag.
   */
  legSent?: boolean }

/** After a transfer without a clear outcome (status timeout, transaction "in flight") a new bridge to the same chain — no sooner than this. */
export const BRIDGE_COOLDOWN_MS = 15 * 60_000;

export class Funding {
  constructor(private d: FundingDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }
  /** A bridge to the chain is running right now (a second call for the same chain will not wait — refusal). */
  private inFlight = new Set<Chain>();
  /** Chain → until when a bridge there is forbidden (the outcome of the previous transfer is unknown: money may still arrive). */
  private cooldown = new Map<Chain, { untilMs: number; why: string }>();

  /** Native treasury balance on the chain, USD. undefined — unknown (no keys / no RPC). */
  async balanceUsd(c: Chain): Promise<number | undefined> {
    const px = await this.d.nativeUsd(c);
    if (!px || !this.d.wallets) return undefined;
    try {
      if (c === 'solana') { if (!this.d.sol) return undefined; return (await this.d.sol.getBalance(this.d.wallets.solTreasury.publicKey)) / 1e9 * px; }
      const s = this.d.evm(c); if (!s) return undefined;
      return Number(await s.balance(this.d.wallets.evmTreasury.address)) / 1e18 * px;
    } catch { return undefined; }
  }

  /**
   * Chain `chain` must hold needUsd + a gas reserve. Not enough — via the Relay bridge from the chain with the largest free balance.
   * shadow: only a quote (checks that a path exists), nothing is sent.
   */
  async ensure(chain: Chain, needUsd: number, mode: 'shadow' | 'live'): Promise<FundResult> {
    const target = needUsd + reserveOf(chain);
    const have = await this.balanceUsd(chain);
    if (have !== undefined && have >= target) return { ok: true, note: `funds on ${chain}: $${have.toFixed(2)}` };
    if (mode === 'live') {
      // Balance could not be read (RPC/price) ≠ no money: otherwise every signal would push a bridge to a chain where the money already is
      if (have === undefined) return { ok: false, note: `balance on ${chain} unknown (RPC or price) — not bridging blind` };
      // Repeat protection: a bridge to the same chain is already running, or the previous transfer there ended without a clear outcome
      if (this.inFlight.has(chain)) return { ok: false, note: `bridge to ${chain} already in progress` };
      const cd = this.cooldown.get(chain);
      if (cd && cd.untilMs > this.now()) return { ok: false, note: `bridge to ${chain} paused until ${new Date(cd.untilMs).toISOString().slice(11, 19)} UTC: ${cd.why}` };
      this.inFlight.add(chain);
      try { return await this.ensureInner(chain, needUsd, target, have, mode); } finally { this.inFlight.delete(chain); }
    }
    return this.ensureInner(chain, needUsd, target, have, mode);
  }

  private async ensureInner(chain: Chain, needUsd: number, target: number, have: number | undefined, mode: 'shadow' | 'live'): Promise<FundResult> {
    if (!this.d.relay) return have === undefined && mode === 'shadow' ? { ok: true, note: 'funding not checked (no keys in shadow, no Relay key)' }
      : { ok: false, note: `not enough on ${chain} ($${(have ?? 0).toFixed(2)} < $${target.toFixed(2)}) and no bridge configured (RELAY_API_KEY)` };
    const short = target - (have ?? 0);
    const amountUsd = short * 1.04 + 0.1; // margin for the bridge fee
    if (amountUsd > this.d.equityUsd() * this.d.maxShareOfEquity) return { ok: false, note: `bridge of $${amountUsd.toFixed(2)} exceeds ${Math.round(this.d.maxShareOfEquity * 100)}% of equity` };
    // Source: the chain with the largest free balance (Ethereum — only if it holds more than $50: gas is expensive)
    let from: Chain | undefined; let free = 0;
    if (this.d.wallets) {
      for (const c of Object.keys(RELAY_CHAIN_IDS) as Chain[]) {
        if (c === chain) continue;
        if (this.d.sources && !this.d.sources.includes(c)) continue; // source — only a chain from the list (reconciled chains)
        if (c === 'solana' && !this.d.allowSolanaSource) continue; // E-10: Solana as a source — only explicitly
        const b = await this.balanceUsd(c);
        if (b === undefined) continue;
        const f = b - reserveOf(c);
        if (c === 'ethereum' && b < 50) continue;
        if (f > free) { free = f; from = c; }
      }
      if (!from || free < amountUsd) return { ok: false, note: `not enough on ${chain} and no chain has $${amountUsd.toFixed(2)} free to bridge (best: ${from ?? 'none'} $${free.toFixed(2)})` };
    } else from = this.d.home === chain ? (chain === 'base' ? 'arbitrum' : 'base') : this.d.home;
    if (from === 'solana' && !this.d.allowSolanaSource) return { ok: false, note: 'bridge from solana is off (E-10): Solana leg is not firewalled like EVM — needs a separate decision' };
    const px = await this.d.nativeUsd(from);
    if (!px) return { ok: false, note: `no ${from} price` };
    const amount = BigInt(Math.floor((amountUsd / px) * 10 ** decimalsOf(from)));
    // Without wallets only a shadow quote is possible (E-12): its addresses are placeholders, there is nothing to send and nothing to send with
    if (!this.d.wallets && mode !== 'shadow') return { ok: false, note: 'keystore locked — the bridge needs unlocked wallets' };
    const user = from === 'solana' ? this.d.wallets?.solTreasury.publicKey.toBase58() ?? this.solPlaceholder() : this.d.wallets?.evmTreasury.address ?? EVM_PLACEHOLDER;
    const recipient = chain === 'solana' ? this.d.wallets?.solTreasury.publicKey.toBase58() ?? this.solPlaceholder() : this.d.wallets?.evmTreasury.address ?? EVM_PLACEHOLDER;
    const placeholder = this.d.wallets ? '' : ' (keystore not created yet: quoted for a placeholder address, nothing can be sent)';
    let q: RelayQuote;
    try { q = await this.d.relay.quote({ user, recipient, from, to: chain, amount }); } catch (e) { return { ok: false, note: `bridge quote ${from}→${chain}: ${err(e)}` }; }
    // A quote without a recipient or without an output amount is not a quote: refusal (previously the check was silently skipped)
    const outUsd = Number(q.details?.currencyOut?.amountUsd ?? NaN);
    if (!q.details?.recipient) return { ok: false, note: 'bridge quote: no recipient in details' };
    if (!Number.isFinite(outUsd)) return { ok: false, note: 'bridge quote: no currencyOut.amountUsd' };
    const feeUsd = amountUsd - outUsd;
    const quoteNote = `Relay ${from}→${chain}: $${amountUsd.toFixed(2)} in, $${outUsd.toFixed(2)} out (fee ≈ $${feeUsd.toFixed(2)})${q.details?.timeEstimate ? `, ~${q.details.timeEstimate}s` : ''}`;
    if (q.details.recipient.toLowerCase() !== recipient.toLowerCase()) return { ok: false, note: `bridge quote recipient mismatch (${q.details.recipient})` };
    if (outUsd < short) return { ok: false, note: `${quoteNote} — would not cover the shortfall $${short.toFixed(2)}` };
    if (mode === 'shadow') return { ok: true, note: `would bridge: ${quoteNote}${placeholder}` };
    // live: steps in order (a native coin usually has one step — deposit). Once a leg has gone on-chain, any outcome other than "money arrived"
    // puts a pause on bridging to this chain: the money may still arrive, a second bridge 15 s later would double the transfer
    let legSent = false;
    const pause = (why: string) => this.cooldown.set(chain, { untilMs: this.now() + BRIDGE_COOLDOWN_MS, why });
    try {
      for (const step of q.steps) {
        if (step.kind !== 'transaction') return { ok: false, note: `bridge: unexpected step kind ${step.kind}` };
        for (const it of step.items) {
          if (it.status === 'complete') continue;
          const res = from === 'solana' ? await this.sendSol(it, amount) : await this.sendEvm(from, it, amount);
          if (!res.ok) {
            // Transaction "in flight" (the node accepted it, no receipt): the money may still leave and arrive — pause repeat bridging to this chain
            if (res.pending) pause(`previous leg pending (${res.note})`);
            return { ok: false, note: `bridge ${step.id}: ${res.note}`, ...(legSent || res.pending ? { legSent: true } : {}) };
          }
          legSent = true;
          if (it.check?.endpoint) {
            const st = await this.waitStatus(it.check.endpoint);
            if (st !== 'success') {
              pause(`status ${st}, request ${q.requestId ?? '?'}`); // the leg left: failure/refund/timeout — money in motion, a refund will come later
              return { ok: false, note: `bridge ${from}→${chain} status: ${st} (request ${q.requestId ?? '?'})`, legSent: true };
            }
          }
        }
      }
    } catch (e) { if (legSent) pause(`error after a sent leg: ${err(e)}`); return { ok: false, note: `bridge: ${err(e)}`, ...(legSent ? { legSent: true } : {}) }; }
    const after = await this.balanceUsd(chain);
    await this.d.notify?.(`🌉 Bridge ${quoteNote} — done, ${chain} now holds $${(after ?? 0).toFixed(2)}`).catch(() => {});
    const arrived = (after ?? 0) >= needUsd;
    if (!arrived) pause(`bridged, but balance on ${chain} reads $${(after ?? 0).toFixed(2)} < $${needUsd.toFixed(2)} (lagging node?)`);
    return { ok: arrived, note: `bridged: ${quoteNote}`, bridged: { from, usd: amountUsd, requestId: q.requestId }, legSent: true };
  }

  /**
   * Bridges whose money may now be moving between chains: a transfer running right now, and a pause after a leg without a clear
   * outcome ("in flight", status not success, money not yet visible on the target chain). For wallet reconciliation and PaperExecutor.inFlight() (#117).
   */
  inTransit(): string[] {
    const out = [...this.inFlight].map(c => `bridge to ${c}: running`);
    for (const [c, cd] of this.cooldown) if (cd.untilMs > this.now() && !this.inFlight.has(c)) out.push(`bridge to ${c}: paused until ${new Date(cd.untilMs).toISOString().slice(11, 19)} UTC (${cd.why})`);
    return out;
  }

  /**
   * Solana placeholder address for a shadow quote while the keystore is not created yet (E-12 #73). Previously the system program
   * `1111…1111` was used — Relay answered HTTP 400 "is a token contract and cannot receive funds", and the whole Solana shadow buy check failed.
   * The placeholder is an ordinary address: the public key of a new keypair whose secret part is discarded at once (nothing can be signed with it).
   * One per process. It never gets into a send: without wallets ensureInner goes beyond the quote only in shadow.
   */
  private solQuoteAddr?: string;
  private solPlaceholder(): string { return (this.solQuoteAddr ??= Keypair.generate().publicKey.toBase58()); }

  private async waitStatus(endpoint: string): Promise<string> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
    const deadline = Date.now() + (this.d.waitMs ?? 5 * 60_000);
    let st = 'unknown';
    while (Date.now() < deadline) {
      st = await this.d.relay!.status(endpoint).catch(() => 'unknown');
      if (['success', 'failure', 'refund', 'refunded'].includes(st)) return st;
      await sleep(3_000);
    }
    return `timeout (${st})`;
  }

  private async sendEvm(from: Chain, it: RelayItem, amount: bigint): Promise<{ ok: boolean; note: string; pending?: boolean }> {
    const s = this.d.evm(from); const me = this.d.wallets!.evmTreasury;
    if (!s) return { ok: false, note: `no RPC for ${from}` };
    const t = it.data ?? {};
    const value = BigInt(t.value ?? 0);
    if (Number(t.chainId) !== s.cfg.id) return { ok: false, note: `wrong chain ${t.chainId}` };
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(t.to))) return { ok: false, note: 'bad target' };
    if (value > (amount * 102n) / 100n) return { ok: false, note: `value ${value} > amount` };
    // Target and calldata come from the Relay API (solver addresses cannot be pinned), so the signature filter and simulation are mandatory:
    // transfer/approve of our tokens, 7702 etc. — refusal; per the simulation only the native coin leaves, no more than amount + gas, with no new approvals
    const tx = { to: t.to as `0x${string}`, data: (t.data ?? '0x') as `0x${string}`, value };
    const fw = checkTransaction({ ...tx, chainId: s.cfg.id }, { self: me.address, treasury: me.address, chainId: s.cfg.id, expectedTargets: [tx.to], maxValueWei: (amount * 102n) / 100n });
    if (!fw.allow) return { ok: false, note: `firewall: ${fw.reason}` };
    const sim = await simulateEvmCalls(s.cfg.rpc, me.address, [tx], this.d.fetchImpl ?? fetch);
    if (!sim.supported) return { ok: false, note: `simulation unavailable on this RPC (${(sim.error ?? 'eth_simulateV1').slice(0, 80)}) — not bridging blind` };
    if (!sim.success || !sim.diff) return { ok: false, note: `simulation reverted: ${sim.error ?? ''}`.slice(0, 160) };
    const v = checkSimulationDiff(sim.diff, { maxNativeOutWei: value + (sim.gasCostWei ?? 0n) * 2n + 10n ** 15n, mustReceiveSomething: false });
    if (!v.allow) return { ok: false, note: v.reason };
    const sent = await s.send(me, { ...tx, gas: sim.gasUsed ? (sim.gasUsed * 140n) / 100n : undefined });
    return sent.ok ? { ok: true, note: sent.hash } : { ok: false, note: sent.pending ? `pending ${sent.hash}` : `failed ${sent.hash}`, pending: sent.pending };
  }

  /** Solana: Relay instructions → transaction; the only signer is our treasury; per the simulation no more SOL than amount + 0.01 leaves. */
  private async sendSol(it: RelayItem, amount: bigint): Promise<{ ok: boolean; note: string; pending?: boolean }> {
    const conn = this.d.sol; const kp = this.d.wallets!.solTreasury;
    if (!conn) return { ok: false, note: 'no Solana RPC' };
    const ins = (it.data?.instructions ?? []).map((i: any) => new TransactionInstruction({ programId: new PublicKey(i.programId),
      keys: (i.keys ?? []).map((k: any) => ({ pubkey: new PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable })), data: Buffer.from(String(i.data ?? ''), 'hex') }));
    if (!ins.length) return { ok: false, note: 'no instructions' };
    const signers = new Set(ins.flatMap((i: TransactionInstruction) => i.keys.filter(k => k.isSigner).map(k => k.pubkey.toBase58())));
    if ([...signers].some(sg => sg !== kp.publicKey.toBase58())) return { ok: false, note: 'instruction needs a foreign signer' };
    const luts = (await Promise.all((it.data?.addressLookupTableAddresses ?? []).map((a: string) => conn.getAddressLookupTable(new PublicKey(a)).then(r => r.value))))
      .filter((x): x is AddressLookupTableAccount => !!x);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ins }).compileToV0Message(luts));
    const before = await conn.getBalance(kp.publicKey);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [kp.publicKey.toBase58()] } });
    if (sim.value.err) return { ok: false, note: `simulation: ${JSON.stringify(sim.value.err).slice(0, 120)}` };
    const afterLamports = sim.value.accounts?.[0]?.lamports;
    if (afterLamports === undefined || BigInt(before) - BigInt(afterLamports) > amount + 10_000_000n) return { ok: false, note: 'simulation: SOL outflow above the bridge amount' };
    tx.sign([kp]);
    // The send broke off with an error (timeout, network) — the transaction may have gone out: this is "in flight", not "not sent" (bridge pause, legSent flag)
    let sig: string;
    try { sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }); }
    catch (e) { return { ok: false, note: `solana send error (may have been sent): ${err(e)}`, pending: true }; }
    const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed').catch(e => ({ value: { err: err(e) } }));
    return c.value.err ? { ok: false, note: `solana ${sig}: ${JSON.stringify(c.value.err).slice(0, 100)}`, pending: /timeout|expired|not confirmed/i.test(JSON.stringify(c.value.err)) } : { ok: true, note: sig };
  }
}
