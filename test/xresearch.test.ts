import { describe, it, expect } from 'vitest';
import { twitterApiIo, pageText, type XProvider } from '../src/analyst/enrich.js';
import { xResearch, parseSmartCsv } from '../src/analyst/xresearch.js';
import { hardRejectReasons } from '../src/checks/hardcheck.js';
import { compactDossier } from '../src/analyst/analyst.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('X client: a failed lookup is not "not found" (OOLONG 2026-10-27)', () => {
  it('credits/HTTP errors throw with the reason; "user not found" is notFound', async () => {
    await expect(twitterApiIo('k', () => NOW, json(402, { message: 'Credits not enough' })).profile('oolongperp')).rejects.toThrow(/402.*Credits/);
    await expect(twitterApiIo('k', () => NOW, json(200, { status: 'error', msg: 'rate limit' })).search('x')).rejects.toThrow(/rate limit/);
    expect(await twitterApiIo('k', () => NOW, json(200, { status: 'error', msg: 'user not found' })).profile('nobody')).toEqual({ handle: 'nobody', notFound: true });
    const p = await twitterApiIo('k', () => NOW, json(200, { status: 'success', data: { userName: 'oolongperp', id: '42', followers: 5100, createdAt: '2026-09-27T00:00:00Z',
      profile_bio: { entities: { url: { urls: [{ expanded_url: 'https://oolong.trade' }] } } } } })).profile('oolongperp');
    expect(p).toMatchObject({ handle: 'oolongperp', id: '42', followers: 5100, ageDays: 30, bioUrls: ['https://oolong.trade'] });
  });
});

describe('X research pack: who talks, smart and notable followers, bots', () => {
  const post = (author: string, followers: number, likes: number, hoursAgo = 2, text = 'oolong perps live') => ({ text, createdAt: new Date(NOW - hoursAgo * 3600_000).toISOString(), likes, retweets: 0, views: likes * 50, author, authorFollowers: followers });
  const x: XProvider = {
    async profile(h) { return { handle: h, id: '42', followers: 900, ageDays: 30 }; },
    async search(q) {
      if (q === 'from:oolongperp') return [];
      if (q.startsWith('$OOLONG')) return [post('cobie', 900_000, 400), post('anon1', 30, 1), post('anon1', 30, 2), post('oolongperp', 900, 50)];
      if (q.startsWith('@oolongperp')) return [post('kol_x', 25_000, 80), post('anon2', 10, 0)];
      return [];
    },
    async timeline() { return [post('oolongperp', 900, 120, 1, 'v2 is live'), post('oolongperp', 900, 30, 20)]; },
    async followers() { return [
      { handle: 'HsakaTrades', followers: 600_000, statuses: 9000 }, { handle: 'fund_y', followers: 40_000, statuses: 100, description: 'we invest' },
      { handle: 'b1', followers: 0, statuses: 0, createdAt: new Date(NOW - 5 * 86400_000).toISOString() }, { handle: 'b2', followers: 2, statuses: 1 }] },
  };
  it('counts distinct authors without the project itself, marks smart, finds notable followers and empty accounts', async () => {
    const smart = { handles: parseSmartCsv('handle,note\ncobie,trader\n@HsakaTrades,trader\nbad handle!,x') };
    const pack = await xResearch({ handle: 'oolongperp', ticker: 'OOLONG' }, x, NOW, smart);
    const top = pack.talk.find(t => t.query.startsWith('$OOLONG (Top)'))!;
    expect(top.posts).toBe(3);
    expect(top.uniqueAuthors).toBe(2);
    expect(top.notableAuthors).toEqual([{ handle: 'cobie', followers: 900_000, smart: 'trader' }]);
    expect(pack.talk.find(t => t.query.startsWith('@oolongperp'))!.notableAuthors[0]).toMatchObject({ handle: 'kol_x' });
    expect(pack.activity).toMatchObject({ posts: 2, lastPostAgeHours: 1, avgLikes: 75 });
    expect(pack.hiddenFromSearch).toBe(true);
    expect(pack.followers).toMatchObject({ sampled: 4, emptyPct: 50, newPct: 25, smart: [{ handle: 'HsakaTrades', note: 'trader' }] });
    expect(pack.followers!.notable.map(n => n.handle)).toEqual(['HsakaTrades', 'fund_y']);
    expect(pack.unchecked).toEqual([]);
  });
  it('a failing provider is recorded as unchecked, not as an empty project', async () => {
    const bad: XProvider = { async profile() { throw new Error('twitterapi.io HTTP 402: Credits not enough'); }, async search() { throw new Error('twitterapi.io HTTP 402'); } };
    const pack = await xResearch({ handle: 'oolongperp', ticker: 'OOLONG' }, bad, NOW, { handles: new Map() });
    expect(pack.account).toMatchObject({ handle: 'oolongperp', error: expect.stringMatching(/402/) });
    expect(pack.unchecked.join(' ')).toMatch(/profile @oolongperp.*402/);
    expect(pack.talk).toEqual([]);
  });
});

