// Live NFTs: FCFS mint from a wallet pool (Minter), secondary buys and sales into the best OpenSea offers, sweeping leftovers.
// A mint is "armed" 3 minutes before the public start and fires at the start; a repeated call for the same drop
// (e.g. a deferred action at its due time) does not create a second mint. Risk limits are checked at planning and before firing.
import { Wallets, newKeyMaterial } from './keystore.js';
import type { LiveTrader } from './trader.js';
import { Minter, planMint, openSeaMintCalldata, nftsReceived, type MintCfg, type MintDrop, type MintResult, type MintCalldata } from './minter.js';
import { OPENSEA_CONDUIT, SEAPORT, type OpenSeaTrade } from './openseaTrade.js';
import { checkTransaction, checkSimulationDiff } from '../safety/firewall.js';
import { simulateEvmCalls } from '../safety/simulate.js';
import { utcMs } from '../time.js';
import type { Decision } from '../types.js';
import { encodeFunctionData, parseAbi, formatEther, type PrivateKeyAccount } from 'viem';

const NFT_ABI = parseAbi(['function setApprovalForAll(address operator, bool approved)', 'function isApprovedForAll(address owner, address operator) view returns (bool)']);
const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const ARM_BEFORE_MS = 3 * 60_000;
/** Gas for selling an NFT into an offer from a burner wallet (approve to the conduit + fulfillment). */
const SELL_GAS = 400_000n;

export interface NftHolding { wallet: string; tokenIds: string[] }
export interface LiveMintOutcome { minted: number; holdings: NftHolding[]; spentEth: number; result: MintResult }
export interface NftLiveDeps {
  trader: LiveTrader; wallets?: Wallets; openseaKey?: string; trade?: OpenSeaTrade; cfg: MintCfg; equityUsd: () => number; ethUsd: () => number;
  notify: (t: string) => Promise<void>; now?: () => number; calldata?: MintCalldata;
  /** Risk control: undefined — allowed, a string — why not (stops, cash net of reserved, position limit, already held). */
  guard?: (usd: number, token: string) => string | undefined;
  /** Mint budget by source score (USD): a low-score source gets fewer wallets. */
  budgetUsd?: (d: Decision) => number;
  /** WETH per chain — a sale into an offer pays in WETH. */
  weth?: Record<string, string>;
}

export class NftLive {
  private armed = new Set<string>();
  /** Burner wallets taken by a mint (address → drop): two drops do not share wallets and do not drain each other. */
  private leased = new Map<string, string>();
  /** Reserved for armed live mints (USD): two simultaneous mints do not pass the cash check on the same money. */
  private reservedUsd = 0;
  reserved() { return this.reservedUsd; }
  constructor(private d: NftLiveDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }

