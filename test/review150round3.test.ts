// Review #150, round 3: V3 — form submit and "done" (rules and model), V1 — combining marks and homoglyphs, V2 — truncated address
// separators, V4 — ambiguous list options, token estimate.
import { describe, it, expect } from 'vitest';
import { formPlanner, runSiteSession, submitHistory, formStillOpen, type Observation, type PlannerContext, type SiteDriver, type SiteElement } from '../src/exec/siteSession.js';
import { hybridPlanner, parseChoice, type ModelPick } from '../src/exec/sitePlanner.js';

const SITE = 'https://task.example/apply';
const VALUES = { xHandle: 'scarf_ai', evmAddress: '0x1234567890abcdef1234567890abcdef12345678' };
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });
const page = (elements: SiteElement[], text = 'Apply'): Observation => ({ url: SITE, text, elements, scoped: true });
const ctx = (o: Partial<PlannerContext> = {}): PlannerContext => ({ values: VALUES, steps: [], xTasks: [], siteHost: 'task.example', ...o });
const step = (n: number, action: any, label = '') => ({ n, url: SITE, action, label });

describe('V3: what counts as a form submit', () => {
  const form = (o: Partial<SiteElement> = {}) => [el('x', 'input', 'X username', { value: '', form: 'f', required: true }), el('go', 'button', 'Continue', { form: 'f', ...o })];
  it('"Next" outside a form — not a submit; "Continue" of a form with input — a submit; submit — always; the cookie button "Confirm choices" — never', () => {
    const p1 = page([el('n', 'button', 'Next'), ...form()]);
    expect(submitHistory(ctx({ steps: [step(1, { kind: 'click', el: 'n' }, 'Next')], pages: new Map([[1, p1]]) })).submitted).toBe(false);
    // "Continue" of a form without input in it — not a submit either
    expect(submitHistory(ctx({ steps: [step(1, { kind: 'click', el: 'go' }, 'Continue')], pages: new Map([[1, p1]]) })).submitted).toBe(false);
    const filled = ctx({ steps: [step(1, { kind: 'fill', el: 'x', value: 'x_handle' }, 'X username'), step(2, { kind: 'click', el: 'go' }, 'Continue')], pages: new Map([[1, p1], [2, p1]]) });
    expect(submitHistory(filled)).toMatchObject({ submitted: true, form: 'f' });
    const p2 = page([el('s', 'button', 'Go!', { submit: true })]);
    expect(submitHistory(ctx({ steps: [step(1, { kind: 'click', el: 's' }, 'Go!')], pages: new Map([[1, p2]]) })).submitted).toBe(true);
    const p3 = page([el('c', 'button', 'Confirm choices', { cookie: true, submit: true, form: 'f' })]);
    const cookieCtx = ctx({ steps: [step(1, { kind: 'fill', el: 'x', value: 'x_handle' }), step(2, { kind: 'click', el: 'c' }, 'Confirm choices')], pages: new Map([[1, p1], [2, p3]]) });
    expect(submitHistory(cookieCtx).submitted).toBe(false);
  });

  it('a form with an empty required field the session did not enter is still on the page — "done" is not counted for the rules or the model', () => {
    // round 4: a field entered by the session and empty after the submit — a reset after success (see review150reset); a field the session did not enter makes it open
    const open = page([...form(), el('m', 'input', 'Favourite colour', { value: '', form: 'f', required: true })], 'Thanks for joining!');
    expect(formStillOpen(open, 'f')).toBe(true);
    expect(formStillOpen(page([el('x', 'input', 'X username', { value: 'scarf_ai', form: 'f', required: true })]), 'f')).toBe(false);
    const prev = page([...form()], 'Apply');
    const c = ctx({ steps: [step(1, { kind: 'fill', el: 'x', value: 'x_handle' }), step(2, { kind: 'click', el: 'go' }, 'Continue')], pages: new Map([[1, prev], [2, prev]]) });
    expect(formPlanner.next(open, c)).not.toMatchObject({ kind: 'done' });
    expect(parseChoice({ action: 'done', quote: 'Thanks for joining', why: 'x' }, open, c, { submitted: true, before: ['Apply'], form: 'f' }))
      .toMatchObject({ ok: false, reason: 'done: a form on the page still has an empty required field "Favourite colour" that the session did not fill' });
    const gone = page([], 'Thanks for joining!');
    expect(formPlanner.next(gone, c)).toMatchObject({ kind: 'done' });
  });

  it('session: the model presses the carousel "Next" and says done on a phrase from the slide — not done', async () => {
    let slide = 0;
    const driver: SiteDriver = { async open() {}, async close() {}, async fill() {}, async click() { slide++; },
      async observe() { return page([el('n', 'button', 'Next'), el('m', 'input', 'Favourite colour', { value: '', form: 'g1', required: true }), el('s', 'button', 'Enviar', { submit: true, form: 'g1' })],
        slide ? 'Slide 2: Thanks for joining our community!' : 'Slide 1'); } };
    let k = 0;
    const pick: ModelPick = async () => ({ input: k++ === 0 ? { action: 'click', id: 'n', why: 'x' } : { action: 'done', quote: 'Thanks for joining our community', why: 'x' }, usd: 0.0005 });
    const r = await runSiteSession({ url: SITE, driver, values: VALUES, planner: hybridPlanner(formPlanner, pick) });
    expect(r.status).not.toBe('done');
  });
});

