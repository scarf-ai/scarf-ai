// Dossier for the analyst: everything that can be learned about a project without a model. Every source has a timeout,
// one source failing does not break the dossier. All data from here is UNTRUSTED for the model (websites and X posts
// may contain instructions), so money never depends on dossier text: trade addresses
// are taken only from Discord messages.
import { BlockList, isIP } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lookup as dnsLookup } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import type { MarketClient, MarketInfo, RugInfo } from '../checks/token.js';
import type { Chain } from '../types.js';
import type { NftInfo, OpenSeaClient } from './opensea.js';
import { perpAssetsInText } from '../checks/perp.js';
import { prefilter } from '../extract/prefilter.js';
import { xResearch, confirmProjectX, searchCandidates, normalizeHandle, handleLike, discordLike, siteKey, profileLinkHandle, type XPack, type SmartAccounts, type SmartCheckMeasure, type ProjectX, type XEntity } from './xresearch.js';
import { hardRejectReasons } from '../checks/hardcheck.js';
import { review as reviewLog } from '../review/log.js';
import { notScannerBot } from '../intel/entities.js';

// ---------------- X (twitterapi.io) ----------------
export interface XProfile { handle: string; id?: string; followers?: number; following?: number; createdAt?: string; ageDays?: number; blueVerified?: boolean;
  statuses?: number; description?: string; bioUrls?: string[]; unavailable?: string; automated?: boolean;
  /** The account does not exist (X answered "user not found"). */ notFound?: boolean;
  /** The check failed (API error, limit, credits) — this is NOT an argument against the project. */ error?: string }
export interface XPost { text: string; createdAt: string; likes: number; retweets: number; views?: number; author: string; authorFollowers?: number }
export interface XFollower { handle: string; id?: string; followers?: number; statuses?: number; createdAt?: string; description?: string; blueVerified?: boolean }
export type XFollowers = XFollower[] & { partial?: string };
export type XIds = Map<string, string> & { failed?: { handle: string; reason: string }[] };
export interface XProvider {
  profile(handle: string): Promise<XProfile | undefined>;
  search(query: string, type?: 'Latest' | 'Top'): Promise<XPost[]>;
  /** Own posts by userId (visible even for accounts hidden from search). */ timeline?(userId: string): Promise<XPost[]>;
  /** Followers, newest first: pages × 200. partial — later pages could not be fetched (reason). */ followers?(handle: string, pages?: number): Promise<XFollowers>;
  /** Follower IDs (up to 5000 per request) — to match against the smart list. */ followerIds?(handle: string, count?: number): Promise<string[]>;
  /** handle → userId for the smart list. failed — names not resolved because of an X failure (not "no such account"), with reason. */ ids?(handles: string[]): Promise<XIds>;
}

const toPost = (t: any): XPost => ({ text: String(t?.text ?? '').slice(0, 280), createdAt: t?.createdAt, likes: t?.likeCount ?? 0,
  retweets: t?.retweetCount ?? 0, views: t?.viewCount, author: t?.author?.userName ?? '?', authorFollowers: t?.author?.followers });

/**
 * Even request pace to twitterapi.io for the whole process (A-06). The free tier allows 1 request per 5 s
 * (text of every 429 in the 2026-10-29 log; the owner 2026-11-09: we stay on the free tier). Before, up to 4 requests went at once —
 * in 17 of 19 analyses with X some checks ended in 429.
 *  - fg — analyses: wait no longer than maxWaitMs, otherwise an immediate "not checked (queue)" error — an analysis does not hang for minutes;
 *  - bg — background (smart-list IDs): only when analyses need nothing, no wait limit;
 *  - 429 → the next request no earlier than Retry-After (or the interval), retry out of queue, up to 2 times.
 */
export interface XPaceOpts { minIntervalMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> }
export const X_FREE_TIER_INTERVAL_MS = 5_200;
export const X_MAX_WAIT_MS = 90_000;
type Lane = 'fg' | 'bg';

function xPacer(nowMs: () => number, o: XPaceOpts) {
  const interval = o.minIntervalMs ?? X_FREE_TIER_INTERVAL_MS, maxWait = o.maxWaitMs ?? X_MAX_WAIT_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let nextAt = 0; let pumping = false; let streak429 = 0; let fuseUntil = -Infinity;
  type Waiter = { go: () => void; fail: (e: Error) => void; retry: boolean };
  const lanes: Record<Lane, Waiter[]> = { fg: [], bg: [] };
  const fused = () => fuseUntil > nowMs();
  const tripped = () => new Error(`twitterapi.io: not checked — X is rate-limiting (HTTP 429${streak429 > 1 ? ` × ${streak429} in a row` : ''}), next try in ${Math.max(0, Math.ceil((fuseUntil - nowMs()) / 1000))} s`);
  const pump = async () => {
    if (pumping) return; pumping = true;
    try {
      while (lanes.fg.length || lanes.bg.length) {
        const wait = nextAt - nowMs();
        if (wait > 0) { await sleep(wait); continue; } // an analysis request may have arrived while waiting — it goes before background
        const w = lanes.fg.shift() ?? lanes.bg.shift()!;
        nextAt = nowMs() + interval; w.go();
      }
    } finally { pumping = false; }
  };
  return {
    interval, maxWait, fused, tripped,
    turn(lane: Lane, retry = false): Promise<void> {
      // Fuse (acceptance #57, round 3: Retry-After 60 → one xResearch waited 360 s): while X says wait, analysis requests
      // fail at once ("not checked"), background waits. After the deadline a new request is a probe; a good answer resets the counter.
      if (lane === 'fg' && !retry && fused()) return Promise.reject(tripped());
      if (lane === 'fg' && !retry) {
        const eta = Math.max(0, nextAt - nowMs()) + lanes.fg.length * interval;
        if (eta > maxWait) return Promise.reject(new Error(`twitterapi.io: not checked — request queue ${Math.round(eta / 1000)} s > ${Math.round(maxWait / 1000)} s (free tier: 1 request per ${interval / 1000} s)`));
      }
      return new Promise<void>((go, fail) => {
        const w: Waiter = { go, fail, retry };
        if (retry) lanes[lane].unshift(w); else lanes[lane].push(w);
        void pump();
      });
    },
    /** 429: the next request not before the deadline. Three 429s in a row or a deadline ≥ 30 s trips the fuse: the analysis queue is dropped at once. */
    backoff(ms: number) {
      nextAt = Math.max(nextAt, nowMs() + ms); streak429++;
      if (streak429 >= 3 || ms >= 30_000) {
        fuseUntil = nextAt;
        const keep = lanes.fg.filter(w => w.retry);
        for (const w of lanes.fg) if (!w.retry) w.fail(tripped());
        lanes.fg = keep;
      }
    },
    ok() { streak429 = 0; },
  };
}

/** Retry-After: seconds or an HTTP date; at most a minute. */
function retryAfterMs(h: string | null, nowMs: number): number | undefined {
  if (!h) return undefined;
  const sec = Number(h);
  const ms = Number.isFinite(sec) ? sec * 1000 : Date.parse(h) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.min(60_000, ms) : undefined;
}

