// FCFS minter (public = first come, first served). The goal is to be faster than people and other agents without losing money.
//  1. Plan: how many wallets — by risk/reward (EV per wallet > 0), within the capital share and a hard cap.
//  2. Preparation (minutes before start): fund the burner wallets from the main one; get the mint calldata
//     from OpenSea for each wallet; simulate the mint "as if it had already started" (block time override);
//     sign all transactions in advance (gas, nonce, raised priority where it decides the queue).
//  3. Fire: at the start moment (L2 — exactly at T, Ethereum — at the nearest slot ≥ T) all signed transactions
//     go out simultaneously to all RPC lanes. Receipts — from the first node that answers.
//  4. Result: how many NFTs arrived on each wallet; leftover ETH returns to the main wallet.
// In shadow everything is the same except funding and sending: plan, calldata, simulation and signatures — for checking.
import { formatEther, type PrivateKeyAccount } from 'viem';
import type { EvmSender, Fees } from './evm.js';
import { checkTransaction } from '../safety/firewall.js';
import { utcMs } from '../time.js';

/** SeaDrop (OpenSea) — a shared mint contract for many drops; otherwise the target is the collection contract itself. */
export const SEADROP = ['0x00005ea00ac477b1030ce78506496e8c2de24bf5'];
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
/** Price in ETH → wei without float strings (0 and 1e-7 ETH used to break parseEther). */
export const ethToWei = (eth: number) => BigInt(Math.round(eth * 1e9)) * 1_000_000_000n;
/** NFTs that arrived on the wallet per the receipt logs: ERC-721 Transfer and ERC-1155 TransferSingle. */
export function nftsReceived(receipt: any, wallet: string): { count: number; tokenIds: string[] } {
  const w = wallet.toLowerCase(); let count = 0; const tokenIds: string[] = [];
  for (const l of receipt?.logs ?? []) {
    const t0 = String(l.topics?.[0]).toLowerCase();
    if (t0 === TRANSFER && l.topics?.length === 4 && ('0x' + String(l.topics[2]).slice(26)).toLowerCase() === w) { count++; tokenIds.push(BigInt(l.topics[3]).toString()); }
    else if (t0 === TRANSFER_SINGLE && l.topics?.length === 4 && ('0x' + String(l.topics[3]).slice(26)).toLowerCase() === w) {
      const d = String(l.data).slice(2); const id = BigInt('0x' + d.slice(0, 64)); const v = Number(BigInt('0x' + d.slice(64, 128)));
      count += v; tokenIds.push(id.toString());
    }
  }
  return { count, tokenIds };
}
/** Reserve for the L1 data fee (Base/OP; on Arbitrum/Robinhood it is in gas) — so that a "whole balance" transfer is not rejected. */
const L2_RESERVE_WEI = 5_000_000_000_000n;

export interface MintDrop { slug: string; contract: string; chain: string; startUtc: string; endUtc?: string; priceEth: number; maxPerWallet?: number;
  exitEstimateEth?: number; sellFeesPct: number; leftForPublic?: number }
export interface MintPlan { wallets: number; perWallet: number; perWalletCostEth: number; totalEth: number; evPerWalletEth: number; why: string }
export interface MintCfg { maxWallets: number; maxShareOfEquity: number; minMultipleForMany: number; pSuccess: number; gasPerMint: bigint; priorityMultiplier: number }

/**
 * How many wallets: EV per wallet = p·(exit·(1−fees) − price − gas) − (1−p)·gas of a failure.
 * EV ≤ 0 → 0 wallets. Exit / breakeven < minMultipleForMany → 1 wallet (we don't multiply something doubtful).
 * Otherwise — as many as the budget (capital share) allows, no more than the cap and no more than what is left for the public.
 */
