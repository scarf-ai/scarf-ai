// #69, finisher round 2 (reviewer repro on eed2361 — red, here with the correct expectation): main rule F92-2 (acceptance #92, Y1) — "the project was held (act without a stated reason → watch): no note,
// we don't invent a replacement". Input — the main test "a held escalation drops the act-worded public note: no thought" (test/intel.test.ts),
// the only difference in variant A — the model, as the new A-08 prompt says, also gave a note in projects[].publicNote.
import { describe, it, expect } from 'vitest';
import { recheckDue } from '../src/intel/router.js';
import { handleMessage } from '../src/pipeline.js';
import { setup, msg, MINT } from './a08-helpers.js';

const ACT_NOTE = 'Planning to take a small position in $BRIXO now that volume held.';
async function escalate(projectsNote: boolean) {
  const s = setup();
  s.marketExtra.set(MINT, { symbol: 'BRIXO' });
  s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.8, thesis: 'waiting for volume', publicNote: 'Watching $BRIXO, want to see volume hold first.' }));
  const r0 = await handleMessage(msg({ text: `$BRIXO ${MINT} launched` }), s.deps);
  expect(r0.analysis?.thought?.note).toMatch(/Watching \$BRIXO/);
  s.clock.set(s.clock.now() + 61 * 60_000);
  s.setAnalyst(() => ({ verdict: 'act', confidence: 0.8, thesis: 'volume held, entering', publicNote: ACT_NOTE,
    ...(projectsNote ? { project: { name: '$BRIXO' }, projects: [{ ref: MINT, name: '$BRIXO', verdict: 'act', category: 'memecoin', thesis: 'volume held', publicNote: ACT_NOTE }] } : {}),
    intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.8 }] }));
  const callsBefore = s.calls.length;
  const r = await recheckDue(s.deps);
  return { r: r[0], extraModelCalls: s.calls.length - callsBefore - 1 };
}

describe('repro #69: F92-2 (held escalation → no act-worded note, no replacement)', () => {
  it('A: note also in projects[].publicNote — a held project gives no thought with an act note', async () => {
    const { r } = await escalate(true);
    expect(r.analysis?.verdict).toBe('watch');               // the hold worked
    expect(r.decisions).toEqual([]);
    expect(r.analysis?.thought).toBeUndefined();             // main: no thought
  });
  it('B: like the main Y1 test — the note is dropped, no repeat request for a note ("we don\'t invent a replacement")', async () => {
    const { r, extraModelCalls } = await escalate(false);
    expect(r.analysis?.verdict).toBe('watch');
    expect(r.analysis?.thought).toBeUndefined();
    expect(extraModelCalls).toBe(0);
  });
});

// Finisher #69, round 3 (nice-to-have): the held project is found in stabilizeVerdict by name only (ref is not a card key) —
// its projects[].publicNote is dropped by the stabilization itself, without relying on a mark in the thought plan
describe('F92-2: stabilizeVerdict drops the per-project note of a project held by name', () => {
  it('ref is not a card key, name matches the card → verdict kept, its publicNote removed; another project keeps its note', async () => {
    const { stabilizeVerdict } = await import('../src/intel/router.js');
    const { parseVerdict } = await import('../src/analyst/analyst.js');
    const s = setup();
    s.marketExtra.set(MINT, { symbol: 'BRIXO' });
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.8, thesis: 'waiting for volume', publicNote: 'Watching $BRIXO, want to see volume hold first.' }));
    await handleMessage(msg({ text: `$BRIXO ${MINT} launched` }), s.deps);
    s.clock.set(s.clock.now() + 61 * 60_000);
    const v = parseVerdict({ verdict: 'watch', confidence: 0.8, thesis: 't', project: { name: 'Other' },
      projects: [{ ref: 'not-a-key', name: '$BRIXO', verdict: 'act', thesis: 'volume held', publicNote: ACT_NOTE },
        { ref: 'other', name: 'Other', verdict: 'watch', thesis: 'x', publicNote: 'Watching Other: early, nothing to act on yet.' }] }).verdict!;
    const notes = stabilizeVerdict(s.deps, v, [1]);
    expect(notes[0]).toMatch(/^\$BRIXO: kept watch/);
    expect(v.projects[0]).toMatchObject({ verdict: 'watch' });
    expect(v.projects[0].publicNote).toBeUndefined();
    expect(v.projects[1].publicNote).toBe('Watching Other: early, nothing to act on yet.');
  });
});
