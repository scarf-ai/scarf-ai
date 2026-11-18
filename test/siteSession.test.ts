// E-06 (#16), part one: a session on a task site without money — rules and the loop on a fake driver (no browser and no network).
import { describe, it, expect } from 'vitest';
import { runSiteSession, formPlanner, refuseAction, valueFor, fieldWants, xTaskFromLink, sameSite, registrable, sessionSummary, MONEY_RE,
  type Observation, type SiteDriver, type SiteElement, type SessionValues, type SiteAction } from '../src/exec/siteSession.js';

const VALUES: SessionValues = { xHandle: '@scarf_ai', evmAddress: '0x1111111111111111111111111111111111111111', solAddress: '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump' };
const SITE = 'https://tinmoths.xyz/apply';
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });

/** A fake site: pages are functions of state; fill/click change the state. Records everything entered and clicked. */
function fakeSite(pages: (st: Record<string, any>) => Observation, onClick?: (id: string, st: Record<string, any>) => void) {
  const st: Record<string, any> = { fields: {} as Record<string, string>, clicks: [] as string[] };
  const log = { opened: [] as string[], closed: 0 };
  const driver: SiteDriver = {
    async open(u) { log.opened.push(u); },
    async observe() { return pages(st); },
    async fill(id, text) { st.fields[id] = text; },
    async click(id) { st.clicks.push(id); onClick?.(id, st); },
    async screenshot() { return new Uint8Array([1, 2, 3]); },
    async close() { log.closed++; },
  };
  return { driver, st, log };
}
/** A form like Tin Moths has (journal 2026-11-12): 01 IDENTIFY (X username) → 02 MISSIONS → 03 WALLET, the CONTINUE button. */
function tinMoths(opts: { missions?: SiteElement[] } = {}) {
  return fakeSite((st) => {
    const step = st.step ?? 1;
    if (step === 1) return { url: SITE, text: '01 IDENTIFY Enter your X username', elements: [el('x', 'input', 'X username', { inputType: 'text', value: st.fields.x ?? '' }), el('go', 'button', 'CONTINUE')] };
    if (step === 2) return { url: SITE, text: '02 MISSIONS', elements: [...(opts.missions ?? []), el('go', 'button', 'CONTINUE')] };
    if (step === 3) return { url: SITE, text: '03 WALLET Your EVM wallet address', elements: [el('w', 'input', 'EVM wallet address (0x…)', { inputType: 'text', value: st.fields.w ?? '' }), el('ok', 'checkbox', 'I agree to the terms', { checked: !!st.agreed }), el('go', 'button', 'SUBMIT')] };
    return { url: SITE, text: 'Application received. Thank you — we will review it.', elements: [] };
  }, (id, st) => { if (id === 'ok') st.agreed = true; if (id === 'go') st.step = (st.step ?? 1) + 1; });
}

describe('E-06: the application form goes through entirely without the model', () => {
  it('three steps (X name → tasks → wallet): only agent values entered, the application submitted, the confirmation saved', async () => {
    const s = tinMoths();
    const r = await runSiteSession({ url: SITE, driver: s.driver, values: VALUES });
    expect(r.status).toBe('done');
    expect(r.confirmation).toMatch(/Application received\. Thank you/);
    expect(s.st.fields).toEqual({ x: 'scarf_ai', w: VALUES.evmAddress }); // the name without "@", the address — of the burner wallet
    expect(s.st.clicks).toEqual(['go', 'go', 'ok', 'go']);
    expect(r.steps.map(x => x.action.kind)).toEqual(['fill', 'click', 'click', 'fill', 'click', 'click', 'done']);
    expect(r.screenshot).toEqual(new Uint8Array([1, 2, 3]));
    expect(s.log.closed).toBe(1);
    expect(sessionSummary(r, SITE)).toMatch(/✅ Application on tinmoths\.xyz submitted: .*\nDone \(6\): entered x_handle into .X username.; clicked .CONTINUE./);
  });

  it('the Solana wallet field gets the Solana address, the EVM field — the EVM address', async () => {
    const s = fakeSite((st) => st.sent ? { url: SITE, text: 'You are on the waitlist', elements: [] }
      : { url: SITE, text: 'Join', elements: [el('s', 'input', 'Solana wallet', { value: st.fields.s ?? '' }), el('e', 'input', 'ETH address', { value: st.fields.e ?? '' }), el('go', 'button', 'Join the waitlist')] },
    (id, st) => { if (id === 'go') st.sent = true; });
    const r = await runSiteSession({ url: SITE, driver: s.driver, values: VALUES });
    expect(r.status).toBe('done'); expect(s.st.fields).toEqual({ s: VALUES.solAddress, e: VALUES.evmAddress });
  });
});