  /**
   * Mint: plan by risk/reward (gas — at the current chain price) → preparation 3 min before start → fire at the start.
   * shadow: no funding and no sending — a "what we would do" report. onDone is called after firing (live).
   */
  async schedule(d: Decision, mode: 'shadow' | 'live', onDone?: (o: LiveMintOutcome) => Promise<void>): Promise<string> {
    const n = d.nft!;
    const key = `${d.chain}:${n.slug}`;
    if (this.armed.has(key)) return 'already armed for this drop';
    const s = this.d.trader.sender(d.chain);
    if (!s) return `no RPC for ${d.chain}`;
    if (!this.d.openseaKey && !this.d.calldata) return 'no OpenSea key for mint calldata';
    const W = this.d.wallets;
    if (!W && mode === 'live') return 'keystore locked';
    // The ETH price is needed for the $ budget: zero or stale (after #47 index.ts passes 0 here if the price is older than 10 min) — the mint is not planned
    if (!(this.d.ethUsd() > 0)) return 'no fresh ETH price — mint not planned';
    const drop: MintDrop = { slug: n.slug, contract: n.contract, chain: d.chain, startUtc: n.publicStartUtc ?? new Date(this.now()).toISOString(), endUtc: n.publicEndUtc,
      priceEth: n.priceEth, maxPerWallet: n.maxPerWallet, exitEstimateEth: n.exitEstimateEth, sellFeesPct: n.sellFeesPct, leftForPublic: n.leftForPublic };
    const fees = await s.getFees().catch(() => undefined);
    const gasEth = fees ? Number(formatEther(this.d.cfg.gasPerMint * (fees.maxFeePerGas + fees.maxPriorityFeePerGas * BigInt(Math.round(this.d.cfg.priorityMultiplier)))))
      : Number(this.d.cfg.gasPerMint) * 30e-9; // without RPC — conservatively 30 gwei
    const plan = planMint(drop, this.d.equityUsd(), this.d.ethUsd(), gasEth, this.d.cfg, this.d.budgetUsd?.(d));
    if (plan.wallets === 0) return `mint plan: 0 wallets — ${plan.why}`;
    const totalUsd = plan.totalEth * this.d.ethUsd();
    const token = `nft:${n.slug}`;
    const blocked = mode === 'live' ? this.d.guard?.(totalUsd, token) : undefined;
    if (blocked) return `mint blocked by risk control: ${blocked}`;
    // Mint money — on the mint chain in advance (3 min before start it only needs to be spread across the wallets)
    let fundNote = '';
    if (this.d.trader.funding) {
      const f = await this.d.trader.funding.ensure(d.chain, totalUsd, mode).catch(e => ({ ok: false, note: String(e).slice(0, 120) }));
      if (!f.ok) return `mint funding: ${f.note}`;
      fundNote = ` · ${f.note}`;
    }
    // Free burner wallets
    const pool = (W ?? new Wallets(newKeyMaterial(plan.wallets))).evmBurners.filter(b => !this.leased.has(b.address.toLowerCase()));
    if (pool.length < plan.wallets) return `need ${plan.wallets} free burner wallets, have ${pool.length} (npm run wallets -- add N)`;
    const burners = pool.slice(0, plan.wallets);
    this.armed.add(key);
    if (mode === 'live') { for (const b of burners) this.leased.set(b.address.toLowerCase(), key); this.reservedUsd += totalUsd; }
    let unreserved = false;
    const unreserve = () => { if (mode === 'live' && !unreserved) { unreserved = true; this.reservedUsd = Math.max(0, this.reservedUsd - totalUsd); } };
    const release = () => { for (const b of burners) if (this.leased.get(b.address.toLowerCase()) === key) this.leased.delete(b.address.toLowerCase()); };
    const minter = new Minter(s, this.d.calldata ?? openSeaMintCalldata(this.d.openseaKey!), this.d.cfg);
    const startMs = utcMs(drop.startUtc);
    const armAt = Math.max(this.now(), startMs - ARM_BEFORE_MS);
    setTimeout(async () => {
      const treasury = (W ?? new Wallets(newKeyMaterial(0))).evmTreasury;
      const say = (t: string) => this.d.notify(t).catch(() => undefined); // a Telegram failure must not affect mint accounting
      const dropSigned = () => { for (const b of burners) s.resetNonce(b.address); }; // signed but not sent — the nonces are free
      let stage: 'arm' | 'fire' | 'done' = 'arm';
      let res: MintResult | undefined;
      try {
        // Hours may have passed between the plan and arming: the stop, the ETH price and the $ cap are checked again (#117 item 6)
        const again = mode === 'live' ? (this.d.guard?.(0, '') ?? this.budgetProblem(plan.totalEth, d)) : undefined;
        if (again) throw new Error(`risk control before arming: ${again}`);
        const armed = await minter.arm(drop, plan, treasury, burners, { fund: mode === 'live' });
        await say(`🎯 Mint ${n.slug}: ${mode === 'live' ? 'armed' : 'SHADOW — would be armed'} on ${plan.wallets} wallet(s) × ${plan.perWallet}, budget ${plan.totalEth.toFixed(5)} ETH ($${totalUsd.toFixed(2)}). ${plan.why}. ${armed.notes.join('; ')}`);
        // And once more right before firing: arming waits for the public start, the price may have gone stale or risen meanwhile
        const halt = mode === 'live' ? (this.d.guard?.(0, '') ?? this.budgetProblem(plan.totalEth, d)) : undefined;
        if (mode === 'shadow') dropSigned();
        else if (halt) { dropSigned(); await say(`🎯 Mint ${n.slug} cancelled before firing: ${halt}. Returning ETH from the wallets.`); await minter.sweep(burners, treasury.address).catch(() => 0); }
        else {
          stage = 'fire';
          res = await minter.fire(armed, () => this.now());
          stage = 'done';
        }
      } catch (e) {
        if (stage === 'arm') {
          dropSigned();
          await say(`⚠️ Mint ${n.slug} did not happen: ${String((e as Error).message ?? e).slice(0, 220)}`);
          if (mode === 'live') { await minter.sweep(burners, treasury.address).catch(() => 0); }
        } else await say(`⚠️ Mint ${n.slug}: error while firing — ${String((e as Error).message ?? e).slice(0, 200)}. Check the wallets.`);
      }
      try {
        if (res && mode === 'live') {
          await say(`🎯 Mint ${n.slug}: sent ${res.sent}, included ${res.included}, NFT ${res.minted}, spent ${res.spentEth.toFixed(5)} ETH, ${res.ms} ms`);
          const holdings = res.perWallet.filter(w => w.nfts > 0).map(w => ({ wallet: w.wallet, tokenIds: w.tokenIds }));
          // Leftover ETH — always home (NFTs stay on the wallets; gas for the sale is added before the sale)
          await minter.sweep(burners, treasury.address).catch(() => 0);
          if (onDone) await onDone({ minted: res.minted, holdings, spentEth: res.spentEth, result: res }); // the firing result is recorded in any case
        }
      } catch (e) { await say(`⚠️ Mint ${n.slug}: result not recorded (${String((e as Error).message ?? e).slice(0, 160)}) — NFTs on wallets: ${res?.perWallet.filter(w => w.nfts).map(w => w.wallet).join(', ')}`); }
      finally {
        unreserve();
        if (mode === 'shadow') this.armed.delete(key); else setTimeout(() => this.armed.delete(key), 3600_000);
        release(); // ETH from the wallets is returned; NFTs stay on them (sale — by token id), the wallets are free again
      }
    }, Math.max(0, armAt - this.now()));
    return `${mode === 'live' ? 'armed' : 'shadow-armed'}: ${plan.wallets} wallet(s) at ${drop.startUtc} (prepare at ${new Date(armAt).toISOString().slice(11, 19)} UTC)${fundNote}`;
  }

