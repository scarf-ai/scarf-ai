// A-08, acceptance round 3 of PR #69: every round 2 review reproduction (X1–X5, S1, L1–L2, N1, D1–D2, T1, R1, Q1–Q2) — an ordinary test
// with the correct expectation. Through handleMessage → the #68 fix loop → a real Publisher (auto).
import { describe, it, expect } from 'vitest';
import { handleMessage } from '../src/pipeline.js';
import { parseOpenSea } from '../src/analyst/opensea.js';
import { cleanNote, fitSentences, repeatsNote, recheckDue, NAME_X_MS, type AnalysisWithThoughts } from '../src/intel/router.js';
import { systemPrompt } from '../src/analyst/analyst.js';
const SYSTEM = () => systemPrompt('brief');
import { confirmProjectX, handleLike, siteKey, type XCheckCtx } from '../src/analyst/xresearch.js';
import type { AnalystRunner } from '../src/analyst/analyst.js';
import { parseTrustCsv, TrustTable } from '../src/trust/trust.js';
import { setup, msg, xMock, MINT, CSV } from './a08-helpers.js';
import { withPublisher, triaged, withSmart } from './a08-publish.js';

const ctx = (x: any, over: Partial<XCheckCtx> = {}): XCheckCtx => ({ x, pages: [], errors: [], smart: { handles: new Map(), ids: async () => new Map([['1', 'a'], ['2', 'b']]) }, ...over });
const thoughtsOf = (r: { analysis?: unknown }) => r.analysis as AnalysisWithThoughts;

