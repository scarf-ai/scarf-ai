// E-06 (#16): a real browser driver for a session on a task site (Chromium via playwright-core).
// Difference from the Analyst's reader (src/analyst/browser.ts): here the page is not only read — things are typed into it and clicked.
// So the restrictions are stricter and live in the driver itself, not only in the session rules:
//  • a clean profile for every session: no login, no cookies from past sessions; a wallet on the page — only if the session was given one
//    (attachWallet, part 2), and it is a keyless "socket": the site's requests are decided by SiteWallet in Node;
//  • file downloads and service workers are forbidden; there are no permissions (camera, geolocation, clipboard);
//  • the server's internal network is closed at the connection level: the browser goes online only through a local proxy (siteProxy.ts), which
//    resolves the name itself and connects exactly to the checked public IP — this closes both WebSocket and DNS spoofing (acceptance #143, W1);
//    on top — a host check in request and WebSocket interception, WebRTC — only through the proxy;
//  • popups and new tabs are closed immediately (links to X open exactly those);
//  • page dialogs (alert / confirm / prompt) are dismissed.
// Which actions are allowed is decided by src/exec/siteSession.ts (refuseAction); the driver only executes them.
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { startEgressProxy, resolvePublic, type EgressProxy } from './siteProxy.js';
import { normObservation, normOption, sameSite, type Observation, type PageWallet, type SiteDriver } from './siteSession.js';
import type { Frame } from 'playwright-core';

/**
 * Code that runs on the page (and in each of its frames from the same site): collects visible fields, lists, checkboxes, switches,
 * buttons and links and marks every element with the data-scarf-id attribute. Passed as a string: under tsx a function would get a
 * `__name` wrapper that does not exist on the page (like READ_PAGE_JS). The driver substitutes __PREFIX__: '' for the page, 'i1-' … for frames.
 * #148 item 2: open shadow DOM; the form group (form) and the required flag (required) on fields; "header and footer" (chrome);
 * overlap by another element (covered); the consent button in a cookie banner (cookie); labels from svg title / img alt; hidden
 * (sr-only) checkboxes; select with options; radio and role=radio / option. Limit — 120 fields, 80 buttons, 60 links.
 */