  /** After a restart: return ETH from burner wallets not taken by a mint (a mint armed before the restart is cancelled — money goes home). */
  async sweepIdle(chain: Decision['chain']): Promise<number> {
    const s = this.d.trader.sender(chain); const W = this.d.wallets;
    if (!s || !W) return 0;
    const m = new Minter(s, async () => { throw new Error('unused'); }, this.d.cfg);
    // While the sweep runs, ETH from burner wallets reaches the treasury outside accounting: wallet reconciliation must wait (#117 item 3)
    this.sweeping.set(chain, (this.sweeping.get(chain) ?? 0) + 1);
    try { return await m.sweep(W.evmBurners.filter(b => !this.leased.has(b.address.toLowerCase())), W.evmTreasury.address); }
    finally { const n = (this.sweeping.get(chain) ?? 1) - 1; if (n > 0) this.sweeping.set(chain, n); else this.sweeping.delete(chain); }
  }
  private sweeping = new Map<string, number>();
  /** What in the NFT part is moving treasury money outside accounting right now: the burner-wallet sweep and a reserved mint. */
  inFlight(): string[] {
    const out = [...this.sweeping.keys()].map(c => `sweeping leftovers from burner wallets (${c})`);
    if (this.reservedUsd > 0) out.push(`mint (reserve $${this.reservedUsd.toFixed(2)})`);
    return out;
  }

  /**
   * Mint budget in ETH at arming or firing time: the ETH price must be fresh (ethUsd() > 0), and the $ budget at the CURRENT price —
   * no higher than the same cap the plan was built on (capital share and decision budget), with a 2 % margin. The refusal reason or undefined.
   */
  budgetProblem(totalEth: number, d: Decision): string | undefined {
    const px = this.d.ethUsd();
    if (!(px > 0) || !Number.isFinite(px)) return 'no fresh ETH price';
    const cap = Math.min(this.d.equityUsd() * this.d.cfg.maxShareOfEquity, this.d.budgetUsd?.(d) ?? Infinity);
    const usd = totalEth * px;
    return usd > cap * 1.02 ? `mint budget $${usd.toFixed(2)} at the current ETH price exceeds the cap $${cap.toFixed(2)}` : undefined;
  }