/**
 * twitterapi.io: X-API-Key header. An error is HTTP 4xx/5xx or status: "error" in the response; such responses throw
 * with the reason text (before, a failure silently became "not found" and the analyst thought the account did not exist — OOLONG 2026-10-27).
 * Prices — X_PRICES in src/cost/xmeter.ts (C-06, checked against twitterapi.io 2026-11-13); not duplicated here.
 */
export function twitterApiIo(apiKey: string, nowMs: () => number, fetchImpl: typeof fetch = fetch, pace: XPaceOpts = {}): XProvider {
  const pacer = xPacer(nowMs, pace);
  const get = async (path: string, params: Record<string, string>, allowError?: RegExp, lane: Lane = 'fg') => {
    const u = new URL(`https://api.twitterapi.io${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    let r!: Response;
    const t0 = nowMs();
    for (let attempt = 0; attempt < 3; attempt++) {
      await pacer.turn(lane, attempt > 0);
      r = await fetchImpl(u, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(12_000) });
      if (r.status !== 429) { pacer.ok(); break; }
      const wait = retryAfterMs(r.headers.get('retry-after'), nowMs()) ?? pacer.interval;
      pacer.backoff(wait);
      // An analysis does not retry when the fuse has tripped or a retry would exceed the wait limit since the first enqueue
      if (lane === 'fg' && attempt < 2 && pacer.fused()) throw pacer.tripped();
      if (lane === 'fg' && attempt < 2 && nowMs() - t0 + wait > pacer.maxWait)
        throw new Error(`twitterapi.io: not checked — HTTP 429, retry would exceed ${Math.round(pacer.maxWait / 1000)} s`);
    }
    const j: any = await r.json().catch(() => ({}));
    const msg = String(j?.msg ?? j?.message ?? j?.error ?? '').slice(0, 120);
    if (!r.ok) throw new Error(`twitterapi.io HTTP ${r.status}${msg ? `: ${msg}` : ''}`);
    if (j?.status === 'error' && !(allowError && allowError.test(msg))) throw new Error(`twitterapi.io: ${msg || 'error'}`);
    return j;
  };
  const profileOn = async (handle: string, lane: Lane): Promise<XProfile> => {
    const j = await get('/twitter/user/info', { userName: handle }, /not found/i, lane);
    if (j?.status === 'error') return { handle, notFound: true };
    const d = j?.data;
    if (!d) throw new Error('twitterapi.io: empty profile');
    if (d.unavailable) return { handle, unavailable: String(d.unavailableReason ?? d.message ?? 'unavailable') };
    const created = d.createdAt ? Date.parse(d.createdAt) : NaN;
    const urls = [...(d.profile_bio?.entities?.url?.urls ?? []), ...(d.profile_bio?.entities?.description?.urls ?? [])].map((x: any) => String(x?.expanded_url ?? '')).filter(Boolean).slice(0, 5);
    return { handle: d.userName ?? handle, id: d.id ? String(d.id) : undefined, followers: d.followers, following: d.following, createdAt: d.createdAt,
      ageDays: Number.isFinite(created) ? Math.floor((nowMs() - created) / 86400_000) : undefined,
      blueVerified: d.isBlueVerified, statuses: d.statusesCount, description: String(d.description ?? '').slice(0, 300), bioUrls: urls.length ? urls : undefined, automated: d.isAutomated };
  };
  return {
    profile: (handle) => profileOn(handle, 'fg'),
    async search(query, type = 'Latest') {
      const j = await get('/twitter/tweet/advanced_search', { query, queryType: type, cursor: '' });
      return (j?.tweets ?? []).slice(0, 20).map(toPost);
    },
    async timeline(userId) {
      const j = await get('/twitter/user/tweet_timeline', { userId, includeReplies: 'false', cursor: '' });
      return (j?.tweets ?? j?.data?.tweets ?? []).slice(0, 20).map(toPost);
    },
    async followers(handle, pages = 1) {
      const out: XFollower[] = []; let cursor = ''; let partial: string | undefined;
      for (let i = 0; i < Math.min(5, pages); i++) {
        let j: any;
        // A failure on page 2+ (queue, 429) does not discard what was already fetched — a partial sample with a mark
        try { j = await get('/twitter/user/followers', { userName: handle, cursor, pageSize: '200' }); }
        catch (e) { if (!i) throw e; partial = `pages ${i + 1}+ not checked: ${String((e as Error).message ?? e).slice(0, 100)}`; break; }
        for (const f of j?.followers ?? []) out.push({ handle: String(f.userName ?? f.screen_name ?? ''), id: f.id ? String(f.id) : undefined, followers: f.followers_count,
          statuses: f.statuses_count, createdAt: f.created_at, description: f.description ? String(f.description).slice(0, 160) : undefined, blueVerified: f.isBlueVerified });
        if (!j?.has_next_page || !j?.next_cursor) break;
        cursor = String(j.next_cursor);
      }
      const res: XFollowers = out.filter(f => f.handle);
      if (partial) res.partial = partial;
      return res;
    },
    async followerIds(handle, count = 5000) {
      const j = await get('/twitter/user/followers_ids', { userName: handle, count: String(Math.min(5000, Math.max(200, Math.round(count)))), cursor: '' });
      return (j?.ids ?? []).map(String);
    },
    async ids(handles) {
      const m = new Map<string, string>();
      // batch_info_by_ids works by ID; for names — one profile at a time (the smart list is cached for a week).
      // Background queue: 56 names × 5 s ≈ 5 min — analyses go first (A-06)
      // An X failure (402, 429, network) is kept apart from "no such account": otherwise an empty map would look "checked" (acceptance #57, round 3)
      const failed: { handle: string; reason: string }[] = [];
      for (const h of handles.slice(0, 300)) {
        try { const p = await profileOn(h, 'bg'); if (p?.id) m.set(p.id, p.handle); }
        catch (e) { failed.push({ handle: h, reason: String((e as Error).message ?? e).slice(0, 120) }); }
      }
      return Object.assign(m, { failed });
    },
  };
}

/**
 * X response cache on top of the provider (A-06): profile and followers change over hours, not minutes — one account
 * is not fetched again in every analysis. Search — 10 min (talk about a fresh token changes fast).
 * Errors are not cached; identical in-flight requests share one answer. Sits on top of meterX: a cache hit
 * is not a twitterapi.io call and does not reach the Cost counter. One cache per provider (analyses and model tools).
 */
export const X_CACHE_TTL_MS = { profile: 6 * 3600_000, followers: 6 * 3600_000, followerIds: 6 * 3600_000, timeline: 30 * 60_000, search: 10 * 60_000 } as const;
const X_CALL_CACHES = new WeakMap<XProvider, XProvider>();
const CACHED_X = Symbol('cachedX');
/**
 * Follower-check tally of one X research (A-16, smart_check measurement): records actually received from twitterapi.io,
 * and a "taken from the call cache" flag. Set around xResearch via AsyncLocalStorage — parallel analyses do not mix.
 */
export interface FollowerTally { idsRecords: number; sampleRecords: number; idsCached: boolean; sampleCached: boolean }
const followerTally = new AsyncLocalStorage<FollowerTally>();
export function cachedX(x: XProvider, nowMs: () => number = Date.now): XProvider {
  if ((x as { [CACHED_X]?: true })[CACHED_X]) return x;     // already cached: a second layer would count a hit as a request
  const hit = X_CALL_CACHES.get(x);
  if (hit) return hit;
  const memo = new Map<string, { at: number; ttl: number; p: Promise<unknown> }>();
  /** shortIf: an answer to re-check soon (no account / unavailable, partial sample) — lives like search, 10 min. */
  const call = <T,>(ttl: number, key: string, f: () => Promise<T>, shortIf?: (v: T) => boolean): Promise<T> => {
    const now = nowMs(); const c = memo.get(key);
    const tally = followerTally.getStore();
    const kind = key.startsWith('fi|') ? 'ids' : key.startsWith('f|') ? 'sample' : undefined;
    if (c && now - c.at < c.ttl) { if (tally && kind) tally[kind === 'ids' ? 'idsCached' : 'sampleCached'] = true; return c.p as Promise<T>; }
    const p = f();
    if (tally && kind) p.then(v => { const n = Array.isArray(v) ? v.length : 0; if (kind === 'ids') tally.idsRecords += n; else tally.sampleRecords += n; }, () => { /* failure — 0 records */ });
    memo.set(key, { at: now, ttl, p });
    p.then(v => { const e = memo.get(key); if (e?.p === p && shortIf?.(v)) e.ttl = Math.min(e.ttl, X_CACHE_TTL_MS.search); },
      () => { if (memo.get(key)?.p === p) memo.delete(key); });
    if (memo.size > 2000) memo.delete(memo.keys().next().value!);
    return p;
  };
  const T = X_CACHE_TTL_MS;
  const c: XProvider = {
    // A fresh or renamed account: "missing" may become "exists" in 10 min
    profile: h => call(T.profile, `p|${h.toLowerCase()}`, () => x.profile(h), v => !!(v?.notFound || v?.unavailable)),
    search: (q, type = 'Latest') => call(T.search, `s|${type}|${q}`, () => x.search(q, type)),
  };
  if (x.timeline) c.timeline = id => call(T.timeline, `t|${id}`, () => x.timeline!(id));
  if (x.followers) c.followers = (h, pages = 1) => call(T.followers, `f|${h.toLowerCase()}|${pages}`, () => x.followers!(h, pages), v => !!v.partial);
  // The follower count changes between analyses — key by a 1000 bucket (the request is up to 5000 IDs anyway), otherwise the cache never hits
  if (x.followerIds) c.followerIds = (h, count) => { const b = Math.min(5000, Math.ceil(Math.max(1, count ?? 5000) / 1000) * 1000); return call(T.followerIds, `fi|${h.toLowerCase()}|${b}`, () => x.followerIds!(h, b)); };
  if (x.ids) c.ids = hs => x.ids!(hs);
  Object.defineProperty(c, CACHED_X, { value: true });
  X_CALL_CACHES.set(x, c);
  return c;
}

// Scanner bots: the list and filter are in src/intel/entities.ts (they are cut there before entity selection).
// Here is the second line: the X from a token's DexScreener profile may also be a bot.

// ---------------- Domain age (RDAP) ----------------
export async function domainAgeDays(domain: string, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  const r = await fetchImpl(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(8_000) });
  // 404 — this zone's registry (.trade, .fun …) has no RDAP: age unknown, this is not "no such domain"
  if (r.status === 404) throw new Error(`no RDAP data for .${domain.split('.').pop()} — age unknown`);
  if (!r.ok) throw new Error(`rdap HTTP ${r.status}`);
  const j: any = await r.json();
  const reg = (j?.events ?? []).find((e: any) => e.eventAction === 'registration')?.eventDate;
  return reg ? Math.floor((nowMs - Date.parse(reg)) / 86400_000) : undefined;
}

// ---------------- Website text (with protection against internal-network access) ----------------
// Non-public ranges: private, loopback, link-local (cloud metadata 169.254.169.254), CGNAT, benchmark, multicast, reserved
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./, /^192\.0\.0\./, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./, /^(22[4-9]|23\d|24\d|25[0-5])\./];
/**
 * Review #144: internal IPv6 networks are checked on the parsed address (BlockList), not the text: the expanded forms 0:0:0:0:0:0:0:1,
 * 0:0:0:0:0:ffff:7f00:1, IPv4-compatible ::7f00:1 slipped past the text check below.
 */
const V6_INTERNAL = new BlockList();
for (const [net, prefix] of [['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const)
  V6_INTERNAL.addSubnet(net, prefix, 'ipv6');
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some(re => re.test(ip));
  if (isIP(ip) === 6) { try { if (V6_INTERNAL.check(ip, 'ipv6')) return true; } catch { return true; } }
  const v = ip.toLowerCase();
  // IPv4 inside IPv6 (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d) — always refused
  if (/(^|:)(\d{1,3}\.){3}\d{1,3}$/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('::ffff:')) return true;
  return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^fe[c-f]/.test(v) || v.startsWith('ff');
}
/**
 * The connection goes exactly to the IP we checked (DNS-rebinding protection: between the check and the request
 * the domain cannot "move" to 169.254.169.254).
 */
const pinnedAgent = new Agent({
  connect: {
    lookup: (host: string, opts: any, cb: any) => dnsLookup(host, { ...opts, all: true }, (err: any, addrs: any) => {
      if (err) return cb(err);
      const list = (Array.isArray(addrs) ? addrs : [{ address: addrs, family: opts?.family ?? 4 }]) as { address: string; family: number }[];
      if (!list.length || list.some(a => isPrivateIp(a.address))) return cb(new Error(`refused: ${host} resolves to a non-public address`));
      return opts?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    }),
  },
});
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s)');
  if (u.username || u.password) throw new Error('credentials in url');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('non-standard port');
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(h)) { if (isPrivateIp(h)) throw new Error('private ip'); return u; }
  if (/\.(local|internal|localhost|lan|home|corp)$/i.test(h) || h === 'localhost' || !h.includes('.')) throw new Error('local host');
  return u; // DNS is checked on connect (pinnedAgent)
}
/** fetch through the checking agent. */
const safeFetch = ((u: any, init: any) => undiciFetch(u, { ...init, dispatcher: pinnedAgent })) as unknown as typeof fetch;
export function htmlToText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
export interface PageInfo { title?: string; description?: string; text: string;
  /** Site links to X, Telegram, Discord, docs, GitHub, the app. */ links?: string[];
  /** The site is a JavaScript app: the HTML has almost no text. This is NOT a sign of an empty site. */ jsApp?: boolean;
  /** Read in a real browser (Chromium): buttons and task pages. */ rendered?: boolean; buttons?: string[];
  tasks?: { url: string; title?: string; text: string }[] }

const meta = (html: string, name: string) => html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']{1,400})["']`, 'i'))?.[1]
  ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']{1,400})["'][^>]*(?:name|property)=["']${name}["']`, 'i'))?.[1];
const USEFUL_LINK = /(x\.com|twitter\.com|t\.me|discord\.(gg|com)|docs\.|gitbook|github\.com|medium\.com|mirror\.xyz|whitepaper|\/docs|app\.|dexscreener|coingecko|opensea)/i;

export async function pageText(url: string, fetchImpl: typeof fetch = safeFetch, maxChars = 3000, redirectsLeft = 3): Promise<PageInfo | undefined> {
  const u = await assertPublicUrl(url);
  const r = await fetchImpl(u, { redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; research bot)' } });
  if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); return loc && redirectsLeft > 0 ? pageText(new URL(loc, u).toString(), fetchImpl, maxChars, redirectsLeft - 1) : undefined; }
  if (!r.ok) throw new Error(`site HTTP ${r.status}`);
  if (!/text\/html|text\/plain/.test(r.headers.get('content-type') ?? '')) return undefined;
  const body = (await r.text()).slice(0, 400_000);
  const dec = (t?: string) => t?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  const title = dec(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])?.slice(0, 150);
  const description = dec(meta(body, 'description') ?? meta(body, 'og:description') ?? meta(body, 'twitter:description'))?.slice(0, 300);
  const text = htmlToText(body);
  const links = [...new Set([...body.matchAll(/href=["'](https?:\/\/[^"'#\s]{4,200})["']/gi)].map(m => m[1]).filter(l => USEFUL_LINK.test(l)))].slice(0, 12);
  // A JS app (React/Next/Vite): almost no text in the HTML, content is drawn in the browser
  const jsApp = text.length < 400 && /<script[^>]+src=|id=["'](root|app|__next)["']/i.test(body);
  return { title, description, text: text.slice(0, maxChars), ...(links.length ? { links } : {}), ...(jsApp ? { jsApp } : {}) };
}