describe('A-08 r3 — blocker 1: only the project\'s own @handle reaches the post', () => {
  it('X1 short name: «Hood» is not @hoodrich_kev even with smart followers (equal, or prefix of a ≥ 6-char name, ≤ +4 chars)', async () => {
    expect([handleLike('hoodrich_kev', 'Hood'), handleLike('coinbase', 'Base'), handleLike('monad', 'Monad Punks'), handleLike('fenlampr', 'Fen Lamp'), handleLike('hood', 'Hood'), handleLike('fenlampofficial', 'Fen Lamp')])
      .toEqual([false, false, false, true, true, false]);
    const s = triaged(['Hood']); const p = withPublisher(s);
    const x: any = xMock([{ author: 'hoodrich_kev', text: 'Hood szn, aping everything on Robinhood Chain' }], { hoodrich_kev: { followers: 90_000, blueVerified: true } });
    withSmart(s, x, { hoodrich_kev: ['1', '2', '5'] });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Hood', category: 'nft' }, publicNote: 'Watching Hood: a new Robinhood Chain collection, thin floor so far.', thesis: 'x' }));
    await p.batch(['Hood mint is live', 'hood floor moving']);
    expect(p.posted).toEqual(['Watching Hood: a new Robinhood Chain collection, thin floor so far. Low confidence on this one. No position.']);
  });

  it('X2 clone token copies the real project\'s X and site in its DexScreener profile → not confirmed (no link to THIS address)', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'PENGU', twitter: 'pudgypenguins', websites: ['https://pudgypenguins.com'] });
    s.deps.intel!.enrich.x = xMock([], { pudgypenguins: { followers: 900_000, bioUrls: ['https://pudgypenguins.com'] } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'PENGU' }, publicNote: 'Watching $PENGU: fresh pair, volume is picking up.', thesis: 'x' }));
    const r = await p.one({ text: `${MINT} new pengu` });
    expect(s.calls[0].user).not.toContain('"projectX"');
    expect(s.calls[0].user).toContain('@pudgypenguins not confirmed (no link to this address in its bio or posts)');
    expect(thoughtsOf(r).thought?.note).not.toContain('@pudgypenguins');
    expect(p.posted[0]).toMatch(/^Watching \$PENGU: fresh pair/);
  });

  // Round 3, item 2: "posted the address" counts for a DexScreener candidate only with a bio link to this address (finisher, round 2; here — the token page)
  it('X2+ the real token: its X posted this address (own post found by search) and its bio links this address → tagged', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'PENGU', twitter: 'pudgypenguins', websites: ['https://pudgypenguins.com'] });
    s.deps.intel!.enrich.x = xMock([{ author: 'pudgypenguins', text: `$PENGU is live. Only CA: ${MINT}` }, { author: 'random', text: `${MINT}` }], { pudgypenguins: { followers: 900_000, bioUrls: [`https://pump.fun/coin/${MINT}`] } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'PENGU' }, publicNote: 'Watching $PENGU: fresh pair, volume is picking up.', thesis: 'x' }));
    await p.one({ text: `${MINT} new pengu` });
    expect(s.calls[0].user).toContain(`"projectX":[{"entity":"sol:${MINT}","name":"$PENGU","handle":"pudgypenguins","how":"@pudgypenguins posted ${MINT.slice(0, 8)}…"`);
    expect(p.posted[0]).toBe(`Watching $PENGU (@pudgypenguins): fresh pair, volume is picking up. No position.\nCA: ${MINT} (solana)`);   // the CA line — T-09 (main)
  });

  it('X3 «twitter» of the token is somebody\'s tweet: the tweet author is not the project (no link to the address); /status/ links are not accounts', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'KEV', twitter: 'hoodrich_kev' });   // this is how checks/token.ts parses x.com/hoodrich_kev/status/… (a request to Execution)
    const x: any = xMock([], { hoodrich_kev: { followers: 90_000 } });
    withSmart(s, x, { hoodrich_kev: ['1'] });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'KEV' }, publicNote: 'Watching $KEV: a meme around one viral post, volume is real.', thesis: 'x' }));
    await p.one({ text: `${MINT} kev coin` });
    expect(p.posted).toEqual([`Watching $KEV: a meme around one viral post, volume is real. No position.\nCA: ${MINT} (solana)`]);
  });

  it('X4 two look-alikes with 2 smart followers each: follower counts do not decide → tie, nobody tagged', async () => {
    const x: any = xMock([], { fenlampr: { followers: 2100 }, fenlamp_hq: { followers: 2101 } });
    x.followerIds = async () => ['1', '2'];
    const c = ctx(x);
    const r = await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlampr', from: 'search' }, { handle: 'fenlamp_hq', from: 'search' }], c);
    expect(r).toBeUndefined();
    expect(c.errors).toContain('x for Fen Lamp: @fenlampr and @fenlamp_hq tie — not tagging either');
  });

  it('X5 a confirmed X of token $HOOD is not glued to the thought about the NFT collection «Hood» (name match only for name:/collection:)', async () => {
    const s = triaged(['Hood']); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'HOOD', twitter: 'hoodcoin_sol', websites: ['https://hoodcoin.fun'] });
    s.deps.intel!.enrich.x = xMock([], { hoodcoin_sol: { followers: 800, description: `$HOOD ${MINT}` } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Hood', category: 'nft' }, publicNote: 'Watching Hood: the NFT mint opens tomorrow, supply 3,333.', thesis: 'x',
      projects: [{ ref: 'Hood', name: 'Hood', verdict: 'watch', category: 'nft', thesis: 'nft mint' }, { ref: MINT, verdict: 'ignore', category: 'memecoin', thesis: 'unrelated coin' }] }));
    const r = await p.batch([`someone aped ${MINT} lol`, 'Hood nft mint tomorrow']);
    expect(s.calls.at(-1)!.user).toContain(`"entity":"sol:${MINT}","name":"$HOOD","handle":"hoodcoin_sol"`);   // the token X is confirmed — and stays with the token
    expect(thoughtsOf(r).thoughts!.map(t => t.note)).toEqual(['Watching Hood: the NFT mint opens tomorrow, supply 3,333.']);
  });
});

