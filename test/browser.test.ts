import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSocket } from 'node:dgram';
import { browserReader, probeBrowser, startReaderProxy, READ_PAGE_JS, READER_BROWSER_ARGS } from '../src/analyst/browser.js';
import { startEgressProxy, type EgressProxy } from '../src/exec/siteProxy.js';

// The same check as in production at startup: a trial launch of the binary that chromium.launch() will start
// (headless shell by default, not full Chromium). A folder is not enough: in cloud sessions it holds a different build,
// and the test failed instead of being skipped (#23, Ops 2026-10-29; fix after HQ acceptance #34).
// #144: if the default binary is missing but full Chromium exists (SCARF_TEST_CHROMIUM / /opt/pw-browsers/chromium) — launch with it,
// as in test/siteBrowser.test.ts; without a browser the tests are skipped.
const ARGS = READER_BROWSER_ARGS; // the same parameters as the production reader
const exe = [process.env.SCARF_TEST_CHROMIUM, '/opt/pw-browsers/chromium'].find(p => p && existsSync(p));
const probeOk = !!process.env.PLAYWRIGHT_BROWSERS_PATH && (await probeBrowser()) === undefined;
const launchWith = (extra: string[] = []) => async () => (await import('playwright-core')).chromium.launch(
  !probeOk && exe ? { executablePath: exe, args: ['--no-sandbox', ...ARGS, ...extra] } : { args: [...ARGS, ...extra] });
const launch = launchWith();
let hasBrowser = probeOk;
if (!hasBrowser && exe) { try { const b = await launch(); await b.close(); hasBrowser = true; } catch { hasBrowser = false; } }
// Binaries for the WebRTC test: full Chromium and headless shell (chromium.launch() without executablePath starts it)
const pw = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const headlessShell = [process.env.SCARF_TEST_HEADLESS_SHELL, ...(existsSync(pw) ? readdirSync(pw) : []).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse()
  .flatMap(d => [join(pw, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), join(pw, d, 'chrome-linux', 'headless_shell')])].find(p => p && existsSync(p));
const WEBRTC_BINS = ([['full Chromium', exe], ['headless shell', headlessShell]] as [string, string | undefined][]).filter((x): x is [string, string] => !!x[1]);

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => { for (const s of open.splice(0).reverse()) await s.close(); });
async function service(body: string = 'secret', host = '127.0.0.1') {
  const hits = { http: 0, ws: 0 };
  const srv: Server = createServer((_q, r) => { hits.http++; r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(body); });
  srv.on('upgrade', (_q, sock) => { hits.ws++; sock.destroy(); });
  await new Promise<void>(r => srv.listen(0, host, r));
  open.push({ close: () => new Promise(r => srv.close(r)) });
  return { hits, port: (srv.address() as AddressInfo).port };
}

describe.skipIf(!hasBrowser)('site in a real browser (JS apps, task pages — Chirpochain 2026-10-29)', () => {
  it('renders JS content, lists buttons and reads the task pages of the same site; blocks non-public hosts', async () => {
    const pages: Record<string, string> = {
      '/': `<html><head><title>Chirpo</title></head><body><div id="root"></div><script>
        document.getElementById('root').innerHTML = '<h1>Mine chirpos on Sepolia</h1><button>Connect wallet</button><a href="/quests">Quests</a><a href="/about">About</a><a href="https://x.com/chirpo">X</a>';
      </script></body></html>`,
      '/quests': `<html><body><script>document.body.innerHTML='<h2>Daily quests</h2><ul><li>Follow on X</li><li>Run a miner 1h</li><li>Invite 3 friends</li></ul>'</script></body></html>`,
      '/about': '<html><body>About us</body></html>',
    };
    const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[req.url ?? '/'] ?? 'nope'); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    // Local server: 127.0.0.1 (and its port) is allowed explicitly in the test; the normal mode (reader) rejects it as an internal address
    const reader = browserReader(launch);
    const r2 = browserReader(launch, { resolveHost: async (h) => (h === '127.0.0.1' ? '127.0.0.1' : undefined), ports: () => true });
    const p = await r2.render(`http://127.0.0.1:${port}/`, { tasks: true, timeoutMs: 15_000 });
    expect(p?.text).toContain('Mine chirpos on Sepolia');
    expect(p?.buttons).toContain('Connect wallet');
    expect(p?.tasks?.map(t => t.text).join(' ')).toContain('Run a miner 1h');
    expect(p?.tasks?.some(t => t.url.endsWith('/about'))).toBe(false);
    await expect(reader.render(`http://127.0.0.1:${port}/`)).rejects.toThrow(/non-public/);
    await r2.close(); await reader.close(); srv.close();
  }, 60_000);
});