// ---------------- Contract check on Robinhood Chain (Blockscout) ----------------
export async function rhContractVerified(address: string, fetchImpl: typeof fetch = fetch): Promise<boolean | undefined> {
  const r = await fetchImpl(`https://robinhoodchain.blockscout.com/api/v2/smart-contracts/${address}`, { signal: AbortSignal.timeout(8_000) });
  if (r.status === 404) return false;
  if (!r.ok) return undefined;
  const j: any = await r.json();
  return j?.is_verified === true;
}

// ---------------- Dossier assembly ----------------
export interface EnrichDeps {
  market: MarketClient;
  x?: XProvider;
  domainAge?: (d: string) => Promise<number | undefined>;
  page?: (url: string) => Promise<PageInfo | undefined>;
  rhVerified?: (addr: string) => Promise<boolean | undefined>;
  opensea?: OpenSeaClient;
  perp?: import('../checks/perp.js').PerpClient;
  /** What is trending on the market now (GeckoTerminal, DexScreener). */
  trends?: TrendsClient;
  /** Prediction markets (Polymarket). */
  polymarket?: import('../checks/polymarket.js').PolymarketClient;
  /** Known smart X accounts (server/config/smart-accounts.csv). */
  smart?: SmartAccounts;
  /** Clock (tests use virtual time). */
  now?: () => number;
  /** A site in a real browser (JS app sites, tasks/quests). */
  render?: (url: string, opts?: { tasks?: boolean; timeoutMs?: number }) => Promise<import('./browser.js').RenderedPage | undefined>;
  /** Honeypot simulation for EVM (honeypot.is). */
  honeypot?: import('../checks/hardcheck.js').HoneypotCheck;
}
export interface Dossier {
  tokens: { address: string; chain: Chain; market?: MarketInfo; rug?: RugInfo; rhVerified?: boolean; honeypot?: import('../checks/hardcheck.js').HoneypotInfo }[];
  domains: { domain: string; ageDays?: number; note?: string }[];
  x: XProfile[];
  xSearch: { query: string; posts: XPost[] }[];
  /** X research by code: profile, timeline, who writes and how much, followers (smart, bought). */
  xResearch?: XPack[];
  pages: ({ url: string } & PageInfo)[];
  nft: NftInfo[];
  /** Prediction markets from the message links (outcome prices from the order book). */
  predictions?: import('../checks/polymarket.js').PmMarket[];
  /** Perp prices for assets named in the text (BTC, ETH…). */
  perps?: Record<string, number>;
  /** Token addresses from the project's official X (the owner's decision 2026-10-23), verified by code — they can be acted on. */
  officialCas?: OfficialCa[];
  /** Trends: what is rising on the token's chain and what our communities discuss (for low-score sources). */
  trends?: MarketTrends & { communities?: CommunityTrend[] };
  /**
   * Project X accounts confirmed by code (A-08): each says whose it is (entity: evm:/sol:/collection:/name:) and how it was confirmed.
   * A post about a project gets only that project's handle.
   */
  projectX?: ProjectX[];
  errors: string[];
}