describe('A-08 r3 — no silent refusals (desirable 7)', () => {
  it('S1 smart IDs still warming → the reason is in errors, with the rejected candidate', async () => {
    const x: any = xMock([], { fenlampr: { followers: 2100 } });
    x.followerIds = async () => ['1', '2'];
    const c = ctx(x, { smart: { handles: new Map([['a', ''], ['b', '']]), ids: async () => undefined } });
    expect(await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlampr', from: 'search' }], c)).toBeUndefined();
    expect(c.errors).toEqual(['x candidate @fenlampr: smart list not ready — smart-follower check skipped', 'x for Fen Lamp: @fenlampr not confirmed (smart 0)']);
  });
  it('S2 OpenSea failure on the mutual-link check is recorded', async () => {
    const x: any = xMock([], { fenlampr: { followers: 2100, bioUrls: ['https://opensea.io/collection/fenlamp'] } });
    x.followerIds = async () => ['1'];
    const c = ctx(x, { opensea: { async nft() { throw new Error('OpenSea HTTP 500'); } } });
    await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlampr', from: 'search' }], c);
    expect(c.errors[0]).toBe('x candidate @fenlampr: OpenSea fenlamp: OpenSea HTTP 500');
  });
});

describe('A-08 r3 — blocker 2: X lookups never delay the model, the exit or the entry', () => {
  it('L1 the name search hangs → the model is called and the position is closed meanwhile', async () => {
    const s = triaged(['Fen Lamp']);
    s.deps.trust = new TrustTable(parseTrustCsv(CSV + 'channel,ServerB,lounge,,6,chat\nauthor,ServerB,,u1,6,\nauthor,ServerB,,u2,6,\n').rows);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'x', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }] }));
    await handleMessage(msg({ text: `${MINT} buying` }), s.deps);
    expect(s.risk.holds(MINT)).toBe(true);
    const before = s.calls.length;
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const seen: string[] = [];
    s.deps.intel!.enrich.x = { async search(q: string) { seen.push(`search ${q}`); if (q === '"Fen Lamp"') await gate; return []; }, async profile(h: string) { seen.push(`profile ${h}`); return { handle: h }; } } as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.8, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Watching Fen Lamp.', thesis: 'x', exits: [{ token: MINT, reason: 'team is unloading', sourceIdx: 2 }] }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'lounge', author: 'u1', text: 'Fen Lamp mint tomorrow' }), s.deps);
    const p = handleMessage(msg({ sourceServer: 'ServerB', channel: 'lounge', author: 'u2', text: `team wallet is unloading ${MINT} fyi` }), s.deps);
    await new Promise(r => setTimeout(r, 300));
    expect(s.calls.length).toBe(before + 1);       // the model is called without waiting for X
    expect(s.risk.holds(MINT)).toBe(false);        // the position is closed while the handle search still hangs
    expect(seen).toContain('search "Fen Lamp"');   // the search goes after the actions
    release();
    await p;
  });

  it('L2 nothing from X runs before the model in a batch with only a name', async () => {
    const s = triaged(['Fen Lamp']);
    const seen: string[] = []; let seenAtModel: string[] = [];
    const x: any = { async search(q: string) { seen.push(`search ${q}`); return [{ text: 'Fen Lamp', createdAt: '2026-11-10T12:00:00Z', likes: 1, retweets: 0, author: 'fenlampr' }]; },
      async profile(h: string) { seen.push(`profile ${h}`); return { handle: h, followers: 2100 }; },
      async followerIds(h: string) { seen.push(`followerIds ${h}`); return ['1', '2']; } };
    s.deps.intel!.enrich.x = x;
    s.deps.intel!.enrich.smart = { handles: new Map([['a', ''], ['b', '']]), ids: async () => new Map([['1', 'a'], ['2', 'b']]) };
    s.deps.intel!.runAnalyst = (async () => { seenAtModel = [...seen]; return { verdict: { verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp' }, publicNote: 'Watching Fen Lamp.', thesis: 'x' }, usage: [{ input_tokens: 1, output_tokens: 1 }], toolCalls: [] }; }) as any;
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u1', text: 'Fen Lamp looks good' }), s.deps);
    const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u2', text: 'fen lamp floor up' }), s.deps);
    expect(seenAtModel).toEqual([]);
    expect(seen).toEqual(['search "Fen Lamp"', 'profile fenlampr', 'followerIds fenlampr']);
    expect(thoughtsOf(r).thought?.note).toBe('Watching Fen Lamp (@fenlampr).');
  });

  // The limit of the name search after actions — NAME_X_MS (12 s, HQ 2026-11-18 from the production log: 5 s was not enough)
  it('L3 a hung X is cut at NAME_X_MS: the thought goes out without a handle, the reason is recorded', async () => {
    const s = triaged(['Fen Lamp']);
    s.deps.intel!.enrich.x = { async search() { return new Promise<never>(() => { /* hangs */ }); }, async profile(h: string) { return { handle: h }; } } as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp' }, publicNote: 'Watching Fen Lamp: thin floor.', thesis: 'x' }));
    const t0 = Date.now();
    const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u1', text: 'Fen Lamp looks good' }), s.deps).then(() => handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u2', text: 'fen lamp floor up' }), s.deps));
    expect(NAME_X_MS).toBe(12_000);
    expect(Date.now() - t0).toBeLessThan(NAME_X_MS + 1500);
    expect(thoughtsOf(r).thought?.note).toBe('Watching Fen Lamp: thin floor.');
  }, 20_000);

  it('L4 the result of a name search is cached for 24 h: three batches about one project → one search', async () => {
    const s = triaged(['Fen Lamp']);
    const seen: string[] = [];
    const x: any = xMock([{ author: 'fenlampr', text: 'Fen Lamp' }], { fenlampr: { followers: 2100 } }, seen);
    withSmart(s, x, { fenlampr: ['1', '2'] });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp' }, publicNote: 'Watching Fen Lamp.', thesis: 'x' }));
    const p = withPublisher(s);
    const rs = [await p.batch(['Fen Lamp a', 'fen lamp b']), await p.batch(['Fen Lamp c', 'fen lamp d']), await p.batch(['Fen Lamp e', 'fen lamp f'])];
    expect(seen.filter(q => q === 'search "Fen Lamp"')).toHaveLength(1);
    expect(rs.map(r => thoughtsOf(r).thought?.note)).toEqual(['Watching Fen Lamp (@fenlampr).', 'Watching Fen Lamp (@fenlampr).', 'Watching Fen Lamp (@fenlampr).']);
  });
});