describe('website: JS apps, meta and links', () => {
  it('reads title, description, useful links and marks a JS app', async () => {
    const html = `<html><head><title>Oolong — perps</title><meta name="description" content="Trade perps on Robinhood Chain"></head>
      <body><div id="root"></div><script src="/app.js"></script><a href="https://docs.oolong.trade/intro">Docs</a><a href="https://x.com/oolongperp">X</a><a href="https://example.com/x">x</a></body></html>`;
    const f = (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const p = await pageText('https://oolong.trade', f);
    expect(p).toMatchObject({ title: 'Oolong — perps', description: 'Trade perps on Robinhood Chain', jsApp: true, links: ['https://docs.oolong.trade/intro', 'https://x.com/oolongperp'] });
  });
});

describe('hard checks (no model) — facts only, no "old and −90%" rule', () => {
  it('honeypot, authority and blocked sells → avoid; tiny liquidity → ignore only for low trust and pairs older than 1 h', () => {
    expect(hardRejectReasons({ address: 'a', honeypot: { isHoneypot: true, reason: 'transfer fails' } }, { strictLiquidity: false })?.verdict).toBe('avoid');
    expect(hardRejectReasons({ address: 'a', rug: { risk: 'high', freezeOrMintAuthority: true, reasons: [] } }, { strictLiquidity: false })?.verdict).toBe('avoid');
    expect(hardRejectReasons({ address: 'a', market: { chain: 'base', priceUsd: 1, buys24h: 40, sells24h: 0 } }, { strictLiquidity: false })?.reasons[0]).toMatch(/0 sells/);
    const thin = { address: 'a', market: { chain: 'robinhood' as const, priceUsd: 1, liquidityUsd: 1200, pairAgeMinutes: 90, buys24h: 10, sells24h: 5 } };
    expect(hardRejectReasons(thin, { strictLiquidity: true })?.verdict).toBe('ignore');
    expect(hardRejectReasons(thin, { strictLiquidity: false })).toBeUndefined();
    expect(hardRejectReasons({ ...thin, market: { ...thin.market, pairAgeMinutes: 20 } }, { strictLiquidity: true })).toBeUndefined();
    // an old pair down 95%, but with normal liquidity — to the model (comebacks happen)
    expect(hardRejectReasons({ address: 'a', market: { chain: 'solana', priceUsd: 0.001, liquidityUsd: 40_000, pairAgeMinutes: 60 * 24 * 90, buys24h: 300, sells24h: 280 } }, { strictLiquidity: true })).toBeUndefined();
  });
  it('the model gets a compact dossier: no empty fields, failures listed as unchecked', () => {
    const c = compactDossier({ tokens: [{ address: 'a', chain: 'solana', market: { chain: 'solana', priceUsd: 0.000123456789, fdvUsd: undefined } as any }], domains: [], x: [], xSearch: [], pages: [], nft: [], errors: ['x research: HTTP 402'] }) as any;
    expect(c).toEqual({ tokens: [{ address: 'a', chain: 'solana', market: { chain: 'solana', priceUsd: 0.0001235 } }], unchecked: ['x research: HTTP 402'] });
  });
});
