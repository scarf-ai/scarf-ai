// E-06 (#16), acceptance #143 W1: the local proxy of the session browser — blocking the internal network at the connection level.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { startEgressProxy, resolvePublic, EGRESS_PORTS, type EgressProxy } from '../src/exec/siteProxy.js';
import { SITE_BROWSER_ARGS } from '../src/exec/siteBrowser.js';

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });
async function service(body = 'secret') {
  const hits = { http: 0, ws: 0 };
  const srv: Server = createServer((_q, r) => { hits.http++; r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(body); });
  srv.on('upgrade', (_q, sock) => { hits.ws++; sock.destroy(); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  open.push({ close: () => new Promise(r => srv.close(r)) });
  return { hits, port: (srv.address() as AddressInfo).port };
}
async function proxy(o?: Parameters<typeof startEgressProxy>[0]): Promise<EgressProxy> { const p = await startEgressProxy(o); open.push(p); return p; }
const proxyPort = (p: EgressProxy) => Number(new URL(p.url).port);
/** CONNECT through the proxy: the first response line. */
const tunnel = (p: EgressProxy, target: string) => new Promise<string>((ok) => {
  const s = connect(proxyPort(p), '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let buf = ''; s.on('data', (c) => { buf += c; if (buf.includes('\r\n')) { ok(buf.split('\r\n')[0]); s.destroy(); } });
  s.on('error', () => ok('error')); s.on('close', () => ok(buf.split('\r\n')[0] || 'closed'));
});
/** Plain HTTP through the proxy: status and body. */
const plain = (p: EgressProxy, url: string) => new Promise<{ status: number; body: string }>((ok) => {
  const r = request({ host: '127.0.0.1', port: proxyPort(p), method: 'GET', path: url, headers: { host: url.startsWith('http') ? new URL(url).host : 'x' } }, (res) => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => ok({ status: res.statusCode ?? 0, body: b }));
  });
  r.on('error', () => ok({ status: 0, body: '' })); r.end();
});

describe('E-06 W1: resolvePublic — where connecting is allowed', () => {
  it('internal addresses and names — refused: loopback, private networks, cloud metadata, IPv6, IPv4 inside IPv6, localhost, a name without a dot', async () => {
    for (const h of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', '::ffff:127.0.0.1', 'fd00::1', 'localhost', 'redis', 'db.internal', 'printer.local'])
      expect([h, await resolvePublic(h)]).toEqual([h, undefined]);
  });
  it('a public IP — itself (the name is not resolved again)', async () => {
    expect(await resolvePublic('1.1.1.1')).toBe('1.1.1.1');
  });
  it('review #144: IPv6 in expanded and non-standard notation is normalized before the check — refused', async () => {
    for (const h of ['0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '0:0:0:0:0:0:0:0', '0:0:0:0:0:ffff:7f00:1', '[0:0:0:0:0:FFFF:A9FE:A9FE]', '::7f00:1',
      '::ffff:0:7f00:1', '0064:ff9b:0:0:0:0:7f00:1', 'FD00:0:0:0:0:0:0:1', 'FE80:0:0:0:0:0:0:1', 'FF02:0:0:0:0:0:0:1', '64:ff9b:1::a00:1'])
      expect([h, await resolvePublic(h)]).toEqual([h, undefined]);
    // public IPv6 still pass — in both compressed and expanded notation
    for (const h of ['2606:4700:4700::1111', '2606:4700:4700:0:0:0:0:1111']) expect([h, await resolvePublic(h)]).toEqual([h, h]);
  });
  it('review #144: a raw CONNECT to the expanded notation [0:0:0:0:0:ffff:7f00:1] — 403, the service gets no connection', async () => {
    const svc = await service(); const p = await proxy({ ports: () => true });
    expect(await tunnel(p, `[0:0:0:0:0:ffff:7f00:1]:${svc.port}`)).toBe('HTTP/1.1 403 Forbidden');
    expect(await tunnel(p, `[0:0:0:0:0:0:0:1]:${svc.port}`)).toBe('HTTP/1.1 403 Forbidden');
    expect(svc.hits).toEqual({ http: 0, ws: 0 });
  });
});

describe('E-06 W1: the proxy refuses internal addresses on connect', () => {
  it('a tunnel (HTTPS, WebSocket) to 127.0.0.1, a private network, cloud metadata and localhost — 403; the service gets no connection', async () => {
    const svc = await service(); const p = await proxy({ ports: () => true });
    expect(await tunnel(p, `127.0.0.1:${svc.port}`)).toMatch(/403/);
    expect(await tunnel(p, `localhost:${svc.port}`)).toMatch(/403/);
    expect(await tunnel(p, '169.254.169.254:80')).toMatch(/403/);
    expect(await tunnel(p, '10.0.0.5:443')).toMatch(/403/);
    expect(await tunnel(p, '[::1]:443')).toMatch(/403/);
    expect(svc.hits).toEqual({ http: 0, ws: 0 });
    expect(p.refused).toEqual([`127.0.0.1:${svc.port}`, `localhost:${svc.port}`, '169.254.169.254:80', '10.0.0.5:443', '[::1]:443']);
  });

  it('plain HTTP to an internal address — 403; non-HTTP and garbage — 400', async () => {
    const svc = await service(); const p = await proxy({ ports: () => true });
    expect((await plain(p, `http://127.0.0.1:${svc.port}/admin`)).status).toBe(403);
    expect((await plain(p, '/etc/passwd')).status).toBe(400);
    expect(svc.hits.http).toBe(0);
  });

  it('ports: by default only web (80, 443, 8080, 8443) — SSH, mail and databases are closed even for a public address', async () => {
    expect([...EGRESS_PORTS]).toEqual([80, 443, 8080, 8443]);
    const p = await proxy({ resolve: async () => '127.0.0.1' }); // the address is allowed — it is the port that is checked
    for (const port of [22, 25, 5432, 6379, 3306]) expect(await tunnel(p, `example.com:${port}`)).toMatch(/403/);
  });

  it('the connection goes to the IP the check returned, not to the name: the name is asked once (DNS spoofing is closed)', async () => {
    const svc = await service('public page'); const asked: string[] = [];
    const p = await proxy({ ports: () => true, resolve: async (h) => { asked.push(h); return h === 'task.scarf-test.invalid' ? '127.0.0.1' : undefined; } });
    const r = await plain(p, `http://task.scarf-test.invalid:${svc.port}/`);
    expect(r).toEqual({ status: 200, body: 'public page' });
    expect(await tunnel(p, `task.scarf-test.invalid:${svc.port}`)).toMatch(/200/);
    expect(asked).toEqual(['task.scarf-test.invalid', 'task.scarf-test.invalid']); // once per connection
  });

  it('an address check failure — refused, not let through', async () => {
    const p = await proxy({ ports: () => true, resolve: async () => { throw new Error('dns down'); } });
    expect(await tunnel(p, 'example.com:443')).toMatch(/403/);
  });
});

// The same block in a real Chromium when there is nothing but the proxy: no request interception, no WebSocket interception
const exe = [process.env.SCARF_TEST_CHROMIUM, '/opt/pw-browsers/chromium'].find(p => p && existsSync(p));
const launch = async () => (await import('playwright-core')).chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox', ...SITE_BROWSER_ARGS] } : { args: [...SITE_BROWSER_ARGS] });
let hasBrowser = false;
try { if (exe || process.env.PLAYWRIGHT_BROWSERS_PATH) { const b = await launch(); await b.close(); hasBrowser = true; } } catch { hasBrowser = false; }

describe.skipIf(!hasBrowser)('E-06 W1: the proxy alone, without Playwright interception', () => {
  it('WebSocket and fetch from the page to 127.0.0.1 do not reach the internal service; the site itself (an allowed name) opens', async () => {
    const internal = await service();
    const site = await service(`<html><body><h1>Join</h1><div id="out">-</div><script>
      const out = (t) => { document.getElementById('out').innerText += ' ' + t; };
      const w = new WebSocket('ws://127.0.0.1:${internal.port}/'); w.onopen = () => out('ws-open'); w.onerror = () => out('ws-error');
      fetch('http://127.0.0.1:${internal.port}/', { mode: 'no-cors' }).then(() => out('fetch-ok'), () => out('fetch-failed'));
    </script></body></html>`);
    const p = await proxy({ ports: () => true, resolve: async (h) => (h === 'task.scarf-test.invalid' ? '127.0.0.1' : undefined) });
    const b = await launch();
    try {
      const ctx = await b.newContext({ proxy: { server: p.url, bypass: '<-loopback>' } });
      const page = await ctx.newPage();
      await page.goto(`http://task.scarf-test.invalid:${site.port}/`, { waitUntil: 'domcontentloaded' });
      // fetch gets the proxy's own 403 answer (for the page it is a "server answer"), WebSocket — a connection error
      await page.waitForFunction(`/ws-error/.test(document.getElementById('out').innerText) && /fetch-/.test(document.getElementById('out').innerText)`, undefined, { timeout: 10_000 });
      expect(await page.innerText('#out')).not.toMatch(/ws-open/);
    } finally { await b.close(); }
    expect(internal.hits).toEqual({ http: 0, ws: 0 });
    expect(p.refused.filter(x => x === `127.0.0.1:${internal.port}`).length).toBeGreaterThanOrEqual(2); // both WebSocket and fetch came to the proxy and were refused
  }, 60_000);
});