describe('A-08 r3 — blocker 3: no thought about the project just traded', () => {
  it('T1 perp trade (no token address): the main thought is dropped, the trade post covers it', async () => {
    const s = setup(); const p = withPublisher(s);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'trusted caller opened a low-leverage BTC long', project: { name: 'BTC' }, publicNote: 'Planning a small $BTC long with a stop under 97k.',
      intents: [{ kind: 'perp_trade', chain: 'unknown', asset: 'BTC', side: 'long', leverage: 3, stopPrice: 97_000, takeProfitPrice: 106_000, urls: [], summary: 'long BTC', stance: 'buy', confidence: 0.8 }] }));
    const r = await p.one({ author: 'caller1', text: 'Opened a long on $BTC here with low leverage, invalidation below 97k' });
    expect(r.decisions[0].action).toBe('open_perp');
    expect(thoughtsOf(r).thoughts).toEqual([]);
    expect(thoughtsOf(r).thoughtSkip).toBe('BTC: trade post covers it');
    expect(p.posted.some(t => /Planning a small \$BTC long/.test(t))).toBe(false);
  });
  it('T2 a trade on one project keeps the thought about another project of the same analysis', async () => {
    const s = setup(); const p = withPublisher(s);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'x', project: { name: 'BTC' }, publicNote: 'Planning a small $BTC long.',
      projects: [{ ref: 'BTC', name: 'BTC', verdict: 'act', thesis: 'long' }, { ref: 'Fen Lamp', name: 'Fen Lamp', verdict: 'watch', thesis: 'nft', publicNote: 'Fen Lamp is on my list: thin floor.' }],
      intents: [{ kind: 'perp_trade', chain: 'unknown', asset: 'BTC', side: 'long', leverage: 3, stopPrice: 97_000, takeProfitPrice: 106_000, urls: [], summary: 'long BTC', stance: 'buy', confidence: 0.8 }] }));
    const r = await p.one({ author: 'caller1', text: 'Opened a long on $BTC, also Fen Lamp looks good' });
    expect(thoughtsOf(r).thoughts!.map(t => t.subject)).toEqual(['Fen Lamp']);
    expect(p.posted).toEqual(['Fen Lamp is on my list: thin floor. No position.']);
  });
});

