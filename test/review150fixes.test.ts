// PR #150 fixes (E-06 part 2b, #148) after two reviews: B1 label normalization and money words, B2 truncated addresses, B3 the model's "done",
// O1 the worst call price before the call, X tasks without the model, "Connect" without a wallet, email in other languages.
import { describe, it, expect } from 'vitest';
import { formPlanner, isMoney, normLabel, normObservation, refuseAction, fieldWants, walletStep, runSiteSession,
  type Observation, type PlannerContext, type SiteDriver, type SiteElement } from '../src/exec/siteSession.js';
import { hybridPlanner, parseChoice, snapshot, buildPrompt, worstCallUsd, SITE_SYSTEM, SITE_MODELS, SITE_CALL_LIMITS, type ModelPick, type PickPrompt } from '../src/exec/sitePlanner.js';

const SITE = 'https://task.example/apply';
const VALUES = { xHandle: 'scarf_ai', evmAddress: '0x1234567890abcdef1234567890abcdef12345678', solAddress: '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump' };
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });
const page = (elements: SiteElement[], text = 'Apply'): Observation => ({ url: SITE, text, elements, scoped: true });
const ctx = (o: Partial<PlannerContext> = {}): PlannerContext => ({ values: VALUES, steps: [], xTasks: [], siteHost: 'task.example', ...o });
const ZW = '​', RLO = '‮', SHY = '­', WJ = '⁠', BOM = '﻿';

describe('B1: label normalization', () => {
  it('NFKC, invisible and bidi characters removed, spaces collapsed', () => {
    expect(normLabel(`Ap${ZW}pr${SHY}ove${WJ}  ${BOM}USDC${RLO}\n`)).toBe('Approve USDC');
    expect(normLabel('ＡＰＰＲＯＶＥ')).toBe('APPROVE');                      // full-width
    expect(normLabel('𝐁𝐮𝐲 now')).toBe('Buy now');                             // "mathematical" bold
  });

  it('isMoney sees money through invisible characters, bidi, full-width letters and Cyrillic / Greek homoglyphs', () => {
    for (const l of [`Ap${ZW}prove`, `Mi${SHY}nt now`, `Wallet${ZW}Connect`, `Bu${WJ}y $SCARF`, `Cl${RLO}aim`, 'ＢＵＹ', 'Аpprove', 'Сlaim', 'Мint', 'Swаp', 'Βuy', 'Ѕtake'])
      expect([l, isMoney(l)]).toEqual([l, true]);
    // Russian money words are still caught (homoglyph folding is only an extra check)
    expect(isMoney('Купить место')).toBe(true);
    for (const l of ['Continue', 'Отправить', 'Enviar', 'Believe in us', 'Mua thêm thông tin?'.replace('Mua', 'Xem'), 'Submit application', 'Weiter', 'Suivant'])
      expect([l, isMoney(l)]).toEqual([l, false]);
  });

  it('money words de / fr / it / ja / vi / id', () => {
    for (const l of ['Jetzt kaufen', 'Einzahlung', 'Bezahlen', 'Acheter maintenant', 'Dépôt', 'Réclamer', 'Acquista ora', 'Preleva', 'Conia NFT', '購入する', '入金', 'ミント',
      'Mua ngay', 'Nạp tiền', 'Thanh toán', 'Beli sekarang', 'Bayar', 'Klaim hadiah', 'Swap', 'Bridge', 'Stake', 'Deposit', 'Claim with fee'])
      expect([l, isMoney(l)]).toEqual([l, true]);
  });

  it('walletStep does not let "money" with an invisible character through; a secret field with an invisible character is secret', () => {
    expect(walletStep(`Connect wallet and ap${ZW}prove`)).toBe(false);
    expect(walletStep('Connect wallet')).toBe(true);
    expect(fieldWants(el('p', 'input', `Pass${ZW}word`))).toBe('unsupported');
    expect(fieldWants(el('p', 'input', 'Ѕeed phrase'))).toBe('unsupported');
    const o = page([el('p', 'input', `Pass${ZW}word`)]);
    expect(refuseAction({ kind: 'fill', el: 'p', value: 'x_handle' }, o, 'task.example', VALUES)).toMatch(/secret field/);
  });

  it('the "form submit button" branch is not weakened: a submit without a "next" word is pressed, a submit "about money" is not', () => {
    const go = page([el('x', 'input', 'X username', { value: 'scarf_ai', form: 'g1' }), el('s', 'button', 'Go!', { submit: true, form: 'g1' })]);
    expect(formPlanner.next(go, ctx())).toMatchObject({ kind: 'click', el: 's' });
    const trap = page([el('x', 'input', 'X username', { value: 'scarf_ai', form: 'g1' }), el('s', 'button', `Ap${ZW}prove`, { submit: true, form: 'g1' })]);
    expect(formPlanner.next(trap, ctx())).not.toMatchObject({ kind: 'click', el: 's' });
  });

  it('the session loop normalizes the driver observation: the rules and refuseAction see the same text as the model', async () => {
    const o = normObservation(page([el('a', 'button', `Mi${ZW}nt`, { options: [`Ba${ZW}se`], group: `Ne${RLO}twork` })], `Join${ZW}  now`));
    expect([o.text, o.elements[0].label, o.elements[0].options, o.elements[0].group]).toEqual(['Join now', 'Mint', ['Base (normalized)'], 'Network']); // V4: the option with an invisible character is marked
    const clicks: string[] = [];
    const driver: SiteDriver = { async open() {}, async close() {}, async fill() {}, async click(id) { clicks.push(id); },
      async observe() { return page([el('x', 'input', 'X username', { value: 'scarf_ai', form: 'g1' }), el('s', 'button', `Bu${ZW}y`, { submit: true, form: 'g1' })]); } };
    const r = await runSiteSession({ url: SITE, driver, values: VALUES });
    expect(clicks).toEqual([]); expect(r.status).toBe('stopped');
    expect(r.reason).toMatch(/next step is "Buy"/);
  });
});

