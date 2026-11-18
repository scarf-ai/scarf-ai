// A-08 (the owner 2026-11-10 13:59 UTC): every watch/act analysis yields a thought on X. Acceptance round 2 (PR #69): every round 1 review item
// — an ordinary test with the correct expectation (the reviewer reproductions on this code are red).
// The owner's decision 2026-11-11 08:50 UTC: "find the right handles… smart accounts follow them — the chance it is not an impostor is higher".
import { describe, it, expect } from 'vitest';
import { handleMessage } from '../src/pipeline.js';
import { parseOpenSea } from '../src/analyst/opensea.js';
import { withHandle, cleanNote, type AnalysisWithThoughts } from '../src/intel/router.js';
import { confirmProjectX, searchCandidates, handleLike, siteKey, normalizeHandle, type XCheckCtx } from '../src/analyst/xresearch.js';
import type { AnalystRunner } from '../src/analyst/analyst.js';
import { setReviewSink } from '../src/review/log.js';
import { setup, msg, xMock, MINT } from './a08-helpers.js';
import { parseDexScreener } from '../src/checks/token.js';
import { withPublisher } from './a08-publish.js';

type S = ReturnType<typeof setup>;
const batch = async (s: S, texts: string[]) => {
  let r: Awaited<ReturnType<typeof handleMessage>> | undefined;
  for (const [i, text] of texts.entries()) r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: `user${i}`, text }), s.deps);
  return r!.analysis as AnalysisWithThoughts;
};
const triaged = (names?: string[]) => { const s = setup({ batch: 2, triage: true }); s.setTriage(() => ({ escalate: true, focus: [1, 2], names, reason: 'x' })); return s; };
/** A smart list: two accounts (IDs 1 and 2); the test sets the candidates' followers. */
const withSmart = (s: S, x: any, followers: Record<string, string[]>) => {
  x.followerIds = async (h: string) => followers[h] ?? ['99'];
  s.deps.intel!.enrich.x = x;
  s.deps.intel!.enrich.smart = { handles: new Map([['alpha_a', 'trader'], ['alpha_b', 'collector']]), ids: async () => new Map([['1', 'alpha_a'], ['2', 'alpha_b']]) };
};
const ctx = (x: any, over: Partial<XCheckCtx> = {}): XCheckCtx => ({ x, pages: [], errors: [], smart: { handles: new Map(), ids: async () => new Map([['1', 'a'], ['2', 'b']]) }, ...over });

describe('A-08 round 2: the thought exists for every watch/act (core of the card)', () => {
  it('chat batch, no verdict.projects → thought for the main project; Fen Lamp → @fenlampr (two smart followers)', async () => {
    const s = triaged(['Fen Lamp']);
    const x: any = xMock([{ author: 'fenlampr', text: 'Fen Lamp holders update' }, { author: 'fenlampfan' }], { fenlampr: { followers: 2100, bioUrls: ['https://opensea.io/collection/fenlamp'] }, fenlampfan: { followers: 10 } });
    withSmart(s, x, { fenlampr: ['1', '2', '50'] });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Watching Fen Lamp: holders grow, the floor is thin.', thesis: 'x' }));
    const a = await batch(s, ['Fen Lamp looks good', 'fen lamp floor up']);
    // Round 3: the name search — after the model and the actions; it does not get into the model request, the code inserts the handle
    expect(s.calls[0].user).not.toContain('"projectX"');
    expect(a.thought).toMatchObject({ subject: 'Fen Lamp', verdict: 'watch', confidence: 0.5, note: 'Watching Fen Lamp (@fenlampr): holders grow, the floor is thin.' });
  });
});