export const OBSERVE_JS = `(() => {
  const P = __PREFIX__;
  const CAP = { field: 120, button: 80, link: 60 };
  const clean = (t, n) => String(t || '').replace(/\\s+/g, ' ').trim().slice(0, n || 160);
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01; };
  // All page elements, including open shadow DOM (Reown AppKit / Web3Modal / Dynamic wallet windows live there)
  const all = [];
  const walk = (root) => { root.querySelectorAll('*').forEach((e) => { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); }); };
  walk(document);
  const up = (n) => (n ? (n.parentNode || n.host || null) : null); // up the tree across the shadow DOM boundary
  const chain = (n) => { const out = []; while (n) { out.push(n); n = up(n); } return out; };
  const rootOf = (e) => { const r = e.getRootNode(); return r && r.querySelector ? r : document; };
  const shadowText = (root) => { let t = ''; root.querySelectorAll('*').forEach((n) => { if (n.parentNode === root) t += ' ' + (n.innerText || ''); if (n.shadowRoot) t += ' ' + shadowText(n.shadowRoot); }); return t; };
  const slotText = (e) => { let t = ''; if (e.querySelectorAll) e.querySelectorAll('slot').forEach((s) => s.assignedNodes({ flatten: true }).forEach((n) => { t += ' ' + (n.textContent || ''); })); return t; };
  const iconText = (e) => { const tt = e.querySelector && e.querySelector('svg title'); const im = e.querySelector && e.querySelector('img[alt]'); return (tt && tt.textContent) || (im && im.getAttribute('alt')) || ''; };
  const txt = (e) => clean(e.innerText) || clean(slotText(e)) || (e.shadowRoot ? clean(shadowText(e.shadowRoot)) : '') || clean(e.getAttribute('aria-label')) || clean(e.getAttribute('title')) || clean(iconText(e)) || clean(e.value);
  const byId = (e, id) => { const r = rootOf(e); return id ? (r.getElementById ? r.getElementById(id) : r.querySelector('#' + CSS.escape(id))) : null; };
  const labelEl = (e) => { const r = rootOf(e); return (e.id && r.querySelector('label[for="' + CSS.escape(e.id) + '"]')) || (e.closest && e.closest('label')) || null; };
  const labelOf = (e) => {
    const parts = []; const l = labelEl(e); if (l) parts.push(l.innerText);
    parts.push(e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('name'), e.getAttribute('title'));
    (e.getAttribute('aria-labelledby') || '').split(/\\s+/).forEach((id) => { const n = byId(e, id); if (n) parts.push(n.innerText); });
    if (!l) { // forms without label[for]: the label is a neighbouring label / legend or a short text before the field
      const box = e.closest && e.closest('div, fieldset, li, p, td'); const near = box && box.querySelectorAll('input, textarea, select').length === 1 ? box.querySelector('label, legend') : null;
      if (near && !near.contains(e) && !near.control && !near.querySelector('input, select, textarea')) parts.push(near.innerText); // a label of its own field only
      const prev = e.previousElementSibling; if (prev && !prev.querySelector('input, select, textarea, button') && clean(prev.innerText).length <= 80) parts.push(prev.innerText);
    }
    const seen = []; parts.map((p) => clean(p, 80)).filter(Boolean).forEach((p) => { if (!seen.includes(p)) seen.push(p); });
    return clean(seen.join(' · '));
  };
  const required = (e, label) => (e.required || e.getAttribute('aria-required') === 'true' || /\\*|\\(required\\)|обязательн|obligatori|obrigat|必填|필수|zorunlu/i.test(label)) && !/optional|необязательн|opcional|可选|선택|isteğe/i.test(label);
  // "Header and footer": search in the header, subscription and social links in the footer — not part of the task
  const chrome = (e) => chain(e).some((n) => n.matches && n.matches('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"], [role="search"]'));
  // Overlap: what will actually be under the click (banners, modals, dimming)
  const topAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; } return el; };
  const covered = (e) => {
    const r = e.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false; // off screen: the browser will scroll before clicking
    const t = topAt(x, y); if (!t) return false;
    if (chain(t).includes(e) || chain(e).includes(t)) return false;
    const lab = t.closest && t.closest('label'); if (lab && (lab.control === e || lab.contains(e))) return false;
    return true;
  };
  // Form group: <form>, and without it — the nearest ancestor that has both a field and a button
  const BTN = 'button, [role="button"], input[type="submit"], input[type="button"]';
  const roots = []; const gid = (el) => { let i = roots.indexOf(el); if (i < 0) { roots.push(el); i = roots.length - 1; } return P + 'g' + (i + 1); };
  const groupRoot = (e) => {
    const f = chain(e).find((n) => n.tagName === 'FORM'); if (f) return f;
    let a = up(e); let depth = 0;
    while (a && depth < 10 && a !== document.body && a !== document.documentElement) { if (a.querySelector && a.querySelector(BTN)) return a; a = up(a); depth++; }
    return null;
  };
  const cookieBox = (e) => { let a = up(e); let d = 0; while (a && d < 6) { const t = a.innerText || ''; if (t.length < 900 && /cookie|consent|gdpr|файл(ы|ов) cookie|куки/i.test(t)) return true; a = up(a); d++; } return false; };

  document.querySelectorAll('[data-scarf-id]').forEach((e) => e.removeAttribute('data-scarf-id'));
  all.forEach((e) => { if (e.hasAttribute && e.hasAttribute('data-scarf-id')) e.removeAttribute('data-scarf-id'); });
  const out = []; let n = 0; const count = { field: 0, button: 0, link: 0 };
  const add = (e, bucket, o, probe) => {
    if (count[bucket] >= CAP[bucket]) return; count[bucket]++;
    const id = P + 'e' + (++n); e.setAttribute('data-scarf-id', id);
    const item = Object.assign({ id: id, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' }, o);
    if (covered(probe || e)) item.covered = true;
    if (chrome(e)) item.chrome = true;
    item._el = e; out.push(item);
  };
  all.forEach((e) => {
    if (!e.matches || !e.matches('input, textarea, select, button, a, [role="button"], [role="checkbox"], [role="radio"], [role="option"], [role="switch"], [role="combobox"]')) return;
    const tag = e.tagName.toLowerCase(); const type = (e.getAttribute('type') || '').toLowerCase(); const role = e.getAttribute('role');
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      // A checkbox hidden from view (sr-only) is clicked via its visible label
      const target = vis(e) ? e : labelEl(e); if (!target || !vis(target)) return;
      const label = labelOf(e) || txt(target);
      if (type === 'checkbox') return add(e, 'field', { kind: 'checkbox', label: label, checked: !!e.checked, required: required(e, label) }, target);
      const fs = e.closest('fieldset, [role="radiogroup"]'); const lg = fs && fs.querySelector('legend'); const group = clean((lg && lg.innerText) || (fs && fs.getAttribute('aria-label')) || e.getAttribute('name'), 80);
      return add(e, 'field', { kind: 'radio', label: label, checked: !!e.checked, group: group, required: !!e.required }, target);
    }
    if (!vis(e)) return;
    if (role === 'checkbox' || role === 'switch') return add(e, 'field', { kind: 'checkbox', label: txt(e) || labelOf(e), checked: e.getAttribute('aria-checked') === 'true' });
    if (role === 'radio' || role === 'option') {
      const box = e.closest('[role="radiogroup"], [role="listbox"]'); const by = box && byId(box, (box.getAttribute('aria-labelledby') || '').split(/\\s+/)[0]);
      return add(e, 'field', { kind: role, label: txt(e) || labelOf(e), checked: (e.getAttribute('aria-checked') || e.getAttribute('aria-selected')) === 'true', group: clean((box && box.getAttribute('aria-label')) || (by && by.innerText), 80) });
    }
    if (tag === 'select') {
      const label = labelOf(e); const sel = e.options[e.selectedIndex];
      const options = Array.from(e.options).filter((o) => !o.disabled && o.value !== '').map((o) => clean(o.text, 60)).filter(Boolean).slice(0, 40);
      return add(e, 'field', { kind: 'select', label: label, options: options, value: sel && sel.value !== '' && !sel.disabled ? clean(sel.text, 60) : '', required: required(e, label) });
    }
    if (tag === 'input' && (type === 'submit' || type === 'button')) return add(e, 'button', { kind: 'button', label: clean(e.value) || labelOf(e), submit: type === 'submit' });
    if (tag === 'input' && type === 'hidden') return;
    if (tag === 'input' || tag === 'textarea') { const label = labelOf(e); return add(e, 'field', { kind: 'input', label: label, inputType: tag === 'input' ? (type || 'text') : tag, value: String(e.value || ''), required: required(e, label) }); }
    if (tag === 'a') { const href = e.getAttribute('href'); return add(e, href && !href.startsWith('#') && !href.startsWith('javascript:') ? 'link' : 'button', { kind: 'link', label: txt(e) || labelOf(e), href: href && !href.startsWith('#') && !href.startsWith('javascript:') ? e.href : undefined }); }
    const label = txt(e) || labelOf(e);
    return add(e, 'button', { kind: 'button', label: label, submit: tag === 'button' && type !== 'button' && type !== 'reset' && !!chain(e).find((x) => x.tagName === 'FORM') });
  });
  // Fields — into their groups; buttons — into the innermost group that contains them
  out.forEach((it) => { if (it.kind !== 'button' && it.kind !== 'link') { const r = groupRoot(it._el); if (r) it.form = gid(r); } });
  out.forEach((it) => {
    if (it.kind === 'button' || (it.kind === 'link' && !it.href)) {
      const r = chain(it._el).find((x) => roots.includes(x)); if (r) it.form = gid(r);
      if (cookieBox(it._el) && /^(accept|allow|agree|i agree|i accept|got it|ok|okay|понятно|принять|согласен|aceptar|aceitar|同意|接受|동의|kabul)/i.test(it.label)) it.cookie = true;
    }
    delete it._el;
  });
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || '').filter((s) => /recaptcha|hcaptcha|turnstile|captcha/i.test(s));
  let extra = ''; all.forEach((e) => { if (e.shadowRoot && e.getRootNode() === document && extra.length < 1500) extra += ' ' + shadowText(e.shadowRoot); });
  const text = clean(document.title) + '\\n' + String(document.body ? document.body.innerText : '').replace(/[ \\t]+/g, ' ').slice(0, 4000) + (clean(extra, 1500) ? '\\n' + clean(extra, 1500) : '') + (frames.length ? '\\n[captcha frame]' : '');
  return { url: location.href, title: document.title, text: text, elements: out };
})()`;