describe('B2: truncated agent addresses and the group field', () => {
  it('"0x1234…5678", "0x123456...5678", "77Hqxi…pump" are cut from labels, groups and text; a foreign address with a different start — not', () => {
    const o = page([el('a', 'button', '0x1234…5678'), el('r', 'radio', 'EVM', { group: `Wallet ${VALUES.evmAddress}` }), el('q', 'radio', 'SOL', { group: 'Pay to 77Hqxi...pump' })],
      'Connected: 0x123456...5678 and 77Hqxi…pump; their wallet 0xabcdef…9999');
    const s = snapshot(o, ctx());
    const user = buildPrompt(o, ctx(), { code: 'no_next', reason: 'x' }, s, 'site_data_x').user;
    expect(user).not.toMatch(/0x1234|77Hqxi|12345678\b/);
    expect(user).toMatch(/group: Wallet \[agent evm_address\]/); expect(user).toMatch(/group: Pay to \[agent sol_address\]/);
    expect(user).toContain('0xabcdef...9999');
  });
});

describe('B3: the model\'s "done"', () => {
  /**
   * The model path separate from the rules: the rules always stop with a code (formPlanner itself sets done by SUCCESS_RE — that is not about the model).
   * With its first answer the model presses (the submit button or cookie), with the second — done with a quote.
   */
  function session(o: { before: string; after: string; press?: 's' | 'c'; quote: string }) {
    let submitted = false;
    const els = [el('c', 'button', 'Accept', { cookie: true }), el('m', 'input', 'Shoe size', { value: '', form: 'g1' }), el('s', 'button', 'Submit', { submit: true, form: 'g1' })];
    const driver: SiteDriver = { async open() {}, async close() {}, async fill() {},
      async click(id) { if (id === 's') submitted = true; },
      async observe() { return page(submitted ? [] : els, submitted ? o.after : o.before); } };
    let n = 0;
    const pick: ModelPick = async () => ({ input: n++ === 0 ? { action: 'click', id: o.press ?? 's', why: 'press it' } : { action: 'done', quote: o.quote, why: 'page confirms' }, usd: 0.0005 });
    const stuck = { next: () => ({ kind: 'stop' as const, code: 'no_next' as const, reason: 'rules stuck' }) };
    return runSiteSession({ url: SITE, driver, values: VALUES, planner: hybridPlanner(stuck, pick) });
  }

  it('the confirmation appeared after pressing "Submit" → done', async () => {
    const r = await session({ before: 'Join the waitlist today.', after: 'Join the waitlist today. Thank you! Your application was received.', quote: 'Your application was received' });
    expect([r.status, r.reason]).toEqual(["done", undefined]); expect(r.confirmation).toBe("Your application was received");
    expect(r.steps.map(s => [s.action.kind, s.by])).toEqual([['click', 'haiku'], ['done', 'haiku']]);
  });

  it('only the cookie banner was pressed, the confirmation quote is on the page → not done', async () => {
    const r = await session({ before: 'Thank you for visiting our site!', after: '', press: 'c', quote: 'Thank you for visiting our site' });
    expect(r.status).not.toBe('done'); expect(r.reason).toMatch(/no submit \/ continue button was pressed/);
  });

  it('the same phrase was on the page before the press → not done; the phrase is not a confirmation → not done', async () => {
    const a = await session({ before: 'Thank you for joining early! Fill the form.', after: 'Thank you for joining early! Fill the form.', quote: 'Thank you for joining early' });
    expect(a.status).not.toBe('done'); expect(a.reason).toMatch(/the quote was on the page before the form was submitted/);
    const b = await session({ before: 'Join the waitlist today.', after: 'Join the waitlist today.', quote: 'Join the waitlist today' });
    expect(b.status).not.toBe('done'); expect(b.reason).toMatch(/the quote is not a confirmation/);
  });

  it('only the cookie banner (or a checkbox) was pressed → not counted as a submit', () => {
    const o = page([], 'Thank you for visiting!');
    const c = ctx({ steps: [{ n: 1, url: SITE, action: { kind: 'click', el: 'c' }, label: 'Accept' }] });
    expect(parseChoice({ action: 'done', quote: 'Thank you for visiting', why: 'x' }, o, c)).toMatchObject({ ok: false, reason: expect.stringMatching(/no submit \/ continue button was pressed/) });
    expect(parseChoice({ action: 'done', quote: 'Thank you for visiting', why: 'x' }, o, c, { submitted: false, before: [] }).ok).toBe(false);
  });
});