describe('A-08 round 2 — blocker 1: the @handle belongs to the project of the thought', () => {
  it('H1 another token\'s confirmed X stays with that token (entity-bound), the main project is not tagged with it', async () => {
    const s = triaged(['Fen Lamp']);
    s.marketExtra.set(MINT, { twitter: 'bobotoken', websites: ['https://bobo.fun'] });
    // Round 3: the token X is confirmed only by a back-link to its address (here — the address in the X bio)
    s.deps.intel!.enrich.x = xMock([], { bobotoken: { followers: 500, bioUrls: ['https://bobo.fun'], description: `bobo on solana. CA: ${MINT}` } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Watching Fen Lamp: holders grow, floor is thin.', thesis: 'x' }));
    const a = await batch(s, [`someone aped ${MINT} lol`, 'Fen Lamp floor is moving']);
    expect(s.calls[0].user).toContain(`"projectX":[{"entity":"sol:${MINT}","handle":"bobotoken","how":"@bobotoken has ${MINT.slice(0, 8)}… in its bio"`);
    expect(a.thought?.note).toBe('Watching Fen Lamp: holders grow, floor is thin.');
  });
  it('H2 X found for the first triage name is not glued to a different main project', async () => {
    const s = triaged(['Fen Lamp', 'Kelp']);
    const x: any = xMock([{ author: 'fenlampr' }], { fenlampr: { bioUrls: ['https://opensea.io/collection/fenlamp'] } });
    withSmart(s, x, { fenlampr: ['1', '2'] });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Kelp', category: 'defi' }, publicNote: 'Kelp season two is on my list.', thesis: 'x' }));
    const a = await batch(s, ['Fen Lamp floor up', 'Kelp season two soon']);
    expect(a.thought).toMatchObject({ subject: 'Kelp', note: 'Kelp season two is on my list.' });
  });
});

describe('A-08 round 2 — blocker 2: no post text is cut out of the thesis', () => {
  const s0 = () => { const s = triaged(['Fen Lamp']); return s; };
  it('empty publicNote → one short note request to the same model AFTER the analysis; its note is marked note_retry', async () => {
    const s = s0();
    const users: string[] = [];
    s.deps.intel!.runAnalyst = (async ({ user }) => {
      users.push(user);
      const retry = user.startsWith('PUBLIC NOTES ONLY');
      return { verdict: retry ? { verdict: 'watch', thesis: 'same', confidence: 0.5, publicNote: 'Fen Lamp is on my list: steady holders, thin floor.' }
        : { verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: '', thesis: 'Two members of the group flagged Fen Lamp within an hour. The poster has a 9/10 track record.' },
      usage: [{ input_tokens: 400, output_tokens: 120 }], toolCalls: [] };
    }) as AnalystRunner;
    const a = await batch(s, ['Fen Lamp looks good', 'fen lamp floor up']);
    expect(users).toHaveLength(2);
    expect(users[1]).toMatch(/^PUBLIC NOTES ONLY/);
    expect(users[1]).toContain('never copy who said what');
    expect(a.thoughts).toEqual([expect.objectContaining({ subject: 'Fen Lamp', note: 'Fen Lamp is on my list: steady holders, thin floor.', origin: 'note_retry' })]);
    expect(JSON.stringify(a.thoughts)).not.toMatch(/members|group|poster|9\/10/);
  });
  it('the retry gives nothing → no thought, exact reason (the thesis is never posted)', async () => {
    const s = s0();
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: '', thesis: 'Two members of the group flagged Fen Lamp within an hour.' }));
    const a = await batch(s, ['Fen Lamp looks good', 'fen lamp floor up']);
    expect(s.calls).toHaveLength(2);
    expect(a.thought).toBeUndefined();
    expect(a.thoughtSkip).toBe('Fen Lamp: no public note');
  });
  it('model notes still pass the leak check; a long non-EVM address is shortened', () => {
    const names = ['ServerB', 'chat', 'user0'];
    expect(cleanNote('Saw Fen Lamp in the alpha chat today.', 'Fen Lamp', undefined, names)).toBeUndefined();
    const sui = '0x2f6e3a0d8c9b1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
    expect(cleanNote(`Fen Lamp package ${sui} is fresh.`, 'Fen Lamp', undefined, names)).toBe('Fen Lamp package 0x2f6e…7e8f is fresh.');
  });
});