  private account(h: string): PrivateKeyAccount | undefined {
    const W = this.d.wallets; if (!W) return undefined;
    return W.evmBurners.find(b => b.address.toLowerCase() === h.toLowerCase()) ?? (W.evmTreasury.address.toLowerCase() === h.toLowerCase() ? W.evmTreasury : undefined);
  }

  /** Buy the cheapest collection listing from the main wallet. Price — no higher than maxPriceEth (recomputed at the moment of purchase). */
  async buyFloor(p: { slug: string; contract: string; chain: string; maxPriceEth: number; /** purchase cap in $ (decision size) */ maxUsd?: number }, mode: 'shadow' | 'live'): Promise<{ ok: boolean; holdings: NftHolding[]; spentEth: number; note: string; pending?: boolean }> {
    const fail = (note: string, pending = false) => ({ ok: false, holdings: [] as NftHolding[], spentEth: 0, note, pending });
    if (!this.d.trade) return fail('no OpenSea trade client');
    const s = this.d.trader.sender(p.chain as any);
    if (!s) return fail(`no RPC for ${p.chain}`);
    const W = this.d.wallets ?? (mode === 'shadow' ? new Wallets(newKeyMaterial(0)) : undefined);
    if (!W) return fail('keystore locked');
    if (!(this.d.ethUsd() > 0)) return fail('no fresh ETH price');
    const me = W.evmTreasury;
    try {
      const l = await this.d.trade.bestListing(p.slug);
      if (!l) return fail('no listings');
      const priceEth = Number(formatEther(l.priceWei));
      if (priceEth > p.maxPriceEth * 1.02) return fail(`floor moved: ${priceEth} ETH > ${p.maxPriceEth}`);
      // $ cap at the current ETH price (#117 item 6): the ETH price of the NFT may have held while ETH itself rose since the decision
      const usd = priceEth * this.d.ethUsd();
      if (p.maxUsd !== undefined && !(usd <= p.maxUsd * 1.02)) return fail(`price $${usd.toFixed(2)} at the current ETH price exceeds the decision size $${p.maxUsd.toFixed(2)}`);
      if (this.d.trader.funding) {
        const f = await this.d.trader.funding.ensure(p.chain as any, priceEth * this.d.ethUsd() * 1.02, mode).catch(e => ({ ok: false, note: String(e).slice(0, 120) }));
        if (!f.ok) return fail(`funding: ${f.note}`);
      }
      const tx = await this.d.trade.buyListingTx(l, me.address);
      const fw = checkTransaction({ ...tx, chainId: s.cfg.id }, { self: me.address, treasury: me.address, chainId: s.cfg.id, expectedTargets: SEAPORT, maxValueWei: (l.priceWei * 101n) / 100n });
      if (!fw.allow) return fail(`firewall: ${fw.reason}`);
      // Simulation: an NFT of this collection must arrive, no more ETH than price + gas must leave
      const sim = await simulateEvmCalls(s.cfg.rpc, me.address, [tx], fetch, mode === 'shadow' ? { [me.address]: { balance: '0x' + (10n ** 21n).toString(16) } } : undefined);
      if (sim.supported && !sim.success) return fail(`simulation reverted: ${sim.error}`);
      if (sim.supported && sim.diff) {
        const v = checkSimulationDiff(sim.diff, { maxNativeOutWei: tx.value + (sim.gasCostWei ?? 0n) * 2n, minReceive: { [p.contract.toLowerCase()]: 1n }, mustReceiveSomething: true });
        if (!v.allow) return fail(v.reason);
      }
      if (mode === 'shadow') return { ok: true, holdings: [], spentEth: priceEth, note: `would buy 1 ${p.slug} at ${priceEth} ETH via Seaport, ${sim.supported ? 'simulated OK' : 'simulation unavailable — live would refuse'}` };
      if (!sim.supported) return fail('live: simulation unavailable — not buying blind');
      const r = await s.send(me, { ...tx, gas: sim.gasUsed ? (sim.gasUsed * 140n) / 100n : undefined });
      if (r.pending) return fail(`buy pending ${r.hash} — check the wallet`, true);
      if (!r.ok) return fail(`buy tx failed ${r.hash}`);
      const got = nftsReceived(r.receipt, me.address);
      const gasEth = Number(formatEther(BigInt(r.receipt.gasUsed ?? 0) * BigInt(r.receipt.effectiveGasPrice ?? 0)));
      // The receipt succeeded — the purchase happened even if the id was not parsed (the position is recorded anyway)
      return { ok: true, holdings: [{ wallet: me.address, tokenIds: got.tokenIds }], spentEth: priceEth + gasEth, note: `bought ${got.count || 1} ${p.slug}${got.tokenIds.length ? '' : ' (token id not parsed — sell manually)'}` };
    } catch (e) { return fail(String((e as Error).message ?? e).slice(0, 200)); }
  }

