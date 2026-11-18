// Project handles in posts (production, night of 2026-11-17/18; the owner's decision 2026-11-18 ~12:55 UTC):
//  - "Quarry (Quarry__app) wants to open pre-IPO…" — a handle from the Discord message without "@" (not confirmed: smart followers were required);
//  - "Coilmarkers / Runelings / Partitas: …" — the collections' X accounts are confirmed via OpenSea, but there is one thought for three projects — no handles.
// Through handleMessage → real Publisher (auto), as in A-08 r3.
import { describe, it, expect } from 'vitest';
import { parseOpenSea } from '../src/analyst/opensea.js';
import { cleanNote, NAME_X_MS, type AnalysisWithThoughts } from '../src/intel/router.js';
import { confirmProjectX, discordLike, type XCheckCtx } from '../src/analyst/xresearch.js';
import type { AnalystRunner } from '../src/analyst/analyst.js';
import { handleMessage } from '../src/pipeline.js';
import { setup, xMock, msg, MINT } from './a08-helpers.js';
import { withPublisher } from './a08-publish.js';

const thoughtsOf = (r: { analysis?: unknown }) => r.analysis as AnalysisWithThoughts;
const ctx = (x: any, over: Partial<XCheckCtx> = {}): XCheckCtx => ({ x, pages: [], errors: [], ...over });
const coll = (slug: string, name: string, twitter?: string) => parseOpenSea(slug, undefined, { name, contracts: [], ...(twitter ? { twitter_username: twitter } : {}) }, {}, 0);
/** Nobody has smart followers: the candidates' followers are other IDs. */
const noSmart = (s: ReturnType<typeof setup>, x: any) => {
  x.followerIds = async () => ['99'];
  s.deps.intel!.enrich.x = x;
  s.deps.intel!.enrich.smart = { handles: new Map([['alpha_a', ''], ['alpha_b', '']]), ids: async () => new Map([['1', 'alpha_a'], ['2', 'alpha_b']]) };
};

const STREET_NOTE = 'Quarry (@Quarry__app) wants to open pre-IPO private-company shares to more people. I\'m planning to join the waitlist.';