describe('A-08 round 2 — blocker 3: nothing slow sits before exits and trades', () => {
  const hangingRetry = (s: S, first: unknown) => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const users: string[] = [];
    s.deps.intel!.runAnalyst = (async ({ user }) => {
      users.push(user);
      if (user.startsWith('PUBLIC NOTES ONLY')) await gate;
      return { verdict: user.startsWith('PUBLIC NOTES ONLY') ? { verdict: 'watch', thesis: 's', confidence: 0.8, publicNote: '' } : first, usage: [{ input_tokens: 10, output_tokens: 10 }], toolCalls: [] };
    }) as AnalystRunner;
    return { release, users };
  };
  it('L1 the exit of a held position is done before the note request even starts', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'x', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }] }));
    await handleMessage(msg({ text: `${MINT} buying` }), s.deps);
    expect(s.risk.holds(MINT)).toBe(true);
    const h = hangingRetry(s, { verdict: 'watch', confidence: 0.8, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: '', thesis: 'x', exits: [{ token: MINT, reason: 'dev dumped', sourceIdx: 1 }] });
    const p = handleMessage(msg({ text: `Fen Lamp mint tomorrow. also dev dumped ${MINT}, get out` }), s.deps);
    await new Promise(r => setTimeout(r, 100));
    expect(h.users.some(u => u.startsWith('PUBLIC NOTES ONLY'))).toBe(true);
    expect(s.risk.holds(MINT)).toBe(false);            // the exit is already done while the note request hangs
    h.release();
    expect((await p).exits).toEqual([MINT]);
  });
  it('L2 a trade on the main project: buy first, and no note request at all (the trade post covers it)', async () => {
    const s = setup();
    const h = hangingRetry(s, { verdict: 'act', confidence: 0.9, project: { name: 'Bobo' }, publicNote: '', thesis: 'x',
      intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }] });
    const r = await handleMessage(msg({ text: `${MINT} buying` }), s.deps);
    expect(r.decisions.map(d => d.action)).toEqual(['buy_token']);
    expect(h.users).toHaveLength(1);
    expect((r.analysis as AnalysisWithThoughts).thoughtSkips).toContain('Bobo: trade post covers it');
  });
  it('L3 the name is searched once per analysis (after the actions); a failed X search is recorded in the review log', async () => {
    const s = triaged(['Fen Lamp']);
    const seen: string[] = [];
    s.deps.intel!.enrich.x = xMock([{ author: 'fenlamp_fan' }], { fenlamp_fan: { followers: 10 } }, seen) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp' }, publicNote: 'Watching Fen Lamp.', thesis: 'x' }));
    await batch(s, ['Fen Lamp looks good', 'fen lamp up']);
    expect(seen.filter(x => x === 'search "Fen Lamp"')).toHaveLength(1);
    const s2 = triaged(['Fen Lamp']);
    s2.deps.intel!.enrich.x = { async search(): Promise<never> { throw new Error('twitterapi.io HTTP 402: credits'); }, async profile(h: string) { return { handle: h }; } };
    s2.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp' }, publicNote: 'Watching Fen Lamp.', thesis: 'x' }));
    const logged: [string, Record<string, unknown>][] = [];
    setReviewSink({ write: (k, d) => { logged.push([k, d]); } });
    try { await batch(s2, ['Fen Lamp looks good', 'fen lamp up']); } finally { setReviewSink({ write() {} }); }
    expect(logged.find(([k]) => k === 'project_x')?.[1]).toMatchObject({ names: ['Fen Lamp'], found: [], errors: [expect.stringMatching(/^x search "Fen Lamp": twitterapi\.io HTTP 402/)] });
  });
});