/**
 * Part 2: the session wallet code on the page. It is only a "socket": every site request goes to Node (the __scarfWalletRequest binding)
 * and is decided in SiteWallet — there is neither a key nor rules on the page. EVM — an EIP-1193 provider (window.ethereum) and an EIP-6963 announcement;
 * Solana — a Phantom-style provider (window.solana, window.phantom.solana). The isMetaMask / isPhantom flags are for compatibility
 * with sites that look for a wallet by them (other wallets do this too). The driver substitutes __INFO__: addresses, no secrets.
 */
export const WALLET_JS = `(() => {
  const info = __INFO__;
  if (window.__scarfWalletReady) return; window.__scarfWalletReady = true;
  const call = (kind, method, params) => window.__scarfWalletRequest({ kind: kind, method: String(method), params: params }).then((r) => {
    if (r && r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
    return r ? r.result : undefined;
  });
  const emitter = () => { const ls = {}; return {
    on: (ev, f) => { (ls[ev] = ls[ev] || []).push(f); }, off: (ev, f) => { ls[ev] = (ls[ev] || []).filter((x) => x !== f); },
    emit: (ev, v) => (ls[ev] || []).slice().forEach((f) => { try { f(v); } catch (e) {} }) }; };
  if (info.evm) {
    const em = emitter(); let chain = '0x1';
    const provider = {
      isMetaMask: true, isScarf: true,
      request: async (a) => {
        const method = a && a.method; const params = a && Array.isArray(a.params) ? a.params : (a && a.params !== undefined ? [a.params] : []);
        const res = await call('evm', method, params);
        if (method === 'eth_requestAccounts') { em.emit('connect', { chainId: chain }); em.emit('accountsChanged', res); }
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') { const c = params[0] && params[0].chainId; if (c && c !== chain) { chain = c; em.emit('chainChanged', chain); } }
        return res;
      },
      on: (ev, f) => { em.on(ev, f); return provider; }, removeListener: (ev, f) => { em.off(ev, f); return provider; },
      enable: () => provider.request({ method: 'eth_requestAccounts' }),
      send: (m, p) => (typeof m === 'string' ? provider.request({ method: m, params: p }) : provider.request(m)),
      sendAsync: (payload, cb) => { provider.request(payload).then((r) => cb(null, { id: payload.id, jsonrpc: '2.0', result: r }), (e) => cb(e)); },
      isConnected: () => true,
    };
    provider.addListener = provider.on; provider.off = provider.removeListener;
    try { Object.defineProperty(window, 'ethereum', { value: provider, configurable: false, writable: false }); } catch (e) { window.ethereum = provider; }
    const detail = Object.freeze({ info: Object.freeze({ uuid: '5c4f1a0e-0e06-4e06-9e06-5ca4f0000001', name: 'SCARF Wallet', rdns: 'ai.scarf.wallet',
      icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%23222%22/%3E%3C/svg%3E' }), provider: provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
  }
  if (info.sol) {
    const bytes = Uint8Array.from(info.solBytes); const em = emitter();
    const pk = { toBase58: () => info.sol, toString: () => info.sol, toJSON: () => info.sol, toBytes: () => bytes.slice(), toBuffer: () => bytes.slice(),
      equals: (o) => !!o && String(o.toBase58 ? o.toBase58() : o) === info.sol };
    const money = (m) => () => call('sol', m, []);
    const sol = {
      isPhantom: true, isScarf: true, publicKey: null, isConnected: false,
      connect: async () => { await call('sol', 'connect', []); sol.publicKey = pk; sol.isConnected = true; em.emit('connect', pk); return { publicKey: pk }; },
      disconnect: async () => { await call('sol', 'disconnect', []); sol.publicKey = null; sol.isConnected = false; em.emit('disconnect'); },
      signMessage: async (msg) => { const r = await call('sol', 'signMessage', [Array.from(msg)]); return { signature: Uint8Array.from(r.signature), publicKey: pk }; },
      signTransaction: money('signTransaction'), signAllTransactions: money('signAllTransactions'), signAndSendTransaction: money('signAndSendTransaction'),
      request: async (a) => (a && a.method === 'connect' ? sol.connect() : a && a.method === 'signMessage' ? sol.signMessage(a.params && a.params.message) : call('sol', a && a.method, [])),
      on: (ev, f) => { em.on(ev, f); return sol; }, off: (ev, f) => { em.off(ev, f); return sol; }, removeListener: (ev, f) => { em.off(ev, f); return sol; },
    };
    try { Object.defineProperty(window, 'solana', { value: sol, configurable: false, writable: false }); } catch (e) { window.solana = sol; }
    try { window.phantom = Object.assign(window.phantom || {}, { solana: sol }); } catch (e) {}
  }
})()`;

