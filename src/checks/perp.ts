// Perpetual prices for paper positions: Hyperliquid (public API, no key), mid prices of all markets in one request.
// 15-second cache so the position monitor and the Analyst don't hammer the API.
export interface PerpClient {
  /** Mid price of a market (BTC, ETH, SOL, …) or undefined if there is no such market. */
  price(asset: string): Promise<number | undefined>;
  /** All markets: ticker → price. */
  mids(): Promise<Record<string, number>>;
}

export function hyperliquidClient(fetchImpl: typeof fetch = fetch, nowMs: () => number = Date.now): PerpClient {
  let cache: { at: number; mids: Record<string, number> } | undefined;
  const mids = async () => {
    if (cache && nowMs() - cache.at < 15_000) return cache.mids;
    const r = await fetchImpl('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }), signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`hyperliquid HTTP ${r.status}`);
    const j = await r.json() as Record<string, string>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) { const n = Number(v); if (!k.startsWith('@') && Number.isFinite(n) && n > 0) out[k.toUpperCase()] = n; }
    cache = { at: nowMs(), mids: out };
    return out;
  };
  return { mids, async price(asset) { return (await mids())[normPerpAsset(asset)]; } };
}

/** BTC / bitcoin / $BTC / BTCUSDT → BTC. */
export function normPerpAsset(a: string): string {
  const s = a.trim().toUpperCase().replace(/^\$/, '').replace(/[-/]?(USDT|USDC|USD|PERP)$/, '');
  return ({ BITCOIN: 'BTC', ETHEREUM: 'ETH', ETHER: 'ETH', SOLANA: 'SOL' } as Record<string, string>)[s] ?? s;
}

/** Perp assets mentioned in the text (only those listed on the exchange). */
export function perpAssetsInText(text: string, mids: Record<string, number>): string[] {
  const words = new Set((text.match(/\$?[A-Za-z]{2,10}/g) ?? []).map(w => normPerpAsset(w)));
  return [...words].filter(w => mids[w] !== undefined && (w.length >= 3 || w === 'OP')).slice(0, 4);
}
