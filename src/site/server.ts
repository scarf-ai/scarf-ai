// SCARF website: the page (site/dist) + mascot answers (/api). A process separate from the agent: a crash or a visitor rush
// does not touch trading. Opens the agent database read-only. From outside — only via a Cloudflare tunnel (the port listens on 127.0.0.1).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, extname, normalize, sep, dirname } from 'node:path';
import { answer, anthropicSayCaller, pickModel, CANNED, HAIKU, type Caller, type JournalItem, type PublicStats, type Turn } from './answer.js';
import { costUsd } from '../llm/budget.js';
// Via require: the test bundler (vite) does not know the node:sqlite module
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncT;
import { BRAND } from '../brand.js';

export interface SiteConfig {
  port: number; host: string; distDir: string; agentDb: string; siteDb: string;
  dailyUsd: number; ipPerHour: number; ipPerDay: number; mode: 'paper' | 'live';
  /** Show drafts on the site too, not only what is published on X (for a preview before X is connected). */
  includeDrafts: boolean;
}

export function siteConfig(env = process.env): SiteConfig {
  const root = resolve(env.AGENT_ROOT ?? process.cwd());
  const dataDir = resolve(root, env.AGENT_DATA_DIR ?? 'server/data');
  return {
    port: Number(env.SITE_PORT ?? 8787), host: env.SITE_HOST ?? '127.0.0.1',
    distDir: resolve(root, env.SITE_DIST ?? 'site/dist'),
    agentDb: join(dataDir, 'agent.sqlite'), siteDb: join(dataDir, 'site.sqlite'),
    // The owner's decision 2026-10-24: Haiku, Sonnet for complex ones, a shared limit of $3 a day
    dailyUsd: Number(env.SITE_DAILY_USD ?? 2), ipPerHour: Number(env.SITE_IP_PER_HOUR ?? 20), ipPerDay: Number(env.SITE_IP_PER_DAY ?? 60),
    mode: env.AGENT_MODE === 'live' ? 'live' : 'paper', includeDrafts: env.SITE_INCLUDE_DRAFTS === '1',
  };
}

const PUBLIC_KINDS = ['thought', 'entry', 'exit', 'nft_mint', 'nft_buy', 'prediction', 'prediction_exit', 'skip_review', 'raffle'];

/** The public log from the agent database: posts only (published on X, or drafts too — for a preview). */
export class AgentView {
  private db?: DatabaseSync;
  constructor(private path: string, private includeDrafts: boolean, private mode: 'paper' | 'live') {}
  private open(): DatabaseSync | undefined {
    if (!this.db && existsSync(this.path)) this.db = new DatabaseSync(this.path, { readOnly: true });
    return this.db;
  }
  journal(limit = 40): JournalItem[] {
    const db = this.open();
    if (!db) return [];
    try {
      const st = this.includeDrafts ? "status IN ('posted','draft','awaiting','pending','held')" : "status='posted'";
      return (db.prepare(`SELECT ts_utc, kind, text FROM post_drafts WHERE ${st} AND kind IN (${PUBLIC_KINDS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`)
        .all(...PUBLIC_KINDS, limit) as any[]).map(r => ({ ts: String(r.ts_utc), kind: String(r.kind), text: String(r.text) }));
    } catch { return []; }
  }
  stats(): PublicStats {
    const db = this.open();
    const empty = { closed: 0, wins: 0, pnlUsd: 0, open: 0, mode: this.mode };
    if (!db) return empty;
    try {
      const c = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN proceeds_usd > cost_usd THEN 1 ELSE 0 END) w, SUM(proceeds_usd - cost_usd) p FROM positions WHERE closed_utc IS NOT NULL').get() as any;
      const o = db.prepare('SELECT COUNT(*) n FROM positions WHERE closed_utc IS NULL').get() as any;
      return { closed: Number(c.n ?? 0), wins: Number(c.w ?? 0), pnlUsd: Number(c.p ?? 0), open: Number(o.n ?? 0), mode: this.mode };
    } catch { return empty; }
  }
  /** Server, channel and author names — for checking an answer for leaks. */
  sourceNames(): string[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db.prepare('SELECT DISTINCT server AS n FROM messages UNION SELECT DISTINCT channel FROM messages UNION SELECT DISTINCT author FROM messages').all() as any[];
      return rows.map(r => String(r.n ?? '')).filter(n => n.replace(/\W/g, '').length >= 3);
    } catch { return []; }
  }
}