describe('Option 1: a handle from the Discord message itself', () => {
  it('Quarry: the caller gave the handle, the account exists, looks like the name → "Quarry (@Quarry__app)" without smart followers', async () => {
    const s = setup(); const p = withPublisher(s);
    noSmart(s, xMock([], { Quarry__app: { followers: 1200 } }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Quarry' }, publicNote: STREET_NOTE, thesis: 'x' }));
    const r = await p.one({ text: 'Quarry @Quarry__app opens pre-IPO private-company shares to retail, waitlist is live' });
    expect(thoughtsOf(r).thought?.note).toBe(STREET_NOTE);
    expect(p.posted).toEqual([`${STREET_NOTE} No position.`]);
  });

  it('the handle from the message does not look like the name → not set, and no "( )" brackets with a bare name', async () => {
    const s = setup(); const p = withPublisher(s);
    noSmart(s, xMock([], { quarrytrader9: { followers: 1200 } }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Quarry' }, publicNote: 'Quarry (@quarrytrader9) wants to open pre-IPO private-company shares to more people.', thesis: 'x' }));
    const r = await p.one({ text: 'Quarry pre-IPO shares, waitlist via @quarrytrader9' });
    expect(thoughtsOf(r).thought?.note).toBe('Quarry wants to open pre-IPO private-company shares to more people.');
    expect(p.posted[0]).not.toMatch(/quarrytrader9|\(\s*\)/i);
  });

  it('the "discord" threshold (review R2): the name or the name + a whitelisted suffix; other tails and digits — no', () => {
    expect(['Quarry__app', 'QuarryHQ', 'quarry', 'quarry_xyz', 'QuarryLabs'].map(h => discordLike(h, 'Quarry'))).toEqual([true, true, true, true, true]);
    expect(['quarryofficial', 'Quarry_official'].map(h => discordLike(h, 'Quarry'))).toEqual([false, false]);
    expect(['quarrybets', 'QuarryFi', 'Quarry2024', 'quarryapp2', 'thestreet', 'st'].map(h => discordLike(h, 'Quarry'))).toEqual([false, false, false, false, false, false]);
  });

  it('two matching handles in the message for one project → tag nobody, the reason goes to the log', async () => {
    const x: any = xMock([], { Quarry__app: { followers: 1200 }, QuarryHQ: { followers: 900 } });
    const c = ctx(x);
    const r = await confirmProjectX({ entity: 'name:quarry', name: 'Quarry', sites: [], slugs: [] },
      [{ handle: 'Quarry__app', from: 'discord' }, { handle: 'QuarryHQ', from: 'discord' }], c);
    expect(r).toBeUndefined();
    expect(c.errors).toContain('x for Quarry: Discord message names @Quarry__app, @QuarryHQ — ambiguous, none tagged from the message');
    const s = setup(); const p = withPublisher(s);
    noSmart(s, x);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Quarry' }, publicNote: STREET_NOTE, thesis: 'x' }));
    await p.one({ text: 'Quarry @Quarry__app opens pre-IPO shares, also @QuarryHQ' });
    expect(p.posted[0]).toBe('Quarry wants to open pre-IPO private-company shares to more people. I\'m planning to join the waitlist. No position.');
  });

  it('the "discord" source (review R3): only the trusted caller\'s own text — not a reply, not an embed, not a chat batch, not a low score', async () => {
    const run = async (over: Record<string, unknown>, batch = false) => {
      const s = setup(batch ? { batch: 2, triage: true } : {}); const p = withPublisher(s);
      if (batch) s.setTriage(() => ({ escalate: true, focus: [1, 2], names: ['Quarry'], reason: 'x' }));
      noSmart(s, xMock([], { Quarry__app: { followers: 1200 } }));
      s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Quarry' }, publicNote: STREET_NOTE, thesis: 'x' }));
      if (batch) return (await p.batch(['Quarry pre-IPO shares look interesting', 'Quarry waitlist is live, follow @Quarry__app'])) && p.posted[0];
      await p.one(over); return p.posted[0];
    };
    const bare = 'Quarry wants to open pre-IPO private-company shares to more people. I\'m planning to join the waitlist. No position.';
    expect(await run({ text: 'Quarry opens pre-IPO shares, waitlist is live' , replyToText: 'official: @Quarry__app' })).toBe(bare);           // only in the reply
    expect(await run({ text: 'Quarry opens pre-IPO shares, waitlist is live\n---\nQuarry (@Quarry__app)\nhttps://x.com/Quarry__app' })).toBe(bare); // only in the embed
    expect(await run({ sourceServer: 'ServerB', channel: 'degen', author: 'anon', text: 'Quarry opens pre-IPO shares, waitlist @Quarry__app' })).toBe(bare); // score 5
    expect(await run({}, true)).toBe(bare);                                                                                                     // chat batch
    expect(await run({ text: 'Quarry opens pre-IPO shares, waitlist @Quarry__app' })).toBe(`${STREET_NOTE} No position.`);                        // caller, own text
  });

  it('the account from the message does not exist (notFound) → not set', async () => {
    const x: any = xMock([], { Quarry__app: { notFound: true } });
    const c = ctx(x);
    expect(await confirmProjectX({ entity: 'name:quarry', name: 'Quarry', sites: [], slugs: [] }, [{ handle: 'Quarry__app', from: 'discord' as any }], c)).toBeUndefined();
  });

  it('token: the handle from the message looks like the ticker, but there is no back-link to the CA → not set; CA in the bio → set', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'PENGU' });
    noSmart(s, xMock([], { pengu: { followers: 50_000 } }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'PENGU' }, publicNote: 'Watching $PENGU (@pengu): fresh pair, volume is picking up.', thesis: 'x' }));
    const r = await p.one({ text: `${MINT} $PENGU by @pengu` });
    expect(thoughtsOf(r).thought?.note).toBe('Watching $PENGU: fresh pair, volume is picking up.');
    expect(p.posted[0]).toBe(`Watching $PENGU: fresh pair, volume is picking up. No position.\nCA: ${MINT} (solana)`);

    const s2 = setup(); const p2 = withPublisher(s2);
    s2.marketExtra.set(MINT, { symbol: 'PENGU' });
    noSmart(s2, xMock([], { pengu: { followers: 50_000, description: `official $PENGU ${MINT}` } }));
    s2.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'PENGU' }, publicNote: 'Watching $PENGU (@pengu): fresh pair, volume is picking up.', thesis: 'x' }));
    await p2.one({ text: `${MINT} $PENGU by @pengu` });
    expect(p2.posted[0]).toBe(`Watching $PENGU (@pengu): fresh pair, volume is picking up. No position.\nCA: ${MINT} (solana)`);
  });
});