describe('O1: the worst call price is checked before the call', () => {
  /** A typical request: 60 elements and 1500 chars of page text → ~4–5k tokens. */
  const typical = (): PickPrompt => {
    const els = Array.from({ length: 100 }, (_, i) => el(`e${i}`, i % 3 ? "button" : "input", `Some field or button label number ${i} with several more words in it`, { form: 'g1', required: i % 2 === 0, group: 'Choose one option here' }));
    const o = page(els, 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40));
    return buildPrompt(o, ctx(), { code: 'no_next', reason: 'no field to fill and no button to continue' }, snapshot(o, ctx()), 'site_data_x');
  };

  const worst = (tier: 'haiku' | 'sonnet', p: PickPrompt) => worstCallUsd(SITE_MODELS[tier], p, SITE_CALL_LIMITS[tier].maxRounds, SITE_CALL_LIMITS[tier].maxTokens);

  it('prices (SITE_CALL_LIMITS: Haiku 2 rounds × 1000, Sonnet 1 × 1500): after one Haiku, Sonnet fits in $0.05; three Sonnets — no', () => {
    const p = typical();
    const tokens = Math.ceil((p.system.length + p.user.length) / 3.5);
    const haiku = worst('haiku', p), sonnet = worst('sonnet', p);
    console.log({ promptTokens: tokens, haikuWorstUsd: haiku.toFixed(5), sonnetWorstUsd: sonnet.toFixed(5), haikuCallsIn005: Math.floor(0.05 / haiku), sonnetCallsIn005: Math.floor(0.05 / sonnet),
      oldSonnet8000x2: worstCallUsd(SITE_MODELS.sonnet, p, 2).toFixed(5) });
    expect(tokens).toBeGreaterThan(3500); expect(tokens).toBeLessThan(6000);
    expect(haiku).toBeGreaterThan(0.001); expect(haiku).toBeLessThan(0.005);
    expect(haiku + sonnet).toBeLessThanOrEqual(0.05);
    expect(3 * sonnet).toBeGreaterThan(0.05);
    expect(worstCallUsd(SITE_MODELS.sonnet, p, 2)).toBeGreaterThan(0.05);          // the previous 8000 tokens × 2 rounds — did not fit
    expect(worstCallUsd(SITE_MODELS.haiku, p, 8, 1000)).toBeGreaterThan(haiku * 3); // rounds multiply the price
  });

  /** A model that spends the worst price of its call every time and answers illegibly (Haiku → Sonnet every time). */
  const greedy = (calls: string[]): ModelPick => async (tier, p) => { calls.push(tier); return { input: { action: 'oops', why: 'x' }, usd: worst(tier, p) }; };

  it('Haiku → Sonnet passes the $0.05 pre-check; Sonnet beyond the remainder is not called even without a call counter; spend ≤ $0.05', async () => {
    // A typical page (~4.8k tokens), the rules always stop with a code; the model spends the worst price and answers illegibly.
    // The Sonnet counter is raised to 10 so that it is the $0.05 cap that holds, not the 2-call limit.
    const o = page(Array.from({ length: 100 }, (_, i) => el(`e${i}`, i % 3 ? 'button' : 'input', `Some field or button label number ${i} with several more words in it`, { form: 'g1', required: i % 2 === 0, group: 'Choose one option here' })),
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40));
    const calls: string[] = [];
    const sess = hybridPlanner({ next: () => ({ kind: 'stop', code: 'no_next', reason: 'stuck' }) }, greedy(calls), { sonnetCalls: 10 }); let spent = 0;
    for (let i = 0; i < 10; i++) spent += (await sess.next(o, ctx())).meta?.usd ?? 0;
    expect(calls.slice(0, 2)).toEqual(['haiku', 'sonnet']);              // after one Haiku, Sonnet passed the pre-check
    expect(calls.filter(t => t === 'sonnet').length).toBeLessThan(3);   // three Sonnets per session do not fit
    expect(spent).toBeLessThanOrEqual(0.05);
  });

  it('Haiku does not fit in the daily remainder — not called; Sonnet too', async () => {
    const calls: string[] = [];
    const daily = hybridPlanner(formPlanner, greedy(calls), { dailyLeftUsd: () => 0.0003 });
    const r = await daily.next(page([el('m', 'button', 'Mystery')]), ctx());
    expect(calls).toEqual([]); expect((r as any).reason).toMatch(/haiku call may cost up to \$0\.\d+ — over what is left of the daily session budget/);
  });
});