// ---------------- Address from the project's official X ----------------
// The owner (2026-10-23): "if the CA is on the project's official X page, it may be used". Protection against fakes:
//  - the "official" X is only the account the Discord message itself links (@handle or an x.com link);
//  - the address is taken from that account's bio or its own post (not from replies or other people's posts);
//  - DexScreener confirms: a trading pair exists and either the token profile links the same X,
//    or the token ticker matches the ticker in the message (if the message names one).
export interface OfficialCa { address: string; chain: Chain; handle: string; how: string; symbol?: string }

export async function verifyOfficialCa(address: string, ctx: { handles: string[]; tickers: string[]; profiles?: XProfile[]; posts?: XPost[] }, d: EnrichDeps): Promise<OfficialCa | undefined> {
  const handles = ctx.handles.map(h => h.replace(/^@/, '').toLowerCase()).filter(Boolean);
  if (!handles.length) return undefined;
  const m = await d.market.market(address).catch(() => undefined);
  if (!m?.priceUsd) return undefined;
  const sym = (m.symbol ?? '').replace(/^\$/, '').toLowerCase();
  const tickerOk = !ctx.tickers.length || ctx.tickers.some(t => t.replace(/^\$/, '').toLowerCase() === sym);
  const base = { address, chain: m.chain, symbol: m.symbol };
  if (m.twitter && handles.includes(m.twitter.toLowerCase())) return { ...base, handle: m.twitter, how: `DexScreener profile of the token links @${m.twitter}` };
  if (!tickerOk) return undefined;
  const lc = address.toLowerCase();
  for (const h of handles.slice(0, 2)) {
    const prof = ctx.profiles?.find(p => p.handle.toLowerCase() === h) ?? (d.x ? await d.x.profile(h).catch(() => undefined) : undefined);
    if (prof?.description?.toLowerCase().includes(lc)) return { ...base, handle: h, how: `in the bio of @${h}` };
    const own = (ctx.posts ?? []).filter(p => p.author.toLowerCase() === h);
    const posts = own.some(p => p.text.toLowerCase().includes(lc)) ? own : d.x ? await d.x.search(`from:${h} ${address}`).catch(() => []) : [];
    if (posts.some(p => p.author.toLowerCase() === h && p.text.toLowerCase().includes(lc))) return { ...base, handle: h, how: `posted by @${h}` };
  }
  return undefined;
}