describe('A-08 r3 — must-fix 4: the «Name: » prefix does not hide a done-claim', () => {
  it('N1 sentence-start «Minted…», «Bought…» are rejected before and after the prefix', async () => {
    expect(cleanNote('Minted two on the allowlist, the floor is thin.', 'Fen Lamp', undefined, [])).toBeUndefined();
    expect(cleanNote('Bought the dip here yesterday, watching the floor now.', 'Fen Lamp', 'fenlampr', [])).toBeUndefined();
    const s = triaged(['Fen Lamp']); const p = withPublisher(s);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Bought the dip here yesterday, watching the floor now.', thesis: 'x' }));
    const r = await p.batch(['Fen Lamp looks good', 'fen lamp floor up']);
    expect(p.posted).toEqual([]);
    expect(thoughtsOf(r).thoughtSkip).toBe('Fen Lamp: public note failed the leak check');
  });
});

describe('A-08 r3 — must-fix 5: position disclosure', () => {
  it('D1 held token discussed by name only (no $, no address) → «I hold this.»', async () => {
    const s = triaged(['bobo']); const p = withPublisher(s);
    s.setAnalyst(() => ({ verdict: 'act', confidence: 0.9, thesis: 'x', intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }] }));
    await handleMessage(msg({ text: `$BOBO ${MINT} buying` }), s.deps);
    expect(s.risk.holds(MINT)).toBe(true);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Bobo' }, publicNote: 'Watching Bobo: holders keep growing.', thesis: 'x' }));
    const r = await p.batch(['bobo still running', 'bobo holders up, not selling']);
    expect(thoughtsOf(r).thought).toMatchObject({ holding: true });
    expect(p.posted.at(-1)).toBe('Watching Bobo: holders keep growing. I hold this.');
  });
  it('D2 NFT position nft:fenlamp ↔ card key collection:fenlamp → «I hold this.»', async () => {
    const s = setup(); const p = withPublisher(s);
    s.risk.openPosition({ id: 'n1', chain: 'ethereum', token: 'nft:fenlamp', costUsd: 2, openedAtUtc: s.clock.iso() });
    s.nfts.set('fenlamp', parseOpenSea('fenlamp', undefined, { name: 'Fen Lamp', contracts: [] }, {}, 0));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Watching Fen Lamp: the floor holds, listings are thin.', thesis: 'x' }));
    const r = await p.one({ text: 'Fen Lamp https://opensea.io/collection/fenlamp floor holding' });
    expect(thoughtsOf(r).thought).toMatchObject({ holding: true });
    expect(p.posted).toEqual(['Watching Fen Lamp: the floor holds, listings are thin. I hold this.']);
  });
  it('D3 perp position perp:ETH ↔ card key ticker:eth → holding', async () => {
    const s = setup();
    s.risk.openPosition({ id: 'p1', chain: 'unknown', token: 'perp:ETH', costUsd: 5, openedAtUtc: s.clock.iso() });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'ETH' }, publicNote: 'Watching $ETH: funding is flat.', thesis: 'x' }));
    const r = await handleMessage(msg({ text: '$ETH funding flat, watching' }), s.deps);
    expect(thoughtsOf(r).thought).toMatchObject({ subject: '$ETH', holding: true });
  });
});