/**
 * Chromium launch parameters for a session. WebRTC — only through the proxy: otherwise the page would learn the server's internal addresses and could
 * send UDP bypassing the proxy. A custom launch (tests, server) must pass these same parameters.
 * #144: there are two flags, and both are needed (tested on both binaries): full Chromium understands only `--webrtc-ip-handling-policy`,
 * while the headless shell — which chromium.launch() starts without executablePath, i.e. prod — only `--force-webrtc-ip-handling-policy`.
 * Each of them silently ignores the other's flag, and STUN goes out over UDP.
 */
export const SITE_BROWSER_ARGS: readonly string[] = ['--disable-dev-shm-usage', '--no-first-run',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];

export interface SiteBrowserOpts {
  /** How to launch the browser; default — Chromium from PLAYWRIGHT_BROWSERS_PATH, like the Analyst's reader. Parameters — SITE_BROWSER_ARGS. */
  launch?: () => Promise<Browser>;
  /**
   * Where to connect for a host: a checked IP or undefined (refusal). Default — resolvePublic: public addresses only.
   * One function for both layers — request interception and the proxy (in tests — allow a local site).
   */
  resolveHost?: (host: string, port: number) => Promise<string | undefined>;
  /** Ports one may go out to (default EGRESS_PORTS); in tests — the local site's port. */
  ports?: readonly number[] | ((port: number) => boolean);
  /** How long to wait for the page after navigation and after a click, ms. */
  settleMs?: number;
  actionTimeoutMs?: number;
}