describe('X tasks, "Connect" without a wallet, email in other languages', () => {
  it('the rules stopped with a code, and the page has X tasks → a stop without calling the model', async () => {
    let calls = 0; const pick: ModelPick = async () => { calls++; return { input: { action: 'stop', code: 'no_way', why: 'x' }, usd: 0.001 }; };
    const r = await hybridPlanner(formPlanner, pick).next(page([el('m', 'input', 'Shoe size', { value: '', form: 'g1', required: true }), el('s', 'button', 'Submit', { submit: true, form: 'g1' })]), ctx({ xTasks: ['follow @tinmoths'] }));
    expect(calls).toBe(0); expect(r).toMatchObject({ kind: 'stop' }); expect((r as any).reason).toMatch(/X actions: follow @tinmoths/); expect((r as any).code).toBeUndefined();
  });

  it('"Connect" without a session wallet — refused for the model and for any click; with a wallet — allowed', () => {
    for (const l of ['Connect', `Con${ZW}nect`, 'Подключить', 'Conectar']) {
      const o = page([el('c', 'button', l)]);
      expect([l, parseChoice({ action: 'click', id: 'c', why: 'x' }, o, ctx()).ok]).toEqual([l, false]);
      expect(refuseAction({ kind: 'click', el: 'c' }, o, 'task.example', VALUES, true)).toBeUndefined();
    }
  });

  it('email in es / pt / ru / zh / ko / tr / de / fr — the field is "not ours"; required — a stop without a code (the model is not called)', () => {
    for (const l of ['Correo electrónico', 'E-mail', 'Электронная почта', '邮箱', '이메일', 'E-posta adresi', 'Adresse e-mail', 'Courriel', 'Endereço de e-mail'])
      expect([l, fieldWants(el('f', 'input', l))]).toEqual([l, 'unsupported']);
    const a = formPlanner.next(page([el('f', 'input', 'Correo electrónico', { value: '', form: 'g1', required: true }), el('s', 'button', 'Enviar', { submit: true, form: 'g1' })]), ctx()) as any;
    expect(a.kind).toBe('stop'); expect(a.code).toBeUndefined();
  });
});