describe('A-08 r3 — must-fix 6: the note retry is paid only when the thought can go out', () => {
  const retrySetup = () => {
    const s = triaged(['Fen Lamp']); const p = withPublisher(s);
    const users: string[] = [];
    s.deps.intel!.runAnalyst = (async ({ user }) => {
      users.push(user);
      const retry = user.startsWith('PUBLIC NOTES ONLY');
      return { verdict: retry ? { verdict: 'watch', thesis: 'same', confidence: 0.5, publicNote: 'Fen Lamp is on my list: steady holders, thin floor.' }
        : { verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp', category: 'nft' }, thesis: 'Steady holders.' },
      usage: [{ input_tokens: 6000, output_tokens: 700 }], toolCalls: [] };
    }) as AnalystRunner;
    return { s, p, users };
  };
  it('R1 three batches about one project → one retry (the thought of the first one blocks the next two for 24 h); the retry is in analysis.costUsd; note_retry waits for the button', async () => {
    const { s, p, users } = retrySetup();
    const r1 = await p.batch(['Fen Lamp looks good', 'fen lamp floor up']);
    const r2 = await p.batch(['Fen Lamp again', 'fen lamp still fine']);
    await p.batch(['Fen Lamp third time', 'fen lamp ok']);
    expect(users.filter(u => u.startsWith('PUBLIC NOTES ONLY'))).toHaveLength(1);
    expect(thoughtsOf(r1).thoughts?.[0].origin).toBe('note_retry');
    expect(p.posted).toEqual([]);                                                     // note_retry — only via the button
    expect(thoughtsOf(r2).thoughtSkips).toContain('Fen Lamp: no public note (retry skipped: thought on it posted in 24h)');
    // the analysis and the retry — both in the price: 2 × (6000 in + 700 out) against one call for r2
    expect(r1.analysis!.costUsd).toBeGreaterThan(1.9 * r2.analysis!.costUsd - 0.0005);
    void s;
  });
  it('R2 the daily thought cap is full → no retry', async () => {
    const { s, p, users } = retrySetup();
    const real = s.store.postsOfKind.bind(s.store);
    s.store.postsOfKind = (kind: string, since: string) => (kind === 'thought' ? 8 : real(kind, since));   // already 8 thoughts for the day
    const r = await p.batch(['Fen Lamp looks good', 'fen lamp floor up']);
    expect(users.filter(u => u.startsWith('PUBLIC NOTES ONLY'))).toHaveLength(0);
    expect(thoughtsOf(r).thoughtSkips).toContain('no public note (retry skipped: thoughts cap 8/24h)');
  });
  it('R3 the model budget is exhausted → no retry', async () => {
    const { s, p, users } = retrySetup();
    // the budget lets the first call (the batch analysis itself) through, by the retry it is exhausted
    const pick = s.deps.intel!.budget.pickChatReview.bind(s.deps.intel!.budget);
    let n = 0; (s.deps.intel!.budget as any).pickChatReview = (m: string, c: number) => (n++ === 0 ? pick(m, c) : undefined);
    const r = await p.batch(['Fen Lamp looks good', 'fen lamp floor up']);
    expect(users.filter(u => u.startsWith('PUBLIC NOTES ONLY'))).toHaveLength(0);
    expect(thoughtsOf(r).thoughtSkips?.some(x => /^no public note \(retry skipped: .+ budget exhausted\)$/.test(x))).toBe(true);
  });
  it('R4 a failed retry still records its cost', async () => {
    const s = setup();
    let calls = 0;
    s.deps.intel!.runAnalyst = (async ({ user }) => {
      calls++;
      if (user.startsWith('PUBLIC NOTES ONLY')) throw Object.assign(new Error('overloaded'), { usage: [{ input_tokens: 6000, output_tokens: 300 }] });
      return { verdict: { verdict: 'watch', confidence: 0.6, project: { name: 'Fen Lamp' }, thesis: 'x' }, usage: [{ input_tokens: 6000, output_tokens: 700 }], toolCalls: [] };
    }) as AnalystRunner;
    const spent0 = s.deps.intel!.budget.spent(s.deps.intel!.budget.caps.analystModel);
    const r = await handleMessage(msg({ text: 'Fen Lamp looks good' }), s.deps);
    expect(calls).toBe(2);
    const model = r.analysis!.model;
    const one = s.deps.intel!.budget.spent(model) - spent0;
    expect(r.analysis!.costUsd).toBeCloseTo(one, 6);
    expect(thoughtsOf(r).thoughtSkip).toBe('Fen Lamp: no public note');
  });
});

describe('A-08 r3 — sources and site comparison', () => {
  it('Q1 the X link written in the message is a candidate for the name: two smart followers → tagged', async () => {
    const s = triaged(['Fen Lamp']); const p = withPublisher(s);
    const x: any = xMock([], { fenlampr: { followers: 2100 } });
    withSmart(s, x, { fenlampr: ['1', '2'] });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Watching Fen Lamp: holders grow, the floor is thin.', thesis: 'x' }));
    const r = await p.batch(['Fen Lamp looks good https://x.com/fenlampr', 'fen lamp floor up']);
    expect(thoughtsOf(r).thought?.note).toBe('Watching Fen Lamp (@fenlampr): holders grow, the floor is thin.');
  });
  it('Q2 social hosts and services are not project sites: no «strong» proof from t.me / linktr.ee / opensea.io', async () => {
    expect(['https://linktr.ee/kevcoin', 'https://t.me/kevcoin', 'https://discord.gg/abc', 'https://x.com/kev', 'https://opensea.io/collection/kev', 'https://medium.com/@kev'].map(siteKey)).toEqual(['', '', '', '', '', '']);
    expect([siteKey('https://fenlamp.vercel.app/mint'), siteKey('https://www.fenlamp.xyz/')]).toEqual(['fenlamp.vercel.app', 'fenlamp.xyz']);
    const x: any = xMock([], { kevcoin: { followers: 900, bioUrls: ['https://t.me/kev_private_alpha'] } });
    const c = ctx(x);
    const r = await confirmProjectX({ entity: 'name:kevcoin', name: 'kevcoin', sites: ['https://t.me/kevcoin'], slugs: [] }, [{ handle: 'kevcoin', from: 'search' }], c);
    expect(r).toBeUndefined();
  });
});

describe('A-08 r3 — threshold mutations are caught (desirable 10)', () => {
  it('M1 the badge only orders: 3 smart followers without a badge beat 2 with a badge', async () => {
    const x: any = xMock([], { fenlampr: { followers: 100 }, fenlamp_hq: { followers: 100, blueVerified: true } });
    x.followerIds = async (h: string) => (h === 'fenlampr' ? ['1', '2', '3'] : ['1', '2']);
    const c = ctx(x, { smart: { handles: new Map(), ids: async () => new Map([['1', 'a'], ['2', 'b'], ['3', 'c']]) } });
    const r = await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'fenlamp_hq', from: 'search' }, { handle: 'fenlampr', from: 'search' }], c);
    expect(r).toMatchObject({ handle: 'fenlampr', how: '3 smart account(s) follow it' });
  });
  it('M2 a handle unlike the name is not confirmed by smart followers alone', async () => {
    const x: any = xMock([], { hood_trader: { followers: 9000 } });
    x.followerIds = async () => ['1', '2'];
    const c = ctx(x);
    expect(await confirmProjectX({ entity: 'name:fen lamp', name: 'Fen Lamp', sites: [], slugs: [] }, [{ handle: 'hood_trader', from: 'search' }], c)).toBeUndefined();
    expect(c.errors).toEqual(['x for Fen Lamp: @hood_trader not confirmed (smart 0, handle not like the name)']);
  });
});