/** A single-session driver: its own browser and its own clean profile; close() closes everything. */
export function chromiumSiteDriver(opts: SiteBrowserOpts = {}): SiteDriver {
  let browser: Browser | undefined; let ctx: BrowserContext | undefined; let page: Page | undefined;
  let proxy: EgressProxy | undefined; let wallet: PageWallet | undefined;
  const resolveHost = opts.resolveHost ?? ((h: string) => resolvePublic(h));
  const portOf = (u: URL) => Number(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80));
  /** First layer (request interception): the host must be allowed. The deciding layer is the proxy: it checks and connects to the same IP. */
  const isPublic = async (u: URL) => !!(await resolveHost(u.hostname, portOf(u)).catch(() => undefined));
  const settle = opts.settleMs ?? 4_000; const actionTimeout = opts.actionTimeoutMs ?? 8_000;
  let inflight = 0;
  /**
   * Wait until the page "settles" after navigation or a click: no requests in flight and the content unchanged for 300 ms in a row
   * (no longer than settle). waitForLoadState('networkidle') is not suitable for this: it fires once, at the first load —
   * after clicking "Submit" the page would be read before the site's response, and the session would click the button a second time.
   */
  const quiet = async () => {
    const deadline = Date.now() + settle; let lastSig = ''; let stableSince = 0;
    for (;;) {
      const sig = String(await page!.evaluate(`(document.body ? document.body.innerText.length : 0) + ':' + document.querySelectorAll('*').length + ':' + location.href`).catch(() => `nav:${Date.now()}`));
      const t = Date.now();
      if (sig === lastSig && inflight <= 0) { if (!stableSince) stableSince = t; if (t - stableSince >= 300) return; } else { stableSince = 0; lastSig = sig; }
      if (t >= deadline) return;
      await new Promise(r => setTimeout(r, 100));
    }
  };
  /** Frames of the last observe(): id prefix → frame ('' — the page itself). */
  let frames = new Map<string, Frame>(); let siteHost = '';
  /** List options of the last observe(): id → (normalized text → text on the page) — select() picks the real option. */
  let rawOptions = new Map<string, Map<string, string | null>>();
  const loc = (id: string) => {
    const safe = id.replace(/[^a-z0-9-]/gi, ''); const m = /^(i\d+-)/.exec(safe);
    const fr = frames.get(m?.[1] ?? '') ?? page!.mainFrame();
    return fr.locator(`[data-scarf-id="${safe}"]`).first(); // a Playwright CSS locator pierces open shadow DOM
  };
  return {
    async open(url) {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s)');
      if (!(await isPublic(u))) throw new Error('refused: non-public host');
      siteHost = u.hostname;
      proxy = await startEgressProxy({ resolve: resolveHost, ports: opts.ports });
      browser = await (opts.launch ?? (async () => (await import('playwright-core')).chromium.launch({ args: [...SITE_BROWSER_ARGS] })))();
      // All network egress — through the proxy, including 127.0.0.1 addresses (`<-loopback>` removes Chromium's built-in exception)
      ctx = await browser.newContext({ proxy: { server: proxy.url, bypass: '<-loopback>' }, acceptDownloads: false, serviceWorkers: 'block', permissions: [], viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' });
      await ctx.route('**/*', async (route) => {
        const req = route.request();
        let ru: URL; try { ru = new URL(req.url()); } catch { return route.abort(); }
        if (ru.protocol === 'data:' || ru.protocol === 'blob:') return route.continue();
        if (ru.protocol !== 'https:' && ru.protocol !== 'http:') return route.abort();
        if (req.resourceType() === 'media') return route.abort();
        if (!(await isPublic(ru))) return route.abort();
        return route.continue();
      });
      // Request interception does not see WebSocket — it has its own: an internal host is closed at once, a public one connects (through the proxy)
      await ctx.routeWebSocket(/.*/, async (ws) => {
        let wu: URL | undefined; try { wu = new URL(ws.url()); } catch { wu = undefined; }
        if (!wu || (wu.protocol !== 'wss:' && wu.protocol !== 'ws:') || !(await isPublic(wu))) { await ws.close({ code: 1008, reason: 'refused' }).catch(() => undefined); return; }
        ws.connectToServer();
      });
      if (wallet) {
        const w = wallet;
        // A wallet request from the page: the frame URL is taken from the browser, not from what the page sent
        await ctx.exposeBinding('__scarfWalletRequest', async (source, q: unknown) => {
          const r = (q ?? {}) as { kind?: unknown; method?: unknown; params?: unknown };
          return w.request({ kind: r.kind === 'sol' ? 'sol' : 'evm', method: String(r.method ?? '').slice(0, 80), params: Array.isArray(r.params) ? r.params.slice(0, 8) : [], frameUrl: source.frame?.url() ?? '' });
        });
        await ctx.addInitScript(WALLET_JS.replace('__INFO__', () => JSON.stringify({ evm: w.evmAddress ?? null, sol: w.solAddress ?? null, solBytes: w.solPublicKey ? Array.from(w.solPublicKey) : null })));
      }
      page = await ctx.newPage();
      ctx.on('page', (p) => { if (p !== page) void p.close().catch(() => undefined); }); // popups and new tabs
      page.on('dialog', (d) => { void d.dismiss().catch(() => undefined); });
      page.on('request', () => { inflight++; });
      const landed = () => { inflight = Math.max(0, inflight - 1); };
      page.on('requestfinished', landed); page.on('requestfailed', landed);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => undefined);
      await quiet();
    },
    attachWallet(w) { wallet = w; },
    async observe(): Promise<Observation> {
      if (!page) throw new Error('session is not open');
      const js = (prefix: string) => OBSERVE_JS.replace('__PREFIX__', () => JSON.stringify(prefix));
      const main = (await page.evaluate(js(''))) as Observation;
      frames = new Map([['', page.mainFrame()]]);
      // Frames of the same site (an application form is sometimes in an embedded frame); foreign frames — ads, widgets, captcha — are not read
      let i = 0;
      for (const fr of page.frames()) {
        if (fr === page.mainFrame() || fr.isDetached() || !sameSite(fr.url(), siteHost)) continue;
        if (++i > 5) break;
        const prefix = `i${i}-`;
        try {
          const sub = (await fr.evaluate(js(prefix))) as Observation;
          frames.set(prefix, fr);
          main.elements.push(...sub.elements); main.text = `${main.text}\n${sub.text}`.slice(0, 7000);
        } catch { /* the frame disappeared or has not loaded yet — in the next observe() */ }
      }
      main.scoped = true;
      // Review #150 (B1): labels, options, groups and text are normalized right here — the rules, code checks and the model see the same text
      // V4: an option identical to another after normalization is ambiguous (null): select on it refuses instead of taking the last one
      rawOptions = new Map(main.elements.filter(e => e.options?.length).map(e => {
        const m = new Map<string, string | null>();
        for (const x of e.options!) { const k = normOption(x); m.set(k, m.has(k) ? null : x); }
        return [e.id, m];
      }));
      return normObservation(main);
    },
    async fill(id, text) {
      if (!page) throw new Error('session is not open');
      await loc(id).fill(text, { timeout: actionTimeout });
    },
    async click(id) {
      if (!page) throw new Error('session is not open');
      const l = loc(id);
      // A checkbox or switch hidden from view (sr-only): there is no visible mouse target — click the element itself
      const hiddenToggle = await l.evaluate((e: Element) => e.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(e.getAttribute('type') ?? '')
        && (e.getBoundingClientRect().width <= 1 || e.getBoundingClientRect().height <= 1 || Number(getComputedStyle(e).opacity) <= 0.01)).catch(() => false);
      // (arrow functions without nested named ones: under tsx these do not get the __name wrapper that does not exist on the page)
      if (hiddenToggle) await l.evaluate((e: Element) => (e as HTMLElement).click());
      else await l.click({ timeout: actionTimeout });
      await quiet();
    },
    async select(id, option) {
      if (!page) throw new Error('session is not open');
      const raw = rawOptions.get(id)?.get(option);
      if (raw === null) throw new Error(`option "${option.slice(0, 40)}" is ambiguous — several options have this text`);
      await loc(id).selectOption({ label: raw ?? option }, { timeout: actionTimeout });
      await quiet();
    },
    async screenshot() {
      if (!page) return undefined;
      return new Uint8Array(await page.screenshot({ type: 'png', fullPage: false, timeout: 10_000 }));
    },
    async close() {
      const b = browser; browser = undefined; page = undefined;
      await ctx?.close().catch(() => undefined); ctx = undefined;
      await b?.close().catch(() => undefined);
      const p = proxy; proxy = undefined;
      await p?.close().catch(() => undefined);
    },
  };
}