// ---------------- Market trends ----------------
// The analyst compares the token with what is rising now: the same meme/narrative trending is a plus, a copy of someone else's trend is a flag.
export interface TrendPool { name: string; ageHours?: number; fdvUsd?: number; volume24hUsd?: number; change1hPct?: number; change24hPct?: number }
export interface BoostedToken { chain: string; address: string; description?: string; boost?: number }
export interface MarketTrends { chain: string; trendingPools: TrendPool[]; boosted: BoostedToken[] }
export interface CommunityTrend { key: string; name?: string; authors: number; servers: number }
export interface TrendsClient { trends(chain: Chain | string): Promise<MarketTrends> }

/** Agent chain → GeckoTerminal network name. */
export const GECKO_NETWORK: Record<string, string | undefined> = { solana: 'solana', ethereum: 'eth', base: 'base', arbitrum: 'arbitrum', bsc: 'bsc' };

export function parseGeckoTrending(json: any, nowMs: number): TrendPool[] {
  const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  return (Array.isArray(json?.data) ? json.data : []).slice(0, 12).map((p: any) => {
    const a = p?.attributes ?? {};
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
    return { name: String(a.name ?? '').slice(0, 60), ageHours: Number.isFinite(created) ? Math.round((nowMs - created) / 3600_000) : undefined,
      fdvUsd: num(a.fdv_usd) ?? num(a.market_cap_usd), volume24hUsd: num(a.volume_usd?.h24), change1hPct: num(a.price_change_percentage?.h1), change24hPct: num(a.price_change_percentage?.h24) };
  }).filter((p: TrendPool) => p.name);
}

export function parseDexBoosts(json: any): BoostedToken[] {
  return (Array.isArray(json) ? json : []).slice(0, 30).map((t: any) => ({ chain: String(t?.chainId ?? ''), address: String(t?.tokenAddress ?? ''),
    description: t?.description ? String(t.description).replace(/\s+/g, ' ').slice(0, 140) : undefined, boost: Number(t?.totalAmount) || undefined }))
    .filter((t: BoostedToken) => t.chain && t.address);
}

/** GeckoTerminal trending pools per chain + DexScreener top boosts (all chains, filtered by chain). 10-minute cache. */
export function publicTrends(nowMs: () => number, fetchImpl: typeof fetch = fetch): TrendsClient {
  const cache = new Map<string, { at: number; v: any }>();
  const getJson = async (url: string) => {
    const c = cache.get(url);
    if (c && nowMs() - c.at < 10 * 60_000) return c.v;
    const r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const v = await r.json();
    cache.set(url, { at: nowMs(), v });
    return v;
  };
  return {
    async trends(chain) {
      const net = GECKO_NETWORK[chain];
      const [pools, boosts] = await Promise.all([
        net ? getJson(`https://api.geckoterminal.com/api/v2/networks/${net}/trending_pools?page=1`).then(j => parseGeckoTrending(j, nowMs())).catch(() => [] as TrendPool[]) : Promise.resolve([] as TrendPool[]),
        getJson('https://api.dexscreener.com/token-boosts/top/v1').then(parseDexBoosts).catch(() => [] as BoostedToken[]),
      ]);
      const dsChain = chain === 'bsc' ? 'bsc' : String(chain);
      return { chain: String(chain), trendingPools: pools, boosted: boosts.filter(b => b.chain === dsChain).slice(0, 8) };
    },
  };
}

/**
 * The code hard check rejects all dossier tokens and there is nothing else in it (NFT, markets) — the analysis ends without a model
 * (router: hard_check). One rule for router and for the "skip the follower check" decision (A-16).
 */
export function codeRejectsAll(dos: Pick<Dossier, 'tokens' | 'nft' | 'predictions'>, strictLiquidity: boolean): boolean {
  return dos.tokens.length > 0 && !dos.nft.length && !(dos.predictions?.length) && dos.tokens.every(t => !!hardRejectReasons(t, { strictLiquidity }));
}

const settle = async <T,>(p: Promise<T>, errs: string[], label: string): Promise<T | undefined> => {
  try { return await p; } catch (e) { errs.push(`${label}: ${String((e as Error).message ?? e).slice(0, 120)}`); return undefined; }
};

/** X-pack cache per provider (each run/test has its own). */
const X_CACHES = new WeakMap<XProvider, Map<string, { at: number; pack: XPack }>>();

