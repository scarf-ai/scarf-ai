// Regression (review #150, done-reset.test.ts from /tmp/hq/repro-150-a) and a single "done" model (HQ, 2026-11-17):
// after success the form is cleared and stays on the page (a pop-up "thank you"). The session does not fill or submit a submitted form
// a second time; no new success phrase — a submitted_unconfirmed stop without the model.
import { describe, it, expect } from 'vitest';
import { runSiteSession, type Observation, type SiteDriver, type SiteElement } from '../src/exec/siteSession.js';
import { hybridPlanner, type ModelPick } from '../src/exec/sitePlanner.js';
import { formPlanner } from '../src/exec/siteSession.js';
const SITE = 'https://tinmoths.xyz/apply';
const VALUES = { xHandle: 'scarf_ai', evmAddress: '0x' + '1'.repeat(40) } as any;
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });

/** An application form that is cleared after submitting. toast — for how many observations after the submit the "thank you" is visible (Infinity — always). ids — whether element ids change. */
function resetSite(o: { toast: number; ids?: boolean; keepValue?: boolean }) {
  const s = { v: '', submits: 0, fills: 0, toast: 0, obs: 0 };
  const id = (x: string) => (o.ids ? `${x}${s.obs}` : x);
  const driver: SiteDriver = { async open() {}, async close() {},
    async observe(): Promise<Observation> { s.obs++; const t = s.toast > 0; if (s.toast > 0) s.toast--; return { url: SITE, scoped: true, text: `Apply${t ? "\nYou're on the waitlist!" : ''}`,
      elements: [el(id('x'), 'input', 'X username', { inputType: 'text', value: s.v, form: 'f', required: true }), el(id('go'), 'button', 'Join waitlist', { form: 'f', submit: true })] }; },
    async fill(_id: string, t: string) { s.fills++; s.v = t; }, async click(c: string) { if (c.startsWith('go')) { s.submits++; if (!o.keepValue) s.v = ''; s.toast = o.toast; } } } as any;
  return { s, driver };
}

