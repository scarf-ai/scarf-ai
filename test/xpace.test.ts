// A-06: twitterapi.io on the free tier — 1 request per 5 s (journal 2026-10-29: in 17 of 19 analyses with X some checks were 429).
// Virtual time: sleep moves the clock, there are no real pauses.
import { describe, it, expect } from 'vitest';
import { twitterApiIo, cachedX, buildDossier, type XProvider } from '../src/analyst/enrich.js';
import { xResearch } from '../src/analyst/xresearch.js';

function rig(respond: (url: URL, n: number) => Response) {
  let t = 1_000_000;
  const now = () => t;
  // First let already allowed requests go, then move the clock (like a real setTimeout)
  const sleep = async (ms: number) => { await new Promise(r => setImmediate(r)); t += ms; };
  const calls: { at: number; path: string; q: string }[] = [];
  const fetchImpl = (async (u: URL) => { calls.push({ at: t, path: u.pathname, q: u.searchParams.get('userName') ?? u.searchParams.get('query') ?? '' }); return respond(u, calls.length); }) as unknown as typeof fetch;
  return { now, sleep, calls, fetchImpl, advance: (ms: number) => { t += ms; } };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const profileBody = (h: string) => ({ status: 'success', data: { userName: h, id: `id_${h}`, followers: 10 } });
const tooMany = (retryAfter?: string) => new Response(JSON.stringify({ msg: 'For free-tier users, the QPS limit is one request every 5 seconds.' }),
  { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

describe('twitterapi.io pacing (A-06, free tier: 1 request per 5 s)', () => {
  it('parallel requests go out one by one, ≥ 5.2 s apart, instead of 4 at once', async () => {
    const r = rig((u) => ok(profileBody(u.searchParams.get('userName')!)));
    const x = twitterApiIo('k', r.now, r.fetchImpl, { sleep: r.sleep });
    const out = await Promise.all(['a', 'b', 'c', 'd'].map(h => x.profile(h)));
    expect(out.map(p => p?.handle)).toEqual(['a', 'b', 'c', 'd']);
    const gaps = r.calls.slice(1).map((c, i) => c.at - r.calls[i].at);
    expect(gaps.every(g => g >= 5_200)).toBe(true);
  });

  it('429 → waits Retry-After before the retry, which then succeeds', async () => {
    const r = rig((u, n) => (n === 1 ? tooMany('7') : ok(profileBody('a'))));
    const x = twitterApiIo('k', r.now, r.fetchImpl, { sleep: r.sleep });
    expect((await x.profile('a'))?.handle).toBe('a');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].at - r.calls[0].at).toBeGreaterThanOrEqual(7_000);
  });

  it('three 429 in a row → the error keeps the reason (not "not found")', async () => {
    const r = rig(() => tooMany());
    const x = twitterApiIo('k', r.now, r.fetchImpl, { sleep: r.sleep });
    await expect(x.profile('a')).rejects.toThrow(/429.*free-tier/);
    expect(r.calls).toHaveLength(3);
  });

  it('a request that would wait longer than maxWaitMs fails at once as "not checked", without a call', async () => {
    const r = rig(() => ok({ tweets: [] }));
    const x = twitterApiIo('k', r.now, r.fetchImpl, { sleep: r.sleep, minIntervalMs: 5_000, maxWaitMs: 12_000 });
    const res = await Promise.allSettled([1, 2, 3, 4].map(i => x.search(`q${i}`)));
    expect(res.map(s => s.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
    expect(String((res[3] as PromiseRejectedResult).reason)).toMatch(/not checked — request queue 15 s > 12 s \(free tier: 1 request per 5 s\)/);
    expect(r.calls).toHaveLength(3);
  });

  it('background (smart-list ids) yields to analyses: bg already queued while the pacer sleeps, fg arriving later goes first', async () => {
    // HQ repro (acceptance #57): three background requests are queued, an analysis comes later — and goes second, not fourth
    const r = rig((u) => ok(profileBody(u.searchParams.get('userName')!)));
    const x = twitterApiIo('k', r.now, r.fetchImpl, { sleep: r.sleep });
    const bg = [x.ids!(['b1']), x.ids!(['b2']), x.ids!(['b3'])];
    await Promise.resolve(); await Promise.resolve();
    const fg = x.profile('FG');
    await Promise.all([...bg, fg]);
    expect(r.calls.map(c => c.q)).toEqual(['b1', 'FG', 'b2', 'b3']);
  });

  it('followers: a refusal on page 2+ keeps page 1 and says what was not checked', async () => {
    const r = rig((u) => (u.searchParams.get('cursor') ? tooMany() : ok({ followers: [{ userName: 'f1', followers_count: 5 }], has_next_page: true, next_cursor: 'c2' })));
    const x = twitterApiIo('k', r.now, r.fetchImpl, { sleep: r.sleep });
    const fs = await x.followers!('proj', 3);
    expect(fs.map(f => f.handle)).toEqual(['f1']);
    expect(fs.partial).toMatch(/pages 2\+ not checked: .*429/);
    await expect(twitterApiIo('k', r.now, (async () => tooMany()) as unknown as typeof fetch, { sleep: r.sleep }).followers!('proj', 3)).rejects.toThrow(/429/);
  });
});

describe('X answer cache (A-06): one account is not fetched again in every analysis', () => {
  const counting = () => {
    const n = { profile: 0, search: 0 }; let failNext = false;
    const x: XProvider = {
      async profile(h) { n.profile++; if (failNext) { failNext = false; throw new Error('twitterapi.io HTTP 429'); } return { handle: h, followers: 5 }; },
      async search() { n.search++; return []; },
    };
    return { x, n, fail: () => { failNext = true; } };
  };
  it('profile cached 6 h, search 10 min; errors are not cached; in-flight requests share one call', async () => {
    let t = 0; const now = () => t;
    const { x, n, fail } = counting();
    const c = cachedX(x, now);
    expect(cachedX(x, now)).toBe(c);
    await Promise.all([c.profile('Proj'), c.profile('proj')]);
    expect(n.profile).toBe(1);
    t += 5 * 3600_000; await c.profile('proj'); expect(n.profile).toBe(1);
    t += 2 * 3600_000; await c.profile('proj'); expect(n.profile).toBe(2);
    fail(); await expect(c.profile('other')).rejects.toThrow(/429/);
    await c.profile('other'); expect(n.profile).toBe(4);
    await c.search('$ABC', 'Top'); await c.search('$ABC', 'Top'); await c.search('$ABC', 'Latest');
    expect(n.search).toBe(2);
    t += 11 * 60_000; await c.search('$ABC', 'Top'); expect(n.search).toBe(3);
  });
  it('"not found" and partial follower samples live 10 min, not 6 h (fresh or renamed accounts)', async () => {
    let t = 0; let n = 0; let f = 0;
    const part = Object.assign([{ handle: 'f1' }], { partial: 'pages 2+ not checked' });
    const c = cachedX({ async profile(h) { n++; return { handle: h, notFound: true }; }, async search() { return []; },
      async followers() { f++; return part; } }, () => t);
    await c.profile('fresh'); await c.followers!('p', 3);
    t += 9 * 60_000; await c.profile('fresh'); await c.followers!('p', 3); expect([n, f]).toEqual([1, 1]);
    t += 2 * 60_000; await c.profile('fresh'); await c.followers!('p', 3); expect([n, f]).toEqual([2, 2]);
  });
});

describe('scanner bots are not researched as projects (journal 2026-10-29: @RickBurpBot looked up in 10 analyses)', () => {
  it('the message signs @RickBurpBot and @rick → X research goes to the token’s own X; no lookups of the bots', async () => {
    const profiles: string[] = [], searches: string[] = [];
    const MINT = 'GxMZtiSynthDabcdefghijkmnopqrstuvwxyz1sVpump';
    const dos = await buildDossier({ tokens: [MINT], domains: [], xHandles: ['RickBurpBot', 'rick'], urls: [], tickers: ['TOFU'] }, {
      market: { async market() { return { chain: 'solana', priceUsd: 0.001, twitter: 'tofu_sol' } as any; }, async rug() { return { risk: 'low', freezeOrMintAuthority: false, reasons: [] } as any; } },
      x: { async profile(h) { profiles.push(h); return { handle: h, followers: 1000 }; }, async search(q) { searches.push(q); return []; } },
      now: () => Date.parse('2026-10-29T19:08:00Z'),
    });
    expect(profiles).toEqual(['tofu_sol']);
    expect(searches.some(q => /rick/i.test(q))).toBe(false);
    expect(dos.xResearch?.[0].handle).toBe('tofu_sol');
  });
});

describe('every failed X lookup lands in unchecked (acceptance #57: the < 5 % metric must not be understated)', () => {
  it('own-posts search, follower ids and partial followers are reported, not swallowed', async () => {
    const x: XProvider = {
      async profile(h) { return { handle: h, id: '1', followers: 5000 }; },
      async search(q) { if (q.startsWith('from:')) throw new Error('twitterapi.io: not checked — request queue 95 s > 90 s'); return []; },
      async timeline() { return []; },
      async followers() { return Object.assign([{ handle: 'f1', followers: 3 }], { partial: 'pages 2+ not checked: twitterapi.io HTTP 429' }); },
      async followerIds() { throw new Error('twitterapi.io HTTP 429'); },
    };
    const pack = await xResearch({ handle: 'proj' }, x, Date.parse('2026-11-09T08:00:00Z'), { handles: new Map(), ids: async () => new Map() });
    expect(pack.unchecked.join(' | ')).toMatch(/from:proj .*request queue/);
    expect(pack.unchecked.join(' | ')).toMatch(/follower ids .*429/);
    expect(pack.unchecked.join(' | ')).toMatch(/X followers: pages 2\+ not checked/);
  });
});


describe('cold smart list never blocks an analysis (acceptance #57, round 2)', () => {
  it('ids() answers at once with undefined while the list resolves in the background; xResearch marks the skip; later the IDs are there', async () => {
    const { Store } = await import('../src/store/db.js');
    const { smartAccounts } = await import('../src/analyst/smart.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const csv = join(mkdtempSync(join(tmpdir(), 'smart-')), 'smart-accounts.csv');
    writeFileSync(csv, Array.from({ length: 56 }, (_, i) => `smart${i},x`).join('\n'));
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const x: XProvider = {
      async profile(h) { return { handle: h, id: '42', followers: 1000, ageDays: 300 }; },
      async search() { return []; }, async timeline() { return []; }, async followers() { return []; },
      async followerIds() { return ['1', '2']; },
      async ids(hs) { await gate; return new Map(hs.map(h => [String(Number(h.slice(5)) + 1), h] as [string, string])); },   // smartN → id N+1
    };
    const logs: string[] = [];
    const smart = smartAccounts(csv, x, new Store(':memory:'), () => 0, s => logs.push(s));
    const pack = await xResearch({ handle: 'proj', ticker: 'PRJ' }, x, 0, smart);       // does not wait for the warm-up
    expect(pack.unchecked).toContain('X smart-ID check skipped (smart list warming up)');
    release(); await smart.whenWarm!();
    expect((await smart.ids!())?.size).toBe(56);
    const pack2 = await xResearch({ handle: 'proj2', ticker: 'PRJ' }, x, 0, smart);
    expect(pack2.followers?.smart.map(s => s.handle)).toEqual(['smart0', 'smart1']);
    expect(logs).toEqual([]);
  });
  it('a failed lookup is logged, not swallowed', async () => {
    const { Store } = await import('../src/store/db.js');
    const { smartAccounts } = await import('../src/analyst/smart.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const csv = join(mkdtempSync(join(tmpdir(), 'smart-')), 'smart-accounts.csv');
    writeFileSync(csv, 'smart0,x\n');
    const logs: string[] = [];
    const smart = smartAccounts(csv, { async profile(h) { return { handle: h }; }, async search() { return []; }, async ids(): Promise<never> { throw new Error('twitterapi.io HTTP 402: credits'); } }, new Store(':memory:'), () => 0, s => logs.push(s));
    expect(await smart.ids!()).toBeUndefined();
    await smart.whenWarm!();
    expect(logs).toEqual(['smart accounts: ID lookup failed: twitterapi.io HTTP 402: credits']);
  });
});

describe('unlink the old scanner-bot mega-card (#57 side effect)', () => {
  it('dry run lists, --apply removes the keys of projects glued by x:rickburpbot / x:rick; other projects untouched', async () => {
    const { Store } = await import('../src/store/db.js');
    const { unlinkBotKeys } = await import('../src/intel/unlinkBotKeys.js');
    const store = new Store(':memory:');
    const mega = store.createProject('mega', '2026-11-01T00:00:00Z'); store.linkKeys(mega, ['x:rickburpbot', 'sol:AAA', 'sol:BBB', 'evm:0xccc']);
    const other = store.createProject('kelp', '2026-11-01T00:00:00Z'); store.linkKeys(other, ['domain:kelpdao.xyz']);
    expect(unlinkBotKeys(store, false)).toEqual({ projects: [{ id: mega, keys: 4, sample: expect.arrayContaining(['sol:AAA']) }], removed: 0 });
    expect(store.projectKeys(mega)).toHaveLength(4);
    expect(unlinkBotKeys(store, true).removed).toBe(4);
    expect(store.projectKeys(mega)).toEqual([]);
    expect(store.projectKeys(other)).toEqual(['domain:kelpdao.xyz']);
  });
});

// Acceptance #57, round 3 (HQ reproductions): an empty or incomplete smart-ID map is not passed off as "checked"; 429 retries
// fit within the analysis wait limit.
describe('smart-ID check is never silently «done» on a failed warm-up; 429 retries stay within the wait limit (acceptance #57, round 3)', () => {
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const rig2 = (respond: (u: URL) => Response) => {
    let t = 1_000_000; const now = () => t;
    const sleep = async (ms: number) => { await new Promise(r => setImmediate(r)); t += ms; };
    return { now, sleep, fetchImpl: (async (u: URL) => respond(u)) as unknown as typeof fetch, advance: (ms: number) => { t += ms; } };
  };
  const csvOf = async (names: string[]) => {
    const { mkdtempSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    const p = join(mkdtempSync(join(tmpdir(), 'smart-')), 'smart-accounts.csv'); writeFileSync(p, names.map(n => `${n},note`).join('\n')); return p;
  };
  it('A: X down for the smart names during warm-up (HTTP 402) → the next analysis says the check was not done; the log says why (not «typo»)', async () => {
    const { smartAccounts } = await import('../src/analyst/smart.js'); const { Store } = await import('../src/store/db.js');
    let smartDown = true;
    const r = rig2((u) => {
      const p = u.pathname; const h = u.searchParams.get('userName') ?? '';
      if (p.endsWith('/user/info')) {
        if (h.startsWith('smart') && smartDown) return new Response(JSON.stringify({ msg: 'Credits is not enough' }), { status: 402 });
        return ok({ status: 'success', data: { userName: h, id: 'id_' + h, followers: 3000 } });
      }
      if (p.endsWith('/followers_ids')) return ok({ ids: ['id_smart0', 'id_smart1'] });
      if (p.endsWith('/followers')) return ok({ followers: [{ userName: 'nobody', followers_count: 3 }] });
      return ok({ tweets: [] });
    });
    const x = twitterApiIo('k', r.now, r.fetchImpl, { sleep: r.sleep });
    const logs: string[] = [];
    const smart = smartAccounts(await csvOf(['smart0', 'smart1', 'smart2']), x, new Store(':memory:'), r.now, s => logs.push(s));
    expect((await xResearch({ handle: 'proj' }, x, r.now(), smart)).unchecked.join('|')).toMatch(/warming up/);
    await smart.whenWarm!();
    expect(await smart.ids!()).toBeUndefined();                                   // an empty map — not "checked"
    expect(logs).toEqual(['smart accounts: X lookup failed for 3 of 3 (twitterapi.io HTTP 402: Credits is not enough) — retry in 30 min']);
    r.advance(60 * 60_000); smartDown = false;
    const p2 = await xResearch({ handle: 'proj2' }, x, r.now(), smart);
    expect(p2.followers!.smart.length > 0 || /smart/i.test(p2.unchecked.join('|'))).toBe(true);
    await smart.whenWarm!();                                                       // after 30 min the failure is re-requested
    const p3 = await xResearch({ handle: 'proj3' }, x, r.now(), smart);
    expect(p3.followers!.smart.map(s => s.handle)).toEqual(['smart0', 'smart1']);
  });
  it('B: half of the names fail (429 ×3) → the analysis is told the smart check was partial', async () => {
    const { smartAccounts } = await import('../src/analyst/smart.js'); const { Store } = await import('../src/store/db.js');
    const r = rig2((u) => {
      const p = u.pathname; const h = u.searchParams.get('userName') ?? '';
      if (p.endsWith('/user/info')) {
        if (/^smart[0-4]$/.test(h)) return new Response(JSON.stringify({ msg: 'For free-tier users, the QPS limit is one request every 5 seconds.' }), { status: 429 });
        return ok({ status: 'success', data: { userName: h, id: 'id_' + h, followers: 3000 } });
      }
      if (p.endsWith('/followers_ids')) return ok({ ids: ['id_smart0', 'id_smart3'] });
      if (p.endsWith('/followers')) return ok({ followers: [{ userName: 'nobody', followers_count: 3 }] });
      return ok({ tweets: [] });
    });
    const x = twitterApiIo('k', r.now, r.fetchImpl, { sleep: r.sleep });
    const smart = smartAccounts(await csvOf(Array.from({ length: 10 }, (_, i) => 'smart' + i)), x, new Store(':memory:'), r.now);
    await smart.ids!(); await smart.whenWarm!();
    const p2 = await xResearch({ handle: 'proj2' }, x, r.now(), smart);
    expect(p2.unchecked).toContain('X smart-ID check partial: 5 of 10 smart accounts unresolved');
  });
  for (const ra of [undefined, '60'] as const) {
    it(`all requests answer 429 (Retry-After: ${ra ?? 'none'}) → one xResearch ends within 90 s`, async () => {
      let t = 1_000_000; const now = () => t;
      const sleep = async (ms: number) => { await new Promise(r => setImmediate(r)); t += ms; };
      const fetchImpl = (async () => new Response(JSON.stringify({ msg: 'For free-tier users, the QPS limit is one request every 5 seconds.' }),
        { status: 429, headers: ra ? { 'retry-after': ra } : {} })) as unknown as typeof fetch;
      const x = twitterApiIo('k', now, fetchImpl, { sleep });
      const t0 = now();
      const pack = await xResearch({ handle: 'proj', ticker: 'PRJ', address: 'GxMZtiSynthDabcdefghijkmnopqrstuvwxyz1sVpump' }, x, t0, { handles: new Map() });
      expect((now() - t0) / 1000).toBeLessThanOrEqual(90);
      expect(pack.unchecked.length).toBeGreaterThan(0);
    });
  }
});

describe('429 fuse lifts after the wait X asked for (acceptance #57, round 3)', () => {
  it('Retry-After 60 → analysis requests fail fast for 60 s; after that a probe goes and a success clears the fuse', async () => {
    let t = 1_000_000; const now = () => t; let n = 0; let limited = true;
    const sleep = async (ms: number) => { await new Promise(r => setImmediate(r)); t += ms; };
    const fetchImpl = (async (u: URL) => { n++; return limited ? new Response('{}', { status: 429, headers: { 'retry-after': '60' } }) : new Response(JSON.stringify({ status: 'success', data: { userName: u.searchParams.get('userName'), id: '1' } }), { status: 200 }); }) as unknown as typeof fetch;
    const x = twitterApiIo('k', now, fetchImpl, { sleep });
    await expect(x.profile('a')).rejects.toThrow(/not checked — X is rate-limiting/);
    await expect(x.profile('b')).rejects.toThrow(/next try in 60 s/);
    expect(n).toBe(1);                                                             // the second request did not even go to X
    t += 61_000; limited = false;
    expect((await x.profile('c'))?.handle).toBe('c');
    expect((await x.profile('d'))?.handle).toBe('d');
  });
});

// Acceptance #57, round 2, nice-to-have 3: the warm-up is saved in portions — a restart in the middle of the warm-up does not lose what was resolved.
describe('smart list warm-up survives a restart (acceptance #57, desirable 3)', () => {
  it('a restart after 2 of 3 chunks keeps 20 IDs; only the rest is asked again, in 30 min', async () => {
    const { Store } = await import('../src/store/db.js');
    const { smartAccounts } = await import('../src/analyst/smart.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const csv = join(mkdtempSync(join(tmpdir(), 'smart-')), 'smart-accounts.csv');
    writeFileSync(csv, Array.from({ length: 25 }, (_, i) => `smart${i},x`).join('\n'));
    const store = new Store(':memory:');
    let t = 0; let calls = 0; const asked: string[][] = [];
    const hang = new Promise<never>(() => { /* the process "crashed" on the third portion */ });
    const base = { async profile(h: string) { return { handle: h }; }, async search() { return []; }, async timeline() { return []; }, async followers() { return []; } };
    const x1: XProvider = { ...base, async ids(hs) { asked.push(hs); if (++calls === 3) await hang; return new Map(hs.map(h => ['id_' + h, h] as [string, string])); } };
    const s1 = smartAccounts(csv, x1, store, () => t);
    expect(await s1.ids!()).toBeUndefined();
    for (let i = 0; i < 5 && calls < 3; i++) await new Promise(r => setImmediate(r));
    expect(calls).toBe(3);
    // "Restart": a new instance on the same journal
    const asked2: string[][] = [];
    const x2: XProvider = { ...base, async ids(hs) { asked2.push(hs); return new Map(hs.map(h => ['id_' + h, h] as [string, string])); } };
    const s2 = smartAccounts(csv, x2, store, () => t);
    expect((await s2.ids!())?.size).toBe(20);
    expect(s2.coverage!()).toEqual({ resolved: 20, total: 25 });
    expect(asked2).toEqual([]);                                     // does not re-request right away
    t += 30 * 60_000;
    await s2.ids!(); await s2.whenWarm!();
    expect(asked2).toEqual([asked[2]]);                             // only the third portion (names go in alphabetical order)
    expect(asked2[0]).toHaveLength(5);
    expect((await s2.ids!())?.size).toBe(25);
  });
});