it('SITE_SYSTEM is in place (the price estimate accounts for the role)', () => { expect(SITE_SYSTEM.length).toBeGreaterThan(1000); });

describe('B3 for the rules too: the rules\' "done" — only after a form submit and on a new success phrase', () => {
  /** Site: a cookie banner and a form with X; after the submit — afterSubmit; a click on cookie removes the banner. */
  function site(o: { text: string; afterSubmit?: string }) {
    let cookie = true, sent = false;
    const clicks: string[] = [];
    const driver: SiteDriver = { async open() {}, async close() {}, async fill() {},
      async click(id) { clicks.push(id); if (id === 'c') cookie = false; if (id === 's') sent = true; },
      async observe() {
        if (sent && o.afterSubmit !== undefined) return page([], o.afterSubmit);
        return page([...(cookie ? [el('c', 'button', 'Accept', { cookie: true })] : []), el('x', 'input', 'X username', { value: 'scarf_ai', form: 'g1' }), el('s', 'button', 'Join', { submit: true, form: 'g1' })], o.text);
      } };
    return { driver, clicks };
  }

  it('only cookie pressed, the page already has "Thank you for visiting" → not done (the rules move on — to the form button)', async () => {
    const s = site({ text: 'Thank you for visiting! Join the waitlist.' });
    const r = await runSiteSession({ url: SITE, driver: s.driver, values: VALUES, limits: { maxSteps: 3 } });
    expect(s.clicks[0]).toBe('c'); expect(r.steps[1]).toMatchObject({ action: { kind: 'click', el: 's' } });
    expect(r.status).not.toBe('done');
  });

  it('form submit → "You\'re on the list" appeared → done (the confirmation is a new phrase, not the one shown before)', async () => {
    const s = site({ text: 'Thank you for visiting! Join the waitlist.', afterSubmit: "Thank you for visiting! You're on the list — see you soon." });
    const r = await runSiteSession({ url: SITE, driver: s.driver, values: VALUES });
    expect(r.status).toBe('done'); expect(s.clicks).toEqual(['c', 's']);
    expect(r.confirmation).toMatch(/You're on the list/);
  });

  it('formPlanner directly: a checkbox or cookie is not a submit; without pages a submit is recognized by the button label', () => {
    const o = page([], 'Thank you for registering!');
    const step = (label: string) => ({ values: VALUES, steps: [{ n: 1, url: SITE, action: { kind: 'click' as const, el: 'b' }, label }], xTasks: [], siteHost: 'task.example' });
    expect(formPlanner.next(o, step('I agree to the terms'))).not.toMatchObject({ kind: 'done' });
    expect(formPlanner.next(o, step('Accept'))).not.toMatchObject({ kind: 'done' });
    expect(formPlanner.next(o, step('Submit'))).toMatchObject({ kind: 'done', note: 'Thank you for registering!' });
  });
});
