// #69, finisher round 2 (reviewer reproduction on eed2361 — red): projects[].publicNote longer than 280 chars (the field in the tool schema has neither maxLength nor a char count in the description)
// → zod rejects the WHOLE verdict: exits, actions and project verdicts are lost; parseVerdict cuts thesis/risks/summary
// precisely "so that model junk does not break the whole verdict", but does not cut the new field.
import { describe, it, expect } from 'vitest';
import { parseVerdict } from '../src/analyst/analyst.js';

const MINT = '2qw313mavnLCGnz9L2GAsDvEvwJdWCuLyxv3vtM7pump';
const raw = (note: string) => ({ verdict: 'watch', thesis: 't', confidence: 0.7, publicNote: 'Watching $AAA: volume is real.',
  exits: [{ token: MINT, reason: 'dev sold everything' }],
  projects: [{ ref: MINT, verdict: 'avoid', thesis: 'dev dumped' }, { ref: 'bbb', name: 'BBB', verdict: 'watch', thesis: 'x', publicNote: note }] });

describe('repro #69: per-project publicNote length', () => {
  it('a 281-char note of the second project must not cost the exit on the first', () => {
    expect(parseVerdict(raw('x'.repeat(280))).verdict?.exits).toHaveLength(1);
    const p = parseVerdict(raw('Watching BBB. ' + 'y'.repeat(267)));
    expect(p.error).toBeUndefined();                          // on eed2361: "projects.1.publicNote: String must contain at most 280 character(s)"
    expect(p.verdict?.exits).toHaveLength(1);
    expect(p.verdict?.projects[1].publicNote).toHaveLength(280);
  });
  it('a top-level publicNote longer than 280 chars is cut the same way, the verdict with the exit is intact', () => {
    const p = parseVerdict({ ...raw('ok'), publicNote: 'Watching $AAA. ' + 'z'.repeat(300) });
    expect(p.error).toBeUndefined();
    expect(p.verdict?.publicNote).toHaveLength(280);
    expect(p.verdict?.exits).toHaveLength(1);
  });
});
