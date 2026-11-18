// #148 item 2: a broader rule engine — forms with a submit button, required fields, lists, switches, a cookie banner,
// overlap, header and footer, login buttons, other languages. Pure logic: the page is described as the browser driver returns it.
import { describe, it, expect } from 'vitest';
import { runSiteSession, formPlanner, refuseAction, isMoney, walletStep, type Observation, type SiteAction, type SiteDriver, type SiteElement, type SessionValues, type WalletView } from '../src/exec/siteSession.js';

const SITE = 'https://tinmoths.xyz/apply';
const VALUES: SessionValues = { xHandle: '@scarf_ai', evmAddress: '0x1111111111111111111111111111111111111111', solAddress: '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump' };
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });
const page = (elements: SiteElement[], text = 'Apply'): Observation => ({ url: SITE, text, elements, scoped: true });
const next = (o: Observation, wallet?: WalletView, values: SessionValues = VALUES) => formPlanner.next(o, { values, steps: [], xTasks: [], wallet }) as SiteAction;

/** A fake site: the page is a function of state; input, selection and presses change the state. */
function site(render: (st: Record<string, any>) => Observation) {
  const st: Record<string, any> = { filled: {}, selected: {}, clicks: [] };
  const driver: SiteDriver = { async open() {}, async close() {}, async observe() { return render(st); },
    async fill(id, t) { st.filled[id] = t; }, async select(id, o) { st.selected[id] = o; }, async click(id) { st.clicks.push(id); } };
  return { driver, st };
}

describe('#148 item 2: only the fields of a form with a submit button are filled', () => {
  const HEADER_SEARCH = el('q', 'input', 'Search', { inputType: 'search', value: '', form: 'g1', chrome: true });
  const SEARCH_BTN = el('qb', 'button', 'Go', { form: 'g1', chrome: true, submit: true });
  const FOOTER_MAIL = el('nl', 'input', 'Your email', { inputType: 'email', value: '', form: 'g3', chrome: true, required: true });
  const FOOTER_BTN = el('nlb', 'button', 'Subscribe', { form: 'g3', chrome: true, submit: true });

  it('search in the header and a subscription in the footer do not stop the session: the application form is filled and submitted', async () => {
    const { driver, st } = site(s => (s.clicks.includes('go') ? page([], 'Thank you — application received') : page([HEADER_SEARCH, SEARCH_BTN,
      el('x', 'input', 'X username', { inputType: 'text', value: s.filled.x ?? '', form: 'g2', required: true }),
      el('w', 'input', 'Wallet address', { inputType: 'text', value: s.filled.w ?? '', form: 'g2', required: true }),
      el('go', 'button', 'Submit', { form: 'g2', submit: true }), FOOTER_MAIL, FOOTER_BTN])));
    const r = await runSiteSession({ url: SITE, driver, values: VALUES });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(st.filled).toEqual({ x: 'scarf_ai', w: VALUES.evmAddress });
    expect(st.clicks).toEqual(['go']); // neither "Go" nor "Subscribe" is pressed
  });

  it('a field outside a form with a submit button (a lone field without a button) is not filled and does not stop', () => {
    const a = next(page([el('lone', 'input', 'Promo code', { value: '' }), el('x', 'input', 'X username', { value: '', form: 'g1' }), el('go', 'button', 'Apply', { form: 'g1' })]));
    expect(a).toEqual({ kind: 'fill', el: 'x', value: 'x_handle' });
  });

  it('an optional unknown or unsupported field is skipped; a required one — a stop with a reason', async () => {
    const form = (required: boolean) => (s: Record<string, any>) => (s.clicks.includes('go') ? page([], 'Thanks for applying — you are on the list') : page([
      el('x', 'input', 'X username', { value: s.filled.x ?? '', form: 'g1', required: true }),
      el('d', 'input', 'Discord handle', { value: '', form: 'g1', required }),
      el('m', 'input', 'Why do you want to join?', { inputType: 'textarea', value: '', form: 'g1', required }),
      el('go', 'button', 'Join the waitlist', { form: 'g1' })]));
    const opt = site(form(false));
    const r1 = await runSiteSession({ url: SITE, driver: opt.driver, values: VALUES });
    expect(r1.status).toBe('done'); expect(opt.st.filled).toEqual({ x: 'scarf_ai' });
    const req = site(form(true));
    const r2 = await runSiteSession({ url: SITE, driver: req.driver, values: VALUES });
    expect([r2.status, r2.reason]).toEqual(['stopped', 'the form asks for "Discord handle" — the agent has no such value']);
    expect(req.st.clicks).toEqual([]); // a form with an empty required field is not submitted
  });

  it('without driver markup (the part 1 fake driver) the behaviour is as before: any unknown field — a stop', () => {
    const o: Observation = { url: SITE, text: 'Apply', elements: [el('m', 'input', 'Shoe size', { value: '' }), el('go', 'button', 'Apply')] };
    expect(next(o)).toMatchObject({ kind: 'stop', reason: 'unknown field "Shoe size" — not guessing' });
  });
});

