// E-06 (#16): a session on a task site in a real Chromium against a local site. Without Chromium the tests are skipped
// (as test/browser.test.ts): the browser is looked up in PLAYWRIGHT_BROWSERS_PATH, or by the path from SCARF_TEST_CHROMIUM / /opt/pw-browsers/chromium.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromiumSiteDriver, SITE_BROWSER_ARGS } from '../src/exec/siteBrowser.js';
import { refuseAction, runSiteSession, type SessionValues } from '../src/exec/siteSession.js';

const exe = [process.env.SCARF_TEST_CHROMIUM, '/opt/pw-browsers/chromium'].find(p => p && existsSync(p));
const launch = async () => (await import('playwright-core')).chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox', ...SITE_BROWSER_ARGS] } : { args: [...SITE_BROWSER_ARGS] });
let hasBrowser = false;
try { if (exe || process.env.PLAYWRIGHT_BROWSERS_PATH) { const b = await launch(); await b.close(); hasBrowser = true; } } catch { hasBrowser = false; }
// Binaries for the WebRTC test: full Chromium and headless shell (chromium.launch() without executablePath starts it)
const pw = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const headlessShell = [process.env.SCARF_TEST_HEADLESS_SHELL, ...(existsSync(pw) ? readdirSync(pw) : []).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse()
  .flatMap(d => [join(pw, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), join(pw, d, 'chrome-linux', 'headless_shell')])].find(p => p && existsSync(p));
const WEBRTC_BINS = ([['full Chromium', exe], ['headless shell', headlessShell]] as [string, string | undefined][]).filter((x): x is [string, string] => !!x[1]);

const VALUES: SessionValues = { xHandle: '@scarf_ai', evmAddress: '0x1111111111111111111111111111111111111111', solAddress: '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump' };

/** A site with a three-step JS application form (like Tin Moths): X name → tasks → wallet; submit — POST /apply. */
const FORM = (missions: string) => `<!doctype html><html><head><title>Tin Moths — apply</title></head><body>
<h1 id="h">01 IDENTIFY</h1>
<div id="s1"><label for="xu">X username</label><input id="xu" type="text"><button id="b1">CONTINUE</button></div>
<div id="s2" style="display:none">${missions}<button id="b2">CONTINUE</button></div>
<div id="s3" style="display:none"><input placeholder="EVM wallet address (0x…)" id="w" type="text">
  <label><input type="checkbox" id="ok"> I agree to the terms</label><button id="b3">SUBMIT</button></div>
<div id="done" style="display:none"></div>
<script>
  const show = (id, h) => { for (const s of ['s1','s2','s3','done']) document.getElementById(s).style.display = s === id ? '' : 'none'; document.getElementById('h').innerText = h; };
  b1.onclick = () => { if (xu.value) show('s2', '02 MISSIONS'); };
  b2.onclick = () => show('s3', '03 WALLET');
  b3.onclick = async () => { if (!ok.checked || !w.value) return;
    await fetch('/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: xu.value, wallet: w.value }) });
    document.getElementById('done').innerText = 'Application received. Thank you — we will review it.'; show('done', 'DONE'); };
</script></body></html>`;