  /**
   * Sell the position's NFTs into the best OpenSea offers — only if the offer is ≥ minPriceEth. Returns exactly what was sold
   * (the position is closed only for what was sold). WETH and leftover ETH from burner wallets — to the main one.
   */
  async sellAll(p: { slug: string; contract: string; chain: string; holdings: NftHolding[]; minPriceEth: number }, mode: 'shadow' | 'live'):
    Promise<{ ok: boolean; proceedsEth: number; sold: NftHolding[]; note: string }> {
    const none = (note: string) => ({ ok: false, proceedsEth: 0, sold: [] as NftHolding[], note });
    if (!this.d.trade) return none('no OpenSea trade client');
    const s = this.d.trader.sender(p.chain as any);
    if (!s) return none(`no RPC for ${p.chain}`);
    const W = this.d.wallets;
    if (!W) return none('keystore locked');
    const weth = this.d.weth?.[p.chain];
    const minWei = BigInt(Math.floor(p.minPriceEth * 1e9)) * 1_000_000_000n;
    let proceeds = 0; const sold: NftHolding[] = []; const errs: string[] = [];
    for (const h of p.holdings) {
      const acc = this.account(h.wallet);
      if (!acc) { errs.push(`no key for ${h.wallet}`); continue; }
      const soldHere: string[] = [];
      for (const id of h.tokenIds) {
        try {
          const offer = await this.d.trade.bestOffer(p.slug);
          if (!offer) { errs.push('no offers'); break; }
          if (offer.priceWei < minWei) { errs.push(`best offer ${formatEther(offer.priceWei)} ETH < minimum ${p.minPriceEth}`); break; }
          const tx = await this.d.trade.acceptOfferTx(offer, acc.address, p.contract, id);
          // Separate contexts: the sale — only on Seaport; the approval — only to the OpenSea conduit on the collection contract
          const fwSell = checkTransaction({ ...tx, chainId: s.cfg.id }, { self: acc.address, treasury: W.evmTreasury.address, chainId: s.cfg.id, expectedTargets: SEAPORT, maxValueWei: 0n });
          if (!fwSell.allow) { errs.push(`firewall: ${fwSell.reason}`); continue; }
          const approveData = encodeFunctionData({ abi: NFT_ABI, functionName: 'setApprovalForAll', args: [OPENSEA_CONDUIT as `0x${string}`, true] });
          const fwAppr = checkTransaction({ to: p.contract, data: approveData, value: 0n, chainId: s.cfg.id }, { self: acc.address, treasury: W.evmTreasury.address, chainId: s.cfg.id, expectedTargets: [p.contract], approvalOperatorsAllowlist: [OPENSEA_CONDUIT], maxValueWei: 0n });
          if (!fwAppr.allow) { errs.push(`firewall: ${fwAppr.reason}`); continue; }
          const approved = await s.call(p.contract, encodeFunctionData({ abi: NFT_ABI, functionName: 'isApprovedForAll', args: [acc.address, OPENSEA_CONDUIT as `0x${string}`] })).then(r => BigInt(r) === 1n).catch(() => false);
          const calls = approved ? [tx] : [{ to: p.contract as `0x${string}`, data: approveData, value: 0n }, tx];
          const sim = await simulateEvmCalls(s.cfg.rpc, acc.address, calls, fetch, mode === 'shadow' ? { [acc.address]: { balance: '0x' + (10n ** 20n).toString(16) } } : undefined);
          if (sim.supported && !sim.success) { errs.push(`simulation reverted: ${sim.error}`); continue; }
          if (sim.supported && sim.diff) {
            const minRecv = weth ? { [weth.toLowerCase()]: (minWei * 90n) / 100n } : undefined; // offer minus fees
            const v = checkSimulationDiff(sim.diff, { maxNativeOutWei: (sim.gasCostWei ?? 0n) * 3n, allowedNftOut: { [p.contract.toLowerCase()]: 1 }, minReceive: minRecv, mustReceiveSomething: true,
              approvalOperatorsAllowlist: [OPENSEA_CONDUIT] });
            if (!v.allow) { errs.push(v.reason); continue; }
          }
          if (mode === 'shadow') { proceeds += Number(formatEther(offer.priceWei)); soldHere.push(id); continue; }
          if (!sim.supported) { errs.push('simulation unavailable — not selling blind'); break; }
          await this.ensureGas(s, W.evmTreasury, acc, SELL_GAS);
          if (!approved) { const ar = await s.send(acc, { to: p.contract as `0x${string}`, data: approveData, gas: 100_000n }); if (!ar.ok) { errs.push('approval tx failed'); continue; } }
          const r = await s.send(acc, { ...tx, gas: sim.gasUsed ? (sim.gasUsed * 150n) / 100n : SELL_GAS });
          if (r.ok) { proceeds += Number(formatEther(offer.priceWei)); soldHere.push(id); } else errs.push(r.pending ? `sell ${id} pending ${r.hash}` : `sell ${id} failed`);
        } catch (e) { errs.push(String((e as Error).message ?? e).slice(0, 100)); }
      }
      if (soldHere.length) sold.push({ wallet: h.wallet, tokenIds: soldHere });
      if (mode === 'live' && acc !== W.evmTreasury) await this.sweepTo(s, acc, W.evmTreasury.address, weth).catch(() => undefined);
    }
    return { ok: sold.length > 0, proceedsEth: proceeds, sold, note: `${mode === 'shadow' ? 'would sell' : 'sold'} ${sold.reduce((a, h) => a + h.tokenIds.length, 0)} NFT${errs.length ? `; issues: ${[...new Set(errs)].join('; ')}` : ''}` };
  }