export function planMint(drop: MintDrop, equityUsd: number, ethUsd: number, gasEthPerMint: number, c: MintCfg, budgetUsd?: number): MintPlan {
  const per = Math.max(1, drop.maxPerWallet ?? 1);
  const costEth = drop.priceEth * per + gasEthPerMint;
  const fundingGasEth = gasEthPerMint * 0.3; // ETH transfer to the wallet + returning the leftover
  const perWalletCostEth = costEth + fundingGasEth;
  // Second safeguard (the first is in nftLive): without an ETH price the $ budget is not computed (division by 0 would give an "infinite" budget)
  if (!(ethUsd > 0) || !(equityUsd > 0)) return { wallets: 0, perWallet: per, perWalletCostEth, totalEth: 0, evPerWalletEth: 0, why: 'no ETH price or equity — mint not planned' };
  const exit = drop.exitEstimateEth;
  if (!exit) return { wallets: 0, perWallet: per, perWalletCostEth, totalEth: 0, evPerWalletEth: 0, why: 'no exit price estimate (no offers / recent sales)' };
  const net = exit * (1 - drop.sellFeesPct / 100) * per;
  const ev = c.pSuccess * (net - costEth) - (1 - c.pSuccess) * gasEthPerMint - fundingGasEth;
  if (ev <= 0) return { wallets: 0, perWallet: per, perWalletCostEth, totalEth: 0, evPerWalletEth: ev, why: `EV per wallet ${ev.toFixed(6)} ETH ≤ 0` };
  const multiple = net / costEth;
  const budgetEth = Math.min(equityUsd * c.maxShareOfEquity, budgetUsd ?? Infinity) / ethUsd;
  let n = Math.floor(budgetEth / perWalletCostEth);
  if (multiple < c.minMultipleForMany) n = Math.min(n, 1);
  if (drop.leftForPublic !== undefined) n = Math.min(n, Math.max(1, Math.floor(drop.leftForPublic / per / 50))); // no more than ~2% of the remaining public supply
  n = Math.max(0, Math.min(n, c.maxWallets));
  return { wallets: n, perWallet: per, perWalletCostEth, totalEth: n * perWalletCostEth, evPerWalletEth: ev,
    why: n === 0 ? `budget ${budgetEth.toFixed(5)} ETH < one wallet ${perWalletCostEth.toFixed(5)} ETH` : `exit ×${multiple.toFixed(2)} of cost, EV ${ev.toFixed(6)} ETH/wallet, budget ${(budgetEth).toFixed(5)} ETH` };
}

/** Send moment: L2 — exactly the start; Ethereum — at the beginning of the slot whose block time is ≥ start (12 s slots). */
/** On L2 we fire 250 ms after the start: with accurate server time (chrony) these are the first blocks, not a "too early" revert. */
export const FIRE_MARGIN_MS = 250;

export function fireAtMs(chain: string, startMs: number): number {
  if (chain !== 'ethereum') return startMs;
  const GENESIS = 1606824023_000; // beacon genesis, slot 0
  const slot = Math.ceil((startMs - GENESIS) / 12_000);
  return GENESIS + slot * 12_000 - 1_500; // 1.5 s before the slot: land in this slot's block
}

export interface MintCall { to: `0x${string}`; data: `0x${string}`; value: bigint }
export type MintCalldata = (slug: string, minter: string, quantity: number) => Promise<MintCall>;

/** Mint calldata from OpenSea: POST /api/v2/drops/{slug}/mint (fields target/calldata or to/data — both forms). */
export function openSeaMintCalldata(apiKey: string, fetchImpl: typeof fetch = fetch): MintCalldata {
  return async (slug, minter, quantity) => {
    const r = await fetchImpl(`https://api.opensea.io/api/v2/drops/${encodeURIComponent(slug)}/mint`, { method: 'POST', signal: AbortSignal.timeout(8_000),
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ minter, quantity }) });
    const j: any = await r.json().catch(() => ({}));
    const t = j?.transaction ?? j;
    const to = t?.target ?? t?.to, data = t?.calldata ?? t?.data, value = t?.value ?? '0';
    if (!r.ok || !to || !data) throw new Error(`opensea mint calldata: ${JSON.stringify(j).slice(0, 160)}`);
    return { to, data, value: BigInt(value) };
  };
}

export interface ArmedMint { drop: MintDrop; plan: MintPlan; fireAt: number; signed: { wallet: string; raw: `0x${string}`; hash: `0x${string}`; value: bigint; nonce: number }[]; simulated: boolean; notes: string[] }
export interface MintResult { sent: number; included: number; minted: number; perWallet: { wallet: string; hash: string; ok: boolean; nfts: number; tokenIds: string[] }[]; spentEth: number; ms?: number }

