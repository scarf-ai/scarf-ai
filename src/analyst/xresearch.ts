// X research of a project by code, BEFORE the model call (the owner's decision 2026-10-27: "the bot must collect as much useful
// information as possible and research X properly — this matters most; smart followers, narrative, whether anyone talks about the project at all").
// Requests go in parallel, but twitterapi.io on the free tier allows 1 request per 5 s (A-06): a pack takes up to ~1 min. Everything is compressed into numbers + a few examples so the model judges instead of searching.
// A failed request means "could not check", not "no such account" (OOLONG analysis 2026-10-27).
import type { XPost, XProfile, XProvider, XFollower } from './enrich.js';

/** Known "smart" accounts: server/config/smart-accounts.csv (handle,note). */
export interface SmartAccounts {
  handles: Map<string, string>;
  /** id → handle of the smart list resolved so far; undefined — the list is warming up in the background (the analysis does not wait). */
  ids?: () => Promise<Map<string, string> | undefined>;
  /** Wait for the background warm-up (tests, startup). */
  whenWarm?: () => Promise<void>;
  /** How many list names are resolved to IDs out of all — an incomplete check must be visible in unchecked. */
  coverage?: () => { resolved: number; total: number } | undefined;
}

export interface XTalk {
  query: string; posts: number; uniqueAuthors: number; newestAgeHours?: number;
  likes: number; views: number;
  /** Authors with an audience ≥ 5k and known smart accounts who write about the project. */
  notableAuthors: { handle: string; followers?: number; smart?: string }[];
  sample: { author: string; followers?: number; text: string; likes: number; views?: number; ageHours?: number }[];
}
export interface XPack {
  handle?: string;
  account?: XProfile;
  /** The project's own posts (timeline by userId — visible even if the account is hidden from search). */
  activity?: { posts: number; lastPostAgeHours?: number; avgLikes: number; avgViews?: number; top: { text: string; likes: number; views?: number; ageHours?: number }[] };
  /** The timeline exists but a from:handle search is empty — the account is hidden from X search (common for new or flagged accounts). */
  hiddenFromSearch?: boolean;
  talk: XTalk[];
  followers?: {
    total?: number; sampled: number;
    /** Followers with an audience ≥ 10k (up to 10, descending). */
    notable: { handle: string; followers: number; bio?: string }[];
    /** Known smart accounts among followers. */
    smart: { handle: string; note: string }[];
    /** Share of empty accounts (≤ 5 followers and ≤ 5 posts) and of those created in the last 30 days — a sign of bought followers. */
    emptyPct: number; newPct: number;
  };
  /** What could not be checked (API failure, limit) — NOT an argument against the project. */
  unchecked: string[];
}

const ageH = (iso: string | undefined, now: number) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 3600_000)) : undefined; };
const short = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 100);

export function summarizeTalk(query: string, posts: XPost[], now: number, smart: Map<string, string>, exclude?: string): XTalk {
  const own = exclude?.toLowerCase();
  const others = posts.filter(p => p.author.toLowerCase() !== own);
  const byAuthor = new Map<string, XPost>();
  for (const p of others) { const a = p.author.toLowerCase(); const prev = byAuthor.get(a); if (!prev || (p.authorFollowers ?? 0) > (prev.authorFollowers ?? 0)) byAuthor.set(a, p); }
  const notable = [...byAuthor.values()].filter(p => (p.authorFollowers ?? 0) >= 5000 || smart.has(p.author.toLowerCase()))
    .sort((a, b) => (b.authorFollowers ?? 0) - (a.authorFollowers ?? 0)).slice(0, 8)
    .map(p => ({ handle: p.author, followers: p.authorFollowers, ...(smart.has(p.author.toLowerCase()) ? { smart: smart.get(p.author.toLowerCase()) } : {}) }));
  const sample = [...others].sort((a, b) => (b.likes + (b.views ?? 0) / 100) - (a.likes + (a.views ?? 0) / 100)).slice(0, 5)
    .map(p => ({ author: p.author, followers: p.authorFollowers, text: short(p.text, 180), likes: p.likes, views: p.views, ageHours: ageH(p.createdAt, now) }));
  const ages = others.map(p => ageH(p.createdAt, now)).filter((x): x is number => x !== undefined);
  return { query, posts: others.length, uniqueAuthors: byAuthor.size, newestAgeHours: ages.length ? Math.min(...ages) : undefined,
    likes: others.reduce((a, p) => a + p.likes, 0), views: others.reduce((a, p) => a + (p.views ?? 0), 0), notableAuthors: notable, sample };
}

