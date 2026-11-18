// OpenSea API v2: drop (phases, prices, how many wallets on allowlists, supply), collection (contract, X, fees), stats (floor, sales).
// The key comes only from .env (OPENSEA_API_KEY). Code itself computes how much is left for public and where break-even is.
// A contract address from here is allowed for action because code requests it by the collection link from the Discord message,
// not because the model takes it from a website.
import type { Chain } from '../types.js';
import { utcMs } from '../time.js';

export interface DropStage { label: string; type: string; priceEth: number; startUtc: string; endUtc?: string; maxPerWallet?: number; allowlistWallets?: number | null }
export interface NftInfo {
  slug: string; name?: string; chain: Chain | string; contract?: string; twitter?: string; projectUrl?: string;
  maxSupply?: number; minted?: number; isMinting?: boolean; activeStage?: string;
  stages: DropStage[];
  /** Fees on a secondary sale, % (creator + OpenSea). */
  sellFeesPct: number;
  floorEth?: number; sales1d?: number; volume1dEth?: number; owners?: number; totalSales?: number;
  /**
   * Sales in the last windowMin minutes. The daily average (volume / sales) is skewed by free mints
   * dumped for almost nothing — the decision uses fresh sales (Lanternfolk lesson 2026-10-22).
   */
  recentSales?: { n: number; medianEth: number; minEth: number; maxEth: number; windowMin: number };
  /** Best offer on any NFT of the collection — the price you can sell at instantly. */
  bestOfferEth?: number;
  /** Computed by code. */
  derived: {
    reservedByAllowlists?: number;   // Σ wallets × limit over closed phases
    leftForPublicMin?: number;       // supply − reserved (if allowlists take everything)
    allowlistOverAllocated?: boolean;
    publicStage?: DropStage;
    publicHours?: number;
    breakEvenFloorEth?: number;      // (public price + mint gas) / (1 − fees)
    floorToBreakEven?: number;
    /** Real exit price: max(best offer, median of fresh sales); without them — floor × 0.8. */
    exitEstimateEth?: number;
    exitToBreakEven?: number;
  };
}

const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : undefined; };

export function parseOpenSea(slug: string, drop: any, coll: any, stats: any, mintGasEth: number, extra: { recent?: NftInfo['recentSales']; bestOfferEth?: number } = {}): NftInfo {
  const stages: DropStage[] = (drop?.stages ?? []).map((s: any) => ({
    label: String(s.label ?? s.stage_type ?? '?'), type: String(s.stage_type ?? ''), priceEth: (num(s.price) ?? 0) / 1e18,
    startUtc: s.start_time, endUtc: s.end_time ?? undefined, maxPerWallet: num(s.max_per_wallet), allowlistWallets: s.allowlist_wallet_count ?? null,
  })).sort((a: DropStage, b: DropStage) => utcMs(a.startUtc) - utcMs(b.startUtc));
  const fees = (coll?.fees ?? []).reduce((a: number, f: any) => a + (num(f.fee) ?? 0), 0);
  const maxSupply = num(drop?.max_supply);
  const closed = stages.filter(s => s.type !== 'public_sale' && s.allowlistWallets != null);
  const reserved = closed.length ? closed.reduce((a, s) => a + (s.allowlistWallets ?? 0) * (s.maxPerWallet ?? 1), 0) : undefined;
  const pub = stages.find(s => s.type === 'public_sale');
  const floor = num(stats?.total?.floor_price) || undefined;
  const breakEven = pub ? (pub.priceEth + mintGasEth) / (1 - Math.min(fees, 50) / 100) : undefined;
  const exit = (extra.recent && extra.recent.n >= 3) || extra.bestOfferEth
    ? Math.max(extra.bestOfferEth ?? 0, extra.recent && extra.recent.n >= 3 ? extra.recent.medianEth : 0)
    : (floor ? floor * 0.8 : undefined);
  return {
    slug, name: coll?.name ?? drop?.collection_name, chain: drop?.chain ?? coll?.contracts?.[0]?.chain ?? 'unknown',
    contract: drop?.contract_address ?? coll?.contracts?.[0]?.address, twitter: coll?.twitter_username || undefined, projectUrl: coll?.project_url || undefined,
    maxSupply, minted: num(drop?.total_supply), isMinting: drop?.is_minting, activeStage: drop?.active_stage?.label,
    stages, sellFeesPct: fees,
    // Sales count and volume from /stats are NOT used: OpenSea counts drop mints as sales (including free 0 ETH ones),
    // so "volume / sales" gives a false average price (Lanternfolk lesson 2026-10-22). Prices come only from sale events.
    floorEth: floor, owners: num(stats?.total?.num_owners),
    recentSales: extra.recent, bestOfferEth: extra.bestOfferEth,
    derived: {
      reservedByAllowlists: reserved,
      leftForPublicMin: maxSupply !== undefined && reserved !== undefined ? Math.max(0, maxSupply - reserved) : undefined,
      allowlistOverAllocated: maxSupply !== undefined && reserved !== undefined ? reserved > maxSupply : undefined,
      publicStage: pub,
      publicHours: pub?.endUtc ? (utcMs(pub.endUtc) - utcMs(pub.startUtc)) / 3600_000 : undefined,
      breakEvenFloorEth: breakEven,
      floorToBreakEven: floor && breakEven ? floor / breakEven : undefined,
      exitEstimateEth: exit,
      exitToBreakEven: exit && breakEven ? exit / breakEven : undefined,
    },
  };
}

export interface OpenSeaClient { nft(slug: string): Promise<NftInfo | undefined> }

