// Review hq/A-handles (5022275), HQ repros R1–R5. Each test describes the CORRECT behaviour: red = defect.
// Principle: in a public post a false tag is worse than no tag.
import { describe, it, expect } from 'vitest';
import { handleMessage } from '../src/pipeline.js';
import { parseOpenSea } from '../src/analyst/opensea.js';
import { cleanNote, type AnalysisWithThoughts } from '../src/intel/router.js';
import { setup, xMock, msg, MINT } from './a08-helpers.js';
import { withPublisher, triaged } from './a08-publish.js';

const thoughtsOf = (r: { analysis?: unknown }) => r.analysis as AnalysisWithThoughts;
const noSmart = (s: ReturnType<typeof setup>, x: any) => {
  x.followerIds = async () => ['99'];
  s.deps.intel!.enrich.x = x;
  s.deps.intel!.enrich.smart = { handles: new Map([['alpha_a', ''], ['alpha_b', '']]), ids: async () => new Map([['1', 'alpha_a'], ['2', 'alpha_b']]) };
};

describe('R1 collection X in a token post (keep = all dossier X handles)', () => {
  it('the model wrote "$HOOD (@hoodnft)", @hoodnft is the X of the Hood collection → no tag in the token post', async () => {
    const s = setup(); const p = withPublisher(s);
    s.marketExtra.set(MINT, { symbol: 'HOOD' });
    s.nfts.set('hood', parseOpenSea('hood', undefined, { name: 'Hood', contracts: [], twitter_username: 'hoodnft' } as any, {}, 0));
    s.deps.intel!.enrich.x = xMock([], { hoodnft: { followers: 5000 } }) as any;
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: '$HOOD' }, publicNote: 'Watching $HOOD (@hoodnft): fresh pair, volume is picking up.', thesis: 'x',
      projects: [{ ref: MINT, name: '$HOOD', verdict: 'watch', category: 'memecoin', thesis: 'coin' }, { ref: 'hood', name: 'Hood', verdict: 'ignore', category: 'nft', thesis: 'unrelated collection' }] }));
    await p.one({ text: `$HOOD ${MINT} new pair; unrelated: https://opensea.io/collection/hood` });
    expect(p.posted[0]).not.toContain('@hoodnft');
  });
});

describe('R2 handleLike as the only threshold for "discord"', () => {
  it('"Quarry …, h/t @quarrybets" (another account\'s handle starts with the name) → @quarrybets is not set as the X of project Quarry', async () => {
    const s = setup(); const p = withPublisher(s);
    noSmart(s, xMock([], { quarrybets: { followers: 40_000 } }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Quarry' }, publicNote: 'Quarry wants to open pre-IPO private-company shares to more people.', thesis: 'x' }));
    await p.one({ text: 'Quarry opens pre-IPO private-company shares to retail, waitlist is live. h/t @quarrybets' });
    expect(p.posted[0]).not.toContain('@quarrybets');
  });
});

describe('R3 chat batch: a handle from a member of a low-trust chat (score 3) goes as "discord"', () => {
  it('u2 in ServerB/#chat: "follow @fenlamp_real" → the impostor is not tagged without smart followers', async () => {
    const s = triaged(['Fen Lamp']);
    const x: any = { async search() { return []; }, async profile(h: string) { return { handle: h, followers: 300 }; }, async followerIds() { return ['99']; } };
    s.deps.intel!.enrich.x = x;
    s.deps.intel!.enrich.smart = { handles: new Map([['a', ''], ['b', '']]), ids: async () => new Map([['1', 'a'], ['2', 'b']]) };
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.5, project: { name: 'Fen Lamp' }, publicNote: 'Watching Fen Lamp: thin floor.', thesis: 'x' }));
    await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u1', text: 'Fen Lamp looks good' }), s.deps);
    const r = await handleMessage(msg({ sourceServer: 'ServerB', channel: 'chat', author: 'u2', text: 'fen lamp floor up, follow @fenlamp_real' }), s.deps);
    expect(thoughtsOf(r).thought?.note ?? '').not.toContain('@fenlamp_real');
  });
});

describe('R4 "bare" handles after cleanNote', () => {
  it('"(@a, @b)" and "(via @h)" — no bare names in brackets', () => {
    expect(cleanNote('Quarry (@Quarry__app, @QuarryHQ) wants to open pre-IPO shares.', 'Quarry', undefined, [])).not.toMatch(/Quarry__app|QuarryHQ/);
    expect(cleanNote('Quarry (via @Quarry__app) wants to open pre-IPO shares.', 'Quarry', undefined, [])).not.toMatch(/Quarry__app/);
  });
});

describe('R5 (catches mutation H5 "settled is not written")', () => {
  it('X from the OpenSea page, but the account does not exist (notFound) → no tag in the post', async () => {
    const s = setup(); const p = withPublisher(s);
    s.nfts.set('runelings-', parseOpenSea('runelings-', undefined, { name: 'Runelings', contracts: [], twitter_username: 'quillcrafter' } as any, {}, 0));
    noSmart(s, xMock([], { quillcrafter: { notFound: true } }));
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Runelings', category: 'nft' }, publicNote: 'Runelings mints today, the art looks careful.', thesis: 'x' }));
    await p.one({ text: 'Runelings mint today https://opensea.io/collection/runelings-' });
    expect(p.posted[0]).toBe('Runelings mints today, the art looks careful. No position.');
  });
});