export function summarizeFollowers(list: XFollower[], total: number | undefined, now: number, smart: Map<string, string>): NonNullable<XPack['followers']> {
  const notable = list.filter(f => (f.followers ?? 0) >= 10_000).sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0)).slice(0, 10)
    .map(f => ({ handle: f.handle, followers: f.followers ?? 0, ...(f.description ? { bio: short(f.description, 80) } : {}) }));
  const smartHits = new Map<string, string>();
  for (const f of list) { const h = f.handle.toLowerCase(); if (smart.has(h)) smartHits.set(f.handle, smart.get(h)!); }
  const n = Math.max(1, list.length);
  const empty = list.filter(f => (f.followers ?? 0) <= 5 && (f.statuses ?? 0) <= 5).length;
  const fresh = list.filter(f => { const a = ageH(f.createdAt, now); return a !== undefined && a < 30 * 24; }).length;
  return { total, sampled: list.length, notable, smart: [...smartHits].map(([handle, note]) => ({ handle, note })), emptyPct: Math.round((empty / n) * 100), newPct: Math.round((fresh / n) * 100) };
}

/**
 * Full X pack: profile, own timeline, who writes and how much (ticker, address, @mentions, name), followers.
 * Cost ≈ $0.02–0.05 per project (twitterapi.io); 8–12 requests — up to ~1 min on the free tier (even pace in twitterApiIo).
 */
/**
 * The follower check (IDs up to 5k + sample) is about half of the twitterapi.io credits (A-16 #121). smartCheck: false — skip it
 * (code rejects the token without a model anyway); measure — what the check cost and found, for the log measurement (smart_check event).
 */