/** Dossier for the message entities. Limits: up to 3 tokens, 2 domains, 2 X accounts, 2 pages. */
export async function buildDossier(input: { tokens: string[]; domains: string[]; xHandles: string[]; urls: string[]; tickers: string[]; collections?: string[]; text?: string;
  /** Polymarket: "event/market" from links. */ predictions?: string[];
  /** Hard check as in router (strictLiquidity — source score ≤ 6): all tokens rejected — no follower check (A-16). */ hardCheck?: { strictLiquidity: boolean };
  /** For the smart_check measurement log (A-16). */ log?: { msgId: string; source: string; trust?: number; trigger?: string };
  /**
   * Handles — "discord" candidates (option 1): only from the trusted author's own message text (no reply, embed cards
   * or scanner bots; review A-handles R3). These are not xHandles: those also come from the reply and the batch. Unset — no "discord" candidates.
   */
  discordX?: string[] }, d: EnrichDeps): Promise<Dossier> {
  const errors: string[] = [];
  const dos: Dossier = { tokens: [], domains: [], x: [], xSearch: [], pages: [], nft: [], errors };
  if (d.x) d = { ...d, x: cachedX(d.x, d.now ?? Date.now) };
  if (d.perp && input.text) {
    const mids = await settle(d.perp.mids(), errors, 'hyperliquid');
    if (mids) { const found = perpAssetsInText(input.text, mids); if (found.length) dos.perps = Object.fromEntries(found.map(a => [a, mids[a]])); }
  }
  // Step 1: token market (DexScreener) and NFT (OpenSea). Also the links the project publishes itself: X and website.
  const xHandles = input.xHandles.filter(notScannerBot), urls = [...input.urls], domains = [...input.domains];
  const addX = (raw?: string) => { const h = normalizeHandle(raw); if (h && notScannerBot(h) && !xHandles.some(x => x.toLowerCase() === h.toLowerCase())) xHandles.push(h); };
  const addUrl = (u?: string) => { if (u && /^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u); };
  await Promise.all([
    ...(d.polymarket ? (input.predictions ?? []).slice(0, 2).map(async (ref) => {
      const [event, market] = ref.split('/');
      const ms = await settle(d.polymarket!.markets({ event: event || undefined, market: market || undefined }), errors, `polymarket ${ref.slice(0, 30)}`);
      if (ms?.length) dos.predictions = [...(dos.predictions ?? []), ...ms].slice(0, 10);
    }) : []),
    ...(d.opensea ? (input.collections ?? []).slice(0, 2).map(async (slug) => {
      const n = await settle(d.opensea!.nft(slug), errors, `opensea ${slug}`);
      if (n) { dos.nft.push(n); addX(n.twitter); addUrl(n.projectUrl); }
    }) : []),
    ...input.tokens.slice(0, 3).map(async (a) => {
      const market = await settle(d.market.market(a), errors, `market ${a.slice(0, 8)}`);
      const chain: Chain = market?.chain ?? (a.startsWith('0x') ? 'unknown' : 'solana');
      const rug = chain === 'solana' ? await settle(d.market.rug(chain, a), errors, 'rugcheck') : undefined;
      const [rhVerified, honeypot] = await Promise.all([
        chain === 'robinhood' && d.rhVerified ? settle(d.rhVerified(a), errors, 'blockscout') : Promise.resolve(undefined),
        d.honeypot && a.startsWith('0x') && market?.priceUsd ? settle(d.honeypot(chain, a), errors, 'honeypot') : Promise.resolve(undefined),
      ]);
      dos.tokens.push({ address: a, chain, market, rug, rhVerified, ...(honeypot ? { honeypot } : {}) });
      addX(market?.twitter); for (const w of market?.websites ?? []) addUrl(w);
    }),
  ]);
  for (const u of urls) { try { const h = new URL(u).hostname.replace(/^www\./, ''); const bd = h.split('.').slice(-2).join('.'); if (!domains.includes(bd)) domains.push(bd); } catch { /* ignore */ } }

  // A-16 (#121, the owner 2026-11-13 07:42 UTC): a token that code rejects without a model anyway is not checked against smart accounts
  const rejectedByCode = !!input.hardCheck && codeRejectsAll(dos, input.hardCheck.strictLiquidity);
  // Step 2: X research (profile, timeline, who writes and how much, followers), domain age, website — in parallel
  const ticker = (input.tickers[0] ?? dos.tokens.find(t => t.market?.symbol)?.market?.symbol)?.replace(/^\$/, '');
  const address = input.tokens[0];
  const fetchPage = async (u: string) => { const p = await settle(d.page!(u), errors, `page ${u.slice(0, 40)}`); if (p) dos.pages.push({ url: u, ...p }); return p; };
  await Promise.all([
    ...(d.domainAge ? domains.slice(0, 2).map(async (dm) => {
      try { dos.domains.push({ domain: dm, ageDays: await d.domainAge!(dm) }); }
      catch (e) { dos.domains.push({ domain: dm, note: `age unknown: ${String((e as Error).message ?? e).slice(0, 80)}` }); }
    }) : []),
    ...(d.x && (xHandles.length || ticker || address) ? [(async () => {
      // 30 min cache: re-checks and repeats of the same project do not pay for X again
      // A pack without the follower check is stored separately: it does not suit an analysis that needs the check
      const base = `${xHandles[0] ?? ''}|${ticker ?? ''}|${address ?? ''}`.toLowerCase();
      const key = rejectedByCode ? `${base}|nosmart` : base;
      const now = (d.now ?? Date.now)();
      let X_CACHE = X_CACHES.get(d.x!);
      if (!X_CACHE) { X_CACHE = new Map(); X_CACHES.set(d.x!, X_CACHE); }
      const fresh = (k: string) => { const c = X_CACHE!.get(k); return c && now - c.at < 30 * 60_000 ? c : undefined; };
      const hit = fresh(base) ?? (rejectedByCode ? fresh(key) : undefined);
      let measured: SmartCheckMeasure | undefined;
      const tally: FollowerTally = { idsRecords: 0, sampleRecords: 0, idsCached: false, sampleCached: false };
      const pack = hit ? hit.pack
        : await followerTally.run(tally, () => settle(xResearch({ handle: xHandles[0], ticker, address }, d.x!, now, d.smart ?? { handles: new Map() }, { smartCheck: !rejectedByCode, measure: m => { measured = m; } }), errors, 'x research'));
      if (pack && !hit && !pack.unchecked.length) { X_CACHE.set(key, { at: now, pack }); if (X_CACHE.size > 300) X_CACHE.delete(X_CACHE.keys().next().value!); }
      // A-16 measurement (acceptance #124, round 1): records — only those actually received from twitterapi.io; a call-cache hit is
      // cached: 'calls'; a repeat from the pack cache is an event too (cached: 'pack', 0 records, the finding from the pack), otherwise the
      // threshold script would not see the finding for the analysis that got it
      if (hit && pack) measured = { done: !!pack.followers, why: pack.followers ? undefined : 'cached pack without the check', accountFollowers: pack.account?.followers,
        idsRecords: 0, sampleRecords: 0, smartFound: pack.followers?.smart.map(s => s.handle) ?? [] };
      const failed = (pack?.unchecked ?? []).filter(u => /^X (followers|follower ids|smart)/i.test(u));
      if (measured && input.log) reviewLog.write('smart_check', { ...input.log, ...measured,
        ...(hit ? { cached: 'pack' } : { idsRecords: tally.idsRecords, sampleRecords: tally.sampleRecords, usedIds: measured.idsRecords, usedSample: measured.sampleRecords,
          ...(tally.idsCached || tally.sampleCached ? { cached: 'calls' } : {}) }),
        ...(failed.length ? { failed } : {}), handle: xHandles[0], rejectedByCode,
        tokens: dos.tokens.map(t => ({ address: t.address, chain: t.chain, liquidityUsd: t.market?.liquidityUsd, fdvUsd: t.market?.fdvUsd, pairAgeMinutes: t.market?.pairAgeMinutes })),
        nft: dos.nft.map(n => n.slug) });
      if (!pack) return;
      dos.xResearch = [pack];
      if (pack.account) dos.x.push(pack.account);
      for (const u of pack.account?.bioUrls ?? []) addUrl(u);
    })()] : []),
    ...(d.x ? xHandles.slice(1, 2).map(async (h) => { const p = await d.x!.profile(h).catch(e => ({ handle: h, error: String((e as Error).message ?? e).slice(0, 100) } as XProfile)); if (p) dos.x.push(p); }) : []),
    ...(d.page ? urls.slice(0, 2).map(fetchPage) : []),
  ]);
  // The site is a JS app or almost empty: read the docs linked by the site itself (and the link from the X bio)
  if (d.page) {
    const seen = new Set(dos.pages.map(p => p.url));
    const thin = dos.pages.some(p => p.jsApp || p.text.length < 300) || !dos.pages.length;
    const more = [...urls.filter(u => !seen.has(u)).slice(0, 1),
      ...(thin ? dos.pages.flatMap(p => p.links ?? []).filter(l => /docs\.|gitbook|\/docs|whitepaper|medium\.com|mirror\.xyz/i.test(l)) : [])]
      .filter((u, i, a) => !seen.has(u) && a.indexOf(u) === i).slice(0, 2);
    await Promise.all(more.map(fetchPage));
  }
  // A JS app site or almost empty — open the first one in a real browser (≤ 12 s), together with task pages
  if (d.render) {
    const target = dos.pages.find(p => p.jsApp || p.text.length < 300) ?? (!dos.pages.length && urls[0] ? { url: urls[0] } as any : undefined);
    if (target) {
      const r = await settle(d.render(target.url, { tasks: true, timeoutMs: 12_000 }), errors, `browser ${String(target.url).slice(0, 40)}`);
      if (r) {
        const page = { url: target.url, title: r.title, text: r.text, links: r.links.map(l => l.href).slice(0, 20), buttons: r.buttons, tasks: r.tasks, rendered: true };
        const i = dos.pages.findIndex(p => p.url === target.url);
        if (i >= 0) dos.pages[i] = { ...dos.pages[i], ...page, jsApp: undefined }; else dos.pages.push(page);
      }
    }
  }
  // Step 3: the message has no address but has the project's X — look for the address in its bio and own posts, verify by code
  const ownHandles = input.xHandles.filter(notScannerBot);
  if (!input.tokens.length && ownHandles.length) {
    const msgHandles = ownHandles.map(h => h.toLowerCase());
    const texts = [...dos.x.filter(p => msgHandles.includes(p.handle.toLowerCase())).map(p => p.description ?? ''),
      ...(dos.xResearch ?? []).filter(x => x.handle && msgHandles.includes(x.handle.toLowerCase())).flatMap(x => x.activity?.top.map(t => t.text) ?? [])];
    const cands = [...new Set(texts.flatMap(t => { const pre = prefilter(t); return [...pre.evmAddresses, ...pre.solanaMints]; }))].slice(0, 3);
    const found = (await Promise.all(cands.map(a => verifyOfficialCa(a, { handles: ownHandles, tickers: input.tickers, profiles: dos.x, posts: dos.xSearch.flatMap(q => q.posts) }, d).catch(() => undefined)))).filter(Boolean) as OfficialCa[];
    if (found.length) {
      dos.officialCas = found;
      for (const f of found) { const market = await settle(d.market.market(f.address), errors, 'market'); dos.tokens.push({ address: f.address, chain: f.chain, market }); }
    }
  }
  // Code will reject the tokens without a model (A-16) — do not confirm the project X: there will be no note, paid X requests are not needed (finisher #69, round 2)
  if (!rejectedByCode) {
    const settled = new Set<string>();
    if (d.x) await withLimit(resolveProjectX(dos, d, dos.nft, xHandlesOfMessage(input.discordX ?? []), settled), PROJECT_X_MS, errors, 'project X');
    openseaFallback(dos, dos.nft, settled);
  }
  return dos;
}