describe('#148 item 2: lists and switches', () => {
  it('the "Network" list → the EVM option is selected (the agent has an EVM address); selection only from the list options', async () => {
    const { driver, st } = site(s => (s.clicks.includes('go') ? page([], 'Thank you!') : page([
      el('n', 'select', 'Network', { value: s.selected.n ?? '', options: ['Solana', 'Ethereum', 'Sui'], form: 'g1', required: true }),
      el('w', 'input', 'Wallet address', { value: s.filled.w ?? '', form: 'g1', required: true }), el('go', 'button', 'Submit', { form: 'g1' })])));
    const r = await runSiteSession({ url: SITE, driver, values: VALUES });
    expect(r.status).toBe('done'); expect(st.selected).toEqual({ n: 'Ethereum' }); expect(st.filled.w).toBe(VALUES.evmAddress);
    expect(r.steps.find(x => x.action.kind === 'select')).toMatchObject({ label: 'Network', action: { kind: 'select', el: 'n', option: 'Ethereum' } });
  });

  it('the network list has no EVM, but has Solana → Solana (the agent has a Solana address); neither and the list is required → a stop', () => {
    const sel = (options: string[], required = true) => page([el('n', 'select', 'Blockchain', { value: '', options, form: 'g1', required }), el('go', 'button', 'Submit', { form: 'g1' })]);
    expect(next(sel(['Solana', 'Sui', 'TON']))).toEqual({ kind: 'select', el: 'n', option: 'Solana' });
    expect(next(sel(['Sui', 'TON']))).toMatchObject({ kind: 'stop', reason: 'the form asks to choose "Blockchain" — the rules do not choose in such a list' });
    expect(next(sel(['Sui', 'TON'], false))).toEqual({ kind: 'click', el: 'go' }); // optional — skipped
    expect(next(sel(['Solana', 'Sui']), undefined, { xHandle: 'scarf_ai' })).toMatchObject({ kind: 'stop' }); // no addresses — we do not select
  });

  it('a list not about the network ("Country", "How did you hear about us") is not selected by the rules: required — a stop, optional — skipped', () => {
    const o = (label: string, required: boolean) => page([el('c', 'select', label, { value: '', options: ['Twitter', 'Discord', 'Friend'], form: 'g1', required }), el('go', 'button', 'Submit', { form: 'g1' })]);
    expect(next(o('How did you hear about us?', true))).toMatchObject({ kind: 'stop' });
    expect(next(o('How did you hear about us?', false))).toEqual({ kind: 'click', el: 'go' });
    expect(next(o('Country', true))).toMatchObject({ kind: 'stop' });
  });

  it('an already selected list is not touched', () => {
    expect(next(page([el('n', 'select', 'Network', { value: 'Solana', options: ['Solana', 'Ethereum'], form: 'g1', required: true }), el('go', 'button', 'Submit', { form: 'g1' })]))).toEqual({ kind: 'click', el: 'go' });
  });

  it('"Wallet type" switches: EVM is selected; if already selected — not touched; a group not about the network — not touched', () => {
    const radios = (group: string, checked?: string) => page([el('r1', 'radio', 'Solana', { group, form: 'g1', checked: checked === 'r1' }), el('r2', 'radio', 'EVM', { group, form: 'g1', checked: checked === 'r2' }),
      el('go', 'button', 'Continue', { form: 'g1' })]);
    expect(next(radios('Wallet type'))).toEqual({ kind: 'click', el: 'r2' });
    expect(next(radios('Wallet type', 'r1'))).toEqual({ kind: 'click', el: 'go' });
    expect(next(radios('Favourite colour'))).toEqual({ kind: 'click', el: 'go' });
    // role=option in an open list — the same rule
    expect(next(page([el('o1', 'option', 'Sui', { group: 'Select network', form: 'g1' }), el('o2', 'option', 'Base', { group: 'Select network', form: 'g1' }), el('go', 'button', 'Continue', { form: 'g1' })]))).toEqual({ kind: 'click', el: 'o2' });
  });

  it('refuseAction for select: only a list, only its option, not a "money" option; the list is not pressed', () => {
    const o = page([el('n', 'select', 'Network', { options: ['Ethereum', 'Buy more slots'] }), el('x', 'input', 'X username')]);
    expect(refuseAction({ kind: 'select', el: 'n', option: 'Ethereum' }, o, 'tinmoths.xyz', VALUES)).toBeUndefined();
    expect(refuseAction({ kind: 'select', el: 'n', option: 'Polygon' }, o, 'tinmoths.xyz', VALUES)).toBe('select: no such option in the list');
    expect(refuseAction({ kind: 'select', el: 'n', option: 'Buy more slots' }, o, 'tinmoths.xyz', VALUES)).toMatch(/is about money/);
    expect(refuseAction({ kind: 'select', el: 'x', option: 'Ethereum' }, o, 'tinmoths.xyz', VALUES)).toBe('select: not a list');
    expect(refuseAction({ kind: 'click', el: 'n' }, o, 'tinmoths.xyz', VALUES)).toMatch(/chosen with select/);
  });

  it('a driver without select (part 1) — a failure with a reason, not a silent skip', async () => {
    const o = page([el('n', 'select', 'Network', { value: '', options: ['Ethereum'], form: 'g1', required: true }), el('go', 'button', 'Submit', { form: 'g1' })]);
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: { async open() {}, async close() {}, async fill() {}, async click() {}, async observe() { return o; } } });
    expect([r.status, r.reason]).toEqual(['error', 'driver cannot choose in a list']);
  });
});