describe('E-06: the first version boundaries — a stop, not an action', () => {
  it('X tasks on a step (follow / repost): the session does not do them — lists them and stops; does not go to X', async () => {
    const s = tinMoths({ missions: [el('f', 'link', 'Follow @tinmoths', { href: 'https://x.com/intent/follow?screen_name=tinmoths' }), el('r', 'link', 'Repost', { href: 'https://twitter.com/tinmoths/status/123456' })] });
    const r = await runSiteSession({ url: SITE, driver: s.driver, values: VALUES });
    expect(r.status).toBe('stopped');
    expect(r.xTasks).toEqual(['follow @tinmoths', 'repost tinmoths/status/123456']);
    expect(r.reason).toBe('the site asks for X actions first: follow @tinmoths; repost tinmoths/status/123456');
    expect(s.st.clicks).toEqual(['go']); // only the first step's CONTINUE
    expect(sessionSummary(r, SITE)).toMatch(/X tasks on the site: follow @tinmoths; repost tinmoths\/status\/123456/);
  });

  it('the next step is a wallet, a signature or a deposit: a stop "this is E-13", nothing pressed', async () => {
    for (const label of ['Connect Wallet', 'Sign message to verify', 'Deposit USDC', 'Sign in with Ethereum', 'Mint pass', 'Claim rewards']) {
      const s = fakeSite(() => ({ url: SITE, text: 'Step', elements: [el('m', 'button', label)] }));
      const r = await runSiteSession({ url: SITE, driver: s.driver, values: VALUES });
      expect([label, r.status]).toEqual([label, 'stopped']);
      expect(r.reason).toMatch(/needs a wallet, a signature or money \(E-13\)/);
      expect(s.st.clicks).toEqual([]);
    }
    for (const ok of ['Sign up', 'Sign in', 'Continue', 'Join the waitlist']) expect([ok, MONEY_RE.test(ok)]).toEqual([ok, false]);
  });

  it('captcha — a stop marked "a human is needed"', async () => {
    const s = fakeSite(() => ({ url: SITE, text: 'Verify you are human', elements: [el('x', 'input', 'X username', { value: '' }), el('go', 'button', 'Continue')] }));
    const r = await runSiteSession({ url: SITE, driver: s.driver, values: VALUES });
    expect(r.status).toBe('stopped'); expect(r.needsHuman).toBe('captcha'); expect(s.st.fields).toEqual({});
    expect(sessionSummary(r, SITE)).toMatch(/Need your help: captcha\./);
  });

  it('a field the agent has no value for (email, Discord), an unrecognized field, a password — a stop without input', async () => {
    for (const [label, type, re] of [['Email', 'email', /asks for "Email"/], ['Discord username', 'text', /asks for "Discord username"/], ['Favourite colour', 'text', /unknown field "Favourite colour" — not guessing/], ['Password', 'password', /asks for "Password"/], ['Seed phrase', 'text', /asks for "Seed phrase"/]] as const) {
      const s = fakeSite(() => ({ url: SITE, text: 'Form', elements: [el('q', 'input', label, { inputType: type, value: '' }), el('go', 'button', 'Submit')] }));
      const r = await runSiteSession({ url: SITE, driver: s.driver, values: VALUES });
      expect([label, r.status]).toEqual([label, 'stopped']); expect(r.reason).toMatch(re); expect(s.st.fields).toEqual({}); expect(s.st.clicks).toEqual([]);
    }
  });

  it('the agent has no value (the X name is not set) — a stop, nothing is entered in the field', async () => {
    const s = tinMoths();
    const r = await runSiteSession({ url: SITE, driver: s.driver, values: { evmAddress: VALUES.evmAddress } });
    expect(r.status).toBe('stopped'); expect(r.reason).toBe('the form asks for x_handle, but the agent has no value for it'); expect(s.st.fields).toEqual({});
  });

  it('the page left the task site — a stop; the site does not accept input — "no progress", not endless presses; a step limit', async () => {
    const away = fakeSite((st) => st.go ? { url: 'https://evil.example/collect', text: 'x', elements: [] } : { url: SITE, text: 'Form', elements: [el('go', 'button', 'Continue')] }, (_i, st) => { st.go = true; });
    const r1 = await runSiteSession({ url: SITE, driver: away.driver, values: VALUES });
    expect(r1.status).toBe('stopped'); expect(r1.reason).toBe('the page left the task site (evil.example)');
    const stuck = fakeSite(() => ({ url: SITE, text: 'Form', elements: [el('go', 'button', 'Continue')] }));
    const r2 = await runSiteSession({ url: SITE, driver: stuck.driver, values: VALUES });
    expect(r2.status).toBe('stopped'); expect(r2.reason).toBe('no progress after pressing "Continue" twice'); expect(stuck.st.clicks.length).toBe(2);
    let n = 0;
    const endless = fakeSite(() => ({ url: `${SITE}?p=${n++}`, text: 'Form', elements: [el('go', 'button', 'Next')] }));
    const r3 = await runSiteSession({ url: SITE, driver: endless.driver, values: VALUES, limits: { maxSteps: 5 } });
    expect(r3.status).toBe('stopped'); expect(r3.reason).toBe('step limit (5) reached'); expect(endless.st.clicks.length).toBe(5);
  });

  it('a driver failure — an error result with a reason, the browser closed; a task address not http(s) — refused before opening', async () => {
    const boom = fakeSite(() => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); });
    const r = await runSiteSession({ url: SITE, driver: boom.driver, values: VALUES });
    expect(r.status).toBe('error'); expect(r.reason).toMatch(/ERR_NAME_NOT_RESOLVED/); expect(boom.log.closed).toBe(1);
    const js = fakeSite(() => ({ url: SITE, text: '', elements: [] }));
    const r2 = await runSiteSession({ url: 'javascript:alert(1)', driver: js.driver, values: VALUES });
    expect(r2.status).toBe('stopped'); expect(r2.reason).toBe('task url is not http(s)'); expect(js.log.opened).toEqual([]);
  });
});