describe.skipIf(!hasBrowser)('E-06: a session in a real browser (local site)', () => {
  let server: Server; let base = ''; const applied: any[] = []; const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/apply') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { applied.push(JSON.parse(b)); setTimeout(() => res.end('{}'), 600); }); return; } // the site does not answer right away: the session must not press SUBMIT a second time
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/x') return res.end(FORM('<a href="https://x.com/intent/follow?screen_name=tinmoths" target="_blank">Follow @tinmoths</a>'));
      if (req.url === '/wallet') return res.end('<html><body><h1>Join</h1><button onclick="window.clicked=1">Connect Wallet</button></body></html>');
      if (req.url === '/captcha') return res.end('<html><body><label for="xu">X username</label><input id="xu"><iframe src="https://challenges.cloudflare.com/turnstile/v0/x"></iframe><button>Continue</button></body></html>');
      // review #150 (B1): invisible characters in the label, options and button
      if (req.url === '/norm') return res.end('<html><body><form onsubmit="event.preventDefault()"><label for="n">Net&#8203;work</label><select id="n"><option value="">--</option><option value="b">Ba&#8203;se</option><option value="s">Solana</option><option value="e1">Eth&#8203;ereum</option><option value="e2">Ethe&#8203;reum</option></select><button type="button">Mi&#8203;nt &#8238;now</button></form></body></html>');
      res.end(FORM('<p>No missions today.</p>'));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  // 127.0.0.1 is not a public host: in the test we allow only it, everything else (including x.com) — not
  const driver = () => chromiumSiteDriver({ launch, resolveHost: async (h) => (h === '127.0.0.1' ? '127.0.0.1' : undefined), ports: () => true, settleMs: 700 });

  it('review #150 (B1): the driver returns normalized labels and options; select by a normalized option picks the real one', async () => {
    const d = driver();
    try {
      await d.open(`${base}/norm`);
      const o = await d.observe();
      const sel = o.elements.find(e => e.kind === 'select')!; const btn = o.elements.find(e => e.kind === 'button')!;
      // V4: an option changed by normalization is marked; two such identical ones are ambiguous (the code and the driver refuse)
      expect([sel.label, sel.options, btn.label]).toEqual(['Network', ['Base (normalized)', 'Solana', 'Ethereum (normalized)', 'Ethereum (normalized)'], 'Mint now']);
      expect(refuseAction({ kind: 'select', el: sel.id, option: 'Ethereum (normalized)' }, o, '127.0.0.1', VALUES)).toMatch(/ambiguous/);
      await expect(d.select!(sel.id, 'Ethereum (normalized)')).rejects.toThrow(/ambiguous/);
      await d.select!(sel.id, 'Base (normalized)');
      expect((await d.observe()).elements.find(e => e.kind === 'select')!.value).toBe('Base');
    } finally { await d.close(); }
  }, 60_000);

  it('the three-step form is completed: the site got the X name without "@" and the agent wallet address; the confirmation and a screenshot are saved', async () => {
    const r = await runSiteSession({ url: `${base}/`, driver: driver(), values: VALUES });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(applied).toEqual([{ x: 'scarf_ai', wallet: VALUES.evmAddress }]); // exactly one submit
    expect(r.steps.filter(s => s.action.kind === 'click' && s.label === 'SUBMIT').length).toBe(1);
    expect(r.confirmation).toMatch(/Application received\. Thank you/);
    expect(r.steps.filter(s => s.action.kind === 'fill').map(s => s.label)).toEqual(['X username', 'EVM wallet address (0x...)']); // NFKC (review #150, B1): "…" → "..."
    expect(r.screenshot && r.screenshot.length).toBeGreaterThan(1000);
    expect(Buffer.from(r.screenshot!.slice(0, 4)).toString('hex')).toBe('89504e47'); // PNG
  }, 60_000);

  it('a step with an X task: the session lists the task and stops, does not go to X, the application is not submitted', async () => {
    const before = applied.length;
    const r = await runSiteSession({ url: `${base}/x`, driver: driver(), values: VALUES });
    expect(r.status).toBe('stopped');
    expect(r.xTasks).toEqual(['follow @tinmoths']);
    expect(r.reason).toBe('the site asks for X actions first: follow @tinmoths');
    expect(applied.length).toBe(before);
  }, 60_000);

  it('the "Connect Wallet" button: not pressed, a stop "this is E-13"; a captcha in a frame — a stop "a human is needed", nothing entered in the field', async () => {
    const w = await runSiteSession({ url: `${base}/wallet`, driver: driver(), values: VALUES });
    expect(w.status).toBe('stopped'); expect(w.reason).toMatch(/"Connect Wallet" — needs a wallet, a signature or money \(E-13\)/);
    expect(w.steps.some(s => s.action.kind === 'click')).toBe(false);
    const c = await runSiteSession({ url: `${base}/captcha`, driver: driver(), values: VALUES });
    expect(c.status).toBe('stopped'); expect(c.needsHuman).toBe('captcha'); expect(c.steps.some(s => s.action.kind === 'fill')).toBe(false);
  }, 60_000);

  it('an internal server address is not opened: refused before the page starts', async () => {
    const r = await runSiteSession({ url: `${base}/`, driver: chromiumSiteDriver({ launch }), values: VALUES }); // without permission for 127.0.0.1
    expect(r.status).toBe('error'); expect(r.reason).toMatch(/refused: non-public host/);
  }, 30_000);
});