describe('A-08 round 2 — blocker 4: findProjectX confirms the right account', () => {
  const posts = (...authors: string[]) => authors.map(a => ({ author: a, text: 'Fen Lamp' }));
  it('F1 a look-alike with a paid badge and no smart followers loses to the real account with smart followers', async () => {
    const x: any = xMock(posts('fenlamp_mint', 'fenlampr'), { fenlamp_mint: { blueVerified: true, followers: 40 }, fenlampr: { followers: 2100 } });
    x.followerIds = async (h: string) => (h === 'fenlampr' ? ['1', '2', '7'] : ['7']);
    const r = await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, (await searchCandidates('Fen Lamp', x)).map(h => ({ handle: h, from: 'search' as const })), ctx(x));
    expect(r).toMatchObject({ handle: 'fenlampr', how: '2 smart account(s) follow it' });
  });
  it('the real account without any link but with two smart followers is confirmed; with one and nothing else — not', async () => {
    const x: any = xMock([], { fenlampr: {} });
    x.followerIds = async () => ['1', '2'];
    expect((await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlampr', from: 'search' }], ctx(x)))?.handle).toBe('fenlampr');
    x.followerIds = async () => ['1'];
    expect(await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlampr', from: 'search' }], ctx(x))).toBeUndefined();
  });
  it('one smart follower + a mutual OpenSea link (the collection lists the account back) confirms', async () => {
    const x: any = xMock([], { fenlampr: { bioUrls: ['https://opensea.io/collection/fenlamp'] } });
    x.followerIds = async () => ['1'];
    const opensea = { async nft(slug: string) { return slug === 'fenlamp' ? { name: 'Fen Lamp', twitter: 'fenlampr' } : undefined; } };
    const r = await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlampr', from: 'search' }], ctx(x, { opensea }));
    expect(r?.how).toBe('1 smart account(s) follow it; links OpenSea collection fenlamp, which lists it back');
  });
  it('F2/F3 similarity is prefix/equality, not a substring', () => {
    expect(handleLike('monad', 'Monad Punks')).toBe(false);
    expect(handleLike('coinbase', 'Base')).toBe(false);
    expect(handleLike('fenlampr', 'Fen Lamp')).toBe(true);
    expect(handleLike('monadpunksnft', 'Monad Punks')).toBe(true);
  });
  it('F3 a similar handle with only a badge is not confirmed', async () => {
    const x: any = xMock([], { hoodrich_kev: { blueVerified: true, followers: 90_000 } });
    expect(await confirmProjectX({ entity: 'name:hood', name: 'Hood', sites: [], slugs: [] }, [{ handle: 'hoodrich_kev', from: 'search' }], ctx(x))).toBeUndefined();
  });
  it('F4/F5 OpenSea links: only host opensea.io and the slug from the dossier are proof', async () => {
    const e = { entity: 'collection:fenlamp', name: 'Fen Lamp', sites: [], slugs: ['fenlamp'] };
    for (const bio of ['https://opensea.io/collection/fenlamp-free-mint', 'https://fake-opensea.io/collection/fenlamp', 'https://drainer.example/claim?ref=opensea.io/collection/fenlamp']) {
      const x: any = xMock([], { fenlamp_drop: { bioUrls: [bio] } });
      expect(await confirmProjectX(e, [{ handle: 'fenlamp_drop', from: 'search' }], ctx(x))).toBeUndefined();
    }
    const x: any = xMock([], { fenlampr: { bioUrls: ['https://opensea.io/collection/fenlamp'] } });
    expect((await confirmProjectX(e, [{ handle: 'fenlampr', from: 'search' }], ctx(x)))?.how).toBe('@fenlampr links https://opensea.io/collection/fenlamp (the project\'s own site/collection)');
  });
  it('F6 shared hosting: only the full host counts', async () => {
    expect(siteKey('https://fenlamp.vercel.app/mint')).toBe('fenlamp.vercel.app');
    expect(siteKey('https://app.fenlamp.xyz')).toBe('fenlamp.xyz');
    const e = { entity: 'name:fen lamp', name: 'Fen Lamp', sites: ['https://fenlamp.vercel.app/mint'], slugs: [] };
    const fake: any = xMock([], { fenlamp_fan: { bioUrls: ['https://my-drainer.vercel.app'] } });
    expect(await confirmProjectX(e, [{ handle: 'fenlamp_fan', from: 'search' }], ctx(fake))).toBeUndefined();
    const real: any = xMock([], { fenlampr: { bioUrls: ['https://fenlamp.vercel.app'] } });
    expect((await confirmProjectX(e, [{ handle: 'fenlampr', from: 'search' }], ctx(real)))?.handle).toBe('fenlampr');
  });
  it('F7 a failed profile lookup is recorded, not swallowed; DexScreener X alone is not proof', async () => {
    const c = ctx({ async search() { return []; }, async profile(): Promise<never> { throw new Error('twitterapi.io HTTP 402: credits'); } });
    expect(await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlampr', from: 'search' }], c)).toBeUndefined();
    expect(c.errors).toEqual(['x candidate @fenlampr: twitterapi.io HTTP 402: credits']);
    const x: any = xMock([], { clonex: { followers: 3 } });
    expect(await confirmProjectX({ entity: `sol:${MINT}`, name: '$BOBO', sites: [], slugs: [], dexX: 'clonex' }, [{ handle: 'clonex', from: 'dex' }], ctx(x))).toBeUndefined();
  });
  it('two equally supported candidates without a strong proof → nobody is tagged', async () => {
    const x: any = xMock([], { fenlampr: {}, fenlamp_hq: {} });
    x.followerIds = async () => ['1', '2'];
    const c = ctx(x);
    expect(await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlampr', from: 'search' }, { handle: 'fenlamp_hq', from: 'search' }], c)).toBeUndefined();
    expect(c.errors[0]).toMatch(/tie — not tagging either/);
  });
});

describe('A-08 round 2 — must-fix 5–8', () => {
  // The owner's decision 2026-11-18 ~12:55 UTC: an unconfirmed "(@h)" is removed together with the brackets — no "bare" handle in the post
  it('5 foreign @mentions written by the model lose their «@»; an unconfirmed «(@h)» goes with its brackets; the confirmed handle stays', () => {
    expect(cleanNote('Watching Fen Lamp (@fenlamp_fan), @punk6529 follows it.', 'Fen Lamp', undefined, [])).toBe('Watching Fen Lamp, punk6529 follows it.');
    expect(cleanNote('Watching Fen Lamp (@fenlampr), @punk6529 follows it.', 'Fen Lamp', 'fenlampr', [])).toBe('Watching Fen Lamp (@fenlampr), punk6529 follows it.');
  });
  it('6 handle normalizer: @, links, junk; insertion at a word boundary, no RegExp from data', async () => {
    expect(['@fenlampr', 'https://x.com/fenlampr', 'https://twitter.com/fenlampr/', 'fenlampr'].map(normalizeHandle)).toEqual(['fenlampr', 'fenlampr', 'fenlampr', 'fenlampr']);
    // Round 3 (X3): a link to a tweet or a service page — not an account; a foreign site — not X
    expect(['https://twitter.com/fenlampr/status/1', 'https://x.com/i/communities/1', 'https://x.com/search?q=hood', 'https://t.me/fenlampr'].map(normalizeHandle)).toEqual([undefined, undefined, undefined, undefined]);
    expect(['fenlamp)', 'fen lamp', 'a'.repeat(16), ''].map(normalizeHandle)).toEqual([undefined, undefined, undefined, undefined]);
    expect(withHandle('An arbitrage bot token, I want a week of volume first.', 'ARB', 'arbitrum')).toBe('An arbitrage bot token, I want a week of volume first (@arbitrum).');
    expect(withHandle('Robinhood Chain NFT called Hood, thin floor.', 'Hood', 'hoodnft')).toBe('Robinhood Chain NFT called Hood (@hoodnft), thin floor.');
    // OpenSea returns "@fenlampr", a link or garbage — the post is clean, the analysis does not fail
    for (const [tw, note] of [['@fenlampr', 'Watching Fen Lamp (@fenlampr): floor is thin.'], ['https://x.com/fenlampr', 'Watching Fen Lamp (@fenlampr): floor is thin.'], ['fenlamp)', 'Watching Fen Lamp: floor is thin.']]) {
      const s = setup();
      s.deps.intel!.enrich.x = xMock([], { fenlampr: {} }) as any;
      s.nfts.set('fenlamp', parseOpenSea('fenlamp', undefined, { name: 'Fen Lamp', twitter_username: tw, contracts: [] }, {}, 0));
      s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Watching Fen Lamp: floor is thin.', thesis: 'x' }));
      const r = await handleMessage(msg({ text: 'Fen Lamp https://opensea.io/collection/fenlamp' }), s.deps);
      expect(r.analysis?.thought?.note).toBe(note);
    }
  });
  it('7 held token discussed in a batch without verdict.projects → holding:true (card found by ticker among all batch projects)', async () => {
    const s = triaged(['BOBO']);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'x', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }] }));
    await handleMessage(msg({ text: `$BOBO ${MINT} buying` }), s.deps);
    expect(s.risk.holds(MINT)).toBe(true);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'BOBO' }, publicNote: 'Watching $BOBO: holders keep growing.', thesis: 'x' }));
    const a = await batch(s, ['$BOBO still running', 'bobo holders up']);
    expect(a.thought).toMatchObject({ key: 'p1', subject: '$BOBO', holding: true });
  });
  it('8 one project = one key: three spellings in three batches → the same key; Kelp / Kelp DAO → one thought; main «avoid» → no main thought', async () => {
    const s = triaged(['Fen Lamp']);
    const texts = ['Fen Lamp https://opensea.io/collection/fenlamp', 'fen lamp up'];
    const keys: (string | undefined)[] = [];
    for (const v of [{ project: { name: 'Fen Lamp' } }, { project: { name: 'Fen Lamp' }, projects: [{ ref: 'collection:fenlamp', verdict: 'watch', thesis: 'y' }] }, { project: { name: 'FenLamp' } }]) {
      s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, publicNote: 'Watching Fen Lamp.', thesis: 'x', ...v }));
      keys.push((await batch(s, texts)).thought?.key);
    }
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^p\d+$/);
    const k = triaged();
    k.setAnalyst(() => ({ verdict: 'act', confidence: 0.7, project: { name: 'Kelp' }, publicNote: 'Planning to farm Kelp points this week.', thesis: 'x',
      projects: [{ ref: 'Kelp', name: 'Kelp DAO', verdict: 'act', thesis: 't', publicNote: 'Kelp DAO season two opens.' }] }));
    expect((await batch(k, ['kelp season 2', 'kelp again'])).thoughts?.map(t => t.subject)).toEqual(['Kelp']);
    const a = triaged();
    a.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Kelp' }, publicNote: 'Chirpochain testnet is on my list.', thesis: 'x',
      projects: [{ ref: 'Kelp', verdict: 'avoid', thesis: 'Kelp team dumped.' }, { ref: 'Chirpochain', verdict: 'watch', thesis: 't', publicNote: 'Testnet miners go live on Sepolia next week.' }] }));
    const r = await batch(a, ['kelp season 2', 'chirpochain testnet']);
    expect(r.thoughts?.map(t => [t.subject, t.verdict, t.note])).toEqual([['Chirpochain', 'watch', 'Chirpochain: Testnet miners go live on Sepolia next week.']]);
    expect(r.thoughtSkip).toBe('main project Kelp: own verdict avoid');
  });
});

