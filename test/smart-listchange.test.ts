// Acceptance #57, round 3: an edit of the smart list CSV — the old map is served while the new list warms up;
// coverage() must be computed for the current list, otherwise "no smart followers" goes out as a final conclusion.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xResearch } from '../src/analyst/xresearch.js';
import { smartAccounts } from '../src/analyst/smart.js';
import { Store } from '../src/store/db.js';
import type { XProvider } from '../src/analyst/enrich.js';

const names = Array.from({ length: 10 }, (_, i) => 'smart' + i);

async function setup(followerIds: string[]) {
  const csv = join(mkdtempSync(join(tmpdir(), 'smart-')), 'smart-accounts.csv');
  writeFileSync(csv, names.map(n => `${n},note`).join('\n'));
  const state = { block: false }; const never = new Promise<never>(() => {});
  const x: XProvider = {
    async profile(h) { return { handle: h, id: 'pid_' + h, followers: 3000, ageDays: 300 }; },
    async search() { return []; }, async timeline() { return []; },
    async followers() { return [{ handle: 'nobody', followers: 3 }]; },
    async followerIds() { return followerIds; },
    async ids(hs) { if (state.block) await never; return new Map(hs.map(h => ['id_' + h, h] as [string, string])); },
  };
  const clock = { t: 0 };
  const smart = smartAccounts(csv, x, new Store(':memory:'), () => clock.t);
  await smart.ids!(); await smart.whenWarm!();
  expect((await smart.ids!())?.size).toBe(10);
  // The owner edits the list; warming up the new one is slow (free tier, background lane) — here it never finishes
  const edit = (list: string[]) => {
    state.block = true; clock.t += 60_000;
    writeFileSync(csv, list.map(n => `${n},note`).join('\n'));
    utimesSync(csv, new Date(), new Date(Date.now() + 5000));
  };
  return { x, smart, clock, edit };
}

describe('smart list edited while the old ID map is still cached (#57 review round 3)', () => {
  it('one handle swapped (smart9 -> newguy, who follows the project): reported as partial, not "no smart followers"', async () => {
    const { x, smart, clock, edit } = await setup(['id_newguy']);
    edit([...names.slice(0, 9), 'newguy']);
    expect(smart.coverage!()).toEqual({ resolved: 9, total: 10 });
    const p = await xResearch({ handle: 'proj' }, x, clock.t, smart);
    expect(p.followers!.smart).toEqual([]);
    expect(p.unchecked.some(u => /smart-ID check partial: 1 of 10/.test(u))).toBe(true);
  });

  it('handles of the current list that are in the old cache are still matched', async () => {
    const { x, smart, clock, edit } = await setup(['id_smart3']);
    edit([...names.slice(0, 9), 'newguy']);
    const p = await xResearch({ handle: 'proj' }, x, clock.t, smart);
    expect(p.followers!.smart.map(s => s.handle.toLowerCase())).toContain('smart3');
    expect(p.unchecked.some(u => /smart-ID check partial/.test(u))).toBe(true);
  });

  it('list shrinks by one handle and the rest are resolved: not reported as partial', async () => {
    const { x, smart, clock, edit } = await setup(['id_other']);
    edit(names.slice(0, 9));
    expect(smart.coverage!()).toEqual({ resolved: 9, total: 9 });
    const p = await xResearch({ handle: 'proj' }, x, clock.t, smart);
    expect(p.unchecked.some(u => /smart/i.test(u))).toBe(false);
  });
});