describe('#148 item 2: cookie banner, overlap, header and footer, login buttons', () => {
  it('the cookie banner is closed first — with the consent button; a "money" button in the banner is not pressed', () => {
    const form = [el('x', 'input', 'X username', { value: '', form: 'g1', covered: true }), el('go', 'button', 'Apply', { form: 'g1', covered: true })];
    expect(next(page([...form, el('c', 'button', 'Accept all', { cookie: true })]))).toEqual({ kind: 'click', el: 'c' });
    expect(next(page([...form, el('c', 'button', 'Accept and buy premium', { cookie: true })]))).toMatchObject({ kind: 'stop' });
  });

  it('a covered element is not pressed or filled: the rules skip it, and the action check refuses anyone who picks it', () => {
    const o = page([el('x', 'input', 'X username', { value: '', form: 'g1', covered: true }), el('go', 'button', 'Apply', { form: 'g1', covered: true })]);
    expect(next(o)).toMatchObject({ kind: 'stop' });
    expect(refuseAction({ kind: 'click', el: 'go' }, o, 'tinmoths.xyz', VALUES)).toBe('element is covered by another element');
    expect(refuseAction({ kind: 'fill', el: 'x', value: 'x_handle' }, o, 'tinmoths.xyz', VALUES)).toBe('element is covered by another element');
  });

  it('a "we are on X" link in the footer — not a task; a link to X in the page body and an intent link anywhere — a task', async () => {
    const run = async (link: SiteElement) => {
      const { driver } = site(s => (s.clicks.includes('go') ? page([], 'Thank you!') : page([el('x', 'input', 'X username', { value: s.filled.x ?? '', form: 'g1', required: true }), el('go', 'button', 'Apply', { form: 'g1' }), link])));
      return runSiteSession({ url: SITE, driver, values: VALUES });
    };
    const footer = await run(el('f', 'link', 'X', { href: 'https://x.com/tinmoths', chrome: true }));
    expect(footer.status).toBe('done'); expect(footer.xTasks).toEqual([]);
    const body = await run(el('f', 'link', 'Follow @tinmoths', { href: 'https://x.com/tinmoths' }));
    expect(body.status).toBe('stopped'); expect(body.xTasks).toEqual(['follow @tinmoths']);
    const intent = await run(el('f', 'link', 'Follow', { href: 'https://x.com/intent/follow?screen_name=tinmoths', chrome: true }));
    expect(intent.xTasks).toEqual(['follow @tinmoths']);
  });

  it('login buttons "Log in", "Launch App" are pressed when there is nothing else to do, no more than twice; "Connect" — only with a wallet', async () => {
    expect(next(page([el('a', 'button', 'Launch App')]))).toEqual({ kind: 'click', el: 'a' });
    expect(next(page([el('a', 'button', 'Log in')]))).toEqual({ kind: 'click', el: 'a' });
    expect(next(page([el('a', 'button', 'Connect')]))).toMatchObject({ kind: 'stop' });
    const w: WalletView = { evm: true, sol: false, connected: false, signed: 0 };
    expect(next(page([el('a', 'button', 'Connect')]), w)).toEqual({ kind: 'click', el: 'a' });
    expect(next(page([el('a', 'button', 'Connect')]), { ...w, connected: true })).toMatchObject({ kind: 'stop' });
    const { driver, st } = site(() => page([el('a', 'button', 'Launch App')]));
    const r = await runSiteSession({ url: SITE, driver, values: VALUES });
    expect(st.clicks).toEqual(['a', 'a']); expect(r.status).toBe('stopped');
    // the form matters more than a login button
    expect(next(page([el('a', 'button', 'Log in', { chrome: true }), el('x', 'input', 'X username', { value: '', form: 'g1' }), el('go', 'button', 'Apply', { form: 'g1' })]))).toEqual({ kind: 'fill', el: 'x', value: 'x_handle' });
  });

  it('a form submit button without a clear word (type=submit, label "→") is pressed; the same one in the header — not', () => {
    expect(next(page([el('x', 'input', 'X username', { value: 'scarf_ai', form: 'g1' }), el('go', 'button', '→', { form: 'g1', submit: true })]))).toEqual({ kind: 'click', el: 'go' });
    expect(next(page([el('q', 'input', 'Search', { value: 'abc', form: 'g1', chrome: true }), el('go', 'button', '→', { form: 'g1', submit: true, chrome: true })]))).toMatchObject({ kind: 'stop' });
  });
});