export class Minter {
  constructor(private s: EvmSender, private calldata: MintCalldata, private cfg: MintCfg, private log: (t: string) => void = () => {}) {}

  /** Preparation: calldata, "at start" simulation, signatures. fund=true — fund the wallets (live). */
  async arm(drop: MintDrop, plan: MintPlan, treasury: PrivateKeyAccount, burners: PrivateKeyAccount[], opts: { fund: boolean }): Promise<ArmedMint> {
    const ws = burners.slice(0, plan.wallets);
    if (ws.length < plan.wallets) throw new Error(`need ${plan.wallets} burner wallets, have ${burners.length} (npm run wallets -- add N)`);
    const notes: string[] = [];
    const startMs = utcMs(drop.startUtc);
    const fees = await this.s.getFees(true);
    // Raised priority: on Ethereum/Base/BNB the tip decides the queue; on Arbitrum/Robinhood — arrival time
    const prio = this.s.cfg.priorityMatters ? this.cfg.priorityMultiplier : 1;
    const calls = await Promise.all(ws.map(w => this.calldata(drop.slug, w.address, plan.perWallet)));
    const targets = [drop.contract.toLowerCase(), ...SEADROP];
    const maxValue = (ethToWei(drop.priceEth) * BigInt(plan.perWallet) * 101n) / 100n + 1n;
    calls.forEach((c, i) => {
      const fw = checkTransaction({ to: c.to, data: c.data, value: c.value, chainId: this.s.cfg.id }, { self: ws[i].address, treasury: treasury.address, chainId: this.s.cfg.id, expectedTargets: targets, maxValueWei: maxValue });
      if (!fw.allow) throw new Error(`firewall (wallet ${i}): ${fw.reason}`);
    });
    // Simulate the first wallet's mint with block time = start + 2 s and an overridden balance
    const sim = await this.simulateAt(ws[0].address, calls[0], Math.floor(startMs / 1000) + 2);
    if (sim.ok === false) throw new Error(`mint simulation at start time reverted: ${sim.error}`);
    notes.push(sim.ok === undefined ? 'simulation with time override not supported by RPC — relying on firewall + OpenSea calldata' : `simulated at start: OK, gas ${sim.gas}`);
    const gas = sim.gas ? (sim.gas * 130n) / 100n : this.cfg.gasPerMint;
    if (opts.fund) await this.fund(treasury, ws, calls, gas, fees, prio);
    // Gas with a margin for base fee growth by the start (×3 maxFee): the excess is not charged
    const fireFees: Fees = { maxFeePerGas: fees.maxFeePerGas * 3n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, at: fees.at };
    const signed = await Promise.all(ws.map(async (w, i) => {
      const nonce = opts.fund ? await this.s.nonce(w.address) : 0;
      const t = await this.s.sign(w, { ...calls[i], gas }, { priorityMultiplier: prio, nonce, fees: fireFees });
      return { wallet: w.address, raw: t.raw, hash: t.hash, value: calls[i].value, nonce: t.nonce };
    }));
    // Server clock vs chain time: firing before the start by block time = a revert and lost gas
    let fireAt = fireAtMs(drop.chain, startMs) + (drop.chain === 'ethereum' ? 0 : FIRE_MARGIN_MS);
    const headMs = await this.s.headTimeMs().catch(() => undefined);
    if (headMs !== undefined) {
      const ahead = Date.now() - headMs; // on L2 the block is fresh (≤ 1–2 s); more — the server clock runs fast
      // Only a warning: on a quiet chain the last block can be old, and shifting the fire time would lose the race. Server time — chrony.
      if (drop.chain !== 'ethereum' && ahead > 3_000) notes.push(`⚠️ last block is ${(ahead / 1000).toFixed(1)} s old — check server time (chronyc tracking)`);
    }
    notes.push(`${signed.length} tx signed, fire at ${new Date(fireAt).toISOString()}`);
    return { drop, plan, fireAt, signed, simulated: sim.ok === true, notes };
  }