// HQ addendum 2026-11-11 17:45 UTC (the owner's decision 17:30): item 3 — the token note length, item 4 — the re-check note.
describe('A-08 r3+ — HQ addendum 17:45 UTC: token note length and re-check notes', () => {
  it('3 token note: ≤ 190 chars in complete sentences; one over-long sentence → no thought', async () => {
    expect(fitSentences('Watching $KEV: volume is real. Holders keep growing every hour. I want two more days of flow before I act.', 70)).toBe('Watching $KEV: volume is real. Holders keep growing every hour.');
    expect(fitSentences('x'.repeat(200), 190)).toBeUndefined();
    const s = setup();
    s.marketExtra.set(MINT, { symbol: 'KEV' });
    const long = 'Watching $KEV: a meme around one viral post and the volume is real. ' + 'Holders keep growing hour after hour and the chart has not had a real pullback yet, so I wait. ' + 'I want two more days of flow.';
    expect(long.length).toBeGreaterThan(190);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'KEV' }, publicNote: long, thesis: 'x' }));
    const r = await handleMessage(msg({ text: `${MINT} kev coin` }), s.deps);
    const note = thoughtsOf(r).thought!.note;
    expect(note.length).toBeLessThanOrEqual(190);
    expect(note).toBe('Watching $KEV: a meme around one viral post and the volume is real. Holders keep growing hour after hour and the chart has not had a real pullback yet, so I wait.');
    const s2 = setup();
    s2.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'KEV' }, publicNote: `Watching $KEV ${'because the volume keeps climbing '.repeat(7)}now`, thesis: 'x' }));
    const r2 = await handleMessage(msg({ text: `${MINT} kev coin` }), s2.deps);
    expect(thoughtsOf(r2).thoughtSkip).toMatch(/^KEV: public note too long for a token post \(\d+ chars, one sentence\)$/);
    expect(SYSTEM()).toContain('For a token (it has a contract address) keep publicNote within 190 characters, in complete sentences: the post adds a CA line.');
  });

  it('4 re-check: the model sees its last public note and the RE-CHECK rule; a repeated note does not go out, a new one does', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Watching Fen Lamp: thin floor, steady holders.', thesis: 'first look', recheckAfterMinutes: 60 }));
    const r1 = await handleMessage(msg({ text: 'Fen Lamp https://opensea.io/collection/fenlamp floor holding' }), s.deps);
    expect(thoughtsOf(r1).thought?.note).toBe('Watching Fen Lamp: thin floor, steady holders.');
    // A re-check an hour later: the model repeats the note → no thought
    s.clock.set(s.clock.now() + 61 * 60_000);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Still watching Fen Lamp: thin floor, steady holders.', thesis: 'same', recheckAfterMinutes: 60 }));
    const [r2] = await recheckDue(s.deps);
    const user = s.calls.at(-1)!.user;
    expect(user).toContain('RE-CHECK: this is a scheduled re-check');
    expect(user).toMatch(/your last public note \(\d{4}-\d\d-\d\dT\d\d:\d\dZ\): Watching Fen Lamp: thin floor, steady holders\./);
    expect(thoughtsOf(r2).thoughts).toEqual([]);
    expect(thoughtsOf(r2).thoughtSkip).toBe('Fen Lamp: re-check note repeats the last one');
    // The next re-check: what changed → the thought goes out
    s.clock.set(s.clock.now() + 61 * 60_000);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Fen Lamp', category: 'nft' }, publicNote: 'Fen Lamp update: the floor doubled since this morning and listings dried up.', thesis: 'floor x2' }));
    const [r3] = await recheckDue(s.deps);
    expect(thoughtsOf(r3).thought?.note).toBe('Fen Lamp update: the floor doubled since this morning and listings dried up.');
    expect(repeatsNote('Fen Lamp update: the floor doubled since this morning and listings dried up.', 'Watching Fen Lamp: thin floor, steady holders.')).toBe(false);
  });
});
