// #148 item 2: the rule engine in a real Chromium against a local site — shadow DOM, select, radio, sr-only checkboxes, own iframe,
// overlap by a cookie banner, labels from svg title / img alt, header and footer, more than 80 elements. Without Chromium the tests are skipped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { chromiumSiteDriver, SITE_BROWSER_ARGS } from '../src/exec/siteBrowser.js';
import { runSiteSession, type SessionValues } from '../src/exec/siteSession.js';
import { SiteWallet, evmSigner } from '../src/exec/siteWallet.js';

const exe = [process.env.SCARF_TEST_CHROMIUM, '/opt/pw-browsers/chromium'].find(p => p && existsSync(p));
const launch = async () => (await import('playwright-core')).chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox', ...SITE_BROWSER_ARGS] } : { args: [...SITE_BROWSER_ARGS] });
let hasBrowser = false;
try { if (exe || process.env.PLAYWRIGHT_BROWSERS_PATH) { const b = await launch(); await b.close(); hasBrowser = true; } } catch { hasBrowser = false; }

const VALUES: SessionValues = { xHandle: '@scarf_ai', evmAddress: '0x1111111111111111111111111111111111111111', solAddress: '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump' };
const POST = `const send = (data) => fetch('/apply', { method: 'POST', body: JSON.stringify(data) }).then(() => { document.body.innerHTML = '<h1>Thank you — application received</h1>'; });`;