describe('smart-account list (the owner 2026-11-11): handles X returns no ID for are logged and retried alone', () => {
  it('logs the missing handles for the owner, re-asks only them after 6 h, keeps the resolved IDs', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Store } = await import('../src/store/db.js');
    const { smartAccounts } = await import('../src/analyst/smart.js');
    const dir = mkdtempSync(join(tmpdir(), 'smart-'));
    const csv = join(dir, 'smart-accounts.csv');
    writeFileSync(csv, 'handle,note\northogonal,trader\ndead_Iee,mod\nalpha_a,x\n');
    let t = 0; const asked: string[][] = []; const logs: string[] = [];
    const known: Record<string, string> = { orthogonal: '1', alpha_a: '3' };
    const x = { async profile(h: string) { return { handle: h }; }, async search() { return []; },
      async ids(hs: string[]) { asked.push(hs); return new Map(hs.filter(h => known[h]).map(h => [known[h], h] as [string, string])); } };
    const sm = smartAccounts(csv, x as any, new Store(':memory:'), () => t, s => logs.push(s));
    expect(await sm.ids!()).toBeUndefined();                                       // a cold list: the analysis does not wait
    await sm.whenWarm!();
    expect([...(await sm.ids!())!.values()].sort()).toEqual(['alpha_a', 'orthogonal']);
    expect(logs).toEqual(['smart accounts: X has no account for 1 of 3: dead_iee (typo or renamed? — fix server/config/smart-accounts.csv)']);
    t += 3600_000; await sm.ids!(); expect(asked).toHaveLength(1);                  // within 6 h — from the cache
    known.dead_iee = '2'; t += 6 * 3600_000;
    expect((await sm.ids!())!.size).toBe(2);                                       // returns the old map right away, the follow-up request — in the background
    await sm.whenWarm!();
    expect((await sm.ids!())!.size).toBe(3);
    expect(asked[1]).toEqual(['dead_iee']);                                          // the follow-up request — only what is missing
  });
});

