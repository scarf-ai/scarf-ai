// Hard cutoffs in code, without the model (cost-saving option 2, the owner's decision 2026-10-27).
// Only facts that the model's opinion does not change: honeypot, authority to mint/freeze tokens, tiny liquidity.
// There is no "pair older than 30 days and −90%" rule: tokens and NFTs make comebacks (the owner).
import type { Chain } from '../types.js';
import type { MarketInfo, RugInfo } from './token.js';

export interface HoneypotInfo { isHoneypot: boolean; reason?: string; buyTax?: number; sellTax?: number }
export type HoneypotCheck = (chain: Chain, address: string) => Promise<HoneypotInfo | undefined>;

/** honeypot.is: buy and sell simulation (Ethereum, BNB Chain, Base). No data — undefined (not an argument). */
const HP_CHAIN: Partial<Record<Chain, number>> = { ethereum: 1, bsc: 56, base: 8453 };
export function honeypotIs(fetchImpl: typeof fetch = fetch): HoneypotCheck {
  return async (chain, address) => {
    const id = HP_CHAIN[chain];
    if (!id || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
    const r = await fetchImpl(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${id}`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    if (!j?.simulationSuccess && !j?.honeypotResult?.isHoneypot) return undefined;
    return { isHoneypot: !!j?.honeypotResult?.isHoneypot, reason: j?.honeypotResult?.honeypotReason, buyTax: j?.simulationResult?.buyTax, sellTax: j?.simulationResult?.sellTax };
  };
}

export interface HardFacts { address: string; market?: MarketInfo; rug?: RugInfo; honeypot?: HoneypotInfo }

/**
 * Reasons to cut a token without the model. Empty list — the token goes to the Analyst.
 * strictLiquidity: the "liquidity < $3k" rule — only for sources with score ≤ 6 and pairs older than an hour
 * (fresh tokens on the Pons curve start with low liquidity, and a trusted call is early).
 */
export function hardRejectReasons(f: HardFacts, opts: { strictLiquidity: boolean; minLiquidityUsd?: number }): { verdict: 'avoid' | 'ignore'; reasons: string[] } | undefined {
  const avoid: string[] = [];
  if (f.honeypot?.isHoneypot) avoid.push(`honeypot (simulation: ${f.honeypot.reason ?? 'cannot sell'})`);
  else if ((f.honeypot?.sellTax ?? 0) >= 50) avoid.push(`sell tax ${f.honeypot!.sellTax}%`);
  if (f.rug?.freezeOrMintAuthority) avoid.push('mint/freeze authority is still active (can mint or freeze holders)');
  const m = f.market;
  if (m?.priceUsd && (m.buys24h ?? 0) >= 30 && (m.sells24h ?? 0) === 0) avoid.push(`${m.buys24h} buys and 0 sells in 24h (sells look blocked)`);
  if (avoid.length) return { verdict: 'avoid', reasons: avoid };
  const min = opts.minLiquidityUsd ?? 3000;
  if (opts.strictLiquidity && m?.priceUsd && m.liquidityUsd !== undefined && m.liquidityUsd < min && (m.pairAgeMinutes ?? 0) >= 60)
    return { verdict: 'ignore', reasons: [`liquidity $${Math.round(m.liquidityUsd)} < $${min} on a pair older than 1 h`] };
  return undefined;
}