// #144: the reader proxy decision by default (resolvePublic + web ports) — without a browser
const proxyPort = (p: EgressProxy) => Number(new URL(p.url).port);
const tunnel = (p: EgressProxy, target: string) => new Promise<string>((ok) => {
  const s = connect(proxyPort(p), '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let buf = ''; s.on('data', (c) => { buf += c; if (buf.includes('\r\n')) { ok(buf.split('\r\n')[0]); s.destroy(); } });
  s.on('error', () => ok('error')); s.on('close', () => ok(buf.split('\r\n')[0] || 'closed'));
});
const plain = (p: EgressProxy, url: string) => new Promise<number>((ok) => {
  const r = request({ host: '127.0.0.1', port: proxyPort(p), method: 'GET', path: url, headers: { host: new URL(url).host } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode ?? 0)); });
  r.on('error', () => ok(0)); r.end();
});
async function readerProxy(o?: Parameters<typeof startReaderProxy>[0]) { const p = await startReaderProxy(o); open.push(p); return p; }

describe('#144: reader proxy — the internal network is closed at the connection level', () => {
  it('by default: tunnel (HTTPS, WebSocket) and HTTP to loopback, private networks, link-local, cloud metadata, IPv6 ULA and ::ffff: — 403', async () => {
    const svc = await service();
    const p = await readerProxy({ ports: () => true }); // the service port is allowed — the refusal comes from the address, not the port
    const targets = [`127.0.0.1:${svc.port}`, `[::ffff:127.0.0.1]:${svc.port}`, `[::ffff:7f00:1]:${svc.port}`, `localhost:${svc.port}`, '[::1]:443', '10.0.0.5:443', '172.16.3.4:443',
      '192.168.1.1:443', '169.254.169.254:80', '169.254.10.1:443', '[fd00::1]:443', '[fc12::5]:443', '[fe80::1]:443', '0.0.0.0:443', 'metadata.google.internal:80', 'router.lan:443', 'intranet:80'];
    for (const t of targets) expect([t, await tunnel(p, t)]).toEqual([t, 'HTTP/1.1 403 Forbidden']);
    for (const u of [`http://127.0.0.1:${svc.port}/`, `http://[::ffff:127.0.0.1]:${svc.port}/`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/']) expect([u, await plain(p, u)]).toEqual([u, 403]);
    expect(svc.hits).toEqual({ http: 0, ws: 0 });
  });
  it('by default only web ports (80, 443, 8080, 8443): SSH, mail, databases are closed even on an allowed address', async () => {
    const svc = await service();
    const p = await readerProxy({ resolveHost: async () => '127.0.0.1' }); // "everything is public" — only ports are checked
    for (const t of ['site.example:22', 'site.example:25', 'site.example:5432', `site.example:${svc.port}`]) expect([t, await tunnel(p, t)]).toEqual([t, 'HTTP/1.1 403 Forbidden']);
    expect(svc.hits).toEqual({ http: 0, ws: 0 });
  });
});

// #144: the reader's real Chromium — a page from a Discord link cannot reach the server's internal network
describe.skipIf(!hasBrowser)('#144: the reader in a real browser cannot reach the internal network', () => {
  const PAGE = (host: string, ip: number) => `<html><head><title>Join</title></head><body><h1>Join the mint</h1><div id="out">-</div><script>
    const out = (t) => { document.getElementById('out').innerText += ' ' + t; };
    try { const w = new WebSocket('ws://${host}:${ip}/'); w.onopen = () => out('ws-open'); w.onerror = () => out('ws-error'); } catch (e) { out('ws-throw'); }
    fetch('http://${host}:${ip}/', { mode: 'no-cors' }).then(() => out('fetch-ok'), () => out('fetch-failed'));
    const i = new Image(); i.src = 'http://${host}:${ip}/pixel.png';
  </script></body></html>`;

  it('WebSocket, fetch and an image from the page to 127.0.0.1 — the internal service gets no connection at all; the page itself is read; the proxy closes with the browser', async () => {
    const internal = await service();
    const site = await service(PAGE('127.0.0.1', internal.port));
    const proxies: EgressProxy[] = [];
    // "public" in the test is only the name localhost (the page from Discord); 127.0.0.1 is the server's internal network
    const r = browserReader(launch, { resolveHost: async (h) => (h === 'localhost' ? '127.0.0.1' : undefined), ports: () => true,
      startProxy: async (o) => { const p = await startEgressProxy(o); proxies.push(p); return p; } });
    let page;
    try { page = await r.render(`http://localhost:${site.port}/`, { tasks: false, timeoutMs: 10_000 }); } finally { await r.close(); }
    expect(page?.title).toBe('Join');
    expect(page?.text).toMatch(/Join the mint/);
    expect(page?.text).not.toMatch(/ws-open|fetch-ok/);
    expect(internal.hits).toEqual({ http: 0, ws: 0 });
    expect(site.hits.http).toBeGreaterThanOrEqual(1);
    expect(proxies.length).toBe(1);
    expect(await tunnel(proxies[0], 'example.com:443')).toMatch(/^(error|closed)$/); // the proxy closed together with the browser
  }, 60_000);

  it('the browser crashed (closed by itself) — its proxy closes; the next render starts a new browser and a new proxy', async () => {
    const site = await service('<html><body><h1>Join the mint</h1></body></html>');
    const proxies: EgressProxy[] = []; const browsers: import('playwright-core').Browser[] = [];
    const r = browserReader(async () => { const b = await launch(); browsers.push(b); return b; }, { ports: () => true,
      resolveHost: async (h) => (h === 'localhost' ? '127.0.0.1' : undefined), startProxy: async (o) => { const p = await startEgressProxy(o); proxies.push(p); return p; } });
    try {
      expect((await r.render(`http://localhost:${site.port}/`, { tasks: false }))?.text).toMatch(/Join the mint/);
      await browsers[0].close(); // a "crash" bypassing reader.close()
      await new Promise(res => setTimeout(res, 200));
      expect(await tunnel(proxies[0], 'example.com:443')).toMatch(/^(error|closed)$/);
      expect((await r.render(`http://localhost:${site.port}/`, { tasks: false }))?.text).toMatch(/Join the mint/);
      expect([browsers.length, proxies.length]).toEqual([2, 2]);
    } finally { await r.close(); }
    expect(await tunnel(proxies[1], 'example.com:443')).toMatch(/^(error|closed)$/);
  }, 60_000);

  // Review #144: in production chromium.launch() without executablePath starts headless shell, which understands a different flag than full Chromium
  // — both binaries are checked, whichever exist in the environment
  for (const [name, bin] of WEBRTC_BINS) it(`WebRTC (UDP bypassing the proxy): STUN from the page to an internal address is not sent — ${name}`, async () => {
    const udp = createSocket('udp4'); let packets = 0; udp.on('message', () => { packets++; });
    await new Promise<void>(r => udp.bind(0, '127.0.0.1', r)); open.push({ close: () => new Promise<void>(r => udp.close(() => r())) });
    const stun = udp.address().port;
    const site = await service(`<html><body><h1>Join the mint</h1><script>
      (async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stun}' }] }); pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer()); window.__pc = pc; })();
    </script></body></html>`);
    const r = browserReader(async () => (await import('playwright-core')).chromium.launch({ executablePath: bin, args: ['--no-sandbox', ...READER_BROWSER_ARGS] }),
      { resolveHost: async (h) => (h === 'localhost' ? '127.0.0.1' : undefined), ports: () => true });
    try {
      expect((await r.render(`http://localhost:${site.port}/`, { tasks: false }))?.text).toMatch(/Join the mint/);
      await new Promise(res => setTimeout(res, 1500));
    } finally { await r.close(); }
    expect(packets).toBe(0);
  }, 60_000);

  // Review #144 (R4, R5): a proxy refusal is a refusal (exception "refused…" → "BROWSER FAILED" in the dossier), not site text
  it('a port not in EGRESS_PORTS (a site on http://…:3000 etc.) — refused in the first layer, an exception, not the proxy refusal text', async () => {
    const site = await service('<h1>Real project site</h1>');
    const r = browserReader(launch, { resolveHost: async (h) => (h === 'localhost' ? '127.0.0.1' : undefined) }); // ports — default
    try { await expect(r.render(`http://localhost:${site.port}/`, { tasks: false, timeoutMs: 8_000 })).rejects.toThrow(/^refused/); } finally { await r.close(); }
    expect(site.hits.http).toBe(0);
  }, 60_000);

  it('a redirect to an internal address (main page — exception "refused…"; task page — dropped), the service gets nothing', async () => {
    const internal = await service();
    const pages: Record<string, { status?: number; location?: string; body?: string }> = {
      '/go': { status: 302, location: `http://127.0.0.1:${internal.port}/` },
      '/quests': { status: 302, location: `http://127.0.0.1:${internal.port}/quests` },
      '/': { body: '<html><head><title>Join</title></head><body><h1>Join the mint</h1><a href="/quests">Quests</a></body></html>' },
    };
    const srv = createServer((q, res) => { const x = pages[q.url ?? '/'] ?? { body: 'nope' };
      res.writeHead(x.status ?? 200, { 'content-type': 'text/html', ...(x.location ? { location: x.location } : {}) }); res.end(x.body ?? ''); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r)); open.push({ close: () => new Promise(r => srv.close(r)) });
    const port = (srv.address() as AddressInfo).port;
    const r = browserReader(launch, { resolveHost: async (h) => (h === 'localhost' ? '127.0.0.1' : undefined), ports: () => true });
    let main;
    try {
      await expect(r.render(`http://localhost:${port}/go`, { tasks: false, timeoutMs: 8_000 })).rejects.toThrow(/^refused/);
      main = await r.render(`http://localhost:${port}/`, { tasks: true, timeoutMs: 10_000 });
    } finally { await r.close(); }
    expect(main?.text).toMatch(/Join the mint/);
    expect(main?.tasks).toBeUndefined(); // the task page was refused — its "text" (the proxy response) does not get into the dossier
    expect(internal.hits).toEqual({ http: 0, ws: 0 });
  }, 60_000);

  // HQ decision on review #144: a subresource refusal (fetch with a redirect, TURN over TCP, WebSocket, image, iframe) is blocked silently,
  // the dossier is not lost; an exception only if the main navigation was refused
  it('subresource refusals (fetch and iframe redirect to an internal address, TURN over TCP, WebSocket) — the render returns the page text; the service gets nothing', async () => {
    const internal = await service();
    let tcp = 0; const t = createNetServer((s) => { tcp++; s.destroy(); }); await new Promise<void>(r => t.listen(0, '127.0.0.1', r));
    open.push({ close: () => new Promise(r => t.close(r)) }); const tp = (t.address() as AddressInfo).port;
    const pages: Record<string, { status?: number; location?: string; body?: string }> = {
      '/r': { status: 302, location: `http://127.0.0.1:${internal.port}/x` },
      '/f': { status: 302, location: `http://127.0.0.1:${internal.port}/frame` },
      '/': { body: `<html><head><title>Join</title></head><body><h1>Join the mint</h1><iframe src="/f"></iframe><script>
        fetch('/r').then(r => r.text()).then(t => document.body.append('GOT:' + t), () => document.body.append(' fetch-failed'));
        try { new WebSocket('ws://127.0.0.1:${internal.port}/'); } catch (e) {}
        (async () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: ['turn:127.0.0.1:${tp}?transport=tcp'], username: 'u', credential: 'p' }], iceTransportPolicy: 'relay' });
          pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer()); window.__pc = pc; })();
      </script></body></html>` },
    };
    const srv = createServer((q, res) => { const x = pages[q.url ?? '/'] ?? { body: 'nope' };
      res.writeHead(x.status ?? 200, { 'content-type': 'text/html', ...(x.location ? { location: x.location } : {}) }); res.end(x.body ?? ''); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r)); open.push({ close: () => new Promise(r => srv.close(r)) });
    const port = (srv.address() as AddressInfo).port;
    const r = browserReader(launch, { resolveHost: async (h) => (h === 'localhost' ? '127.0.0.1' : undefined), ports: () => true });
    let page;
    try { page = await r.render(`http://localhost:${port}/`, { tasks: false, timeoutMs: 10_000 }); await new Promise(res => setTimeout(res, 1000)); } finally { await r.close(); }
    expect(page?.text).toMatch(/Join the mint/);
    expect(page?.text).not.toMatch(/GOT:secret|refused: non-public host/);
    expect({ ...internal.hits, tcp }).toEqual({ http: 0, ws: 0, tcp: 0 });
  }, 60_000);

  it('DNS rebinding: at check time the name is public, for Chromium itself it is an internal address; the proxy decides the connection — the internal service gets nothing', async () => {
    // The internal service is on 127.0.0.2. For Chromium the name rebind.scarf-test.invalid points to it (--host-resolver-rules — "DNS at
    // connection time"), while the check (resolveHost — "DNS at check time") returns 127.0.0.1, where this service is absent. Without a proxy Chromium
    // would resolve the name itself and reach 127.0.0.2; with the proxy it does not resolve the name — the proxy resolves it once and connects to the checked IP.
    const internal = await service('secret', '127.0.0.2');
    const site = await service(PAGE('rebind.scarf-test.invalid', internal.port));
    const asked: string[] = [];
    const r = browserReader(launchWith(['--host-resolver-rules=MAP rebind.scarf-test.invalid 127.0.0.2']), { ports: () => true,
      resolveHost: async (h, port) => { asked.push(`${h}:${port}`); return h === 'localhost' || h === 'rebind.scarf-test.invalid' ? '127.0.0.1' : undefined; } });
    let page;
    try { page = await r.render(`http://localhost:${site.port}/`, { tasks: false, timeoutMs: 10_000 }); } finally { await r.close(); }
    expect(page?.text).toMatch(/Join the mint/);
    expect(asked).toContain(`rebind.scarf-test.invalid:${internal.port}`); // the page tried — and the check made the decision
    expect(internal.hits).toEqual({ http: 0, ws: 0 });
  }, 60_000);
});

// Journal 2026-10-29: on the server (tsx, esbuild keepNames) every render failed with "__name is not defined".
// Without a browser: the page code is a string, runs on its own, and browser.ts has no evaluate with a function.
describe('page script survives keepNames builds (journal 2026-10-29: __name is not defined on every site)', () => {
  it('READ_PAGE_JS is plain JS that runs without build helpers', () => {
    const el = (innerText: string, href?: string) => ({ innerText, href, getAttribute: () => null });
    const doc = { title: 'Chirpo', body: { innerText: 'Mine  chirpos\n\n on Sepolia' },
      querySelectorAll: (sel: string) => sel === 'a[href]' ? [el(' Quests ', 'https://s.xyz/quests'), el('mail', 'mailto:a@b.c')] : [el('Connect wallet'), el('Connect wallet'), el('')] };
    const run = new Function('document', '__name', `return ${READ_PAGE_JS}`);
    expect(run(doc, undefined)).toEqual({ title: 'Chirpo', text: 'Mine chirpos on Sepolia', links: [{ text: 'Quests', href: 'https://s.xyz/quests' }], buttons: ['Connect wallet'] });
  });
  it('browser.ts never passes a function to evaluate (it would get __name inserts under tsx)', () => {
    const src = readFileSync(new URL('../src/analyst/browser.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\.evaluate\(\s*(async\s*)?(\(|function|[A-Za-z_$][\w$]*\s*=>)/);
    expect(src).toMatch(/\.evaluate\(READ_PAGE_JS\)/);
  });
});