describe('E-06: action check by code — independent of the planner', () => {
  const page: Observation = { url: SITE, text: 'Form', elements: [
    el('x', 'input', 'X username', { inputType: 'text' }), el('pw', 'input', 'Password', { inputType: 'password' }), el('seed', 'input', 'Recovery phrase', { inputType: 'text' }),
    el('cw', 'button', 'Connect wallet'), el('go', 'button', 'Continue'), el('off', 'button', 'Continue', { disabled: true }),
    el('out', 'link', 'Docs', { href: 'https://other.example/docs' }), el('in', 'link', 'Rules', { href: 'https://app.tinmoths.xyz/rules' }), el('tw', 'link', 'Follow', { href: 'https://x.com/tinmoths' }),
    el('js', 'link', 'Next', { href: 'javascript:void(0)' }) ] };
  const check = (a: SiteAction, v: SessionValues = VALUES) => refuseAction(a, page, 'tinmoths.xyz', v);

  it('the planner (in future — the model) cannot: type into a password or seed phrase, press a wallet, follow an external link, open X, press a disabled element', () => {
    expect(check({ kind: 'fill', el: 'x', value: 'x_handle' })).toBeUndefined();
    expect(check({ kind: 'fill', el: 'pw', value: 'x_handle' })).toMatch(/field type "password" is never filled/);
    expect(check({ kind: 'fill', el: 'seed', value: 'evm_address' })).toMatch(/secret field/);
    expect(check({ kind: 'fill', el: 'go', value: 'x_handle' })).toMatch(/not a text field/);
    expect(check({ kind: 'fill', el: 'x', value: 'x_handle' }, {})).toMatch(/no value for x_handle/);
    expect(check({ kind: 'click', el: 'cw' })).toMatch(/needs a wallet, a signature or money/);
    expect(check({ kind: 'click', el: 'go' })).toBeUndefined();
    expect(check({ kind: 'click', el: 'off' })).toMatch(/disabled/);
    expect(check({ kind: 'click', el: 'out' })).toMatch(/leaves the task site \(other\.example\)/);
    expect(check({ kind: 'click', el: 'in' })).toBeUndefined(); // a subdomain of the same site
    expect(check({ kind: 'click', el: 'tw' })).toMatch(/link to X is an X task/);
    expect(check({ kind: 'click', el: 'js' })).toMatch(/leaves the task site \(not http\)/);
    expect(check({ kind: 'click', el: 'nope' })).toMatch(/no such element/);
  });

  it('a check refusal stops the session: a planner that goes for the wallet presses nothing', async () => {
    const s = fakeSite(() => ({ url: SITE, text: 'Form', elements: [el('cw', 'button', 'Connect wallet')] }));
    const rogue = { next: () => ({ kind: 'click', el: 'cw' } as SiteAction) };
    const r = await runSiteSession({ url: SITE, driver: s.driver, planner: rogue, values: VALUES });
    expect(r.status).toBe('stopped'); expect(r.reason).toMatch(/^refused: click: "Connect wallet" needs a wallet/); expect(s.st.clicks).toEqual([]);
    expect(r.steps[0].refused).toBeDefined();
  });

  it('values: the X name — without "@" and only allowed characters; addresses — only of the right form', () => {
    expect(valueFor('x_handle', { xHandle: '@scarf_ai' })).toBe('scarf_ai');
    expect(valueFor('x_handle', { xHandle: 'not a handle!' })).toBeUndefined();
    expect(valueFor('x_handle', { xHandle: '' })).toBeUndefined();
    expect(valueFor('evm_address', { evmAddress: '0x123' })).toBeUndefined();
    expect(valueFor('sol_address', { solAddress: '0x1111111111111111111111111111111111111111' })).toBeUndefined();
    expect(fieldWants(el('a', 'input', 'Your Twitter handle'))).toBe('x_handle');
    expect(fieldWants(el('a', 'input', 'Wallet address'))).toBe('evm_address');
    expect(fieldWants(el('a', 'input', 'SOL wallet'))).toBe('sol_address');
    expect(fieldWants(el('a', 'input', 'Full name'))).toBe('unsupported');
    expect(fieldWants(el('a', 'input', 'Shoe size'))).toBeUndefined();
  });

  it('X links are parsed into tasks; "the same site" — the second-level domain, only http(s)', () => {
    expect(xTaskFromLink('https://x.com/intent/follow?screen_name=abc', 'Follow')).toBe('follow @abc');
    expect(xTaskFromLink('https://twitter.com/intent/retweet?tweet_id=42', 'RT')).toBe('repost 42');
    expect(xTaskFromLink('https://x.com/intent/like?tweet_id=42', '')).toBe('like 42');
    expect(xTaskFromLink('https://x.com/abc/status/42', 'Like this')).toBe('like abc/status/42');
    expect(xTaskFromLink('https://x.com/abc', 'Our X')).toBe('follow @abc');
    expect(xTaskFromLink('https://x.com/intent/tweet?text=hi', 'Tweet')).toMatch(/post a tweet \(not allowed/);
    expect(xTaskFromLink('https://tinmoths.xyz/x', 'x')).toBeUndefined();
    expect(sameSite('https://app.tinmoths.xyz/a', 'tinmoths.xyz')).toBe(true);
    expect(sameSite('https://tinmoths.xyz.evil.com/a', 'tinmoths.xyz')).toBe(false);
    expect(sameSite('ftp://tinmoths.xyz/a', 'tinmoths.xyz')).toBe(false);
  });

  it('formPlanner does not declare success on a single "thank you" word before the first press', async () => {
    const o: Observation = { url: SITE, text: 'Thank you for visiting. Apply below.', elements: [el('x', 'input', 'X username', { value: '' }), el('go', 'button', 'Apply')] };
    expect(await formPlanner.next(o, { values: VALUES, steps: [], xTasks: [] })).toEqual({ kind: 'fill', el: 'x', value: 'x_handle' });
  });
});

// Acceptance #143, H1: the session result goes to Telegram with parse_mode HTML — text from the page must not become markup
describe('E-06 H1: page text in the session result is escaped', () => {
  const page = (after: Observation): SiteDriver => {
    let step = 0;
    return { async open() {}, async close() {}, async fill() {}, async click() { step++; },
      async observe() { return step === 0 ? { url: 'https://task.example/', text: 'Join', elements: [{ id: 'e1', kind: 'button', label: 'Continue' }] } : after; } };
  };

  it('HQ reproduction: a "Thank you" page with a link — the result has no link markup, the text shows as text', async () => {
    const r = await runSiteSession({ url: 'https://task.example/', values: {},
      driver: page({ url: 'https://task.example/ok', text: 'Thank you! <a href="https://evil.example/claim">Click to confirm your wallet</a>', elements: [] }) });
    expect(r.status).toBe('done');
    const s = sessionSummary(r, 'https://task.example/');
    expect(s).not.toMatch(/<a href=/); expect(s).not.toMatch(/<[a-z/]/i);
    expect(s).toMatch(/&lt;a href="https:\/\/evil\.example\/claim"&gt;Click to confirm your wallet&lt;\/a&gt;/);
  });

  it('"Terms & Conditions" and angle brackets in labels and reasons — escaped (Telegram will not answer 400); a checkbox that does not tick — a stop after two attempts', async () => {
    const o: Observation = { url: 'https://task.example/', text: 'Join', elements: [
      { id: 'c', kind: 'checkbox', label: 'I agree to the Terms & Conditions <b>now</b>', checked: false }, { id: 'w', kind: 'button', label: 'Continue' }] };
    const r = await runSiteSession({ url: 'https://task.example/', values: {}, driver: { async open() {}, async close() {}, async fill() {}, async click() {}, async observe() { return o; } } });
    const s = sessionSummary(r, 'https://task.example/');
    expect(r.status).toBe('stopped');
    expect(r.reason).toBe('the checkbox "I agree to the Terms & Conditions <b>now</b>" does not tick after two attempts'); // and not 25 presses in a row
    expect(r.steps.filter(x => x.action.kind === 'click').length).toBe(2);
    expect(s).toMatch(/Terms &amp; Conditions &lt;b&gt;now&lt;\/b&gt;/);
    expect(s.replace(/&(amp|lt|gt);/g, '')).not.toMatch(/[<>&]/); // not a single "live" markup character
  });

  it('the result is not longer than the Telegram limit even with a long site text', async () => {
    const r = await runSiteSession({ url: 'https://task.example/', values: {}, driver: page({ url: 'https://task.example/ok', text: `Thank you ${'<'.repeat(5000)}`, elements: [] }) });
    expect(sessionSummary(r, 'https://task.example/').length).toBeLessThanOrEqual(4096);
  });
});

describe('E-06: "the same site" under a shared hosting suffix (acceptance #143)', () => {
  it('vercel.app, github.io, pages.dev, co.uk: a foreign site on the same hosting — not the task site; its own subdomain — yes', () => {
    expect(sameSite('https://evil.vercel.app/x', 'tinmoths.vercel.app')).toBe(false);
    expect(sameSite('https://tinmoths.vercel.app/x', 'tinmoths.vercel.app')).toBe(true);
    expect(sameSite('https://app.tinmoths.vercel.app/x', 'tinmoths.vercel.app')).toBe(true);
    expect(sameSite('https://other.github.io/', 'tinmoths.github.io')).toBe(false);
    expect(sameSite('https://phish.pages.dev/', 'tinmoths.pages.dev')).toBe(false);
    expect(sameSite('https://evil.co.uk/', 'tinmoths.co.uk')).toBe(false);
    expect(sameSite('https://www.tinmoths.co.uk/', 'tinmoths.co.uk')).toBe(true);
    expect(registrable('a.b.up.railway.app')).toBe('b.up.railway.app');
    expect(registrable('www.cityprotocol.co')).toBe('cityprotocol.co');
    expect(registrable('vercel.app')).toBe('vercel.app');
  });
});

describe('E-06: a field that does not accept input', () => {
  it('the field stayed empty after two inputs — a stop with a reason, not input up to the step limit', async () => {
    const o: Observation = { url: SITE, text: 'Apply', elements: [el('x', 'input', 'X username', { value: '' }), el('go', 'button', 'Apply')] };
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: { async open() {}, async close() {}, async fill() {}, async click() {}, async observe() { return o; } } });
    expect([r.status, r.reason]).toEqual(['stopped', 'the field "X username" stays empty after two attempts']);
    expect(r.steps.filter(x => x.action.kind === 'fill').length).toBe(2);
  });
});