describe('reset form + toast', () => {
  it('fill → Submit → same form, fields empty again, toast «You are on the waitlist!» → done, one submission, one fill', async () => {
    const { s, driver } = resetSite({ toast: Infinity });
    const r = await runSiteSession({ url: SITE, values: VALUES, driver });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(r.confirmation).toMatch(/You're on the waitlist!/);
    expect([s.submits, s.fills]).toEqual([1, 1]);
  });

  it('same, but the toast disappears after one observation → done on that observation, no second submission', async () => {
    const { s, driver } = resetSite({ toast: 1 });
    const r = await runSiteSession({ url: SITE, values: VALUES, driver });
    expect(r.status).toBe('done');
    expect([s.submits, s.fills]).toEqual([1, 1]);
  });

  it('"thank you" disappeared before the next observation → submits 1, not done, code submitted_unconfirmed, the model is not called', async () => {
    for (const ids of [false, true]) {
      const { s, driver } = resetSite({ toast: 0, ids });
      let calls = 0;
      const pick: ModelPick = async () => { calls++; return { input: { action: 'done', quote: "You're on the waitlist!", why: 'x' }, usd: 0.0005 }; };
      const r = await runSiteSession({ url: SITE, values: VALUES, driver, planner: hybridPlanner(formPlanner, pick) });
      expect([ids, s.submits, s.fills, r.status, r.code, calls]).toEqual([ids, 1, 1, 'stopped', 'submitted_unconfirmed', 0]);
      expect(r.reason).toMatch(/the form was sent, but no confirmation is visible/);
    }
  });

  it('open form: a field is recognized by form and label (ids change); entered but not submitted — open; header, search and "money" — not forms in play', async () => {
    const { openFields, resubmitRefusal } = await import('../src/exec/siteSession.js');
    const { parseChoice } = await import('../src/exec/sitePlanner.js');
    const pg = (ids: string, elements: SiteElement[], text = 'Apply'): Observation => ({ url: SITE, scoped: true, text, elements: elements.map(e => ({ ...e, id: e.id + ids })) });
    const F = (v = '') => [el('x', 'input', 'X username', { value: v, form: 'f', required: true }), el('go', 'button', 'Join', { form: 'f', submit: true })];
    const p1 = pg('1', F()), p2 = pg('2', F('scarf_ai'));
    const st = (n: number, action: any, label: string) => ({ n, url: SITE, action, label });
    const filled = { values: VALUES, steps: [st(1, { kind: 'fill', el: 'x1', value: 'x_handle' }, 'X username')], xTasks: [], pages: new Map([[1, p1]]) } as any;
    const sent = { ...filled, steps: [...filled.steps, st(2, { kind: 'click', el: 'go2' }, 'Join')], pages: new Map([[1, p1], [2, p2]]) };
    const after = pg('3', F(), "You're in!");
    expect(openFields(after, filled)).toEqual(['X username']);   // entered, the form not submitted — the field is open
    expect(openFields(after, sent)).toEqual([]);                 // entered and submitted, empty again — a reset after success
    // a field the session did not enter, in the header form, the search form and the "Buy" form — not open forms
    const extra = pg('3', [...F(), el('h', 'input', 'Newsletter', { form: 'h', required: true, chrome: true }), el('hb', 'button', 'Subscribe', { form: 'h', submit: true, chrome: true }),
      el('q', 'input', 'Search', { form: 's', required: true, inputType: 'search' }), el('qb', 'button', 'Go', { form: 's', submit: true }),
      el('a', 'input', 'Amount', { form: 'm', required: true }), el('ab', 'button', 'Buy now', { form: 'm', submit: true })]);
    expect(openFields(extra, sent)).toEqual([]);
    // input into a field of a submitted form and a second submit with the same button without new input — refused (for the model too)
    expect(resubmitRefusal({ kind: 'fill', el: 'x3', value: 'x_handle' }, after, sent)).toMatch(/already sent/);
    expect(resubmitRefusal({ kind: 'click', el: 'go3' }, pg('3', F('scarf_ai')), sent)).toMatch(/does not send it twice/);
    expect(resubmitRefusal({ kind: 'click', el: 'go3' }, pg('3', F('scarf_ai')), filled)).toBeUndefined();
    expect(parseChoice({ action: 'fill', id: 'x3', value: 'x_handle', why: 'x' }, after, { ...sent, siteHost: 'tinmoths.xyz' })).toMatchObject({ ok: false, reason: expect.stringMatching(/already sent/) });
  });

  it('the session loop itself refuses any planner input into a submitted form', async () => {
    const { s, driver } = resetSite({ toast: 0 });
    const naive = { next: (o: Observation) => (o.elements[0].value ? { kind: 'click' as const, el: o.elements[1].id } : { kind: 'fill' as const, el: o.elements[0].id, value: 'x_handle' as const }) };
    const r = await runSiteSession({ url: SITE, values: VALUES, driver, planner: naive });
    expect([s.submits, s.fills, r.status]).toEqual([1, 1, 'stopped']);
    expect(r.reason).toMatch(/^refused: the form was already sent/);
  });

  it('"the wallet signed, nothing more to press" — not done while the page has an open form', () => {
    const o: Observation = { url: SITE, scoped: true, text: 'Verified', elements: [el('m', 'input', 'Favourite colour', { value: '', form: 'f', required: true, covered: true }),
      el('go', 'button', 'Submit', { form: 'f', submit: true, disabled: true })] };
    const c = { values: VALUES, steps: [], xTasks: [], wallet: { evm: true, sol: false, connected: true, signed: 1 } } as any;
    expect(formPlanner.next(o, c)).not.toMatchObject({ kind: 'done' });
    expect(formPlanner.next({ ...o, elements: [] }, c)).toMatchObject({ kind: 'done' });
  });

  it('the form stayed filled after the submit and there is no "thank you" → a second submit with the same button is not made', async () => {
    const { s, driver } = resetSite({ toast: 0, keepValue: true });
    const r = await runSiteSession({ url: SITE, values: VALUES, driver });
    expect([s.submits, s.fills, r.status, r.code]).toEqual([1, 1, 'stopped', 'submitted_unconfirmed']);
  });
});
