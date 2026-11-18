// Review #150 regression, round 3 (moved from /tmp/hq/repro-150-b/r150c.test.ts). Repeat review #150 (hq/E-06-2b-fixes, fec5afa). Red = the defect is present.
import { describe, it, expect } from 'vitest';
import { parseChoice, snapshot, buildPrompt, hybridPlanner } from '../src/exec/sitePlanner.js';
import { formPlanner, runSiteSession, isMoney, normObservation, type Observation, type SiteDriver } from '../src/exec/siteSession.js';

const VALUES = { xHandle: 'scarf_ai', evmAddress: '0x1234567890abcdef1234567890abcdef12345678', solAddress: '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump' };
const ctx = (over: any = {}) => ({ values: VALUES, steps: [], xTasks: [], siteHost: 'task.example', ...over }) as any;

describe('V1: a "money" word with a combining mark or a homoglyph outside the table — the code lets the model click through', () => {
  for (const label of ['Ap̵prove USDC', 'Mi̇nt now', 'Mınt now' /* ı U+0131 */, 'Apprօve' /* Armenian օ U+0585 */, 'Clai̲m reward', 'Bu̶y $SCARF']) {
    it(label, () => {
      const o = normObservation({ url: 'https://task.example/', text: 'Join', elements: [{ id: 'e1', kind: 'button', label }] } as any);
      expect(isMoney(o.elements[0].label)).toBe(true);                               // red: false
      expect(parseChoice({ action: 'click', id: 'e1', why: 'x' }, o, ctx()).ok).toBe(false);
    });
  }
});

describe('V2: a truncated address with other separators goes to the model', () => {
  for (const shown of ['0x1234—5678', '0x1234–5678', '0x1234 ... 5678', '0x1234⋯5678', '0x12…678', '77Hq…pump', '0X1234…5678']) {
    it(shown, () => {
      const o: Observation = { url: 'https://task.example/', text: `Connected: ${shown}`, elements: [{ id: 'e1', kind: 'button', label: shown }] } as any;
      const user = buildPrompt(o, ctx(), { code: 'no_next', reason: 'x' }, snapshot(o, ctx()), 'site_data_x').user;
      expect(user).not.toContain(shown);                                             // red where it is not cut out
    });
  }
});

describe('V3: "done" after pressing a carousel "Next" without a form — the success phrase appeared without a submit', () => {
  it('carousel slide 2: "Thanks for joining our community!"', async () => {
    let step = 0;
    const page = (n: number): Observation => ({ url: 'https://task.example/', scoped: true,
      text: n === 0 ? 'Join our waitlist. Slide 1: fast and fun.' : 'Join our waitlist. Slide 2: Thanks for joining our community of 10k builders!',
      elements: [{ id: 'e1', kind: 'button', label: 'Next' }, { id: 'e2', kind: 'input', label: 'Favourite colour', inputType: 'text', required: true, form: 'g1' }, { id: 'e3', kind: 'button', label: 'Enviar', submit: true, form: 'g1' }] } as any);
    const driver: SiteDriver = { async open() {}, async close() {}, async fill() {}, async click() { step++; }, async select() {}, async observe() { return page(step); } } as any;
    // the model: first "Next" (carousel), then done on the phrase from slide 2
    let k = 0;
    const pick = async () => ({ input: k++ === 0 ? { action: 'click', id: 'e1', why: 'next' } : { action: 'done', quote: 'Thanks for joining our community', why: 'ok' }, usd: 0.0005 });
    const r = await runSiteSession({ url: 'https://task.example/', driver, planner: hybridPlanner(formPlanner, pick), values: VALUES });
    expect(r.status).not.toBe('done');                                               // red: done, the form with a required field was not submitted
  });
});

describe('V4: two list options identical after normalization — the driver picks the last one', () => {
  it('"Ethereum" and "Ethe​reum" → the normalized→raw map keeps one', () => {
    const raw = ['Ethereum', 'Ethe​reum'];
    const m = new Map(raw.map(x => [normObservation({ url: '', text: '', elements: [{ id: 'x', kind: 'select', label: '', options: [x] }] } as any).elements[0].options![0], x]));
    expect(m.size).toBe(2);                                                          // red: 1 — two different options are indistinguishable
  });
});
