// Regression (reviewer A, /tmp/hq/repro-150-a/done-honest.test.ts). Review of the #150 fixes: the rules' "done" after submitHistory/freshSuccess — honest completions are not lost. Green = fine.
import { describe, it, expect } from 'vitest';
import { runSiteSession, type Observation, type SiteDriver, type SiteElement } from '../src/exec/siteSession.js';
const SITE = 'https://tinmoths.xyz/apply';
const VALUES = { xHandle: 'scarf_ai', evmAddress: '0x' + '1'.repeat(40) } as any;
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });
type S = { filled: Record<string, string>; clicks: string[] };
function drv(view: (s: S) => Observation): SiteDriver {
  const s: S = { filled: {}, clicks: [] };
  return { async open() {}, async observe() { return view(s); }, async fill(id: string, t: string) { s.filled[id] = t; }, async click(id: string) { s.clicks.push(id); }, async close() {} } as any;
}
const pg = (elements: SiteElement[], text: string, url = SITE): Observation => ({ url, text, elements, scoped: true } as any);
const F = (s: S, form = 'f') => [el('x', 'input', 'X username', { inputType: 'text', value: s.filled.x ?? '', form, required: true }), el('go', 'button', 'Submit', { form, submit: true })];

describe('honest completions', () => {
  it('one page form, same url, success text replaces form', async () => {
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: drv(s => s.clicks.includes('go') ? pg([], 'Apply — Thank you! Application received.') : pg(F(s), 'Apply')) });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
  });
  it('multi-step: Continue → wallet → Submit → success on new url', async () => {
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: drv(s => {
      if (s.clicks.includes('go2')) return pg([], "You're on the waitlist! See you soon.", `${SITE}/done`);
      if (s.clicks.includes('go1')) return pg([el('w', 'input', 'Wallet address', { inputType: 'text', value: s.filled.w ?? '', form: 'g', required: true }), el('go2', 'button', 'Submit', { form: 'g', submit: true })], 'Step 2', `${SITE}/2`);
      return pg([el('x', 'input', 'X username', { inputType: 'text', value: s.filled.x ?? '', form: 'f', required: true }), el('go1', 'button', 'Continue', { form: 'f' })], 'Step 1');
    }) });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
  });
  it('SPA: form stays in DOM, success in a modal (same url), form fields still present', async () => {
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: drv(s => s.clicks.includes('go') ? pg([...F(s), el('ok', 'button', 'Close')], 'Apply\nSuccessfully registered! We have received your application.') : pg(F(s), 'Apply')) });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
  });
  it('page shows "Thank you for visiting" before anything; after Submit → "Thanks for joining" → done (new phrase)', async () => {
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: drv(s => s.clicks.includes('go') ? pg([], 'Thank you for visiting. Thanks for joining the waitlist!') : pg(F(s), 'Thank you for visiting. Apply')) });
    console.log(r.status, r.reason, r.confirmation);
    expect(r.status).toBe('done');
  });
});
