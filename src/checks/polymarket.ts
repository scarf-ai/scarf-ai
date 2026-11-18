// Polymarket: prediction markets (the owner's decision 2026-10-23 — paper only for now; live after the lawyer).
// Data — public APIs without a key: Gamma (market description) and CLOB (order book).
// Outcome price 0..1 = market probability; a winning share pays $1, a losing one — $0.

export interface PmOutcome { name: string; tokenId: string; ask?: number; bid?: number; gammaPrice?: number }
export interface PmMarket {
  slug: string; eventSlug?: string; question: string; outcomes: PmOutcome[];
  endUtc?: string; closed: boolean; active: boolean;
  liquidityUsd?: number; volumeUsd?: number; volume24hUsd?: number;
  /** Resolution rules (truncated). */
  rules?: string;
  /** Winning outcome, if the market is closed and resolved. */
  winner?: string;
  category?: string; feeRate: number; minOrderShares: number;
}
export interface PolymarketClient {
  /** Markets by link: event slug (up to 8 markets, by volume) or a specific market slug. */
  markets(ref: { event?: string; market?: string }): Promise<PmMarket[]>;
  market(slug: string): Promise<PmMarket | undefined>;
}

/** polymarket.com/event/<event>[/<market>] or polymarket.com/market/<market>. */
export function polymarketRef(url: string): { event?: string; market?: string } | undefined {
  const m = url.match(/^https?:\/\/(?:www\.)?polymarket\.com\/(event|market)\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?/i);
  if (!m) return undefined;
  return m[1].toLowerCase() === 'market' ? { market: m[2].toLowerCase() } : { event: m[2].toLowerCase(), market: m[3]?.toLowerCase() };
}

/** Taker fee by category (docs.polymarket.com/trading/fees, checked 2026-10-23): fee = shares × rate × p × (1 − p). */
export function feeRateFor(tags: string[]): { category: string; rate: number } {
  const t = tags.map(x => x.toLowerCase());
  const has = (...k: string[]) => t.some(x => k.some(y => x.includes(y)));
  if (has('geopolitic', 'world')) return { category: 'geopolitics', rate: 0 };
  if (has('crypto', 'bitcoin', 'ethereum')) return { category: 'crypto', rate: 0.07 };
  if (has('sport', 'nba', 'nfl', 'soccer', 'football', 'tennis', 'mlb', 'nhl', 'ufc')) return { category: 'sports', rate: 0.05 };
  if (has('politic', 'election', 'finance', 'tech', 'mention', 'business')) return { category: 'politics/finance/tech', rate: 0.04 };
  return { category: tags[0]?.toLowerCase() ?? 'other', rate: 0.05 };
}
export const pmFee = (shares: number, price: number, rate: number) => shares * rate * price * (1 - price);

const arr = (v: unknown): any[] => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } } return []; };
const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** Parses a Gamma market (the outcomes / outcomePrices / clobTokenIds fields arrive as JSON strings). */
export function parseGammaMarket(m: any, eventSlug?: string, tags: string[] = []): PmMarket | undefined {
  if (!m || typeof m !== 'object' || !m.slug) return undefined;
  const names = arr(m.outcomes).map(String);
  const prices = arr(m.outcomePrices).map(Number);
  const tokens = (arr(m.clobTokenIds).length ? arr(m.clobTokenIds) : arr(m.positionIds)).map(String);
  if (!names.length || names.length !== tokens.length) return undefined;
  const closed = m.closed === true;
  const winIdx = closed ? prices.findIndex(p => p >= 0.99) : -1;
  const mtags = [...tags, ...(Array.isArray(m.tags) ? m.tags.map((t: any) => String(t?.label ?? t)) : []), String(m.category ?? '')].filter(Boolean);
  const fee = feeRateFor(mtags);
  return {
    slug: String(m.slug), eventSlug, question: String(m.question ?? m.title ?? m.slug).slice(0, 200),
    outcomes: names.map((name, i) => ({ name, tokenId: tokens[i], gammaPrice: Number.isFinite(prices[i]) ? prices[i] : undefined })),
    endUtc: m.endDate ? new Date(m.endDate).toISOString() : undefined, closed, active: m.active !== false,
    liquidityUsd: num(m.liquidityNum ?? m.liquidity), volumeUsd: num(m.volumeNum ?? m.volume), volume24hUsd: num(m.volume24hr),
    rules: m.description ? String(m.description).replace(/\s+/g, ' ').slice(0, 700) : undefined,
    winner: winIdx >= 0 ? names[winIdx] : undefined,
    category: fee.category, feeRate: fee.rate, minOrderShares: 5,
  };
}

/** Best prices from the CLOB book: ask — the lowest sell price, bid — the highest buy price. */
export function bestOf(book: any): { ask?: number; bid?: number; minOrder?: number } {
  const ps = (side: any) => (Array.isArray(side) ? side : []).map((l: any) => Number(l?.price)).filter((p: number) => p > 0 && p < 1);
  const asks = ps(book?.asks), bids = ps(book?.bids);
  return { ask: asks.length ? Math.min(...asks) : undefined, bid: bids.length ? Math.max(...bids) : undefined, minOrder: num(book?.min_order_size) };
}

export function polymarketClient(nowMs: () => number, fetchImpl: typeof fetch = fetch): PolymarketClient {
  const cache = new Map<string, { at: number; v: any }>();
  const get = async (url: string, init?: RequestInit) => {
    const key = `${url}|${init?.body ?? ''}`;
    const c = cache.get(key);
    if (c && nowMs() - c.at < 20_000) return c.v;
    const r = await fetchImpl(url, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`polymarket http ${r.status}`);
    const v = await r.json();
    cache.set(key, { at: nowMs(), v });
    return v;
  };
  const withBooks = async (ms: PmMarket[]) => {
    const ids = ms.flatMap(m => m.outcomes.map(o => o.tokenId)).slice(0, 40);
    if (!ids.length) return ms;
    const books: any[] = await get('https://clob.polymarket.com/books', { method: 'POST', body: JSON.stringify(ids.map(token_id => ({ token_id }))) }).catch(() => []);
    const byId = new Map((Array.isArray(books) ? books : []).map(b => [String(b?.asset_id), b]));
    for (const m of ms) for (const o of m.outcomes) {
      const b = byId.get(o.tokenId); if (!b) continue;
      const best = bestOf(b); o.ask = best.ask; o.bid = best.bid; if (best.minOrder) m.minOrderShares = best.minOrder;
    }
    return ms;
  };
  const one = async (slug: string) => {
    const m = await get(`https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`).catch(() => undefined);
    return parseGammaMarket(m);
  };
  return {
    async markets(ref) {
      if (ref.market) { const m = await one(ref.market); return m ? withBooks([m]) : []; }
      if (!ref.event) return [];
      const ev = await get(`https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(ref.event)}`);
      const tags = Array.isArray(ev?.tags) ? ev.tags.map((t: any) => String(t?.label ?? '')) : [];
      const ms = (Array.isArray(ev?.markets) ? ev.markets : []).map((m: any) => parseGammaMarket(m, ref.event, tags)).filter(Boolean) as PmMarket[];
      ms.sort((a, b) => Number(a.closed) - Number(b.closed) || (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0));
      return withBooks(ms.slice(0, 8));
    },
    async market(slug) { const m = await one(slug); return m ? (await withBooks([m]))[0] : undefined; },
  };
}