/** Normalized "discord" candidate handles without scanner bots (where to take them from is decided by router: discordHandles). */
export const xHandlesOfMessage = (hs: string[]): string[] => [...new Set(hs.map(h => normalizeHandle(h)).filter((h): h is string => !!h && notScannerBot(h)))];

/**
 * A handle from the OpenSea page (twitter_username) is strong evidence. If the X profile was not checked within the limit or X is not configured —
 * set it anyway (the owner 2026-11-18 ~12:55 UTC): the handle is normalized and valid by X format; a note goes to errors (log).
 * A collection whose X was already checked (settled) does not get here: the check refused — so the account is missing or blocked.
 */
function openseaFallback(dos: Dossier, nfts: NftInfo[], settled: Set<string>): void {
  const add: ProjectX[] = [];
  for (const n of nfts) {
    const entity = `collection:${n.slug.toLowerCase()}`;
    const h = normalizeHandle(n.twitter);
    if (!h || !notScannerBot(h) || settled.has(entity) || dos.projectX?.some(p => p.entity === entity)) continue;
    add.push({ entity, name: n.name ?? n.slug, handle: h, how: `the OpenSea page of ${entity} lists @${h} (X profile not checked in time)` });
    dos.errors.push(`project X: @${h} for ${entity} taken from the OpenSea page without an X check (not checked in ${PROJECT_X_MS / 1000} s or X not configured)`);
  }
  addProjectX(dos, add);
}

/**
 * Limit on confirming the project X (review #69, round 2, blocker 2): it runs in the dossier — before the model, so before exits and entries, hence
 * no longer than 5 s; if not done in time — no X is set, the reason goes to errors. Search by name runs only after actions (resolveNameX).
 */
export const PROJECT_X_MS = 5000;
export async function withLimit<T>(p: Promise<T>, ms: number, errs: string[], label: string): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>(r => { timer = setTimeout(() => r('late'), ms); (timer as { unref?: () => void }).unref?.(); });
  try {
    const r = await Promise.race([p, late]);
    if (r === 'late') { errs.push(`${label}: not checked in ${ms / 1000} s — no handle`); p.catch(() => { /* a late answer is not needed */ }); return undefined; }
    return r as T;
  } catch (e) { errs.push(`${label}: ${String((e as Error).message ?? e).slice(0, 120)}`); return undefined; }
  finally { clearTimeout(timer); }
}

const xCtx = (dos: Dossier, d: EnrichDeps) => ({ x: d.x!, smart: d.smart, pages: dos.pages, profiles: dos.x, packs: dos.xResearch, opensea: d.opensea, errors: dos.errors });
/** X handles from website pages (profiles only, not tweets). Social networks and services are not the project site. */
const xFromSite = (dos: Dossier, sites: string[]) => dos.pages.filter(p => !!siteKey(p.url) && sites.some(u => { try { return new URL(u).hostname === new URL(p.url).hostname; } catch { return false; } }))
  .flatMap(p => (p.links ?? []).map(profileLinkHandle).filter((h): h is string => !!h));
const addProjectX = (dos: Dossier, found: ProjectX[]) => {
  const all = [...(dos.projectX ?? []), ...found];
  if (all.length) dos.projectX = all.filter((p, i) => all.findIndex(q => q.entity === p.entity) === i);
};

/**
 * X of the dossier's collections and tokens (A-08, round 3). Candidates come from the OpenSea page, the token's DexScreener profile and
 * website pages; choice and threshold — confirmProjectX (for a token — only a back-link to its address). No search by name.
 */