  /** Fire: wait for the moment and send all signed transactions at once. */
  async fire(a: ArmedMint, now: () => number = Date.now): Promise<MintResult> {
    const wait = a.fireAt - now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const t0 = now();
    const res = await Promise.all(a.signed.map(async s => {
      const r = await this.s.broadcast(s.raw, s.hash, { waitMs: 60_000 });
      if (r.pending) this.s.trackPending(s.wallet, s.nonce, s.hash); // mint "in flight": background resolution, as in send()
      const { count: nfts, tokenIds } = nftsReceived(r.receipt, s.wallet);
      const gasEth = r.receipt ? Number(formatEther(BigInt(r.receipt.gasUsed ?? 0) * BigInt(r.receipt.effectiveGasPrice ?? 0))) : 0;
      return { wallet: s.wallet, hash: s.hash, ok: r.ok, nfts, tokenIds, spent: gasEth + (r.ok ? Number(formatEther(s.value)) : 0) };
    }));
    const minted = res.reduce((a, r) => a + r.nfts, 0);
    const spentEth = res.reduce((a, r) => a + r.spent, 0); // mint price (only for those that went through) + gas of all, including reverted ones
    return { sent: res.length, included: res.filter(r => r.ok).length, minted, perWallet: res.map(({ spent: _s, ...r }) => r), spentEth, ms: now() - t0 };
  }

  /** Return leftover ETH from the burner wallets to the main one (after a mint/sale). */
  async sweep(burners: PrivateKeyAccount[], treasury: string): Promise<number> {
    let n = 0;
    const f = await this.s.getFees(true);
    for (const w of burners) {
      const bal = await this.s.balance(w.address).catch(() => 0n);
      const gas = await this.s.estimateGas(w.address, { to: treasury as `0x${string}`, value: 1n }).catch(() => 60_000n);
      const cost = gas * (f.maxFeePerGas + f.maxPriorityFeePerGas) + (this.s.cfg.chain === 'ethereum' ? 0n : L2_RESERVE_WEI);
      if (bal <= cost * 2n) continue;
      const r = await this.s.send(w, { to: treasury as `0x${string}`, value: bal - cost, gas }).catch(() => undefined);
      if (r?.ok) n++;
    }
    return n;
  }

  private async fund(treasury: PrivateKeyAccount, ws: PrivateKeyAccount[], calls: MintCall[], gas: bigint, f: Fees, prio: number) {
    const perGas = gas * (f.maxFeePerGas * 3n + (f.maxPriorityFeePerGas * BigInt(Math.round(prio * 100))) / 100n);
    const sends = await Promise.all(ws.map(async (w, i) => {
      const have = await this.s.balance(w.address).catch(() => 0n);
      const need = calls[i].value + perGas + (this.s.cfg.chain === 'ethereum' ? 0n : L2_RESERVE_WEI); // + L1 data fee (Base/OP)
      if (have >= need) return true;
      const gas = await this.s.estimateGas(treasury.address, { to: w.address, value: need - have }).catch(() => 60_000n);
      const r = await this.s.send(treasury, { to: w.address, value: need - have, gas });
      return r.ok;
    }));
    if (sends.some(x => !x)) throw new Error('funding of burner wallets failed');
    this.log(`funded ${ws.length} wallets`);
  }

  private async simulateAt(from: string, c: MintCall, ts: number): Promise<{ ok?: boolean; error?: string; gas?: bigint }> {
    const hex = (v: bigint | number) => `0x${v.toString(16)}`;
    const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ blockOverrides: { time: hex(ts) }, stateOverrides: { [from]: { balance: hex(10n ** 21n) } },
      calls: [{ from, to: c.to, data: c.data, value: hex(c.value) }] }], validation: false }, 'latest'] };
    try {
      const r = await fetch(this.s.cfg.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const j: any = await r.json();
      if (j.error) return /not (found|supported|available)|does not exist|method/i.test(j.error.message ?? '') ? {} : { ok: false, error: j.error.message };
      const call = j.result?.[0]?.calls?.[0];
      if (!call) return {};
      return call.status === '0x1' ? { ok: true, gas: BigInt(call.gasUsed) } : { ok: false, error: call.error?.message ?? 'reverted' };
    } catch { return {}; }
  }
}
