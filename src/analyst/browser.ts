// Reads websites in a real browser (headless Chromium) — for JavaScript app sites where without a browser
// only one line is visible (OOLONG, Chirpochain 2026-10-28/29: "the site has other tasks too, the agent ignored them").
// Read-only: no wallet, no login, no downloads, no images; every call is a clean profile.
// Protection against internal-network access (#144, same as site sessions — #143 W1): the reader's Chromium goes out ONLY through
// the local proxy src/exec/siteProxy.ts — HTTP, HTTPS (CONNECT) and WebSocket, including 127.0.0.1 addresses (`<-loopback>`).
// The proxy resolves the name itself, refuses internal addresses and connects exactly to the checked IP — DNS rebinding
// between check and connect does not get through. Request and WebSocket interception in Playwright is the first layer (fast refusal, images).
// The proxy lives as long as the reader's browser and closes with it.
import type { Browser } from 'playwright-core';
import { EGRESS_PORTS, resolvePublic, startEgressProxy, type EgressProxy, type EgressProxyOpts } from '../exec/siteProxy.js';

export interface RenderedPage {
  url: string; title?: string; text: string;
  /** Page links (text → address), up to 40. */ links: { text: string; href: string }[];
  /** Buttons and menu items — they show which actions the site offers. */ buttons: string[];
  /** Internal pages with tasks/quests/points (up to 3), read right after. */ tasks?: { url: string; title?: string; text: string }[];
  rendered: true;
}

const TASK_RE = /task|quest|mission|point|airdrop|earn|reward|campaign|invite|referr|faucet|mine|mining|genesis|leaderboard|season|stake|farm|claim|whitelist|allowlist|mint/i;

export interface BrowserReaderOpts {
  /**
   * Where to connect for a host: the checked IP or undefined (refusal). Default — resolvePublic (public addresses only).
   * One function for both layers — request interception and the proxy. In tests — allow the local site.
   */
  resolveHost?: (host: string, port: number) => Promise<string | undefined>;
  /** Ports allowed for egress (default: the proxy's EGRESS_PORTS); in tests — the local site's port. */
  ports?: EgressProxyOpts['ports'];
  /** How to start the proxy (default startEgressProxy); in tests — to observe its address and closing. */
  startProxy?: (o: EgressProxyOpts) => Promise<EgressProxy>;
}

/** Reader proxy: the connect decision is resolveHost (default resolvePublic), ports are EGRESS_PORTS unless set. */
export function startReaderProxy(opts: BrowserReaderOpts = {}, onDeny?: (what: string) => void): Promise<EgressProxy> {
  return (opts.startProxy ?? startEgressProxy)({ resolve: opts.resolveHost ?? ((h: string) => resolvePublic(h)), ports: opts.ports, onDeny });
}
/** The same port policy as the proxy (the first layer must not let through what the proxy will refuse). */
const portPolicy = (ports: BrowserReaderOpts['ports']) => (typeof ports === 'function' ? ports : (p: number) => (ports ?? EGRESS_PORTS).includes(p));
/**
 * Reader Chromium flags. WebRTC (UDP bypassing the proxy: STUN/TURN to internal addresses) — proxy only, i.e. off.
 * There are two flags and both are needed (tested on both binaries, review #144): full Chromium understands only
 * `--webrtc-ip-handling-policy`, while headless shell — launched by chromium.launch() without executablePath, i.e. prod — only
 * `--force-webrtc-ip-handling-policy`. Each silently ignores the other's flag.
 */
export const READER_BROWSER_ARGS: readonly string[] = ['--disable-dev-shm-usage', '--no-first-run',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];
const portOf = (u: URL) => Number(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80));

interface PageRead { title: string; text: string; links: { text: string; href: string }[]; buttons: string[] }
/**
 * Code that runs inside the page is a string, not a function. The server runs the agent via tsx (esbuild with keepNames):
 * a function passed to evaluate got __name(...) insertions that do not exist in the page, and failed with
 * "ReferenceError: __name is not defined" on every site (log 2026-10-29: all browse_site calls and renders). vitest has no keepNames,
 * so the browser test did not see it. The bundler does not change a string.
 */