/** Fresh sales from /events/collection/{slug}?event_type=sale (ETH/WETH). */
export function recentSalesOf(json: any, windowMin: number): NftInfo['recentSales'] {
  const ps = (json?.asset_events ?? []).map((e: any) => Number(e?.payment?.quantity ?? 0) / 10 ** (e?.payment?.decimals ?? 18) / Math.max(1, Number(e?.quantity ?? 1)))
    .filter((p: number) => Number.isFinite(p) && p > 0).sort((a: number, b: number) => a - b);
  if (!ps.length) return { n: 0, medianEth: 0, minEth: 0, maxEth: 0, windowMin };
  return { n: ps.length, medianEth: ps[Math.floor(ps.length / 2)], minEth: ps[0], maxEth: ps[ps.length - 1], windowMin };
}
/** Best active collection offer per 1 NFT (price / quantity). */
export function bestOfferOf(json: any, nowMs: number): number | undefined {
  let best = 0;
  for (const o of json?.offers ?? []) {
    const value = Number(o?.price?.value ?? 0) / 10 ** (o?.price?.decimals ?? 18);
    const qty = Math.max(1, Number(o?.protocol_data?.parameters?.consideration?.[0]?.startAmount ?? 1));
    const end = Number(o?.protocol_data?.parameters?.endTime ?? 0) * 1000;
    if (end && end < nowMs) continue;
    best = Math.max(best, value / qty);
  }
  return best || undefined;
}

export function openSeaClient(apiKey: string, mintGasEth: () => number, fetchImpl: typeof fetch = fetch, nowMs: () => number = Date.now): OpenSeaClient {
  const get = async (path: string) => {
    const r = await fetchImpl(`https://api.opensea.io/api/v2/${path}`, { headers: { 'x-api-key': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`opensea ${path}: HTTP ${r.status}`);
    return r.json();
  };
  return {
    async nft(slug) {
      const s = encodeURIComponent(slug);
      const after = Math.floor((nowMs() - 60 * 60_000) / 1000);
      const [drop, coll, stats, events, offers] = await Promise.all([get(`drops/${s}`).catch(() => undefined), get(`collections/${s}`), get(`collections/${s}/stats`).catch(() => undefined),
        get(`events/collection/${s}?event_type=sale&after=${after}&limit=50`).catch(() => undefined), get(`offers/collection/${s}`).catch(() => undefined)]);
      if (!coll && !drop) return undefined;
      return parseOpenSea(slug, drop, coll, stats, mintGasEth(), { recent: recentSalesOf(events, 60), bestOfferEth: bestOfferOf(offers, nowMs()) });
    },
  };
}

/** Mint rule by numbers: public window, floor vs break-even, sales, share of the allowlist minted. */
export function nftMintRule(n: NftInfo, nowMs: number, r: { minFloorToBreakEven: number; minSales: number; minWlMintedShare: number; windowMinutes: number }): { inWindow: boolean; ok: boolean; facts: string; why: string[] } {
  const pub = n.derived.publicStage;
  const why: string[] = [];
  const start = pub ? utcMs(pub.startUtc) : NaN, end = pub?.endUtc ? utcMs(pub.endUtc) : Infinity;
  const inWindow = !!pub && nowMs >= start - r.windowMinutes * 60_000 && nowMs < end;
  // The decision uses the real exit price (offer / fresh sales), not the listed floor and not the daily average
  const ratio = n.derived.exitToBreakEven ?? 0;
  const sales = n.recentSales?.n ?? 0;
  const share = n.derived.reservedByAllowlists ? (n.minted ?? 0) / n.derived.reservedByAllowlists : 1;
  const soldOut = n.maxSupply !== undefined && n.minted !== undefined && n.minted >= n.maxSupply;
  if (!pub) why.push('no public stage');
  if (soldOut) why.push('sold out');
  if (ratio < r.minFloorToBreakEven) why.push(`exit price ${n.derived.exitEstimateEth?.toFixed(5) ?? '—'} ETH is ${ratio.toFixed(2)}× break-even (< ${r.minFloorToBreakEven}×)`);
  if (sales < r.minSales) why.push(`sales in the last hour ${sales} < ${r.minSales}`);
  if (share < r.minWlMintedShare) why.push(`allowlist minted ${(share * 100).toFixed(0)}% < ${r.minWlMintedShare * 100}%`);
  const facts = `exit ${n.derived.exitEstimateEth?.toFixed(5) ?? '—'} ETH (top offer ${n.bestOfferEth?.toFixed(5) ?? '—'}, median of ${n.recentSales?.n ?? 0} sales in 1 h ${n.recentSales?.medianEth?.toFixed(5) ?? '—'}, floor ${n.floorEth ?? '—'}) vs break-even ${n.derived.breakEvenFloorEth?.toFixed(5) ?? '—'} (${ratio.toFixed(2)}×), minted ${n.minted ?? '—'}/${n.maxSupply ?? '—'}, allowlists ${(share * 100).toFixed(0)}% claimed`;
  return { inWindow, ok: inWindow && !why.length, facts, why };
}

/** When to re-check the project: 30 minutes before the public start (and before the first phase starts, if it has not yet). */
export function nftRecheckTimes(n: NftInfo, nowMs: number): { atUtc: string; reason: string }[] {
  const out: { atUtc: string; reason: string }[] = [];
  const pub = n.derived.publicStage;
  if (pub) { const t = utcMs(pub.startUtc) - 30 * 60_000; if (t > nowMs) out.push({ atUtc: new Date(t).toISOString(), reason: `30 min before public (${pub.startUtc})` }); }
  const first = n.stages[0];
  if (first && first !== pub) { const t = utcMs(first.startUtc) + 30 * 60_000; if (t > nowMs && (!pub || t < utcMs(pub.startUtc) - 60 * 60_000)) out.push({ atUtc: new Date(t).toISOString(), reason: `30 min after first phase (${first.label}) opened — demand check` }); }
  return out;
}