// Acceptance #143, W1: the server internal network is closed at the connection level — for WebSocket and under DNS spoofing too
describe.skipIf(!hasBrowser)('E-06 W1: a task site page does not reach the internal network', () => {
  /** An internal service on 127.0.0.1: counts HTTP requests and WebSocket attempts. */
  async function internalService() {
    const hits = { http: 0, ws: 0 };
    const srv = createServer((_q, r) => { hits.http++; r.end('secret'); });
    srv.on('upgrade', (_q, sock) => { hits.ws++; sock.destroy(); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    return { hits, port: (srv.address() as AddressInfo).port, close: () => new Promise(r => srv.close(r)) };
  }
  async function taskSite(html: (internalPort: number) => string, internalPort: number) {
    const srv = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(html(internalPort)); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    return { port: (srv.address() as AddressInfo).port, close: () => new Promise(r => srv.close(r)) };
  }
  const PAGE = (ip: number) => `<html><body><h1>Join</h1><div id="out">-</div><script>
    const out = (t) => { document.getElementById('out').innerText += ' ' + t; };
    try { const w = new WebSocket('ws://127.0.0.1:${ip}/'); w.onopen = () => out('ws-open'); w.onerror = () => out('ws-error'); w.onclose = () => out('ws-closed'); } catch (e) { out('ws-throw'); }
    fetch('http://127.0.0.1:${ip}/').then(() => out('fetch-ok'), () => out('fetch-failed'));
    const i = new Image(); i.src = 'http://127.0.0.1:${ip}/pixel.png';
  </script></body></html>`;

  it('HQ reproduction: WebSocket, fetch and an image to 127.0.0.1 from the page — the internal service gets no connections', async () => {
    const internal = await internalService(); const site = await taskSite(PAGE, internal.port);
    // "public" in the test — only the name localhost (the task site); 127.0.0.1 — the internal network
    const d = chromiumSiteDriver({ launch, resolveHost: async (h) => (h === 'localhost' ? '127.0.0.1' : undefined), ports: () => true, settleMs: 1500 });
    let text = '';
    try { await d.open(`http://localhost:${site.port}/`); await new Promise(r => setTimeout(r, 1200)); text = (await d.observe()).text; } finally { await d.close(); }
    await internal.close(); await site.close();
    expect(text).toMatch(/Join/); // the task site itself opened
    expect(internal.hits).toEqual({ http: 0, ws: 0 });
    expect(text).not.toMatch(/ws-open|fetch-ok/);
  }, 60_000);

  it('even without request interception in Playwright the proxy decides the connection: it resolves the name, not the browser (DNS spoofing is closed)', async () => {
    const internal = await internalService(); const site = await taskSite(PAGE, internal.port);
    // The name task.scarf-test.invalid does not exist in DNS: if Chromium resolved names itself, the page would not open.
    // The proxy gets the name, asks resolveHost and connects to the returned IP — there is no second name resolution.
    const asked: string[] = [];
    const d = chromiumSiteDriver({ launch, ports: () => true, settleMs: 1200,
      resolveHost: async (h, p) => { asked.push(`${h}:${p}`); return h === 'task.scarf-test.invalid' ? '127.0.0.1' : undefined; } });
    let text = '';
    try { await d.open(`http://task.scarf-test.invalid:${site.port}/`); await new Promise(r => setTimeout(r, 800)); text = (await d.observe()).text; } finally { await d.close(); }
    await internal.close(); await site.close();
    expect(text).toMatch(/Join/);
    expect(asked).toContain(`task.scarf-test.invalid:${site.port}`);
    expect(internal.hits).toEqual({ http: 0, ws: 0 });
  }, 60_000);

  // Review #144: in production chromium.launch() without executablePath starts headless shell, and it understands a different flag than full Chromium
  for (const [name, bin] of WEBRTC_BINS) it(`#144: WebRTC (UDP bypassing the proxy) — STUN from the page to an internal address is not sent (SITE_BROWSER_ARGS) — ${name}`, async () => {
    const launch = async () => (await import('playwright-core')).chromium.launch({ executablePath: bin, args: ['--no-sandbox', ...SITE_BROWSER_ARGS] });
    const { createSocket } = await import('node:dgram');
    const udp = createSocket('udp4'); let packets = 0; udp.on('message', () => { packets++; });
    await new Promise<void>(r => udp.bind(0, '127.0.0.1', r)); const stun = udp.address().port;
    const site = await taskSite(() => `<html><body><h1>Join</h1><script>
      (async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stun}' }] }); pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer()); window.__pc = pc; })();
    </script></body></html>`, 0);
    const d = chromiumSiteDriver({ launch, resolveHost: async (h) => (h === 'localhost' ? '127.0.0.1' : undefined), ports: () => true, settleMs: 700 });
    let text = '';
    try { await d.open(`http://localhost:${site.port}/`); await new Promise(r => setTimeout(r, 1500)); text = (await d.observe()).text; } finally { await d.close(); }
    await site.close(); await new Promise<void>(r => udp.close(() => r()));
    expect(text).toMatch(/Join/);
    expect(packets).toBe(0);
  }, 60_000);
});

// ── Part 2: the session wallet in a real browser ─────────────────────────────────────────────────────────────────────────
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { Keypair } from '@solana/web3.js';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { SiteWallet, evmSigner, solSigner } from '../src/exec/siteWallet.js';

describe.skipIf(!hasBrowser)('E-06 part 2: wallet connection and message signing in a real browser', () => {
  const account = privateKeyToAccount(generatePrivateKey()); const kp = Keypair.generate();
  const got: any[] = []; let server: Server; let base = ''; let port = 0;
  const MSG = 'Sign this message to verify your wallet for Tin Moths.\nNonce: 8231';
  /** A page like task sites have: Connect Wallet → (EIP-6963 or window.ethereum) → Sign message → POST /verify → "Wallet verified". */
  const EVM_PAGE = (action: string) => `<!doctype html><html><body><h1>Join</h1><div id="st">not connected</div>
<button id="c">Connect Wallet</button><button id="s" style="display:none">Sign message</button><div id="done"></div>
<script>
  let provider = null; let acct = null;
  window.addEventListener('eip6963:announceProvider', (e) => { if (e.detail.info.rdns === 'ai.scarf.wallet') provider = e.detail.provider; });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const hex = (t) => '0x' + Array.from(new TextEncoder().encode(t)).map((b) => b.toString(16).padStart(2, '0')).join('');
  c.onclick = async () => { const p = provider || window.ethereum; const a = await p.request({ method: 'eth_requestAccounts' }); acct = a[0];
    st.innerText = 'connected ' + acct + ' via ' + (provider ? 'eip6963' : 'window.ethereum'); c.style.display = 'none'; s.style.display = ''; };
  s.onclick = async () => { const p = provider || window.ethereum;
    try { ${action}
      await fetch('/verify', { method: 'POST', body: JSON.stringify({ kind: 'evm', address: acct, signature: sig, message: ${JSON.stringify(MSG)} }) });
      s.style.display = 'none'; done.innerText = 'Wallet verified. Thank you!';
    } catch (e) { done.innerText = 'rejected: ' + e.code; } };
</script></body></html>`;
  const SOL_PAGE = `<!doctype html><html><body><h1>Join</h1><button id="c">Connect Wallet</button><button id="p" style="display:none">Phantom</button><button id="s" style="display:none">Verify wallet</button><div id="done"></div>
<script>
  let pk = null;
  c.onclick = () => { c.style.display = 'none'; p.style.display = ''; };
  p.onclick = async () => { const r = await window.phantom.solana.connect(); pk = r.publicKey.toBase58(); p.style.display = 'none'; s.style.display = ''; };
  s.onclick = async () => { const r = await window.solana.signMessage(new TextEncoder().encode(${JSON.stringify(MSG)}), 'utf8');
    await fetch('/verify', { method: 'POST', body: JSON.stringify({ kind: 'sol', address: pk, signature: Array.from(r.signature), pkBytes: Array.from(r.publicKey.toBytes()) }) });
    s.style.display = 'none'; done.innerText = 'Wallet verified. Thank you!'; };
</script></body></html>`;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { got.push({ path: req.url, ...JSON.parse(b || '{}') }); res.end('{}'); }); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/sign') return res.end(EVM_PAGE(`const sig = await p.request({ method: 'personal_sign', params: [hex(${JSON.stringify(MSG)}), acct] });`));
      if (req.url === '/tx') return res.end(EVM_PAGE(`const sig = await p.request({ method: 'eth_sendTransaction', params: [{ from: acct, to: '0x1111111111111111111111111111111111111111', value: '0xde0b6b3a7640000' }] });`));
      if (req.url === '/permit') return res.end(EVM_PAGE(`const sig = await p.request({ method: 'eth_signTypedData_v4', params: [acct, JSON.stringify({ primaryType: 'Permit', domain: { name: 'USDC' }, types: {}, message: { spender: '0x1111111111111111111111111111111111111111', value: '115792089237316195423570985008687907853269984665640564039457584007913129639935', deadline: '99999999999' } })] });`));
      if (req.url === '/sol') return res.end(SOL_PAGE);
      // a foreign frame inside the task site tries to get the address and a signature
      if (req.url === '/framed') return res.end(`<html><body><h1>Join</h1><iframe src="http://localhost:${port}/inner" width="300" height="80"></iframe></body></html>`);
      // review #150: the "X username" form in a FOREIGN frame (localhost ≠ 127.0.0.1) — the session does not see it or fill it; input would report /xleak
      if (req.url === '/xframe') return res.end(`<html><body><h1>Join</h1><iframe src="http://localhost:${port}/xinner" width="400" height="120"></iframe></body></html>`);
      if (req.url === '/xinner') return res.end(`<html><body><form onsubmit="event.preventDefault()"><label for="xu">X username</label>
        <input id="xu" oninput="fetch('/xleak', { method: 'POST', body: JSON.stringify({ v: this.value }) })"><button type="submit">Continue</button></form></body></html>`);
      if (req.url === '/inner') return res.end(`<html><body><script>
        (async () => { let out = 'none'; try { const a = await window.ethereum.request({ method: 'eth_requestAccounts' }); out = 'accounts:' + a.join(','); } catch (e) { out = 'err:' + e.code; }
          await fetch('/leak', { method: 'POST', body: JSON.stringify({ out: out, has: typeof window.ethereum }) }); })();
      </script></body></html>`);
      res.end('<html><body>none</body></html>');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port; base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  const driver = () => chromiumSiteDriver({ launch, resolveHost: async (h) => (h === '127.0.0.1' || h === 'localhost' ? '127.0.0.1' : undefined), ports: () => true, settleMs: 700 });
  const wallet = () => new SiteWallet('127.0.0.1', { evm: evmSigner(account), sol: solSigner(kp) });

  it('EVM: the session connects the wallet and signs a message; the site got the burner wallet address and a signature that verifies', async () => {
    got.length = 0; const w = wallet();
    const r = await runSiteSession({ url: `${base}/sign`, driver: driver(), values: {}, wallet: w });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(r.confirmation).toMatch(/Wallet verified\. Thank you/);
    expect(r.steps.filter(s => s.action.kind === 'click').map(s => s.label)).toEqual(['Connect Wallet', 'Sign message']);
    const v = got.find(g => g.path === '/verify');
    expect(v.address).toBe(account.address);
    expect(await verifyMessage({ address: account.address, message: MSG, signature: v.signature })).toBe(true);
    expect(w.signed.map(e => e.message)).toEqual([MSG]);       // the signature text — to the journal
    expect(r.wallet!.events.some(e => e.method === 'eth_requestAccounts' && e.allowed)).toBe(true);
  }, 60_000);

  it('EVM: the site asks for a transaction or permit instead of a message → the wallet refuses, the session stops, the site got no signature', async () => {
    for (const [path, method] of [['/tx', 'eth_sendTransaction'], ['/permit', 'eth_signTypedData_v4']] as const) {
      got.length = 0; const w = wallet();
      const r = await runSiteSession({ url: `${base}${path}`, driver: driver(), values: {}, wallet: w });
      expect(r.status).toBe('stopped');
      expect(r.reason).toMatch(new RegExp(`^the site asked the wallet for ${method} — transactions, typed-data signatures and blind signing are not allowed`));
      expect(got.filter(g => g.path === '/verify')).toEqual([]);
      expect(w.signed).toEqual([]);
    }
  }, 90_000);

  it('Solana: connect and signMessage via window.phantom.solana — the ed25519 signature verifies against the burner wallet public key', async () => {
    got.length = 0; const w = wallet();
    const r = await runSiteSession({ url: `${base}/sol`, driver: driver(), values: {}, wallet: w });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(r.steps.filter(s => s.action.kind === 'click').map(s => s.label)).toEqual(['Connect Wallet', 'Phantom', 'Verify wallet']);
    const v = got.find(g => g.path === '/verify');
    expect(v.address).toBe(kp.publicKey.toBase58());
    expect(v.pkBytes).toEqual(Array.from(kp.publicKey.toBytes()));
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(kp.publicKey.toBytes())]), format: 'der', type: 'spki' });
    expect(edVerify(null, Buffer.from(MSG), pub, Buffer.from(v.signature))).toBe(true);
    expect(w.signed.map(e => [e.chain, e.message])).toEqual([['solana', MSG]]);
  }, 60_000);

  it('a foreign frame inside the task site (another domain) sees the wallet but does not get the address: refusal 4100', async () => {
    got.length = 0; const w = wallet();
    const d = driver(); d.attachWallet!(w);
    try { await d.open(`${base}/framed`); await new Promise(r => setTimeout(r, 1200)); } finally { await d.close(); }
    expect(got.filter(g => g.path === '/leak')).toEqual([{ path: '/leak', out: 'err:4100', has: 'object' }]);
    expect(w.isConnected).toBe(false);
    expect(w.events.at(-1)).toMatchObject({ allowed: false, reason: 'request from a frame outside the task site' });
  }, 60_000);

  it('review #150: the "X username" field in a foreign frame is not visible to the session and is not filled', async () => {
    got.length = 0;
    const d = driver();
    const r = await runSiteSession({ url: `${base}/xframe`, driver: d, values: { xHandle: 'scarf_ai' } });
    await new Promise(res => setTimeout(res, 300));
    expect(r.steps.filter(s => s.action.kind === 'fill')).toEqual([]);
    expect(got.filter(g => g.path === '/xleak')).toEqual([]);
    expect(r.status).toBe('stopped');
  }, 60_000);

  it('without a wallet the page has neither window.ethereum nor window.solana (part 1 did not change)', async () => {
    const d = driver();
    try { await d.open(`${base}/sign`); const o = await d.observe(); expect(o.text).toMatch(/not connected/); } finally { await d.close(); }
    const r = await runSiteSession({ url: `${base}/sign`, driver: driver(), values: {} });
    expect(r.status).toBe('stopped'); expect(r.reason).toMatch(/"Connect Wallet" — needs a wallet, a signature or money \(E-13\)/);
  }, 60_000);
});