// Acceptance round 3 of PR #69 (2026-11-11 19:00 UTC): the reviewer reproductions (X2b, X3b, X5r, D4b) — with the correct expectation.
// On head 790db34 all four are red.
describe('A-08 r3 acceptance — required 1–4', () => {
  const MINT2 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  it('1 (X2b) clone token: its own DexScreener site shows the CLONE address and links the real X → not confirmed, no handle', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'PENGU', twitter: 'pudgypenguins', websites: ['https://pengu-sol.xyz'] });
    (s.deps.intel!.enrich as any).page = async () => ({ text: `PENGU on Solana. CA: ${MINT}. `.repeat(20), links: ['https://x.com/pudgypenguins'] });
    s.deps.intel!.enrich.x = xMock([], { pudgypenguins: { followers: 900_000 } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'PENGU' }, publicNote: 'Watching $PENGU: fresh pair, volume is picking up.', thesis: 'x' }));
    await p.one({ text: `${MINT} new pengu` });
    expect(s.calls[0].user).not.toContain('"projectX"');
    expect(p.posted).toEqual([`Watching $PENGU: fresh pair, volume is picking up. No position.\nCA: ${MINT} (solana)`]);
  });

  it('1+ the same site counts when the X itself links it in its bio → tagged', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'PENGU', twitter: 'pudgypenguins', websites: ['https://pengu-sol.xyz'] });
    (s.deps.intel!.enrich as any).page = async () => ({ text: `PENGU on Solana. CA: ${MINT}. `.repeat(20), links: ['https://x.com/pudgypenguins'] });
    s.deps.intel!.enrich.x = xMock([], { pudgypenguins: { followers: 900_000, bioUrls: ['https://pengu-sol.xyz'] } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'PENGU' }, publicNote: 'Watching $PENGU: fresh pair, volume is picking up.', thesis: 'x' }));
    await p.one({ text: `${MINT} new pengu` });
    expect(p.posted[0]).toMatch(/^Watching \$PENGU \(@pudgypenguins\): fresh pair/);
  });

  it('2 (X3b) DexScreener «twitter» = a KOL\'s tweet (/status/), the KOL posted the CA → not the token\'s X, no handle', async () => {
    const m = parseDexScreener({ pairs: [{ chainId: 'solana', baseToken: { address: MINT, symbol: 'KEV' }, priceUsd: '0.001', liquidity: { usd: 30000 },
      info: { socials: [{ type: 'twitter', url: 'https://x.com/hoodrich_kev/status/1988888888888888888' }] } }] }, MINT, Date.now());
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'KEV', twitter: m!.twitter });
    s.deps.intel!.enrich.x = xMock([{ author: 'hoodrich_kev', text: `aping this one, CA ${MINT}` }], { hoodrich_kev: { followers: 90_000 } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'KEV' }, publicNote: 'Watching $KEV: a meme around one viral post, volume is real.', thesis: 'x' }));
    await p.one({ text: `${MINT} kev coin` });
    expect(p.posted).toEqual([`Watching $KEV: a meme around one viral post, volume is real. No position.\nCA: ${MINT} (solana)`]);
  });

  it('3 (X5r) the X of NFT collection «Hood» is not glued to the thought about the unrelated token $HOOD', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'HOOD' });
    s.nfts.set('hood', parseOpenSea('hood', undefined, { name: 'Hood', contracts: [], twitter_username: 'hoodnft' } as any, {}, 0));
    s.deps.intel!.enrich.x = xMock([], { hoodnft: { followers: 5000 } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: '$HOOD' }, publicNote: 'Watching $HOOD: fresh pair, volume is picking up.', thesis: 'x',
      projects: [{ ref: MINT, name: '$HOOD', verdict: 'watch', category: 'memecoin', thesis: 'coin' }, { ref: 'hood', name: 'Hood', verdict: 'ignore', category: 'nft', thesis: 'unrelated collection' }] }));
    const r = await p.one({ text: `$HOOD ${MINT} new pair; unrelated: https://opensea.io/collection/hood` });
    expect(s.calls[0].user).toContain('"handle":"hoodnft"');                         // the collection X is confirmed — but does not stick to the token
    expect((r.analysis as AnalysisWithThoughts).thoughts?.map(t => t.note)).toEqual(['Watching $HOOD: fresh pair, volume is picking up.']);
    expect(p.posted).toEqual([`Watching $HOOD: fresh pair, volume is picking up. No position.\nCA: ${MINT} (solana)`]);
  });

  it('4 (D4b) held $BOBO (address A); thought about token B (own card, only its address) named «Bobo» → no «I hold this»', async () => {
    const s = setup(); const p = withPublisher(s);
    s.prices.set(MINT2, 0.0002);
    s.marketExtra.set(MINT, { symbol: 'BOBO' }); s.marketExtra.set(MINT2, { symbol: 'BOBO' });
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'x', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }] }));
    await handleMessage({ id: 'd4a', sourceServer: 'ServerA', channel: 'core-calls', author: 'caller', tsUtc: s.clock.iso(), text: `$BOBO ${MINT} buying` }, s.deps);
    expect(s.risk.holds(MINT)).toBe(true);
    s.clock.advance(3 * 3600_000);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Bobo' }, publicNote: 'Watching Bobo: a second deploy, thin liquidity.', thesis: 'x' }));
    const r = await p.one({ text: `${MINT2} new deploy, different contract` });
    const t = (r.analysis as AnalysisWithThoughts).thought;
    expect(s.risk.holds(MINT2)).toBe(false);
    expect(t?.key).not.toBe('p1');
    expect(t?.holding).toBe(false);
    expect(p.posted).toEqual([`Watching Bobo: a second deploy, thin liquidity. No position.\nCA: ${MINT2} (solana)`]);
  });
});