export interface SmartCheckMeasure { done: boolean; why?: string; accountFollowers?: number; idsRecords: number; sampleRecords: number; smartFound: string[] }
export async function xResearch(p: { handle?: string; ticker?: string; address?: string; name?: string }, x: XProvider, now: number, smart: SmartAccounts,
  o: { smartCheck?: boolean; measure?: (m: SmartCheckMeasure) => void } = {}): Promise<XPack> {
  const unchecked: string[] = [];
  const pack: XPack = { handle: p.handle, talk: [], unchecked };
  const sm = smart.handles;
  const h = p.handle?.replace(/^@/, '');
  const queries: { q: string; type: 'Latest' | 'Top' }[] = [];
  if (p.ticker) queries.push({ q: `$${p.ticker.replace(/^\$/, '')}`, type: 'Top' }, { q: `$${p.ticker.replace(/^\$/, '')}`, type: 'Latest' });
  if (p.address) queries.push({ q: p.address, type: 'Latest' });
  if (h) queries.push({ q: `@${h} -from:${h}`, type: 'Latest' });
  if (!p.ticker && !h && p.name && p.name.length >= 4) queries.push({ q: `"${p.name}"`, type: 'Latest' });

  const profileP = h ? x.profile(h).catch(e => ({ handle: h, error: errText(e) } as XProfile)) : Promise.resolve(undefined);
  const searchesP = Promise.all(queries.slice(0, 4).map(async ({ q, type }) => {
    try { return summarizeTalk(`${q} (${type})`, await x.search(q, type), now, sm, h); } catch (e) { unchecked.push(`X search ${q.slice(0, 24)}: ${errText(e)}`); return undefined; }
  }));
  const ownSearchP = h ? x.search(`from:${h}`).catch(e => { unchecked.push(`X search from:${h.slice(0, 15)} (hidden-from-search check): ${errText(e)}`); return undefined; }) : Promise.resolve(undefined);
  const [profile, talks, ownSearch] = await Promise.all([profileP, searchesP, ownSearchP]);
  pack.talk = talks.filter((t): t is XTalk => !!t);
  if (profile) {
    pack.account = profile;
    if (profile.error && !profile.notFound) unchecked.push(`X profile @${h}: ${profile.error}`);
  }
  const checkFollowers = o.smartCheck !== false;
  if (h && profile && !profile.error && !profile.unavailable) {
    const [timeline, followers, ids] = await Promise.all([
      profile.id && x.timeline ? x.timeline(profile.id).catch(e => { unchecked.push(`X timeline: ${errText(e)}`); return undefined; }) : Promise.resolve(undefined),
      checkFollowers && x.followers ? x.followers(h, (profile.followers ?? 0) > 400 ? 3 : 1).catch(e => { unchecked.push(`X followers: ${errText(e)}`); return undefined; }) : Promise.resolve(undefined),
      // More followers than the sample — match all of them (up to 5k) against the smart list by ID: it is cheap
      checkFollowers && (profile.followers ?? 0) > 600 && x.followerIds && smart.ids ? Promise.all([x.followerIds(h, profile.followers).catch(e => { unchecked.push(`X follower ids (smart check): ${errText(e)}`); return undefined; }), smart.ids().then(m => {
        if (!m) unchecked.push('X smart-ID check skipped (smart list warming up)');
        else { const c = smart.coverage?.(); if (c && c.resolved < c.total) unchecked.push(`X smart-ID check partial: ${c.total - c.resolved} of ${c.total} smart accounts unresolved`); }
        return m;
      }, e => { unchecked.push(`X smart list: ${errText(e)}`); return undefined; })]) : Promise.resolve(undefined),
    ]);
    if (timeline) {
      const own = timeline.filter(t => t.author.toLowerCase() === h.toLowerCase() || t.author === '?');
      const ages = own.map(t => ageH(t.createdAt, now)).filter((v): v is number => v !== undefined);
      const views = own.map(t => t.views).filter((v): v is number => typeof v === 'number');
      pack.activity = { posts: own.length, lastPostAgeHours: ages.length ? Math.min(...ages) : undefined,
        avgLikes: own.length ? Math.round(own.reduce((a, t) => a + t.likes, 0) / own.length) : 0,
        avgViews: views.length ? Math.round(views.reduce((a, v) => a + v, 0) / views.length) : undefined,
        top: [...own].sort((a, b) => b.likes - a.likes).slice(0, 3).map(t => ({ text: short(t.text, 200), likes: t.likes, views: t.views, ageHours: ageH(t.createdAt, now) })) };
      if (own.length && ownSearch !== undefined && ownSearch.length === 0) pack.hiddenFromSearch = true;
    }
    if (followers) {
      if (followers.partial) unchecked.push(`X followers: ${followers.partial}`);
      pack.followers = summarizeFollowers(followers, profile.followers, now, sm);
      // Smart accounts among ALL followers (by ID), even if they are not in the profile sample
      if (ids && ids[0] && ids[1]) {
        const mine = new Set(ids[0]);
        for (const [id, handle] of ids[1]) if (mine.has(id) && !pack.followers.smart.some(s => s.handle.toLowerCase() === handle.toLowerCase()))
          pack.followers.smart.push({ handle, note: sm.get(handle.toLowerCase()) ?? '' });
      }
    }
    o.measure?.({ done: checkFollowers, why: checkFollowers ? undefined : 'code check rejects the token', accountFollowers: profile.followers,
      idsRecords: ids?.[0]?.length ?? 0, sampleRecords: followers?.length ?? 0, smartFound: pack.followers?.smart.map(s => s.handle) ?? [] });
  } else o.measure?.({ done: false, why: h ? 'no usable X profile' : 'no X handle', idsRecords: 0, sampleRecords: 0, smartFound: [] });
  return pack;
}