const SLUGS = ['coilmarkers-by-lumenfold', 'runelings-', 'partitas-art'];
const LINKS = SLUGS.map(s => `https://opensea.io/collection/${s}`).join(' ');
const ART_NOTE = 'Three Ethereum art mints today. I\'m watching Coilmarkers by @Lumenfold_ETH and Runelings by @quillcrafter, Partitas is the wildcard.';

describe('Several projects in one thought ("A / B / C")', () => {
  it('production: X of two collections in the dossier (OpenSea) → handles instead of names in the subject, "@" in the body is kept', async () => {
    const s = setup(); const p = withPublisher(s);
    s.nfts.set(SLUGS[0], coll(SLUGS[0], 'Coilmarkers by Lumenfold', 'Lumenfold_ETH'));
    s.nfts.set(SLUGS[1], coll(SLUGS[1], 'Runelings', 'quillcrafter'));
    s.nfts.set(SLUGS[2], coll(SLUGS[2], 'Partitas'));
    noSmart(s, xMock([], { Lumenfold_ETH: { followers: 4000 }, quillcrafter: { followers: 2500 } }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Coilmarkers / Runelings / Partitas', category: 'nft' }, publicNote: ART_NOTE, thesis: 'x' }));
    const r = await p.one({ text: `three art mints today ${LINKS}` });
    expect(s.calls[0].user).toContain('"handle":"Lumenfold_ETH"');
    expect(s.calls[0].user).toContain('"handle":"quillcrafter"');
    const want = `@Lumenfold_ETH / @quillcrafter / Partitas: ${ART_NOTE}`;
    expect(thoughtsOf(r).thought?.note).toBe(want);
    expect(p.posted).toEqual([`${want} No position.`]);
  });

  it('body without "@": the first mention of a name that did not become @ gets " (@handle)"; X — only for its own name', () => {
    const pairs = [{ name: 'Coilmarkers', handle: 'Lumenfold_ETH' }, { name: 'Runelings', handle: 'quillcrafter' }];
    expect(cleanNote('Three art mints: Runelings looks strongest, Coilmarkers is cheaper.', 'Coilmarkers / Runelings / Partitas', pairs, []))
      .toBe('@Lumenfold_ETH / @quillcrafter / Partitas: Three art mints: Runelings looks strongest, Coilmarkers is cheaper.');
    // The subject is one name from the pair: the other project's X is not attached to it, while its own name in the body gets " (@handle)"
    expect(cleanNote('Runelings looks strongest, Coilmarkers is cheaper.', 'Runelings', pairs, []))
      .toBe('Runelings (@quillcrafter) looks strongest, Coilmarkers (@Lumenfold_ETH) is cheaper.');
    expect(cleanNote('Runelings looks strongest, Coilmarkers is cheaper.', 'Runelings', [pairs[1]], []))
      .toBe('Runelings (@quillcrafter) looks strongest, Coilmarkers is cheaper.');
  });

  it('a third collection outside the dossier (the dossier takes two): the X from the OpenSea page is still in the post', async () => {
    const s = setup(); const p = withPublisher(s);
    s.nfts.set(SLUGS[0], coll(SLUGS[0], 'Coilmarkers by Lumenfold', 'Lumenfold_ETH'));
    s.nfts.set(SLUGS[1], coll(SLUGS[1], 'Runelings', 'quillcrafter'));
    s.nfts.set(SLUGS[2], coll(SLUGS[2], 'Partitas', 'partitas_art'));
    noSmart(s, xMock([], { Lumenfold_ETH: { followers: 4000 }, quillcrafter: { followers: 2500 }, partitas_art: { followers: 900 } }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Coilmarkers / Runelings / Partitas', category: 'nft' }, publicNote: 'Three Ethereum art mints today, Partitas looks the most unusual.', thesis: 'x' }));
    const r = await p.one({ text: `three art mints today ${LINKS}` });
    expect(s.calls[0].user).not.toContain('partitas_art');   // the dossier before the model has only two collections
    expect(thoughtsOf(r).thought?.note).toBe('@Lumenfold_ETH / @quillcrafter / @partitas_art: Three Ethereum art mints today, Partitas looks the most unusual.');
  });

  it('the analyst opened the collection with a tool (fetch_page OpenSea) during the analysis → its X from the OpenSea page is in the post', async () => {
    const s = setup(); const p = withPublisher(s);
    s.nfts.set('partitas-art', coll('partitas-art', 'Partitas', 'partitas_art'));
    noSmart(s, xMock([], { partitas_art: { followers: 900 } }));
    s.deps.intel!.enrich.page = async () => ({ title: 'Partitas', text: 'Partitas — generative art. '.repeat(20), links: ['https://opensea.io/collection/partitas-art'] });
    const opened: string[] = [];
    s.deps.intel!.runAnalyst = (async ({ exec }) => {
      opened.push(await exec('fetch_page', { url: 'https://opensea.io/collection/partitas-art' }));
      return { verdict: { verdict: 'watch', confidence: 0.7, project: { name: 'Partitas', category: 'nft' }, publicNote: 'Partitas mints today: generative art, the page looks careful.', thesis: 'x' },
        usage: [{ input_tokens: 1000, output_tokens: 100 }], toolCalls: ['fetch_page'] };
    }) as AnalystRunner;
    const r = await p.one({ text: 'Partitas mint today https://partitas.art' });
    expect(opened[0]).not.toMatch(/^refused/);
    expect(thoughtsOf(r).thought?.note).toBe('Partitas (@partitas_art) mints today: generative art, the page looks careful.');
  });
});

describe('OpenSea without an X response — the handle from the collection page is still set', () => {
  it('the X profile did not answer within the limit (5 s) → handle from the OpenSea page, a note in the log', async () => {
    const s = setup(); const p = withPublisher(s);
    s.nfts.set(SLUGS[0], coll(SLUGS[0], 'Coilmarkers by Lumenfold', 'Lumenfold_ETH'));
    s.nfts.set(SLUGS[1], coll(SLUGS[1], 'Runelings', 'quillcrafter'));
    s.nfts.set(SLUGS[2], coll(SLUGS[2], 'Partitas', 'partitas_art'));
    const x: any = xMock([], { Lumenfold_ETH: { followers: 4000 }, quillcrafter: { followers: 2500 } });
    const prof = x.profile;
    x.profile = async (h: string) => (h === 'partitas_art' ? new Promise(() => { /* hangs */ }) : prof(h));
    noSmart(s, x);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Coilmarkers / Runelings / Partitas', category: 'nft' }, publicNote: 'Three Ethereum art mints today, Partitas looks the most unusual.', thesis: 'x' }));
    const t0 = Date.now();
    const r = await p.one({ text: `three art mints today ${LINKS}` });
    expect(Date.now() - t0).toBeLessThan(7000);
    expect(thoughtsOf(r).thought?.note).toBe('@Lumenfold_ETH / @quillcrafter / @partitas_art: Three Ethereum art mints today, Partitas looks the most unusual.');
  }, 15_000);

  it('collections outside the dossier and the name search — in parallel: the queue waits no longer than NAME_X_MS in total (review item 5)', async () => {
    const s = setup(); const p = withPublisher(s);
    s.nfts.set(SLUGS[0], coll(SLUGS[0], 'Coilmarkers by Lumenfold', 'Lumenfold_ETH'));
    s.nfts.set(SLUGS[1], coll(SLUGS[1], 'Runelings', 'quillcrafter'));
    s.nfts.set(SLUGS[2], coll(SLUGS[2], 'Partitas', 'partitas_art'));
    const x: any = xMock([], { Lumenfold_ETH: { followers: 4000 }, quillcrafter: { followers: 2500 } });
    const prof = x.profile;
    x.profile = async (h: string) => (h === 'partitas_art' ? new Promise(() => { /* hangs → 5 s, handle from the OpenSea page */ }) : prof(h));
    x.search = async (q: string) => (q === '"Mosaic"' ? new Promise(() => { /* the "Mosaic" search hangs → NAME_X_MS */ }) : []);
    noSmart(s, x);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Coilmarkers / Runelings / Partitas / Mosaic', category: 'nft' }, publicNote: 'Four Ethereum art mints today, Mosaic is new to me.', thesis: 'x' }));
    const t0 = Date.now();
    const r = await p.one({ text: `four art mints today ${LINKS} and Mosaic` });
    expect(Date.now() - t0).toBeLessThan(NAME_X_MS + 1500);
    expect(thoughtsOf(r).thought?.note).toBe('@Lumenfold_ETH / @quillcrafter / @partitas_art / Mosaic: Four Ethereum art mints today, Mosaic is new to me.');
  }, 25_000);

  it('the X profile request fails → handle from the OpenSea page (strong, "X not checked"); no account or it is suspended → none', async () => {
    const e = { entity: 'collection:runelings-', name: 'Runelings', sites: [], slugs: ['runelings-'], openseaX: 'quillcrafter' };
    const down: any = { async profile() { throw new Error('twitterapi.io HTTP 503'); }, async search() { return []; } };
    const c = ctx(down);
    expect(await confirmProjectX(e, [{ handle: 'quillcrafter', from: 'opensea' }], c)).toMatchObject({ handle: 'quillcrafter', how: expect.stringContaining('X not checked') });
    expect(c.errors.some(x => /taken from the OpenSea page without an X check/.test(x))).toBe(true);
    expect(await confirmProjectX(e, [{ handle: 'quillcrafter', from: 'opensea' }], ctx(xMock([], { quillcrafter: { notFound: true } })))).toBeUndefined();
    expect(await confirmProjectX(e, [{ handle: 'quillcrafter', from: 'opensea' }], ctx(xMock([], { quillcrafter: { unavailable: 'suspended' } })))).toBeUndefined();
  });
});

describe('Review mutations (item 6): H9, H11, H14', () => {
  it('H9: the model\'s "@" on its own project\'s X in the body is kept (the allowed-handle set is not empty), another one is removed', () => {
    const pairs = [{ name: 'Coilmarkers', handle: 'Lumenfold_ETH' }];
    expect(cleanNote('Coilmarkers by @Lumenfold_ETH mints today, @quillcrafter is watching it.', 'Coilmarkers', pairs, []))
      .toBe('Coilmarkers by @Lumenfold_ETH mints today, quillcrafter is watching it.');
  });

  it('H11: part of a list — the token ($HOOD) does not get the X of the "Hood" collection by name; a collection in the same list gets its own X', async () => {
    const s = setup();
    s.marketExtra.set(MINT, { symbol: 'HOOD' });
    s.nfts.set('hood', coll('hood', 'Hood', 'hoodnft'));
    s.nfts.set('runelings-', coll('runelings-', 'Runelings', 'quillcrafter'));
    noSmart(s, xMock([], { hoodnft: { followers: 5000 }, quillcrafter: { followers: 2500 } }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: '$HOOD / Runelings' }, publicNote: 'Two things today: a fresh pair and an art mint.', thesis: 'x' }));
    const r = await handleMessage(msg({ text: `$HOOD ${MINT} new pair; https://opensea.io/collection/hood https://opensea.io/collection/runelings-` }), s.deps);
    expect(s.calls[0].user).toContain('"handle":"hoodnft"');
    expect(thoughtsOf(r).thought?.note).toBe('$HOOD / @quillcrafter: Two things today: a fresh pair and an art mint.');
  });

  it('H14: a token note with a handle fits the post room minus the CA line (60): the extra sentence goes', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'PENGU' });
    noSmart(s, xMock([], { penguofficial12: { followers: 50_000, description: `official $PENGU ${MINT}` } }));
    const s1 = 'Watching $PENGU: fresh pair, volume is picking up and holders keep growing.';
    const s2 = `${'Flow looks organic so far, '.repeat(4)}I wait for one more day of it.`.slice(0, 190 - s1.length - 2) + '.';
    const note = `${s1} ${s2}`;
    expect(note.length).toBe(190);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'PENGU' }, publicNote: note, thesis: 'x' }));
    const r = await p.one({ text: `${MINT} $PENGU by @penguofficial12` });
    const got = thoughtsOf(r).thought!.note;
    expect(got).toBe(s1.replace('$PENGU', '$PENGU (@penguofficial12)'));
    expect(got.length).toBeLessThanOrEqual(280 - 1 - 'No position.'.length - 60);
    expect(p.posted[0]).toBe(`${got} No position.\nCA: ${MINT} (solana)`);
  });
});