export const READ_PAGE_JS = `(() => {
  const clean = (s) => s.replace(/\\s+/g, ' ').trim();
  const links = [...document.querySelectorAll('a[href]')].map(a => ({ text: clean(a.innerText || a.getAttribute('aria-label') || ''), href: a.href }))
    .filter(l => l.href.startsWith('http')).slice(0, 80);
  const buttons = [...document.querySelectorAll('button, [role="button"], [role="tab"], nav a')].map(e => clean(e.innerText || '')).filter(t => t && t.length < 60);
  return { title: document.title, text: clean(document.body?.innerText ?? ''), links, buttons: [...new Set(buttons)].slice(0, 40) };
})()`;

export interface BrowserReader { render(url: string, opts?: { tasks?: boolean; timeoutMs?: number }): Promise<RenderedPage | undefined>; close(): Promise<void> }

/** One browser (and its proxy) per process, pages one at a time (queue), the browser closes after 5 min idle. */
export function browserReader(launch?: () => Promise<Browser>, opts: BrowserReaderOpts = {}): BrowserReader {
  /** denied — this browser's proxy refusals: an unbounded counter and the latest (up to 200) "host:port". */
  type Session = { browser: Browser; proxy: EgressProxy; denied: { n: number; recent: string[] } };
  let session: Promise<Session> | undefined; let idle: NodeJS.Timeout | undefined; let chain: Promise<unknown> = Promise.resolve();
  const resolveHost = opts.resolveHost ?? ((h: string) => resolvePublic(h));
  const portOk = portPolicy(opts.ports);
  const getSession = (): Promise<Session> => {
    if (session) return session;
    const s: Promise<Session> = (async () => {
      const denied = { n: 0, recent: [] as string[] };
      const proxy = await startReaderProxy(opts, (what) => { denied.n++; denied.recent.push(what); if (denied.recent.length > 200) denied.recent.shift(); });
      let browser: Browser;
      try { browser = await (launch ?? (async () => (await import('playwright-core')).chromium.launch({ args: [...READER_BROWSER_ARGS] })))(); }
      catch (e) { await proxy.close().catch(() => {}); throw e; }
      // Browser crashed or closed — the proxy closes with it; the next render starts both again
      browser.on('disconnected', () => { if (session === s) session = undefined; void proxy.close().catch(() => {}); });
      return { browser, proxy, denied };
    })();
    session = s;
    return s;
  };
  const close = async () => {
    const s = session; session = undefined; if (!s) return;
    const v = await s.catch(() => undefined); if (!v) return;
    await v.browser.close().catch(() => {}); await v.proxy.close().catch(() => {});
  };
  const touch = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { void close(); }, 5 * 60_000); idle.unref?.(); };

  const renderOne = async (url: string, ro: { tasks?: boolean; timeoutMs?: number } = {}): Promise<RenderedPage | undefined> => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s)');
    // First layer (Playwright interception): port per the proxy policy, host:port must be allowed.
    // The deciding layer is the proxy: it checks and connects to the same IP
    const allowed = new Map<string, Promise<boolean>>();
    const isPublic = (x: URL) => {
      const port = portOf(x); const k = `${x.hostname}:${port}`;
      let v = allowed.get(k);
      if (!v) { v = portOk(port) ? resolveHost(x.hostname, port).then(ip => !!ip, () => false) : Promise.resolve(false); allowed.set(k, v); }
      return v;
    };
    if (!(await isPublic(u))) {
      // Internal host — "non-public" on any port; a public site on :3000 etc. — port refusal (not the proxy refusal text)
      const hostOk = await resolveHost(u.hostname, portOf(u)).then(ip => !!ip, () => false);
      throw new Error(hostOk && !portOk(portOf(u)) ? `refused: port ${portOf(u)} is not allowed` : 'refused: non-public host');
    }
    const { browser: b, proxy, denied } = await getSession();
    touch();
    // All egress goes through the proxy, including 127.0.0.1 addresses (`<-loopback>` removes Chromium's built-in exception)
    const ctx = await b.newContext({ proxy: { server: proxy.url, bypass: '<-loopback>' }, acceptDownloads: false, serviceWorkers: 'block', javaScriptEnabled: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' });
    try {
      await ctx.route('**/*', async (route) => {
        const req = route.request();
        let ru: URL; try { ru = new URL(req.url()); } catch { return route.abort(); }
        if (ru.protocol === 'data:' || ru.protocol === 'blob:') return route.continue();
        if (ru.protocol !== 'https:' && ru.protocol !== 'http:') return route.abort();
        if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort();
        if (!(await isPublic(ru))) return route.abort();
        return route.continue();
      });
      // Request interception does not see WebSocket — it has its own: an internal host is closed at once, a public one connects (via the proxy)
      await ctx.routeWebSocket(/.*/, async (ws) => {
        let wu: URL | undefined; try { wu = new URL(ws.url()); } catch { wu = undefined; }
        if (!wu || (wu.protocol !== 'wss:' && wu.protocol !== 'ws:') || !(await isPublic(wu))) { await ws.close({ code: 1008, reason: 'refused' }).catch(() => undefined); return; }
        ws.connectToServer();
      });
      const deadline = Date.now() + (ro.timeoutMs ?? 15_000);
      // A proxy refusal of the MAIN navigation (top-frame document, including its redirects and script navigation) throws "refused…":
      // otherwise the proxy's 403 would be read as site text, and the dossier would get "refused: non-public host" instead of "BROWSER FAILED".
      // Subresource refusals (images, scripts, fetch, WebSocket, iframe) are blocked silently — the site is still read (HQ decision, review #144)
      const read = async (target: string) => {
        const before = denied.n; const nav = new Set<string>();
        const refusal = () => {
          const k = Math.min(denied.n - before, denied.recent.length);
          const hit = k > 0 ? denied.recent.slice(denied.recent.length - k).find(w => nav.has(w)) : undefined;
          return hit ? new Error(`refused: blocked by egress proxy (${hit.slice(0, 80)})`) : undefined;
        };
        const p = await ctx.newPage();
        // Every main-navigation step (a redirect is a separate request) — "host:port" in the same format as proxy refusals
        p.on('request', (q) => {
          if (!q.isNavigationRequest() || q.frame() !== p.mainFrame()) return;
          try { const x = new URL(q.url()); nav.add(`${x.hostname}:${portOf(x)}`); } catch { /* not http */ }
        });
        try {
          await p.goto(target, { waitUntil: 'domcontentloaded', timeout: Math.max(3_000, deadline - Date.now()) });
          await p.waitForLoadState('networkidle', { timeout: Math.min(5_000, Math.max(500, deadline - Date.now())) }).catch(() => {});
          const r = await p.evaluate(READ_PAGE_JS) as PageRead;
          const e = refusal(); if (e) throw e;
          return r;
        } catch (e) { throw refusal() ?? e; } finally { await p.close().catch(() => {}); }
      };
      const main = await read(url);
      const page: RenderedPage = { url, title: main.title?.slice(0, 150), text: main.text.slice(0, 6000), links: dedupeLinks(main.links).slice(0, 40), buttons: main.buttons, rendered: true };
      if (ro.tasks !== false) {
        const base = registrable(u.hostname);
        const cands = dedupeLinks(main.links).filter(l => { try { const lu = new URL(l.href); return registrable(lu.hostname) === base && lu.href !== u.href && (TASK_RE.test(l.text) || TASK_RE.test(lu.pathname)); } catch { return false; } }).slice(0, 3);
        const tasks: NonNullable<RenderedPage['tasks']> = [];
        for (const c of cands) {
          if (Date.now() > deadline - 2_000) break;
          const t = await read(c.href).catch(() => undefined);
          if (t) tasks.push({ url: c.href, title: t.title?.slice(0, 120), text: t.text.slice(0, 2500) });
        }
        if (tasks.length) page.tasks = tasks;
      }
      return page;
    } finally { await ctx.close().catch(() => {}); touch(); }
  };

  return {
    render(url, o) { const r = chain.then(() => renderOne(url, o)); chain = r.catch(() => {}); return r; },
    close,
  };
}

/** Whether the server has a browser: a trial launch (without it sites are read without JS, as before). */
export async function probeBrowser(): Promise<string | undefined> {
  try { const { chromium } = await import('playwright-core'); const b = await chromium.launch(); await b.close(); return undefined; }
  catch (e) { return String((e as Error).message ?? e).split('\n')[0].slice(0, 160); }
}

const registrable = (h: string) => h.replace(/^www\./, '').split('.').slice(-2).join('.');
function dedupeLinks(ls: { text: string; href: string }[]) {
  const seen = new Set<string>(); const out: { text: string; href: string }[] = [];
  for (const l of ls) { const k = l.href.replace(/#.*$/, ''); if (seen.has(k)) continue; seen.add(k); out.push({ text: l.text.slice(0, 60), href: k }); }
  return out;
}