/** Smart list from CSV: handle,note (# is a comment). */
export function parseSmartCsv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || /^handle\s*,/i.test(t)) continue;
    const [h, ...rest] = t.split(',');
    const handle = h.trim().replace(/^@/, '');
    if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) m.set(handle.toLowerCase(), rest.join(',').trim());
  }
  return m;
}

// ---------------- The project's own X (A-08, round 2; the owner's decision 2026-11-11 08:50 UTC) ----------------
// "It must find the right handles… if smart accounts follow it, the chance that it is not an impostor is higher".
// A handle is bound to an entity (token address, collection, name) — a post about a project gets only THAT project's handle.

/** A confirmed project X: whose it is (entity key as in project cards) and how it was confirmed. */
export interface ProjectX { entity: string; name?: string; handle: string; how: string }

/**
 * X handle from any form: "@fenlampr", "https://x.com/fenlampr", "fenlampr" → fenlampr; junk → undefined.
 * A link to a tweet (x.com/someone/status/…) or a service page (/i/…, /search…) is not a project account (review #69, round 2, X3).
 */
export function normalizeHandle(s?: string): string | undefined {
  const raw = String(s ?? '').trim();
  const isUrl = /^https?:\/\//i.test(raw);
  if (isUrl && !/^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i.test(raw)) return undefined;
  const rest = raw.replace(/^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i, '').replace(/^@+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (rest.includes('/')) return undefined;
  if (isUrl && ['i', 'home', 'search', 'intent', 'share', 'hashtag', 'explore', 'messages', 'notifications'].includes(rest.toLowerCase())) return undefined;
  return /^[A-Za-z0-9_]{1,15}$/.test(rest) ? rest : undefined;
}

/** Shared hosting: the project's own site is only the full host (fenlamp.vercel.app), not "vercel.app". */
const SHARED_HOSTS = ['vercel.app', 'netlify.app', 'github.io', 'gitbook.io', 'carrd.co', 'pages.dev', 'web.app', 'firebaseapp.com', 'framer.website',
  'framer.ai', 'framer.app', 'webflow.io', 'wixsite.com', 'notion.site', 'substack.com', 'super.site', 'squarespace.com', 'blogspot.com',
  'herokuapp.com', 'replit.app', 'onrender.com', 'fly.dev', 'glitch.me'];
/**
 * Social networks and services where the "site" is a path on someone else's host (t.me/kevcoin, linktr.ee/x, discord.gg/x, x.com/x, opensea.io/…):
 * this is not the project site, and a link to them confirms nothing (review #69, round 2, Q2: t.me/kevcoin = t.me/anyone).
 */
const NOT_A_SITE = ['t.me', 'telegram.me', 'linktr.ee', 'discord.gg', 'discord.com', 'x.com', 'twitter.com', 'opensea.io', 'magiceden.io', 'medium.com',
  'mirror.xyz', 'github.com', 'youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'beacons.ai', 'bio.link', 'warpcast.com', 'reddit.com',
  'dexscreener.com', 'pump.fun', 'facebook.com', 'threads.net', 'zora.co', 'galxe.com', 'zealy.io', 'layer3.xyz', 'coingecko.com', 'coinmarketcap.com'];
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
/** Site key for comparison: the registrable domain; on shared hosting — the full host; a social network or service — '' (not a project site). */
export function siteKey(u: string): string {
  const h = hostOf(/^https?:\/\//i.test(u) ? u : `https://${u}`);
  if (!h || NOT_A_SITE.some(s => h === s || h.endsWith(`.${s}`))) return '';
  const base = h.split('.').slice(-2).join('.');
  return SHARED_HOSTS.some(s => h === s || h.endsWith(`.${s}`)) ? h : base;
}
const osSlug = (u: string) => (hostOf(u) === 'opensea.io' ? u.match(/^https?:\/\/(?:www\.)?opensea\.io\/collection\/([a-z0-9-]+)/i)?.[1]?.toLowerCase() : undefined);
/** Link to an X profile (not a /status/ tweet, not /i/…) → handle. */
export function profileLinkHandle(u: string): string | undefined {
  const m = u.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i);
  return m && !['i', 'home', 'search', 'intent', 'share', 'hashtag'].includes(m[1].toLowerCase()) ? m[1] : undefined;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * The handle resembles the name (review #69, round 2, X1): equals it, or starts with it if the name has 6+ chars and the handle is no more
 * than 4 chars longer than the name. "Hood" ≠ @hoodrich_kev, "Base" ≠ @coinbase, "Monad Punks" ≠ @monad; fenlampr ← "Fen Lamp".
 */
export function handleLike(handle: string, name: string): boolean {
  const h = squash(handle), n = squash(name);
  if (n.length < 4 || h.length < 4) return false;
  return h === n || (n.length >= 6 && h.startsWith(n) && h.length <= n.length + 4);
}

/** Official project X suffixes accepted for a handle from a Discord message (review A-handles, R2). */
// "official" removed (HQ 2026-11-18, second review): "<name>official" is a classic impostor pattern
export const DISCORD_SUFFIXES = ['app', 'hq', 'xyz', 'io', 'labs', 'nft', 'ai', 'dao', 'protocol'];
/**
 * Threshold for a handle from a Discord message (option 1; review A-handles R2: handleLike let through @quarrybets, @QuarryFi, @Quarry2024
 * for "Quarry"): the squashed handle equals the squashed name, or is the name + one suffix from DISCORD_SUFFIXES; digits and other tails — no.
 */
export function discordLike(handle: string, name: string): boolean {
  const h = squash(handle), n = squash(name);
  if (n.length < 4 || !h.startsWith(n)) return false;
  return h === n || DISCORD_SUFFIXES.includes(h.slice(n.length));
}

/**
 * What is known about the entity for matching: name, sites, OpenSea slugs, X from the OpenSea page and from the DexScreener profile.
 * address — for a token: its X is confirmed only by a back-link to this address (review #69, round 2, X2/X3).
 */
export interface XEntity { entity: string; name?: string; sites: string[]; slugs: string[]; openseaX?: string; dexX?: string; address?: string }
export interface XCheckCtx {
  x: XProvider; smart?: SmartAccounts;
  /** Website pages from the dossier: a project site linking to X is strong evidence. */ pages: { url: string; links?: string[]; text?: string }[];
  /** Profiles and X packs already fetched (do not request again). */ profiles?: XProfile[]; packs?: XPack[];
  /** OpenSea by slug — for the mutual link "profile → collection → the same X". */ opensea?: { nft(slug: string): Promise<{ name?: string; twitter?: string } | undefined> };
  errors: string[];
}
interface Judged { handle: string; strong?: string; smart: number; extra: string[]; badge: boolean; followers: number; similar: boolean; tokenNoCa?: boolean;
  /** The handle was given by the Discord message author (option 1, the owner 2026-11-18 ~12:55 UTC). */ discord?: boolean }
const errText2 = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 100);

/**
 * Where a candidate comes from: opensea — collection page (twitter_username); dex — DexScreener token profile; search — search by name;
 * discord — an @handle or x.com link in the Discord message itself (not a scanner bot); site — a link from the project website page or
 * a dossier X profile that did not come from the message.
 */
export type XCandFrom = 'opensea' | 'dex' | 'search' | 'discord' | 'site';

/** Scores one candidate for an entity. Network: profile (if not in the dossier), search for its own post with the address, follower IDs, OpenSea. */
async function judge(e: XEntity, handle: string, from: XCandFrom, c: XCheckCtx): Promise<Judged | undefined> {
  const hl = handle.toLowerCase();
  const pack = c.packs?.find(p => p.handle?.toLowerCase() === hl);
  let prof = pack?.account ?? c.profiles?.find(p => p.handle.toLowerCase() === hl && !p.error);
  let failed: string | undefined;
  if (!prof) prof = await c.x.profile(handle).catch(err => { failed = errText2(err); c.errors.push(`x candidate @${handle}: ${failed}`); return undefined; });
  // X is unavailable (request failed) and the handle is on this collection's OpenSea page: set it without a network check
  // (the owner's decision 2026-11-18 ~12:55 UTC). If the account is missing or blocked — do not set it. Does not apply to tokens.
  if (!e.address && (from === 'opensea' || normalizeHandle(e.openseaX)?.toLowerCase() === hl) && (!prof || prof.error)) {
    const why = failed ?? prof?.error ?? 'no answer';
    c.errors.push(`x for ${e.name ?? e.entity}: @${handle} taken from the OpenSea page without an X check (X profile lookup failed: ${String(why).slice(0, 80)})`);
    return { handle, smart: 0, extra: [], badge: false, followers: 0, similar: !!e.name && handleLike(handle, e.name), strong: `the OpenSea page of ${e.entity} lists @${handle} (X not checked: lookup failed)` };
  }
  if (!prof || prof.notFound || prof.error || prof.unavailable) return undefined;
  const j: Judged = { handle: prof.handle, smart: 0, extra: [], badge: !!prof.blueVerified, followers: prof.followers ?? 0, similar: !!e.name && handleLike(prof.handle, e.name) };
  // Handle from the Discord message: the account exists (profile fetched) and handle = name (+ an allowlisted suffix) — the "discord" evidence
  if (from === 'discord' && !!e.name && discordLike(prof.handle, e.name)) j.discord = true;
  // Token: anyone fills in the DexScreener profile (X and site) — a clone will list the real project's X and site, and "twitter" can be
  // a link to someone else's tweet. So a token X is confirmed only by a back-link TO THIS ADDRESS: in the X bio, in its posts or on
  // the project site (a page that has the address and a link to this X). Other evidence is not accepted for a token.
  if (e.address) {
    const a = e.address.toLowerCase();
    // Review #69, round 3, items 1–2: the token's site and "twitter" come from the DexScreener profile filled in by the deployer (a clone has its own site
    // with its own address and a link to the real X; "twitter" is a link to a caller's tweet posting the address). So the site counts
    // only if the X itself links it in the bio, and "posted this address" — only with a bio link to this address
    const bio = prof.bioUrls ?? [];
    const bioSites = bio.map(siteKey).filter(Boolean);
    // The back-link for "posted the address" is only to the address itself: the token's sites (e.sites) are filled by the clone deployer (finisher #69, round 2)
    const bioBack = bio.some(u => u.toLowerCase().includes(a));
    if (String(prof.description ?? '').toLowerCase().includes(a)) j.strong = `@${prof.handle} has ${e.address.slice(0, 8)}… in its bio`;
    else if (bioBack && (pack?.activity?.top ?? []).some(t => t.text.toLowerCase().includes(a))) j.strong = `@${prof.handle} posted ${e.address.slice(0, 8)}…`;
    else {
      const sitePage = c.pages.find(p => !!siteKey(p.url) && bioSites.includes(siteKey(p.url)) && String(p.text ?? '').toLowerCase().includes(a) && (p.links ?? []).some(l => profileLinkHandle(l)?.toLowerCase() === hl));
      if (sitePage) j.strong = `the site ${hostOf(sitePage.url)} shows ${e.address.slice(0, 8)}… and links @${prof.handle}`;
      else if (bioBack) {
        const own = await c.x.search(`from:${prof.handle} ${e.address}`).catch(err => { c.errors.push(`x own posts @${prof!.handle}: ${errText2(err)}`); return [] as XPost[]; });
        if (own.some(p => p.author.toLowerCase() === hl && p.text.toLowerCase().includes(a))) j.strong = `@${prof.handle} posted ${e.address.slice(0, 8)}…`;
      }
    }
    if (!j.strong) j.tokenNoCa = true;
    return j;
  }
  const siteKeys = e.sites.map(siteKey).filter(Boolean);
  // Strong evidence: the project itself points to this X, or the X points to the project site / collection from the dossier
  if (from === 'opensea' || normalizeHandle(e.openseaX)?.toLowerCase() === hl) j.strong = `the OpenSea page of ${e.entity} lists @${prof.handle}`;
  const sitePage = c.pages.find(p => siteKeys.includes(siteKey(p.url)) && (p.links ?? []).some(l => profileLinkHandle(l)?.toLowerCase() === hl));
  if (!j.strong && sitePage) j.strong = `the project site ${hostOf(sitePage.url)} links @${prof.handle}`;
  const bio = prof.bioUrls ?? [];
  const bioHit = bio.find(u => (!!siteKey(u) && siteKeys.includes(siteKey(u))) || (!!osSlug(u) && e.slugs.includes(osSlug(u)!)));
  if (!j.strong && bioHit) j.strong = `@${prof.handle} links ${bioHit} (the project's own site/collection)`;
  if (j.strong) return j;
  // Medium evidence: smart followers; a mutual link to a collection with the same name
  const os = bio.map(osSlug).find(sl => sl && e.name && handleLike(sl, e.name));
  if (os && c.opensea) {
    const n = await c.opensea.nft(os).catch(err => { c.errors.push(`x candidate @${prof!.handle}: OpenSea ${os}: ${errText2(err)}`); return undefined; });
    if (n && normalizeHandle(n.twitter)?.toLowerCase() === hl) j.extra.push(`links OpenSea collection ${os}, which lists it back`);
  }
  if (pack?.followers) j.smart = pack.followers.smart.length;
  else if (c.smart?.ids && c.x.followerIds && (j.similar || j.extra.length)) {
    const [ids, smartIds] = await Promise.all([
      c.x.followerIds(prof.handle, prof.followers).catch(err => { c.errors.push(`x followers @${prof!.handle}: ${errText2(err)}`); return undefined; }),
      c.smart.ids().catch(err => { c.errors.push(`x smart list: ${errText2(err)}`); return undefined; })]);
    // A refusal is not silent (review #69, round 2, S1): the list is warming up or incomplete — it shows why it was not confirmed
    if (!smartIds) c.errors.push(`x candidate @${prof.handle}: smart list not ready — smart-follower check skipped`);
    else { const cov = c.smart.coverage?.(); if (cov && cov.resolved < cov.total) c.errors.push(`x candidate @${prof.handle}: smart-follower check partial (${cov.total - cov.resolved} of ${cov.total} unresolved)`); }
    if (ids && smartIds) { const mine = new Set(ids); j.smart = [...smartIds.keys()].filter(id => mine.has(id)).length; }
  }
  return j;
}

/**
 * Threshold (Analyst, A-08, round 3):
 *  - token (address): only a back-link to this address — in the X bio, in its post, or on the site next to a link to the X;
 *  - collection / name: strong evidence — the collection's OpenSea page from the dossier points to the X, the project site (not a social network or
 *    a service) links the X, or the X links the site / collection from the dossier; otherwise a similar handle AND ≥ 2 smart followers, or
 *    1 smart follower and a mutual link with a collection of the same name;
 *  - the checkmark only orders; follower count is not compared; a tie of two without strong evidence — nobody.
 */
// Option 1 (the owner 2026-11-18 ~12:55 UTC): a handle from the Discord message itself, the account exists and resembles the name — no
// smart followers needed. Token (address) — still only a back-link to the address (tokenNoCa).
const confirmed = (j: Judged, needSimilar: boolean) => !j.tokenNoCa && (!!j.strong || !!j.discord
  || ((!needSimilar || j.similar) && (j.smart >= 2 || (j.smart >= 1 && j.extra.length > 0))));
const rank = (j: Judged) => [j.strong ? 1 : 0, j.discord ? 1 : 0, j.smart, j.extra.length, j.badge ? 1 : 0];
const cmp = (a: Judged, b: Judged) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };

/** Picks the project X among candidates: open all (up to 4), confirm by threshold, take the best. Rejected ones go to errors. */
export async function confirmProjectX(e: XEntity, cands: { handle: string; from: XCandFrom }[], c: XCheckCtx): Promise<ProjectX | undefined> {
  let uniq = cands.filter((x, i, a) => a.findIndex(y => y.handle.toLowerCase() === x.handle.toLowerCase()) === i);
  // The message has two or more "name (+ suffix)" handles for one project — we do not know which is real: tag nobody
  // from the message (review A-handles, R2); other candidates (OpenSea, site, search) — by their own thresholds
  const own = !e.address && e.name ? uniq.filter(x => x.from === 'discord' && discordLike(x.handle, e.name!)) : [];
  if (own.length > 1) {
    c.errors.push(`x for ${e.name}: Discord message names ${own.map(x => `@${x.handle}`).join(', ')} — ambiguous, none tagged from the message`);
    uniq = uniq.filter(x => x.from !== 'discord');
  }
  uniq = uniq.slice(0, 4);
  const all = await Promise.all(uniq.map(async x => ({ x, j: await judge(e, x.handle, x.from, c) })));
  const judged = all.filter((r): r is { x: typeof r.x; j: Judged } => !!r.j && confirmed(r.j, r.x.from === 'search' || r.x.from === 'site' || r.x.from === 'discord')).sort((a, b) => cmp(a.j, b.j));
  for (const r of all) if (r.j && !judged.includes(r as { x: typeof r.x; j: Judged }))
    c.errors.push(`x for ${e.name ?? e.entity}: @${r.j.handle} not confirmed (${r.j.tokenNoCa ? 'no link to this address in its bio or posts' : `smart ${r.j.smart}${r.j.similar ? '' : ', handle not like the name'}`})`);
  if (!judged.length) return undefined;
  const [top, second] = judged;
  if (second && !top.j.strong && cmp(top.j, second.j) === 0) { c.errors.push(`x for ${e.name ?? e.entity}: @${top.j.handle} and @${second.j.handle} tie — not tagging either`); return undefined; }
  const j = top.j;
  const why = j.strong ?? (j.discord ? `@${j.handle} is named in the Discord message itself, the account exists and the handle matches the name`
    : [`${j.smart} smart account(s) follow it`, ...j.extra, j.badge ? 'verified badge' : ''].filter(Boolean).join('; '));
  return { entity: e.entity, name: e.name, handle: j.handle, how: why };
}

/** Candidates by name: post authors and @mentions with a similar handle (X post search by name). */
export async function searchCandidates(name: string, x: XProvider): Promise<string[]> {
  const n = name.trim().replace(/^\$/, '');
  if (squash(n).length < 4) return [];
  const posts = await x.search(`"${n}"`, 'Top');
  const out: string[] = [];
  const push = (h: string) => { const v = normalizeHandle(h); if (v && handleLike(v, n) && !out.some(c => c.toLowerCase() === v.toLowerCase())) out.push(v); };
  for (const p of posts) { push(p.author); for (const m of p.text.matchAll(/(?<![\w@])@([A-Za-z0-9_]{4,15})\b/g)) push(m[1]); }
  return out;
}