describe('#148 item 2: other languages — basic words', () => {
  it('"next / submit" in es, pt, ru, zh, ko, tr is pressed', () => {
    for (const label of ['Continuar', 'Siguiente', 'Enviar', 'Próximo', 'Продолжить', 'Отправить', 'Подать заявку', '提交', '下一步', '제출', '다음', 'Devam', 'Gönder', 'Katıl'])
      expect([label, next(page([el('go', 'button', label)]))]).toEqual([label, { kind: 'click', el: 'go' }]);
  });
  it('"money" in the same languages is not pressed — neither by the rules nor by anyone else', () => {
    for (const label of ['Comprar ahora', 'Depositar', 'Reclamar', 'Купить', 'Внести депозит', 'Забрать награду', 'Одобрить', '购买', '领取空投', '铸造', '授权', '구매', '민팅', 'Satın al', 'Onayla']) {
      expect([label, isMoney(label)]).toEqual([label, true]);
      const o = page([el('b', 'button', label)]);
      expect([label, next(o).kind]).toEqual([label, 'stop']);
      expect([label, !!refuseAction({ kind: 'click', el: 'b' }, o, 'tinmoths.xyz', VALUES, true)]).toEqual([label, true]);
    }
    expect(isMoney('Continuar')).toBe(false); expect(isMoney('Продолжить')).toBe(false); expect(isMoney('提交')).toBe(false);
  });
  it('"connect wallet" in other languages — a wallet step (only with a session wallet); consent and "thank you" are understood too', async () => {
    for (const label of ['Conectar billetera', 'Conectar carteira', 'Подключить кошелёк', '连接钱包', '지갑 연결', 'Cüzdan bağla']) {
      expect([label, walletStep(label)]).toEqual([label, true]);
      expect([label, next(page([el('c', 'button', label)]), { evm: true, sol: false, connected: false, signed: 0 })]).toEqual([label, { kind: 'click', el: 'c' }]);
    }
    expect(walletStep('Подключить кошелёк и купить')).toBe(false);
    const { driver } = site(s => (s.clicks.includes('go') ? page([], 'Спасибо! Заявка принята.') : page([el('a', 'checkbox', 'Я согласен с условиями', { checked: s.clicks.includes('a'), form: 'g1' }), el('go', 'button', 'Отправить', { form: 'g1' })])));
    const r = await runSiteSession({ url: SITE, driver, values: VALUES });
    expect(r.status).toBe('done'); expect(r.confirmation).toMatch(/Заявка принята/);
  });
});