const PAGES: Record<string, string> = {
  // A header with search, a footer with a subscription and a "we are on X" link, the application form in the middle, optional fields
  '/chrome': `<html><body>
    <header><form role="search"><input type="search" placeholder="Search"><button type="submit">Go</button></form><nav><a href="/about">About</a></nav></header>
    <main><h1>Whitelist</h1><form id="f" onsubmit="event.preventDefault(); send({ x: xu.value, w: wa.value, d: dc.value, why: why.value })">
      <label for="xu">X username *</label><input id="xu" required>
      <label for="wa">EVM wallet address *</label><input id="wa" required>
      <label for="dc">Discord handle (optional)</label><input id="dc">
      <label for="why">Why do you want to join?</label><textarea id="why"></textarea>
      <button type="submit">Join the waitlist</button></form></main>
    <footer><form onsubmit="event.preventDefault(); fetch('/newsletter', { method: 'POST', body: '{}' })"><input type="email" placeholder="Your email" required><button>Subscribe</button></form>
      <a href="https://x.com/tinmoths">X</a></footer>
    <script>${POST}</script></body></html>`,
  // A network list and wallet type switches; a form without <form> (React-like): fields and a button in one div
  '/choices': `<html><body><h1>Apply</h1><div class="card">
      <div><label for="net">Network *</label><select id="net" required><option value="">Select…</option><option value="sol">Solana</option><option value="eth">Ethereum</option><option value="sui">Sui</option></select></div>
      <fieldset><legend>Wallet type</legend><label><input type="radio" name="wt" value="sol"> Solana</label><label><input type="radio" name="wt" value="evm"> EVM</label></fieldset>
      <div><label for="wa">Wallet address *</label><input id="wa"></div>
      <div><label for="src">How did you hear about us? (optional)</label><select id="src"><option value="">—</option><option>Twitter</option><option>Friend</option></select></div>
      <button id="go" type="button">Continue</button></div>
    <script>${POST} go.onclick = () => { const wt = document.querySelector('input[name=wt]:checked'); if (!net.value || !wt || !wa.value) return; send({ net: net.value, wt: wt.value, w: wa.value, src: src.value }); };</script></body></html>`,
  // The consent checkbox is hidden (sr-only), only its label with a terms link is visible; the submit button is an icon with an svg title
  '/sronly': `<html><head><style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0} .box{display:inline-block;width:16px;height:16px;border:1px solid #333}</style></head><body><h1>Apply</h1>
    <form onsubmit="event.preventDefault(); if (!ok.checked) return; send({ x: xu.value, ok: ok.checked })">
      <label for="xu">X username</label><input id="xu">
      <label><input type="checkbox" id="ok" class="sr-only"><span class="box"></span> I agree to the <a href="/terms">Terms</a></label>
      <button type="submit" aria-label=""><svg width="24" height="24"><title>Submit</title><rect width="24" height="24"/></svg></button></form>
    <script>${POST}</script></body></html>`,
  // A cookie banner across the whole bottom of the screen covers the submit button
  '/cookie': `<html><head><style>#bn{position:fixed;left:0;right:0;bottom:0;top:120px;background:#eee;z-index:9} body{margin:0}</style></head><body><h1 style="height:100px;margin:0">Apply</h1>
    <form style="margin-top:60px" onsubmit="event.preventDefault(); send({ x: xu.value })"><label for="xu">X username</label><input id="xu"><button type="submit">Apply</button></form>
    <div id="bn"><p>We use cookies to improve your experience.</p><button onclick="window.cookieMore=1">Manage</button><button onclick="document.getElementById('bn').remove()">Accept all</button></div>
    <script>${POST}</script></body></html>`,
  // The application form in an embedded frame from the same site; next to it — a foreign frame that must not be read
  '/framed': `<html><body><h1>Apply</h1><iframe src="/inner" width="500" height="200"></iframe><iframe src="http://localhost:__PORT__/foreign" width="300" height="80"></iframe></body></html>`,
  '/inner': `<html><body><form onsubmit="event.preventDefault(); send({ x: xu.value, from: 'iframe' })"><label for="xu">X username</label><input id="xu"><button type="submit">Submit</button></form><script>${POST}</script></body></html>`,
  '/foreign': `<html><body><form><label for="s">Seed phrase</label><input id="s"><button>Continue</button></form></body></html>`,
  // A wallet picker in an open shadow DOM (like Reown AppKit / Web3Modal): buttons inside their own elements, text in a slot
  '/shadow': `<html><body><h1>Join</h1><div id="st">not connected</div><button id="c">Connect</button><button id="s" style="display:none">Sign message</button><div id="done"></div>
    <script>
      class WBtn extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button><slot></slot></button>'; } }
      customElements.define('w-btn', WBtn);
      class WModal extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><div style="background:#fff;margin:60px;padding:20px"><h2>Connect a wallet</h2><w-btn id="wc">WalletConnect</w-btn><w-btn id="mm">MetaMask</w-btn></div></div>';
        r.getElementById('mm').addEventListener('click', async () => { const a = await window.ethereum.request({ method: 'eth_requestAccounts' }); window.acct = a[0]; this.remove(); st.innerText = 'connected'; c.style.display = 'none'; s.style.display = ''; });
        r.getElementById('wc').addEventListener('click', () => { window.wcClicked = 1; fetch('/apply', { method: 'POST', body: JSON.stringify({ wc: true }) }); }); } }
      customElements.define('w-modal', WModal);
      const hex = (t) => '0x' + Array.from(new TextEncoder().encode(t)).map((b) => b.toString(16).padStart(2, '0')).join('');
      c.onclick = () => document.body.appendChild(document.createElement('w-modal'));
      s.onclick = async () => { const sig = await window.ethereum.request({ method: 'personal_sign', params: [hex('Verify your wallet for Tin Moths. Nonce: 5'), window.acct] });
        await fetch('/apply', { method: 'POST', body: JSON.stringify({ address: window.acct, signature: sig }) }); s.style.display = 'none'; done.innerText = 'Wallet verified. Thank you!'; };
    </script></body></html>`,
  // More than 80 elements before the form: a long link menu, the form at the very end of the page
  '/long': `<html><body><h1>Apply</h1><ul>${Array.from({ length: 150 }, (_, i) => `<li><a href="/p${i}">Page ${i}</a></li>`).join('')}</ul>
    <form onsubmit="event.preventDefault(); send({ x: xu.value })"><label for="xu">X username</label><input id="xu"><button type="submit">Submit</button></form><script>${POST}</script></body></html>`,
};

