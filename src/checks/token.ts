// Token checks before a buy: market (DexScreener) and safety (RugCheck for Solana).
// "Safety checks" (can it be sold: freeze/mint authority, trap) — at any score.
// "Quality checks" (liquidity, pair age, activity) — depend on the trust tier.
import type { Chain, Tier, TokenCheck } from '../types.js';

export const DEXSCREENER_CHAIN: Record<Chain, string | undefined> = {
  solana: 'solana', ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', bsc: 'bsc', polygon: 'polygon', robinhood: 'robinhood', unknown: undefined,
};

export interface MarketInfo { chain: Chain; symbol?: string; priceUsd?: number; liquidityUsd?: number; fdvUsd?: number; pairAgeMinutes?: number; buys24h?: number; sells24h?: number; pairAddress?: string; dexId?: string;
  /** Price change over the last hour, % (DexScreener priceChange.h1). S-02: the "don't chase the pump" rule. No data — undefined, not 0. */
  priceChangeH1Pct?: number;
  /** From the token profile on DexScreener: X account, Telegram, websites. */
  twitter?: string; telegram?: string; websites?: string[] }

/** X handle from an x.com/handle or twitter.com/handle link. */
export function xHandleFromUrl(u: string): string | undefined {
  const m = u.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  return m && !['i', 'home', 'search', 'intent', 'share', 'hashtag'].includes(m[1].toLowerCase()) ? m[1] : undefined;
}

/** A decimal number in a string (sign, fraction, exponent). "0x10", "0b1", "1_000", "Infinity" are not numbers. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A percentage from an API response: a number or a string with a decimal number. null, an empty string, a missing field, a non-number and a non-decimal
 * notation ("0x10" — Number() would give 16) are "no data" (undefined), not 0 % and not a random number (#129).
 */
function percentOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && DECIMAL.test(v.trim())) { const n = Number(v.trim()); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

/** Clock tolerance: a pair creation date later than "now" by no more than this — age 0; further in the future — no data. */
export const PAIR_CREATED_FUTURE_SKEW_MS = 2 * 60_000;
/** pairCreatedAt below this is not milliseconds (Unix seconds are 10 digits): the unit is unclear, no age. */
export const PAIR_CREATED_MIN_MS = 1e11;

/**
 * Pair age, min, from pairCreatedAt (ms UTC; a number or a string of digits). No date, a non-number ("soon") or a date in the future beyond
 * the clock tolerance — undefined ("no data"), not NaN and not 0 ("fresh pair") (#129).
 */
export function pairAgeMinutesFrom(createdAt: unknown, nowMs: number): number | undefined {
  const t = typeof createdAt === 'number' ? createdAt : typeof createdAt === 'string' && /^\d+$/.test(createdAt.trim()) ? Number(createdAt.trim()) : NaN;
  if (!Number.isFinite(t) || t <= 0) return undefined;
  // Looks like seconds, not ms (< 1e11 — in ms that is before March 1973): the unit is unclear — "no data", not a 50+ year old pair
  if (t < PAIR_CREATED_MIN_MS) return undefined;
  if (t - nowMs > PAIR_CREATED_FUTURE_SKEW_MS) return undefined;
  return Math.max(0, (nowMs - t) / 60000);
}

/** Parses the DexScreener /latest/dex/tokens/{address} response: takes the pair with the highest liquidity. */
export function parseDexScreener(json: any, address: string, nowMs: number): MarketInfo | undefined {
  const pairs: any[] = (json?.pairs ?? []).filter((p: any) => (p?.baseToken?.address ?? '').toLowerCase() === address.toLowerCase());
  if (!pairs.length) return undefined;
  pairs.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
  const p = pairs[0];
  const chain = (Object.entries(DEXSCREENER_CHAIN).find(([, v]) => v === p.chainId)?.[0] ?? 'unknown') as Chain;
  return {
    chain, symbol: p.baseToken?.symbol ? String(p.baseToken.symbol).slice(0, 20) : undefined,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
    liquidityUsd: p.liquidity?.usd,
    fdvUsd: p.fdv,
    pairAgeMinutes: pairAgeMinutesFrom(p.pairCreatedAt, nowMs),
    buys24h: p.txns?.h24?.buys, sells24h: p.txns?.h24?.sells,
    priceChangeH1Pct: percentOrUndefined(p.priceChange?.h1),
    pairAddress: p.pairAddress, dexId: p.dexId,
    twitter: (p.info?.socials ?? []).map((s: any) => (s?.type === 'twitter' || /x\.com|twitter\.com/.test(String(s?.url ?? ''))) ? xHandleFromUrl(String(s?.url ?? '')) : undefined).find(Boolean),
    telegram: (p.info?.socials ?? []).find((s: any) => s?.type === 'telegram')?.url,
    websites: (p.info?.websites ?? []).map((w: any) => String(w?.url ?? '')).filter((u: string) => /^https?:\/\//.test(u)).slice(0, 3),
  };
}

export interface RugInfo { risk: 'low' | 'medium' | 'high' | 'unknown'; freezeOrMintAuthority: boolean; reasons: string[] }

/** Parses the RugCheck /v1/tokens/{mint}/report/summary response. */
export function parseRugCheck(json: any): RugInfo {
  if (!json || !Array.isArray(json.risks)) return { risk: 'unknown', freezeOrMintAuthority: false, reasons: ['rugcheck: no data'] };
  const reasons = json.risks.map((r: any) => `${r.level}: ${r.name}`);
  const freezeOrMint = json.risks.some((r: any) => /freeze authority|mint authority/i.test(r.name ?? ''));
  const danger = json.risks.some((r: any) => r.level === 'danger');
  const warn = json.risks.some((r: any) => r.level === 'warn');
  return { risk: danger ? 'high' : warn ? 'medium' : 'low', freezeOrMintAuthority: freezeOrMint, reasons };
}

export interface QualityThresholds { minLiquidityUsd: number; minPairAgeMinutes: number; minBuys24h: number; maxFdvUsd: number }
export const QUALITY_BY_TIER: Record<Exclude<Tier, 'ignore' | 'journal'>, QualityThresholds | null> = {
  full: { minLiquidityUsd: 10_000, minPairAgeMinutes: 10, minBuys24h: 50, maxFdvUsd: 50_000_000 },
  fast: { minLiquidityUsd: 3_000, minPairAgeMinutes: 0, minBuys24h: 0, maxFdvUsd: 200_000_000 },
  follow: null, // 10 = follow the call: quality checks are skipped
};

/** A number for a reason: no data — "unknown". */
const fmtNum = (v: number | undefined, pre = '', post = '') => (typeof v === 'number' && Number.isFinite(v) ? `${pre}${Math.round(v)}${post}` : 'unknown');

/**
 * Final token assessment by trust tier. Safety is always checked.
 * opts.ownPick — the agent's own pick (tier full): minimum pair age 0 — fresh pairs (< 10 min) are open (the owner's decision
 * 2026-11-16 "Yes, open", an internal document; S-02 option B). Other full thresholds and people's calls — unchanged.
 */
export function evaluateToken(address: string, tier: Tier, market: MarketInfo | undefined, rug: RugInfo | undefined, opts: { ownPick?: boolean } = {}): TokenCheck {
  const reasons: string[] = [];
  const chain = market?.chain ?? 'unknown';
  // --- safety (any tier) ---
  if (!market || !market.priceUsd) reasons.push('safety: no tradable pair found');
  if (rug?.freezeOrMintAuthority) reasons.push('safety: freeze/mint authority enabled (cannot safely sell)');
  if (market && market.sells24h === 0 && (market.buys24h ?? 0) > 20) reasons.push('safety: buys but zero sells (possible honeypot)');
  const safetyFail = reasons.length > 0;
  // --- quality (by tier) ---
  const qt = tier === 'full' || tier === 'fast' || tier === 'follow' ? QUALITY_BY_TIER[tier] : null;
  const q = qt && opts.ownPick ? { ...qt, minPairAgeMinutes: 0 } : qt;
  if (!safetyFail && q && market) {
    // No number (undefined, NaN) where a minimum is set — fails: "no data" is not 0 and does not bypass the threshold (#129)
    const below = (v: number | undefined, min: number) => min > 0 && !(typeof v === 'number' && Number.isFinite(v) && v >= min);
    if (below(market.liquidityUsd, q.minLiquidityUsd)) reasons.push(`quality: liquidity ${fmtNum(market.liquidityUsd, '$')} < $${q.minLiquidityUsd}`);
    if (below(market.pairAgeMinutes, q.minPairAgeMinutes)) reasons.push(`quality: pair age ${fmtNum(market.pairAgeMinutes, '', ' min')} < ${q.minPairAgeMinutes}`);
    // Own pick: only the minimum age is lifted, the age itself must be known — otherwise "fresh" cannot be told from data without a date
    else if (opts.ownPick && qt && qt.minPairAgeMinutes > 0 && !(typeof market.pairAgeMinutes === 'number' && Number.isFinite(market.pairAgeMinutes)))
      reasons.push('quality: pair age unknown (own pick needs a known pair age)');
    if (below(market.buys24h, q.minBuys24h)) reasons.push(`quality: buys24h ${fmtNum(market.buys24h)} < ${q.minBuys24h}`);
    if ((market.fdvUsd ?? 0) > q.maxFdvUsd) reasons.push(`quality: fdv too high for upside`);
    if (rug?.risk === 'high' && tier === 'full') reasons.push('quality: rugcheck risk high');
  }
  return {
    ok: reasons.length === 0, chain, address, symbol: market?.symbol, pairAddress: market?.pairAddress, dexId: market?.dexId,
    priceUsd: market?.priceUsd, liquidityUsd: market?.liquidityUsd, fdvUsd: market?.fdvUsd,
    pairAgeMinutes: market?.pairAgeMinutes, buys24h: market?.buys24h, sells24h: market?.sells24h,
    rugRisk: rug?.risk ?? 'unknown', reasons,
  };
}

export interface MarketClient {
  market(address: string): Promise<MarketInfo | undefined>;
  rug(chain: Chain, address: string): Promise<RugInfo | undefined>;
}

export function httpMarketClient(nowMs: () => number, fetchImpl: typeof fetch = fetch): MarketClient {
  return {
    async market(address) {
      const r = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
      if (!r.ok) return undefined;
      return parseDexScreener(await r.json(), address, nowMs());
    },
    async rug(chain, address) {
      if (chain !== 'solana') return undefined;
      const r = await fetchImpl(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`);
      if (!r.ok) return { risk: 'unknown', freezeOrMintAuthority: false, reasons: [`rugcheck http ${r.status}`] };
      return parseRugCheck(await r.json());
    },
  };
}