  /** Gas to the wallet before a sale: from the main one, exactly as much as is missing. */
  private async ensureGas(s: NonNullable<ReturnType<LiveTrader['sender']>>, treasury: PrivateKeyAccount, acc: PrivateKeyAccount, gas: bigint) {
    if (acc.address === treasury.address) return;
    const f = await s.getFees(true);
    const need = gas * (f.maxFeePerGas + f.maxPriorityFeePerGas) + 5_000_000_000_000n;
    const have = await s.balance(acc.address);
    if (have >= need) return;
    const r = await s.send(treasury, { to: acc.address, value: need - have });
    if (!r.ok) throw new Error('gas top-up failed');
  }
  /** WETH and ETH from a burner wallet — to the main one (the filter allows transfers to the treasury). */
  private async sweepTo(s: NonNullable<ReturnType<LiveTrader['sender']>>, acc: PrivateKeyAccount, treasury: string, weth?: string) {
    if (weth) {
      const bal = BigInt(await s.call(weth, encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [acc.address] })).catch(() => '0x0'));
      if (bal > 0n) {
        const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [treasury as `0x${string}`, bal] });
        const fw = checkTransaction({ to: weth, data, value: 0n, chainId: s.cfg.id }, { self: acc.address, treasury: treasury as `0x${string}`, chainId: s.cfg.id, expectedTargets: [], expectedTokens: [weth], maxValueWei: 0n });
        if (fw.allow) await s.send(acc, { to: weth as `0x${string}`, data, gas: 100_000n });
      }
    }
    await new Minter(s, async () => { throw new Error('unused'); }, this.d.cfg).sweep([acc], treasury);
  }
}