describe.skipIf(!hasBrowser)('#148 item 2: the rule engine in a real browser', () => {
  let server: Server; let base = ''; let port = 0; const applied: any[] = []; const other: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { if (req.url === '/apply') applied.push(JSON.parse(b || '{}')); else other.push(req.url ?? ''); res.end('{}'); }); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end((PAGES[req.url ?? ''] ?? '<html><body>page</body></html>').replace('__PORT__', String(port)));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port; base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  const driver = () => chromiumSiteDriver({ launch, resolveHost: async (h) => (h === '127.0.0.1' || h === 'localhost' ? '127.0.0.1' : undefined), ports: () => true, settleMs: 700 });
  const run = async (path: string, wallet?: SiteWallet) => { applied.length = 0; other.length = 0; return runSiteSession({ url: `${base}${path}`, driver: driver(), values: VALUES, wallet }); };
  const clicks = (r: Awaited<ReturnType<typeof run>>) => r.steps.filter(s => s.action.kind === 'click').map(s => s.label);

  it('the header with search and the footer with a subscription do not interfere: only application fields are filled, the optional "Discord" and "Why…" are skipped, "we are on X" is not a task', async () => {
    const r = await run('/chrome');
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(applied).toEqual([{ x: 'scarf_ai', w: VALUES.evmAddress, d: '', why: '' }]);
    expect(other).toEqual([]);          // the footer subscription is not submitted
    expect(r.xTasks).toEqual([]);
    expect(clicks(r)).toEqual(['Join the waitlist']);
  }, 60_000);

  it('select and radio: network — Ethereum, wallet type — EVM; the optional "how did you hear" list is untouched; the form without <form> is recognized', async () => {
    const r = await run('/choices');
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(applied).toEqual([{ net: 'eth', wt: 'evm', w: VALUES.evmAddress, src: '' }]);
    expect(r.steps.filter(s => s.action.kind === 'select').map(s => [s.label, (s.action as any).option])).toEqual([['Network *', 'Ethereum']]);
  }, 60_000);

  it('the sr-only consent checkbox is checked (without following the "Terms" link in its label); the icon button with an svg title is pressed', async () => {
    const r = await run('/sronly');
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(applied).toEqual([{ x: 'scarf_ai', ok: true }]);
    expect(clicks(r)).toEqual(['I agree to the Terms', 'Submit']);
  }, 60_000);

  it('a cookie banner covers the form → first "Accept all" (not "Manage"), then the form', async () => {
    const r = await run('/cookie');
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(applied).toEqual([{ x: 'scarf_ai' }]);
    expect(clicks(r)).toEqual(['Accept all', 'Apply']);
    expect(r.steps[0]).toMatchObject({ action: { kind: 'click' }, label: 'Accept all' }); // before input into the covered field
  }, 60_000);

  it('a form in its own iframe is filled and submitted; a foreign iframe (another domain) is not read or filled', async () => {
    const r = await run('/framed');
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(applied).toEqual([{ x: 'scarf_ai', from: 'iframe' }]);
    expect(r.steps.map(s => s.label).join('|')).not.toMatch(/Seed/);
  }, 60_000);

  it('a wallet picker in shadow DOM: "Connect" → "MetaMask" (not WalletConnect) → "Sign message"; the signature verifies', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const w = new SiteWallet('127.0.0.1', { evm: evmSigner(account) });
    const r = await run('/shadow', w);
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(clicks(r)).toEqual(['Connect', 'MetaMask', 'Sign message']);
    expect(applied.length).toBe(1); expect(applied[0].address).toBe(account.address);
    expect(await verifyMessage({ address: account.address, message: 'Verify your wallet for Tin Moths. Nonce: 5', signature: applied[0].signature })).toBe(true);
  }, 60_000);

  it('a form after 150 links (the former 80-element limit cut it off) — found and submitted', async () => {
    const r = await run('/long');
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(applied).toEqual([{ x: 'scarf_ai' }]);
  }, 60_000);
});