describe('Brackets with @mentions (review R4) and fallback without insertions (review item 7)', () => {
  it('only confirmed ones stay in the bracket; none — the whole bracket goes; a bracket without an @handle — as is', () => {
    expect(cleanNote('Quarry (@Quarry__app, @QuarryHQ) wants to open pre-IPO shares.', 'Quarry', 'Quarry__app', [])).toBe('Quarry (@Quarry__app) wants to open pre-IPO shares.');
    expect(cleanNote('Quarry (h/t @quarrybets) wants to open pre-IPO shares.', 'Quarry', 'Quarry__app', [])).toBe('Quarry (@Quarry__app) wants to open pre-IPO shares.');
    expect(cleanNote('Quarry (via @a_b, @c_d) wants to open pre-IPO shares.', 'Quarry', undefined, [])).toBe('Quarry wants to open pre-IPO shares.');
    expect(cleanNote('Quarry mint (2 @ 0.05 ETH, ask team@quarry.app) opens today.', 'Quarry', undefined, [])).toBe('Quarry mint (2 @ 0.05 ETH, ask team@quarry.app) opens today.');
  });
  it('insertions would have to cut a word → the note without insertions, but the model\'s confirmed "@" do not become bare names', () => {
    const one = `Coilmarkers by @Lumenfold_ETH and Runelings both mint today on Ethereum and the art in both drops is careful, slow and very different from the usual noise of the week, ${'and I keep reading the artist notes '.repeat(2)}once.`;
    expect(one.length).toBeLessThanOrEqual(260);
    const out = cleanNote(one, 'Coilmarkers', [{ name: 'Coilmarkers', handle: 'Lumenfold_ETH' }, { name: 'Runelings', handle: 'quillcrafter' }], [], { room: 260 })!;
    expect(out).toBe(one);
    expect(out).toContain('@Lumenfold_ETH');
  });
});