// #148 item 1: three field recognition bugs — the site got wrong data on behalf of the agent
describe('#148 item 1: a field gets only the value it asks for', () => {
  const wants = (label: string, o: Partial<SiteElement> = {}) => fieldWants(el('f', 'input', label, { inputType: 'text', ...o }));
  /** What the session would enter into a form with one such field: a value or a stop reason. */
  async function typed(label: string) {
    const got: Record<string, string> = {};
    const o: Observation = { url: SITE, text: 'Apply', elements: [el('f', 'input', label, { inputType: 'text', value: '' }), el('go', 'button', 'Submit')] };
    const r = await runSiteSession({ url: SITE, values: VALUES, driver: { async open() {}, async close() {}, async click() {}, async fill(id, t) { got[id] = t; }, async observe() { return { ...o, elements: o.elements.map(e => (e.id === 'f' ? { ...e, value: got.f ?? '' } : e)) }; } } });
    return { value: got.f, status: r.status, reason: r.reason };
  }

  it('bug 1: "Discord handle" and "Telegram @username" do not get the X name — the agent has no such value', async () => {
    for (const label of ['Discord handle', 'Discord username', 'Telegram @username', 'Telegram handle', 'TG username', 'Your Discord ID · @username', 'Farcaster handle', 'GitHub username', 'Instagram @handle']) {
      expect([label, wants(label)]).toEqual([label, 'unsupported']);
      const r = await typed(label);
      expect([label, r.value, r.status]).toEqual([label, undefined, 'stopped']);
      expect(r.reason).toMatch(/the agent has no such value/);
    }
  });

  it('bug 2: "Email address" in a type=text field does not get the wallet address; a postal address and a contract address — neither', async () => {
    for (const label of ['Email address', 'E-mail address', 'Your email · address', 'Shipping address', 'Street address', 'Contract address', 'Token address', 'IP address', 'Billing address']) {
      expect([label, wants(label)]).toEqual([label, 'unsupported']);
      expect([label, (await typed(label)).value]).toEqual([label, undefined]);
    }
  });

  it('bug 3: "SUI / TON / BTC address" do not get the EVM address', async () => {
    for (const label of ['SUI address', 'Sui wallet address', 'TON wallet', 'TON address', 'BTC address', 'Bitcoin wallet address', 'Taproot address', 'Aptos wallet', 'Tron (TRC20) address', 'Cosmos address', 'NEAR wallet', 'Starknet address', 'Cardano wallet', 'XRP address']) {
      expect([label, wants(label)]).toEqual([label, 'unsupported']);
      expect([label, (await typed(label)).value]).toEqual([label, undefined]);
    }
  });

  it('bare "handle", "@username", "Address" and "either — or" fields are not recognized: no guesses, nothing is entered in the field', async () => {
    for (const label of ['Handle', '@username', '@handle', 'Address', 'Your address', 'Twitter or Telegram handle', 'EVM or SUI address', 'ETH or SOL wallet']) {
      expect([label, wants(label)]).toEqual([label, undefined]);
      const r = await typed(label);
      expect([label, r.value, r.status]).toEqual([label, undefined, 'stopped']);
    }
  });

  it('the previous fields are recognized as before: X, EVM, Solana', async () => {
    for (const label of ['X username', 'Twitter handle', 'Your Twitter handle', 'X (Twitter) username', 'Twitter · @username', 'X handle · @handle', 'x.com/username', 'Your X account', 'Username on X', 'Twitter profile'])
      expect([label, wants(label)]).toEqual([label, 'x_handle']);
    for (const label of ['Wallet address', 'EVM wallet address (0x…)', 'ETH address', 'Ethereum wallet', 'Wallet', 'Address (0x...)', 'Base wallet address', 'Your wallet', 'ERC-20 address', 'MetaMask address'])
      expect([label, wants(label)]).toEqual([label, 'evm_address']);
    for (const label of ['SOL wallet', 'Solana address', 'Solana wallet address', 'SOL address', 'Phantom wallet'])
      expect([label, wants(label)]).toEqual([label, 'sol_address']);
    expect((await typed('X username')).value).toBe('scarf_ai');
    expect((await typed('Wallet address')).value).toBe(VALUES.evmAddress);
    expect((await typed('Solana address')).value).toBe(VALUES.solAddress);
    expect(wants('Full name')).toBe('unsupported'); expect(wants('Username')).toBe('unsupported'); expect(wants('Shoe size')).toBeUndefined();
    expect(wants('Password')).toBe('unsupported'); expect(wants('Wallet seed phrase')).toBe('unsupported');
  });
});