describe('V1: combining marks, homoglyphs outside the table, mixed script', () => {
  it('"money" is recognized: marks, ı, Armenian օ, small capitals, Cyrillic inside a word', async () => {
    const { isMoney, walletStep, mixedScript, checkForms } = await import('../src/exec/siteSession.js');
    for (const l of ['Ap̵prove USDC', 'Mi̇nt now', 'Mınt now', 'Apprօve', 'Clai̲m reward', 'Bu̶y $SCARF', 'ᴍɪɴᴛ', 'Swɑp', 'Сlaim', 'Purchasé'])
      expect([l, isMoney(l)]).toEqual([l, true]);
    // mixed script without a money word — suspicious too (the safe side): "Continue" with a Cyrillic C
    expect(mixedScript('Сontinue')).toBe(true); expect(isMoney('Сontinue')).toBe(true);
    expect(walletStep('Connect wallet and sw̶ap')).toBe(false);
    expect(checkForms('Ap̵prove')).toContain('Approve');
  });

  it('ordinary labels in European languages, Vietnamese, Turkish, Russian, Japanese — not "money" and not mixed script', async () => {
    const { isMoney, mixedScript, formPlanner: fp } = await import('../src/exec/siteSession.js');
    for (const l of ['Weiter zur Straße', 'Łódź meetup', 'Đăng ký ngay', 'Kayıt ol', 'Inscripción', 'Continuer', 'Далее', '次へ', 'Siguiente', 'Café Society', 'Ørsted list', 'Æon club', 'Join X (Twitter)'])
      expect([l, isMoney(l), mixedScript(l)]).toEqual([l, false, false]);
    // the form button "Đăng ký" is pressed by the rules as "next"
    const o = page([el('x', 'input', 'X username', { value: 'scarf_ai', form: 'g' }), el('s', 'button', 'Đăng ký', { submit: true, form: 'g' })]);
    expect(fp.next(o, ctx())).toMatchObject({ kind: 'click', el: 's' });
  });
});

describe('V2: separators and a short prefix of a truncated address', () => {
  it('"0x12…678", "77Hq...pump", "0x1234 — 5678", "0x1234⋯5678", "0X1234·5678" → [agent …]; a foreign address is not touched', async () => {
    const { snapshot, buildPrompt } = await import('../src/exec/sitePlanner.js');
    const V = { ...VALUES, solAddress: '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump' };
    const c = ctx({ values: V });
    const o = page([el('a', 'button', '0x12…678')], 'Wallets: 77Hq...pump | 0x1234 — 5678 | 0x1234⋯5678 | 0X1234·5678 | other 0xabcd…ef01');
    const user = buildPrompt(o, c, { code: 'no_next', reason: 'x' }, snapshot(o, c), 'site_data_x').user;
    expect(user).not.toMatch(/0x12\.\.\.678|77Hq\.\.\.pump|0x1234 — 5678|0x1234⋯5678|0X1234·5678/i);
    expect(user.match(/\[agent (evm|sol)_address\]/g)?.length).toBe(5);
    expect(user).toContain('0xabcd...ef01');
  });
});

describe('token estimate for the worst price: 2.5 chars per token and +600 tokens of the tool system prompt per round', () => {
  it('the price difference for 2500 Latin request chars = 1000 tokens; the system 600 tokens — in every round', async () => {
    const { worstCallUsd, TOOL_SYSTEM_TOKENS } = await import('../src/exec/sitePlanner.js');
    const { PRICES } = await import('../src/llm/budget.js');
    const m = 'claude-sonnet-5-5', p = PRICES[m];
    const inPrice = Math.max(p.input, p.cacheWrite), fixedPrice = Math.max(p.input, p.cacheWrite1h ?? p.input * 2);
    const base = worstCallUsd(m, { system: '', user: '' }, 1, 100), big = worstCallUsd(m, { system: '', user: 'a'.repeat(2500) }, 1, 100);
    expect(big - base).toBeCloseTo(1000 * inPrice / 1e6, 12);
    expect(TOOL_SYSTEM_TOKENS).toBe(600);
    const two = worstCallUsd(m, { system: '', user: '' }, 2, 100);
    expect(two - 2 * base).toBeCloseTo(150 * inPrice / 1e6, 12);            // round 2: + the answer of round 1 (100) and 50 system tokens
    expect(base).toBeGreaterThan((600 * fixedPrice + 100 * p.output) / 1e6);  // the system prompt is accounted for
  });
});
