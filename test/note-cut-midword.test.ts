// #69, finisher round 3 (reviewer reproduction on 7c4b9bf — red): a note not about a token, longer than 260 chars → cleanNote cuts t.slice(0, 260) mid-word (router.ts:573);
// publisher (fitText) does not touch it — it fits — and adds a period: a cut-off word goes to X.
// With the finisher's fix (parseVerdict cuts to 280) the path is open for notes longer than 280 too; for 261–280 chars it existed before.
import { describe, it, expect } from 'vitest';
import { triaged, withPublisher } from './a08-publish.js';

const S1 = 'Watching Hood: a new Robinhood Chain collection with a thin floor, few listings and steady mints over the last day, which is more than most launches here get.';
const S2 = 'What would make me act is real secondary volume above mint price and holders who do not flip on the first bump, so far neither is there.';

describe('repro #69: non-token note cut mid-word', () => {
  it('a two-sentence note (≈ 290 chars) → only whole words in the post', async () => {
    const note = `${S1} ${S2}`;
    expect(note.length).toBeGreaterThan(280);                 // before the fix the whole verdict failed; now parseVerdict cuts it to 280
    const s = triaged(['Hood']); const p = withPublisher(s);
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.7, project: { name: 'Hood', category: 'nft' }, publicNote: note, thesis: 'x' }));
    await p.batch(['Hood mint is live', 'hood floor moving']);
    expect(p.posted).toHaveLength(1);
    const body = p.posted[0].replace(/ No position\.$/, '');
    // every word of the post is a whole word of the note (none cut off)
    const words = new Set(note.split(/\s+/).map(w => w.replace(/[.,!?…]+$/, '')));
    for (const w of body.split(/\s+/)) expect(words.has(w.replace(/[.,!?…]+$/, '')), `word «${w}»`).toBe(true);
  });
});

describe('cleanNote: one sentence longer than 260 → cut at a word boundary with «…»', () => {
  it('no torn word, ends with «…», within 260', async () => {
    const { cleanNote } = await import('../src/intel/router.js');
    const long = 'Watching Hood: ' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '.';
    const t = cleanNote(long, 'Hood', undefined, [])!;
    expect(t.length).toBeLessThanOrEqual(260);
    expect(t.endsWith('…')).toBe(true);
    const words = new Set(long.split(' '));
    for (const w of t.slice(0, -1).split(' ')) expect(words.has(w), w).toBe(true);
  });
});
