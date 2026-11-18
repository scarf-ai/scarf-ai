// Regression (review #150, r150d.test.ts from /tmp/hq/repro-150-b).
// Round 3 on #150 (ea3628f). Red = the defect is present.
import { describe, it, expect } from 'vitest';
import { parseChoice, hybridPlanner } from '../src/exec/sitePlanner.js';
import { formPlanner, runSiteSession, isMoney, isNext, normObservation, type Observation, type SiteDriver } from '../src/exec/siteSession.js';
const VALUES = { xHandle: 'scarf_ai', evmAddress: '0x1234567890abcdef1234567890abcdef12345678', solAddress: '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump' };
const ctx = (over: any = {}) => ({ values: VALUES, steps: [], xTasks: [], siteHost: 'task.example', ...over }) as any;

describe('G1: a word entirely of letters of another script (not mixed) — not "money"', () => {
  for (const label of ['Арргоѵе' /* all Cyrillic letters */, 'ЅЕӀӀ' /* U+04C0 */, 'Міпт']) it(label, () => {
    const o = normObservation({ url: 'https://task.example/', text: 'Join', elements: [{ id: 'e1', kind: 'button', label }] } as any);
    expect(isMoney(o.elements[0].label)).toBe(true);                                   // red: false
    expect(parseChoice({ action: 'click', id: 'e1', why: 'x' }, o, ctx()).ok).toBe(false);
  });
  it('the "whole word" rule: folding into a "money" word — yes; real Russian, Ukrainian, Greek, Armenian labels — no', async () => {
    const { foreignMoneyWord } = await import('../src/exec/siteSession.js');
    for (const l of ['Арргоѵе', 'ЅЕӀӀ', 'Міпт', 'Join — Міпт', 'Ѕтаке']) expect([l, foreignMoneyWord(l)]).toEqual([l, true]);
    // next to a digit or "_" a folded label has no \b word boundary — only the "whole word" rule catches it
    for (const l of ['Міпт2', 'Арргоѵе_all']) expect([l, isMoney(l)]).toEqual([l, true]);
    for (const l of ['Отправить', 'Продолжить', 'Далее', 'Подать заявку', 'Присоединиться', 'Войти', 'Город', 'Гора', 'Торт', 'Порт', 'Роман', 'Відправити', 'Далі', 'Υποβολή', 'Συνέχεια', 'Ուղարկել', 'Арргоѵеаааааа'])
      expect([l, foreignMoneyWord(l), isMoney(l)]).toEqual([l, false, false]);
    for (const l of ['Отправить', 'Продолжить', 'Далее']) expect([l, isNext(l)]).toEqual([l, true]);
    expect(isMoney('Купить')).toBe(true);
  });
});

/** A session on a fake driver: the model answers in turn from a list. */
async function run(page: (n: number) => Observation, answers: any[]) {
  let step = 0; let k = 0;
  const driver: SiteDriver = { async open() {}, async close() {}, async fill() {}, async click() { step++; }, async select() {}, async observe() { return page(step); } } as any;
  const pick = async () => ({ input: answers[Math.min(k++, answers.length - 1)], usd: 0.0005 });
  return runSiteSession({ url: 'https://task.example/', driver, planner: hybridPlanner(formPlanner, pick), values: VALUES });
}
const REAL_FORM = [{ id: 'e2', kind: 'input', label: 'Favourite colour', inputType: 'text', required: true, form: 'g1' }, { id: 'e3', kind: 'button', label: 'Enviar', submit: true, form: 'g1' }];

describe('G2: V3 — "next" of a foreign block after clicking its checkbox, the real form was not submitted', () => {
  it('carousel g2: checkbox "Remember me" + "Next"; on slide 2 "Thanks for joining…"', async () => {
    const page = (n: number): Observation => ({ url: 'https://task.example/', scoped: true,
      text: n < 2 ? 'Join our waitlist. Slide 1.' : 'Join our waitlist. Slide 2: Thanks for joining our community of builders!',
      elements: [{ id: 'e4', kind: 'checkbox', label: 'Remember me', checked: n >= 1, form: 'g2' }, { id: 'e1', kind: 'button', label: 'Next', form: 'g2' }, ...REAL_FORM] } as any);
    const r = await run(page, [{ action: 'click', id: 'e4', why: 'tick' }, { action: 'click', id: 'e1', why: 'next' }, { action: 'done', quote: 'Thanks for joining our community', why: 'ok' }]);
    expect(r.status).not.toBe('done');                                                 // red: done
  });
});

describe('G3: V3 — the submit button of a foreign form (a footer subscription) counted as submitting the application', () => {
  it('footer g3: "Get updates" (submit, the email field is optional) → "Thanks for subscribing!"', async () => {
    const page = (n: number): Observation => ({ url: 'https://task.example/', scoped: true,
      text: n === 0 ? 'Join our waitlist.' : 'Join our waitlist. Thanks for subscribing to our newsletter!',
      elements: [...REAL_FORM, { id: 'e5', kind: 'input', label: 'Newsletter e-mail', inputType: 'text', form: 'g3' }, { id: 'e6', kind: 'button', label: 'Get updates', submit: true, form: 'g3' }] } as any);
    const r = await run(page, [{ action: 'click', id: 'e6', why: 'submit' }, { action: 'done', quote: 'Thanks for subscribing', why: 'ok' }]);
    expect(r.status).not.toBe('done');                                                 // red: done
  });
});

describe('G4: the "mixed script" regression — ordinary labels are not "money"', () => {
  for (const label of ['Tiếp tục', 'İleri', 'Zgłoś się', 'Weiter zur Anmeldung', 'Göndər' /* Azerbaijani ə */, 'NFT提交', 'Join 🚀', 'Davam et']) it(label, () => {
    expect(isMoney(label)).toBe(false);                                                // red: Göndər
  });
  it('and other ordinary Latin letters: ŀ, ĸ, ŧ, ɛ / ɔ, ſ, Ə — not mixed script; homoglyphs ɑ / ɪ — still a fake', async () => {
    const { mixedScript } = await import('../src/exec/siteSession.js');
    for (const l of ['Coŀlecció', 'Kaĸaa', 'Ŧoŧal', 'Ɛkɔ join', 'Faſt', 'Əlavə et']) expect([l, mixedScript(l), isMoney(l)]).toEqual([l, false, false]);
    for (const l of ['Swɑp', 'Mɪnt']) expect([l, isMoney(l)]).toEqual([l, true]);
  });
});