/** Site money and limits: its own small database, separate from the agent. */
export class SiteLedger {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS spend(day TEXT PRIMARY KEY, usd REAL);
      CREATE TABLE IF NOT EXISTS hits(ip TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS hits_ip ON hits(ip, ts);
      CREATE TABLE IF NOT EXISTS asks(ts TEXT, model TEXT, cost REAL, q_len INTEGER, reason TEXT);`);
  }
  spent(day: string): number { return Number((this.db.prepare('SELECT usd FROM spend WHERE day=?').get(day) as any)?.usd ?? 0); }
  addSpend(day: string, usd: number) { this.db.prepare('INSERT INTO spend VALUES (?,?) ON CONFLICT(day) DO UPDATE SET usd=usd+excluded.usd').run(day, usd); }
  /** Per-IP limit: true — allowed. A successful question is recorded. */
  allow(ip: string, nowMs: number, perHour: number, perDay: number): boolean {
    this.db.prepare('DELETE FROM hits WHERE ts < ?').run(nowMs - 86400_000);
    const h = (this.db.prepare('SELECT COUNT(*) n FROM hits WHERE ip=? AND ts>=?').get(ip, nowMs - 3600_000) as any).n;
    const d = (this.db.prepare('SELECT COUNT(*) n FROM hits WHERE ip=?').get(ip) as any).n;
    if (h >= perHour || d >= perDay) return false;
    this.db.prepare('INSERT INTO hits VALUES (?,?)').run(ip, nowMs);
    return true;
  }
  log(iso: string, model: string, cost: number, qLen: number, reason?: string) { this.db.prepare('INSERT INTO asks VALUES (?,?,?,?,?)').run(iso, model, cost, qLen, reason ?? null); }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const send = (res: ServerResponse, code: number, body: string | Buffer, type = 'application/json', extra: Record<string, string> = {}) => {
  res.writeHead(code, { 'Content-Type': type, ...SECURITY, ...extra });
  res.end(body);
};

/** Visitor IP: the Cloudflare header is trusted only for requests from this same machine (the tunnel). */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const cf = req.headers['cf-connecting-ip'];
  return (local && typeof cf === 'string' && cf) ? cf : remote;
}

async function readBody(req: IncomingMessage, max = 6000): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > max) throw new Error('too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

export interface SiteDeps { cfg: SiteConfig; view: AgentView; ledger: SiteLedger; call?: Caller; now?: () => number }

export function handler(d: SiteDeps) {
  const now = d.now ?? (() => Date.now());
  const busy = new Set<string>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/api/feed' && req.method === 'GET') {
        const items = d.view.journal(20).map(i => ({ ts: i.ts, kind: i.kind, text: i.text }));
        return send(res, 200, JSON.stringify({ brand: { name: BRAND.name, handle: BRAND.handle }, stats: d.view.stats(), items }), 'application/json', { 'Cache-Control': 'public, max-age=30' });
      }
      if (url.pathname === '/api/ask' && req.method === 'POST') {
        const ip = clientIp(req);
        let body: { q?: unknown; history?: unknown };
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'bad request' })); }
        const q = String(body.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
        if (!q) return send(res, 200, JSON.stringify(CANNED.empty));
        if (busy.has(ip)) return send(res, 200, JSON.stringify(CANNED.rate));
        if (!d.ledger.allow(ip, now(), d.cfg.ipPerHour, d.cfg.ipPerDay)) return send(res, 200, JSON.stringify(CANNED.rate));
        const day = new Date(now()).toISOString().slice(0, 10);
        const left = d.cfg.dailyUsd - d.ledger.spent(day);
        if (!d.call) return send(res, 200, JSON.stringify(CANNED.offline));
        if (left <= 0.01) return send(res, 200, JSON.stringify(CANNED.budget));
        const items = d.view.journal(40);
        // Sonnet — only while the day's remainder is ≥ $0.25, otherwise Haiku
        let model = pickModel(q, items);
        if (model !== HAIKU && left < 0.25) model = HAIKU;
        const history: Turn[] = Array.isArray(body.history) ? (body.history as any[]).slice(-3).map(t => ({ q: String(t?.q ?? '').slice(0, 400), a: String(t?.a ?? '').slice(0, 600) })).filter(t => t.q && t.a) : [];
        busy.add(ip);
        try {
          const r = await answer({ q, history, items, stats: d.view.stats(), sourceNames: d.view.sourceNames(), call: d.call, model, cost: costUsd });
          d.ledger.addSpend(day, r.costUsd);
          d.ledger.log(new Date(now()).toISOString(), model, r.costUsd, q.length, r.reason);
          return send(res, 200, JSON.stringify({ text: r.text, pose: r.pose }));
        } catch (e) {
          d.ledger.log(new Date(now()).toISOString(), model, 0, q.length, `error: ${String((e as Error).message ?? e).slice(0, 120)}`);
          return send(res, 200, JSON.stringify(CANNED.error));
        } finally { busy.delete(ip); }
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, JSON.stringify({ error: 'not found' }));
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
      // Static files
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '').replace(/\.\.[/\\]/g, '');
      let file = resolve(d.cfg.distDir, rel || 'index.html');
      if (!file.startsWith(d.cfg.distDir + sep)) return send(res, 403, 'forbidden', 'text/plain');
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(d.cfg.distDir, 'index.html');
      if (!existsSync(file)) return send(res, 404, 'not built yet: npm run site:build', 'text/plain');
      const ext = extname(file).toLowerCase();
      return send(res, 200, readFileSync(file), MIME[ext] ?? 'application/octet-stream', { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    } catch (e) {
      console.error('site', e);
      return send(res, 500, JSON.stringify({ error: 'server error' }));
    }
  };
}

/** Only what the site needs is taken from .env: the agent's other keys (Discord, X, RPC) never reach the site process. */
export function siteEnv(path: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const want = /^(ANTHROPIC_API_KEY|AGENT_MODE|AGENT_DATA_DIR|AGENT_ROOT|SITE_[A-Z_]+)$/;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (want.test(k)) out[k] = v;
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && want.test(m[1]) && out[m[1]] === undefined) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  const env = siteEnv(resolve(process.env.AGENT_ROOT ?? process.cwd(), '.env'));
  const cfg = siteConfig(env);
  const key = env.ANTHROPIC_API_KEY;
  const deps: SiteDeps = { cfg, view: new AgentView(cfg.agentDb, cfg.includeDrafts, cfg.mode), ledger: new SiteLedger(cfg.siteDb), call: key ? anthropicSayCaller(key) : undefined };
  createServer(handler(deps)).listen(cfg.port, cfg.host, () =>
    console.log(`site: http://${cfg.host}:${cfg.port} (${BRAND.name}, limit $${cfg.dailyUsd}/day, ${cfg.ipPerHour}/h per visitor${key ? '' : ', NO ANTHROPIC_API_KEY — answers off'})`));
}