// Finisher #69, round 2 — nice-to-haves 3–4 of reviewer eed2361 (they narrow the rules).
describe('A-08 HQ fixer round 2 — desirable 3–4', () => {
  const kev = (bioUrls: string[]) => {
    const s = setup(); const p = withPublisher(s);
    // the token "twitter" — the caller's tweet, the token site in DexScreener — the site from the caller's bio (the deployer fills both)
    s.marketExtra.set(MINT, { symbol: 'KEV', twitter: 'hoodrich_kev', websites: ['https://kevsite.xyz'] });
    s.deps.intel!.enrich.x = xMock([{ author: 'hoodrich_kev', text: `aping this one, CA ${MINT}` }], { hoodrich_kev: { followers: 90_000, bioUrls } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'KEV' }, publicNote: 'Watching $KEV: a meme around one viral post, volume is real.', thesis: 'x' }));
    return { s, p };
  };
  it('3: the poster\'s bio links the token SITE from DexScreener (deployer-filled) → «posted this address» does not count', async () => {
    const { p } = kev(['https://kevsite.xyz']);
    await p.one({ text: `${MINT} kev coin` });
    expect(p.posted).toEqual([`Watching $KEV: a meme around one viral post, volume is real. No position.\nCA: ${MINT} (solana)`]);
  });
  it('3+: the bio links THIS address → its post with the address counts, tagged', async () => {
    const { p } = kev([`https://dexscreener.com/solana/${MINT}`]);
    await p.one({ text: `${MINT} kev coin` });
    expect(p.posted[0]).toMatch(/^Watching \$KEV \(@hoodrich_kev\): a meme/);
  });

  it('4: tokens the code rejects anyway (A-16) — no project-X confirmation, no paid X calls for it; a clean token still gets it', async () => {
    const run = async (mintAuthority: boolean) => {
      const s = setup(); const seen: string[] = [];
      s.deps.intel!.enrich.market = { ...s.deps.intel!.enrich.market,
        async market() { return { chain: 'solana', symbol: 'PRJ', twitter: 'projx', priceUsd: 0.0001, liquidityUsd: 25_000, fdvUsd: 100_000, pairAgeMinutes: 30, buys24h: 40, sells24h: 30 }; },
        async rug() { return { risk: 'medium', freezeOrMintAuthority: mintAuthority, reasons: [] }; } } as any;
      s.deps.intel!.enrich.x = {
        async profile(h: string) { seen.push(`profile ${h}`); return { handle: h, id: '9', followers: 3000, bioUrls: [`https://pump.fun/coin/${MINT}`] }; },
        async search(q: string) { seen.push(`search ${q}`); return q.startsWith('from:') ? [{ author: 'projx', text: `CA ${MINT}` }] : []; }, async timeline() { return []; },
      } as any;
      const { buildDossier } = await import('../src/analyst/enrich.js');
      const dos = await buildDossier({ tokens: [MINT], domains: [], xHandles: [], urls: [], tickers: [], hardCheck: { strictLiquidity: true } }, s.deps.intel!.enrich);
      return { dos, seen };
    };
    const bad = await run(true);
    expect(bad.dos.projectX).toBeUndefined();
    expect(bad.seen).not.toContain(`search from:projx ${MINT}`);                 // searching for its own post with the address — paid
    const ok = await run(false);
    expect(ok.seen).toContain(`search from:projx ${MINT}`);
    expect(ok.dos.projectX?.[0]).toMatchObject({ entity: `sol:${MINT}`, handle: 'projx' });
  });
});
