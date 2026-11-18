// E-06 (#16), acceptance #143 W1: a local proxy for the session browser — blocking the internal network at the connection level.
// Request interception in Playwright (ctx.route) sees HTTP but not WebSocket, and checks the name while Chromium connects by itself: between the check
// and the connection the name may "move" to an internal address (DNS rebinding). Here the rule sits where the connection is opened:
//  • the session browser goes online ONLY through this proxy (including 127.0.0.1 addresses — the `<-loopback>` rule);
//  • the proxy resolves the name itself, refuses if any address is internal, and connects exactly to the checked IP;
//  • HTTPS and WebSocket go through a CONNECT tunnel, plain HTTP — by forwarding; ports — only from the list.
// The proxy listens on 127.0.0.1 on a random port and lives for one session. It holds no agent keys or data.
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import { isPrivateIp } from '../analyst/enrich.js';

/** Ports the session browser may go out to: web and two common alternates. */
export const EGRESS_PORTS: readonly number[] = [80, 443, 8080, 8443];

/** Where to connect for host: a checked public IP or undefined (refusal). The name is resolved right here — there is no second resolution. */
export async function resolvePublic(host: string): Promise<string | undefined> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(h)) return isPrivateIp(h) ? undefined : h;
  if (!h.includes('.') || /^(localhost|.*\.(local|internal|lan|home|corp|localhost))$/.test(h)) return undefined;
  try {
    const addrs = await lookup(h, { all: true });
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) return undefined;
    return (addrs.find(a => a.family === 4) ?? addrs[0]).address;
  } catch { return undefined; }
}

export interface EgressProxyOpts {
  /** Address check and choice; default resolvePublic. In tests — allow a local site. */
  resolve?: (host: string, port: number) => Promise<string | undefined>;
  ports?: readonly number[] | ((port: number) => boolean);
  idleMs?: number;
  /** Every refusal ("host:port") — without a count limit, unlike the refused list (#144: the reader turns a refusal into an exception). */
  onDeny?: (what: string) => void;
}
export interface EgressProxy {
  /** Address for the browser: http://127.0.0.1:<port>. */
  url: string;
  /** Refusals during the session: "host:port" (for the journal and tests). */
  refused: string[];
  close(): Promise<void>;
}

const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'transfer-encoding']);

export async function startEgressProxy(opts: EgressProxyOpts = {}): Promise<EgressProxy> {
  const resolve = opts.resolve ?? ((h: string) => resolvePublic(h));
  const list = typeof opts.ports === 'function' ? undefined : (opts.ports ?? EGRESS_PORTS);
  const portOk = typeof opts.ports === 'function' ? opts.ports : (p: number) => list!.includes(p);
  const idle = opts.idleMs ?? 60_000;
  const refused: string[] = []; const socks = new Set<Socket>();
  const track = (s: Socket) => { socks.add(s); s.setTimeout(idle, () => s.destroy()); s.on('close', () => socks.delete(s)); s.on('error', () => s.destroy()); return s; };
  const pick = async (host: string, port: number): Promise<string | undefined> => {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !portOk(port)) return undefined;
    return resolve(host, port).catch(() => undefined);
  };
  const deny = (what: string) => { if (refused.length < 200) refused.push(what); try { opts.onDeny?.(what); } catch { /* the observer does not affect the proxy */ } };

  const server: Server = createServer((req: IncomingMessage, res) => {
    // Plain HTTP: the browser sends the full address
    let u: URL;
    try { u = new URL(req.url ?? ''); } catch { res.writeHead(400).end(); return; }
    if (u.protocol !== 'http:') { res.writeHead(400).end(); return; }
    const port = Number(u.port || 80);
    void pick(u.hostname, port).then((ip) => {
      if (!ip) { deny(`${u.hostname}:${port}`); res.writeHead(403, { 'content-type': 'text/plain' }).end('refused: non-public host'); return; }
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
      headers.host = u.host;
      const up = httpRequest({ host: ip, port, method: req.method, path: `${u.pathname}${u.search}`, headers, timeout: idle }, (r) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
        res.writeHead(r.statusCode ?? 502, out); r.pipe(res);
      });
      up.on('timeout', () => up.destroy()); up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(up);
    });
  });
  // HTTPS and WebSocket: a tunnel. The connection — to the checked IP, not to the name
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    track(client);
    const m = /^(\[[0-9a-f:.]+\]|[^:]+):(\d+)$/i.exec(req.url ?? '');
    if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const host = m[1]; const port = Number(m[2]);
    void pick(host, port).then((ip) => {
      if (!ip) { deny(`${host}:${port}`); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const up = track(connect(port, ip));
      up.on('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) up.write(head); up.pipe(client); client.pipe(up); });
      up.on('error', () => { if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
      up.on('close', () => client.destroy()); client.on('close', () => up.destroy());
    });
  });
  server.on('connection', (s) => { track(s); });
  server.on('clientError', (_e, s) => { s.destroy(); });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.off('error', fail); ok(); }); });
  // Review #144: a server error after start (EMFILE/ENFILE on accept) — without a handler this crashes the agent process.
  // The server keeps listening; one journal line per proxy
  let warned = false;
  server.on('error', (e) => { if (!warned) { warned = true; console.warn(`egress proxy: ${String((e as Error).message ?? e).slice(0, 120)}`); } });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, refused,
    async close() { for (const s of socks) s.destroy(); await new Promise<void>(r => server.close(() => r())); },
  };
}