describe('Length: inserted handles do not cut the post and do not drop the thought', () => {
  it('a note at the 260 limit + handles → whole sentences, no "…", within the post room', () => {
    const s1 = 'Coilmarkers / Runelings / Partitas: both art drops mint today on Ethereum and the work in them is careful, slow and very different from the usual noise.';
    const s2 = 'Partitas is the wildcard of the three and I want to see who collects it first before I decide anything.';
    const note = `${s1} ${s2}`;
    expect(note.length).toBeGreaterThan(250);
    expect(note.length).toBeLessThanOrEqual(260);
    const out = cleanNote(note, 'Coilmarkers / Runelings / Partitas', [{ name: 'Coilmarkers', handle: 'Lumenfold_ETH' }, { name: 'Runelings', handle: 'quillcrafter' }], [])!;
    // The handles pushed the note past 260, but the post has room: both sentences whole
    expect(out).toBe(note.replace('Coilmarkers / Runelings', '@Lumenfold_ETH / @quillcrafter'));
    expect(out.length).toBeGreaterThan(260);
    expect(out.length).toBeLessThanOrEqual(280 - 1 - 'No position.'.length);
    // One long sentence: with handles a word would have to be cut — the note without handles, whole
    const one = `Coilmarkers and Runelings both mint today on Ethereum and the art in both drops is careful, slow and very different from the usual noise of the week, ${'and I keep reading the artist notes '.repeat(2)}twice.`;
    expect(one.length).toBeLessThanOrEqual(260);
    const out2 = cleanNote(one, 'Coilmarkers', [{ name: 'Coilmarkers', handle: 'Lumenfold_ETH' }, { name: 'Runelings', handle: 'quillcrafter' }], [], { room: 260 })!;
    expect(out2).toBe(one);
  });

  it('token: a handle within the post room does not drop the thought (190 + handle)', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'PENGU' });
    noSmart(s, xMock([], { pengu: { followers: 50_000, description: `official $PENGU ${MINT}` } }));
    const note = `Watching $PENGU: ${'volume keeps climbing hour after hour, '.repeat(4)}holders grow.`;
    expect(note.length).toBeLessThanOrEqual(190);
    expect(note.length + ' (@pengu)'.length).toBeGreaterThan(190);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'PENGU' }, publicNote: note, thesis: 'x' }));
    const r = await p.one({ text: `${MINT} $PENGU by @pengu` });
    expect(thoughtsOf(r).thought?.note).toBe(note.replace('$PENGU', '$PENGU (@pengu)'));
    expect(p.posted[0]).toBe(`${note.replace('$PENGU', '$PENGU (@pengu)')} No position.\nCA: ${MINT} (solana)`);
  });
});