async function resolveProjectX(dos: Dossier, d: EnrichDeps, nfts: NftInfo[], msgX: string[], settled: Set<string>, tokens = true): Promise<void> {
  const ctx = xCtx(dos, d);
  const jobs: { e: XEntity; cands: Parameters<typeof confirmProjectX>[1] }[] = [];
  for (const n of nfts) {
    const e: XEntity = { entity: `collection:${n.slug.toLowerCase()}`, name: n.name ?? n.slug, sites: n.projectUrl ? [n.projectUrl] : [], slugs: [n.slug.toLowerCase()], openseaX: n.twitter };
    const os = normalizeHandle(n.twitter);
    // A handle from the Discord message is a candidate only if it resembles the collection name (option 1)
    jobs.push({ e, cands: [...(os ? [{ handle: os, from: 'opensea' as const }] : []), ...msgX.filter(h => discordLike(h, e.name!)).map(h => ({ handle: h, from: 'discord' as const })),
      ...xFromSite(dos, e.sites).map(h => ({ handle: h, from: 'site' as const }))] });
  }
  if (tokens) for (const t of dos.tokens) {
    if (!t.market) continue;
    // The DexScreener profile (X and site) is self-declared: a clone will list the real project's X and site; so for address the token X
    // is confirmed only by a back-link to this address (confirmProjectX). A handle from the Discord message for a token — same threshold (no relaxing)
    const e: XEntity = { entity: t.address.startsWith('0x') ? `evm:${t.address.toLowerCase()}` : `sol:${t.address}`, name: t.market.symbol ? `$${t.market.symbol}` : undefined,
      sites: t.market.websites ?? [], slugs: [], dexX: t.market.twitter, address: t.address };
    const dx = normalizeHandle(t.market.twitter);
    jobs.push({ e, cands: [...(dx ? [{ handle: dx, from: 'dex' as const }] : []), ...msgX.slice(0, 2).map(h => ({ handle: h, from: 'discord' as const })),
      ...xFromSite(dos, e.sites).map(h => ({ handle: h, from: 'site' as const }))] });
  }
  const found = (await Promise.all(jobs.filter(j => j.cands.length).map(async j => { const p = await confirmProjectX(j.e, j.cands, ctx); settled.add(j.e.entity); return p; })))
    .filter((p): p is ProjectX => !!p);
  addProjectX(dos, found);
}

/**
 * Collections not in the dossier (the message has more than two; the analyst opened an OpenSea page with a tool during the analysis) —
 * after actions, for notes: OpenSea by slug (twitter_username), then X as in the dossier; if not in time — the handle from the OpenSea page.
 * Limit — PROJECT_X_MS for everything (OpenSea and X together).
 */
export async function resolveCollectionsX(dos: Dossier, slugs: string[], d: EnrichDeps, msgX: string[] = []): Promise<void> {
  const fresh = [...new Set(slugs.map(s => s.toLowerCase()).filter(s => /^[a-z0-9-]+$/.test(s)))].filter(s => !dos.nft.some(n => n.slug.toLowerCase() === s)).slice(0, 4);
  if (!fresh.length || !d.opensea) return;
  const t0 = Date.now();
  const got = await withLimit(Promise.all(fresh.map(s => settle(d.opensea!.nft(s), dos.errors, `opensea ${s}`))), PROJECT_X_MS, dos.errors, 'opensea (collections for the post)');
  const nfts = (got ?? []).filter((n): n is NftInfo => !!n);
  if (!nfts.length) return;
  dos.nft.push(...nfts);
  const settled = new Set<string>();
  const left = Math.max(500, PROJECT_X_MS - (Date.now() - t0));
  if (d.x) await withLimit(resolveProjectX(dos, { ...d, x: cachedX(d.x, d.now ?? Date.now) }, nfts, msgX, settled, false), left, dos.errors, 'project X (collections for the post)');
  openseaFallback(dos, nfts, settled);
}

/**
 * Project X by name (A-08, round 3) — called AFTER exits and actions, with a 5 s limit for all names (router).
 * Candidates: X profiles from the message itself (HQ's first source), then authors and @mentions from a search by name.
 * Found accounts go to dos.projectX with the entity name:<name>; failures go to dos.errors.
 * cache — the result per name for 24 h (kv), so three batches about one project do not search three times.
 */
export async function resolveNameX(dos: Dossier, names: string[], d: EnrichDeps, cache?: { get(k: string): string | undefined; set(k: string, v: string): void }, msgX: string[] = []): Promise<void> {
  if (!d.x) return;
  const ctx = xCtx(dos, d);
  const known = new Set((dos.projectX ?? []).map(p => (p.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')));
  const uniq = [...new Map(names.map(n => n.trim()).filter(n => n.replace(/[^a-z0-9]/gi, '').length >= 4).map(n => [n.toLowerCase().replace(/[^a-z0-9]/g, ''), n])).entries()]
    .filter(([sq]) => !known.has(sq)).slice(0, 2);
  const found = await Promise.all(uniq.map(async ([sq, name]) => {
    const entity = `name:${name.toLowerCase().replace(/\s+/g, ' ')}`;
    const now = (d.now ?? Date.now)();
    // Option 1 (the owner 2026-11-18 ~12:55 UTC): the handle given by the message author goes first, before the name cache (an earlier
    // analysis without a handle in the message may have cached "not found"); if confirmed — no search by name is needed
    const own = msgX.filter(h => discordLike(h, name)).map(h => ({ handle: h, from: 'discord' as const }));
    const byMsg = own.length ? await confirmProjectX({ entity, name, sites: [], slugs: [] }, own, ctx) : undefined;
    if (byMsg) return byMsg;
    try {
      const hit = JSON.parse(cache?.get(`xname:${sq}`) ?? 'null') as { at: number; handle?: string; how?: string } | null;
      if (hit && now - hit.at < 86400_000) return hit.handle ? { entity, name, handle: hit.handle, how: `${hit.how} (cached)` } satisfies ProjectX : undefined;
    } catch { /* old record */ }
    const errs0 = ctx.errors.length;
    // Dossier X profiles that did not come from the message (OpenSea, DexScreener, bio): the old threshold — similar handle and smart followers
    const msgSet = new Set(own.map(o => o.handle.toLowerCase()));
    const fromDossier = dos.x.filter(p => !p.error && !p.notFound && handleLike(p.handle, name) && !msgSet.has(p.handle.toLowerCase())).map(p => ({ handle: p.handle, from: 'site' as const }));
    const searched = await searchCandidates(name, d.x!).catch(err => { ctx.errors.push(`x search "${name.slice(0, 30)}": ${String((err as Error).message ?? err).slice(0, 100)}`); return [] as string[]; });
    const cands = [...fromDossier, ...searched.filter(h => !msgSet.has(h.toLowerCase())).map(h => ({ handle: h, from: 'search' as const }))];
    const px = cands.length ? await confirmProjectX({ entity, name, sites: [], slugs: [] }, cands, ctx) : undefined;
    // A result without failures goes to the cache ("not found" too); an X failure is not cached, the next analysis will try again
    if (ctx.errors.slice(errs0).every(e => / not confirmed | tie — /.test(e))) cache?.set(`xname:${sq}`, JSON.stringify({ at: now, handle: px?.handle, how: px?.how }));
    return px;
  }));
  addProjectX(dos, found.filter((p): p is ProjectX => !!p));
}
