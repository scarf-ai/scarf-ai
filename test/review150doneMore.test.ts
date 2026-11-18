// Regression (review #150, done-more.test.ts from /tmp/hq/repro-150-a).
import { describe, it, expect } from 'vitest';
import { runSiteSession, type Observation, type SiteDriver, type SiteElement } from '../src/exec/siteSession.js';
import { worstCallUsd, buildPrompt, snapshot, SITE_MODELS, SITE_CALL_LIMITS } from '../src/exec/sitePlanner.js';
const SITE = 'https://tinmoths.xyz/apply';
const VALUES = { xHandle: 'scarf_ai', evmAddress: '0x' + '1'.repeat(40) } as any;
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });
function drv(view: (s: any) => Observation): SiteDriver { const s: any = { filled: {}, clicks: [] };
  return { async open() {}, async close() {}, async observe() { return view(s); }, async fill(id: string, t: string) { s.filled[id] = t; }, async click(id: string) { s.clicks.push(id); } } as any; }
describe('more honest completions', () => {
  it('only agree checkbox + Submit button (no fields)', async () => {
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: drv(s => s.clicks.includes('go') ? { url: SITE, scoped: true, text: 'Application received, thank you!', elements: [] } as any
      : { url: SITE, scoped: true, text: 'Join', elements: [el('a', 'checkbox', 'I agree to the Terms', { checked: s.clicks.includes('a'), form: 'f', required: true }), el('go', 'button', 'Submit', { form: 'f', submit: true })] } as any) });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
  });
  it('no <form> markup (scoped=false): field + «Join» div-button', async () => {
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: drv(s => s.clicks.includes('go') ? { url: SITE, text: "You're on the list!", elements: [] } as any
      : { url: SITE, text: 'Join', elements: [el('x', 'input', 'X username', { inputType: 'text', value: s.filled.x ?? '' }), el('go', 'button', 'Join')] } as any) });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
  });
  it('caps: worst Haiku + worst Sonnet ≤ $0.05 on a max-size page', () => {
    const ctx = { values: VALUES, steps: [], xTasks: [], siteHost: 'tinmoths.xyz' } as any;
    const els = Array.from({ length: 120 }, (_, i) => ({ id: `e${i}`, kind: 'link', label: `0x${'ab'.repeat(19)} Item ${i} https://tinmoths.xyz/p/${i}?ref=${'q'.repeat(20)}` }));
    const o = { url: SITE, text: ('Залог 钱包 0x' + 'cd'.repeat(20) + ' ').repeat(40), elements: els, scoped: true } as any;
    const p = buildPrompt(o, ctx, { code: 'no_next', reason: 'x' } as any, snapshot(o, ctx), 'site_data_abcd1234');
    const h = worstCallUsd(SITE_MODELS.haiku, p, SITE_CALL_LIMITS.haiku.maxRounds, SITE_CALL_LIMITS.haiku.maxTokens);
    const so = worstCallUsd(SITE_MODELS.sonnet, p, SITE_CALL_LIMITS.sonnet.maxRounds, SITE_CALL_LIMITS.sonnet.maxTokens);
    console.log({ h, so, sum: h + so, after7: 7 * h + so });
    expect(h + so).toBeLessThanOrEqual(0.05);
  });
});
