// twitterapi.io spend counter (card C-01): a wrapper over XProvider that changes nothing in requests
// and responses, and only writes an xapi event to the review log for every call: method, how many records came back,
// whether there was an error. From these events npm run cost computes $ per day.
// Wiring — one line in src/index.ts (an HQ file): xProvider = meterX(twitterApiIo(...), review).
import type { XProvider } from '../analyst/enrich.js';
import type { ReviewSink } from '../review/log.js';

export type XEndpoint = 'profile' | 'search' | 'timeline' | 'followers' | 'followerIds';

/**
 * twitterapi.io prices (C-06) — checked 2026-11-13 against twitterapi.io/pricing and twitterapi.io/pricing/details:
 *  - «$1 = 100,000 credits»; «Every call has a minimum of 15 credits ($0.00015), including calls that return no data»;
 *  - search (advanced_search) and timeline (tweet_timeline) — 15 credits per tweet;
 *  - profile (user/info) — 18 credits per call;
 *  - followers (user/followers) — per user in the response: 1–99 → 3, 100–199 → 2, 200 → 1 (tier by page size);
 *  - follower IDs (user/followers_ids) — per ID in the response: 1–199 → 2, 200–3 999 → 1, 4 000+ → 0.45.
 * Errors: docs.twitterapi.io/errors — for a rejected search request (400) "you are not charged"; the docs say nothing
 * about 429 and 5xx — we do not price them. Pay-as-you-go prices, without subscription bonuses.
 */
export const X_PRICES = {
  checked: 'checked 2026-11-13 against twitterapi.io/pricing and /pricing/details: $1 = 100 000 credits, minimum 15 credits per call; search and timeline — 15 per tweet, profile — 18 per call; followers and follower IDs — tiers by response size; errors are not counted (a 400 search is "not charged" per docs.twitterapi.io/errors, the docs say nothing about 429/5xx)',
  creditsPerUsd: 100_000,
  minCredits: 15,
};

/** Credits for a successful call. pages — how many 200-row pages followers returned; requests — separate calls (ids(): one profile per name). */
export function xCredits(endpoint: XEndpoint, items: number, pages = 1, requests = 1): number {
  const min = X_PRICES.minCredits;
  switch (endpoint) {
    case 'search': case 'timeline': return Math.max(min * requests, 15 * items);
    case 'profile': return 18 * Math.max(requests, items);
    case 'followerIds': return Math.max(min, items * (items < 200 ? 2 : items < 4000 ? 1 : 0.45));
    case 'followers': {
      // Full 200-row pages — 1 credit per user, the last partial page — by its own tier
      let left = items, c = 0;
      for (let p = 0; p < Math.max(1, pages); p++) { const k = Math.min(200, left); left -= k; c += Math.max(min, k * (k < 100 ? 3 : k < 200 ? 2 : 1)); }
      return c;
    }
  }
  return 0;
}

export function meterX(x: XProvider, sink: ReviewSink, now: () => number = Date.now): XProvider {
  const run = async <T>(endpoint: XEndpoint, meta: (r: T) => Record<string, unknown>, call: () => Promise<T>): Promise<T> => {
    const t0 = now();
    let r: T;
    try { r = await call(); } catch (e) {
      sink.write('xapi', { endpoint, items: 0, ms: now() - t0, error: String((e as Error)?.message ?? e).slice(0, 160) });
      throw e;
    }
    sink.write('xapi', { endpoint, ...meta(r), ms: now() - t0 });
    return r;
  };
  const m: XProvider = {
    profile: h => run('profile', () => ({ items: 1 }), () => x.profile(h)),
    search: (q, type) => run('search', r => ({ items: r.length }), () => x.search(q, type)),
  };
  if (x.timeline) m.timeline = id => run('timeline', r => ({ items: r.length }), () => x.timeline!(id));
  // followers() returns rows of all pages (200 each) as one list; rows without a name are dropped — there are almost none.
  // pages — how many pages were requested (each is a separate request with its own minimum)
  if (x.followers) m.followers = (h, pages) => run('followers', r => ({ items: r.length, pages: Math.max(1, Math.ceil(r.length / 200)) }), () => x.followers!(h, pages));
  if (x.followerIds) m.followerIds = (h, count) => run('followerIds', r => ({ items: r.length }), () => x.followerIds!(h, count));
  // ids() calls profile() once per name inside (up to 300); how many succeeded is not visible from outside —
  // we write the number of names as an upper bound
  if (x.ids) m.ids = hs => run('profile', () => ({ items: Math.min(300, hs.length), upperBound: true }), () => x.ids!(hs));
  return m;
}
