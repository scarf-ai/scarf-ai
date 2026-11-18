// The agent's SQLite log (built-in node:sqlite). Every message, decision, position and markout.
// Raw messages are kept for 7 days, then the text is erased (signals remain without text).
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
// Loaded via require: the test bundler (vite) does not know the node:sqlite module
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, Intent, RawMessage } from '../types.js';
/** Real project verdicts (T-11): marks like seen do not count as such. */
const REAL_VERDICTS = new Set(['avoid', 'ignore', 'watch', 'act']);

export class Store {
  db: DatabaseSyncT;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, ts_utc TEXT, server TEXT, channel TEXT, author TEXT, text TEXT);
      CREATE TABLE IF NOT EXISTS decisions(
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, ts_utc TEXT, server TEXT, channel TEXT, author TEXT,
        kind TEXT, chain TEXT, token TEXT, action TEXT, size_usd REAL, trust_score INTEGER, tier TEXT,
        price_at_decision REAL, reasons TEXT, intent TEXT, mode TEXT);
      CREATE TABLE IF NOT EXISTS positions(
        id TEXT PRIMARY KEY, decision_id INTEGER, chain TEXT, token TEXT, cost_usd REAL, qty REAL, qty_left REAL,
        entry_price REAL, opened_utc TEXT, closed_utc TEXT, proceeds_usd REAL DEFAULT 0, exit_reason TEXT, mode TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS markouts(decision_id INTEGER, horizon TEXT, price REAL, ts_utc TEXT, PRIMARY KEY(decision_id, horizon));
      CREATE TABLE IF NOT EXISTS trust_downgrades(key TEXT PRIMARY KEY, delta INTEGER, updated_utc TEXT);
      CREATE TABLE IF NOT EXISTS risk_state(id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT, updated_utc TEXT);
      CREATE TABLE IF NOT EXISTS blacklist(item TEXT PRIMARY KEY, added_utc TEXT);
      -- Entity mentions (address, ticker, domain, X account, collection, name) — for "buzz" across servers
      CREATE TABLE IF NOT EXISTS mentions(key TEXT, server TEXT, channel TEXT, author TEXT, ts_utc TEXT, msg_id TEXT, kind TEXT);
      CREATE INDEX IF NOT EXISTS mentions_key_ts ON mentions(key, ts_utc);
      -- Project cards: several keys (address + ticker + domain) → one project
      CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT, first_seen TEXT, last_seen TEXT,
        last_verdict TEXT, last_analysis_utc TEXT, last_thesis TEXT, scores TEXT, analyzed_keys TEXT, last_trust INTEGER);
      CREATE TABLE IF NOT EXISTS project_keys(key TEXT PRIMARY KEY, project_id INTEGER);
      -- Opus/Sonnet analyses and chat gatekeeper decisions
      CREATE TABLE IF NOT EXISTS analyses(id INTEGER PRIMARY KEY AUTOINCREMENT, ts_utc TEXT, msg_id TEXT, project_id INTEGER, model TEXT,
        trigger TEXT, verdict TEXT, confidence REAL, json TEXT, cost_usd REAL);
      CREATE TABLE IF NOT EXISTS gate_log(msg_id TEXT, ts_utc TEXT, server TEXT, channel TEXT, class TEXT, escalate INTEGER, score REAL,
        triggers TEXT, cost_usd REAL);
      -- Model spend per UTC day (survives a restart)
      -- Watch list: a scheduled project re-check (30 min before public, etc.)
      CREATE TABLE IF NOT EXISTS watch(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, msg_id TEXT, due_utc TEXT, reason TEXT, done INTEGER DEFAULT 0);
      -- Deferred actions: the decision is made again at the deadline
      CREATE TABLE IF NOT EXISTS scheduled(id INTEGER PRIMARY KEY AUTOINCREMENT, due_utc TEXT, msg_json TEXT, intent_json TEXT, trust_json TEXT, ctx_json TEXT, done INTEGER DEFAULT 0, dedup TEXT UNIQUE);
      -- X post drafts (until the owner's "yes" to auto-publishing)
      CREATE TABLE IF NOT EXISTS post_drafts(id INTEGER PRIMARY KEY AUTOINCREMENT, ts_utc TEXT, kind TEXT, text TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
      -- Chat-channel batches: messages accumulate until there are N, then go to the analyst as one batch
      CREATE TABLE IF NOT EXISTS chat_buffer(channel_key TEXT, msg_id TEXT PRIMARY KEY, ts_utc TEXT, msg_json TEXT);
      CREATE TABLE IF NOT EXISTS llm_spend(day TEXT, model TEXT, usd REAL, PRIMARY KEY(day, model));
    `);
    // Migrations for logs created by earlier versions
    for (const sql of ['ALTER TABLE projects ADD COLUMN last_trust INTEGER', 'ALTER TABLE scheduled ADD COLUMN dedup TEXT',
      'ALTER TABLE projects ADD COLUMN last_real_verdict TEXT', 'ALTER TABLE projects ADD COLUMN last_real_verdict_utc TEXT']) { try { this.db.exec(sql); } catch { /* already exists */ } }
    try { this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS scheduled_dedup ON scheduled(dedup)'); } catch { /* ignore */ }
  }

  chatBufferAdd(key: string, m: RawMessage) { this.db.prepare('INSERT OR IGNORE INTO chat_buffer VALUES (?,?,?,?)').run(key, m.id, m.tsUtc, JSON.stringify(m)); }
  chatBufferCount(key: string): number { return (this.db.prepare('SELECT COUNT(*) n FROM chat_buffer WHERE channel_key=?').get(key) as any).n; }
  /** Take the channel batch (by time) and clear the buffer. */
  chatBufferTake(key: string): RawMessage[] {
    const rows = this.db.prepare('SELECT msg_json FROM chat_buffer WHERE channel_key=? ORDER BY ts_utc').all(key) as any[];
    this.db.prepare('DELETE FROM chat_buffer WHERE channel_key=?').run(key);
    return rows.map(r => JSON.parse(r.msg_json));
  }
  /** Channels where a batch waits longer than the deadline: { key, n, oldest }. */
  chatBufferStats(): { key: string; n: number; oldest: string }[] {
    return (this.db.prepare('SELECT channel_key AS key, COUNT(*) AS n, MIN(ts_utc) AS oldest FROM chat_buffer GROUP BY channel_key').all() as any[]);
  }
  hasMessage(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM messages WHERE id=?').get(id); }
  kvGet(k: string): string | undefined { return (this.db.prepare('SELECT v FROM kv WHERE k=?').get(k) as any)?.v; }
  kvSet(k: string, v: string) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(k, v); }

  saveMessage(m: RawMessage) {
    this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)').run(m.id, m.tsUtc, m.sourceServer, m.channel, m.author, m.text);
  }

  saveDecision(m: RawMessage, d: Decision, mode: string, nowIso: string): number {
    if (m.backfill && !d.reasons.some(r => r.startsWith('backfill:'))) d.reasons.unshift(`backfill: message from ${m.tsUtc}`);
    const token = d.intent.tokenAddress ?? d.intent.contractAddress ?? null;
    const r = this.db.prepare(`INSERT INTO decisions(message_id, ts_utc, server, channel, author, kind, chain, token, action, size_usd,
      trust_score, tier, price_at_decision, reasons, intent, mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      m.id, nowIso, m.sourceServer, m.channel, m.author, d.intent.kind, d.chain, token, d.action, d.sizeUsd,
      d.trust.score, d.trust.tier, d.check?.priceUsd ?? null, JSON.stringify(d.reasons), JSON.stringify(d.intent), mode);
    return Number(r.lastInsertRowid);
  }

  /** Updates a decision after execution (e.g. if the risk check cancelled the trade). */
  updateDecision(id: number, action: string, reasons: string[]) {
    this.db.prepare('UPDATE decisions SET action=?, reasons=? WHERE id=?').run(action, JSON.stringify(reasons), id);
  }

  saveRiskState(json: unknown, iso: string) {
    this.db.prepare('INSERT OR REPLACE INTO risk_state(id, json, updated_utc) VALUES (1,?,?)').run(JSON.stringify(json), iso);
  }
  loadRiskState(): any | undefined {
    const r = this.db.prepare('SELECT json FROM risk_state WHERE id=1').get() as any;
    return r ? JSON.parse(r.json) : undefined;
  }

  /** Decisions that have a token and a price — for markouts (the source value log). */
  pendingMarkouts(horizon: string, olderThanIso: string): { id: number; token: string; chain: string }[] {
    return this.db.prepare(`SELECT d.id, d.token, d.chain FROM decisions d
      WHERE d.token IS NOT NULL AND d.kind = 'token_call' AND d.ts_utc <= ?
      AND NOT EXISTS (SELECT 1 FROM markouts mk WHERE mk.decision_id = d.id AND mk.horizon = ?) LIMIT 50`).all(olderThanIso, horizon) as any;
  }
  saveMarkout(id: number, horizon: string, price: number, iso: string) {
    this.db.prepare('INSERT OR REPLACE INTO markouts VALUES (?,?,?,?)').run(id, horizon, price, iso);
  }

  /** Source statistics: the median price rise after a signal at a horizon. */
  sourceStats(horizon = '24h', sinceIso = '1970-01-01T00:00:00.000Z') {
    const rows = this.db.prepare(`SELECT d.server, d.channel, d.author, d.price_at_decision AS p0, mk.price AS p1
      FROM decisions d JOIN markouts mk ON mk.decision_id = d.id AND mk.horizon = ?
      WHERE d.price_at_decision > 0 AND d.ts_utc >= ? AND d.reasons NOT LIKE '%"backfill:%'`).all(horizon, sinceIso) as any[];
    const by = new Map<string, number[]>();
    for (const r of rows) { const k = `${r.server}|${r.channel}|${r.author}`; (by.get(k) ?? by.set(k, []).get(k)!).push(r.p1 / r.p0 - 1); }
    return [...by.entries()].map(([k, v]) => {
      const s = [...v].sort((a, b) => a - b);
      return { source: k, n: v.length, medianReturn: s[Math.floor(s.length / 2)], winRate: v.filter(x => x > 0).length / v.length };
    }).sort((a, b) => b.n - a.n);
  }

  /** Signal returns for one source (server+author) over a window — for auto-downgrade. */
  sourceReturns(horizon: string, sinceIso: string): { server: string; author: string; ret: number }[] {
    const rows = this.db.prepare(`SELECT d.server, d.author, d.price_at_decision AS p0, mk.price AS p1
      FROM decisions d JOIN markouts mk ON mk.decision_id = d.id AND mk.horizon = ?
      WHERE d.price_at_decision > 0 AND d.ts_utc >= ? AND d.reasons NOT LIKE '%"backfill:%'`).all(horizon, sinceIso) as any[];
    return rows.map(r => ({ server: r.server, author: r.author, ret: r.p1 / r.p0 - 1 }));
  }

  savePosition(p: { id: string; decisionId: number; chain: string; token: string; costUsd: number; qty: number; entryPrice: number; openedUtc: string; mode: string; state: unknown }) {
    this.db.prepare(`INSERT INTO positions(id, decision_id, chain, token, cost_usd, qty, qty_left, entry_price, opened_utc, mode, state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(p.id, p.decisionId, p.chain, p.token, p.costUsd, p.qty, p.qty, p.entryPrice, p.openedUtc, p.mode, JSON.stringify(p.state));
  }
  updatePosition(id: string, qtyLeft: number, proceedsAdd: number, state: unknown, closedIso?: string, reason?: string) {
    this.db.prepare(`UPDATE positions SET qty_left=?, proceeds_usd=proceeds_usd+?, state=?, closed_utc=COALESCE(?, closed_utc), exit_reason=COALESCE(?, exit_reason) WHERE id=?`)
      .run(qtyLeft, proceedsAdd, JSON.stringify(state), closedIso ?? null, reason ?? null, id);
  }
  openPositions(): any[] { return this.db.prepare('SELECT * FROM positions WHERE closed_utc IS NULL').all() as any[]; }

  saveDowngrade(key: string, delta: number, iso: string) { this.db.prepare('INSERT OR REPLACE INTO trust_downgrades VALUES (?,?,?)').run(key, delta, iso); }
  lastDowngradeIso(key: string): string | undefined { return (this.db.prepare('SELECT updated_utc FROM trust_downgrades WHERE key=?').get(key) as any)?.updated_utc; }
  downgrades(): [string, number][] { return (this.db.prepare('SELECT key, delta FROM trust_downgrades').all() as any[]).map(r => [r.key, r.delta]); }
  addBlacklist(item: string, iso: string) { this.db.prepare('INSERT OR IGNORE INTO blacklist VALUES (?,?)').run(item.toLowerCase(), iso); }
  blacklistItems(): string[] { return (this.db.prepare('SELECT item FROM blacklist').all() as any[]).map(r => r.item); }

  /** Erases the text of messages older than 7 days. */
  // ---------- mentions and projects ----------
  addMention(key: string, m: { server: string; channel: string; author: string; tsUtc: string; id: string }, kind = 'mention') {
    this.db.prepare('INSERT INTO mentions VALUES (?,?,?,?,?,?,?)').run(key, m.server.toLowerCase(), m.channel.toLowerCase(), m.author.toLowerCase(), m.tsUtc, m.id, kind);
  }
  /** How many distinct authors and servers mentioned the keys since sinceIso. */
  mentionStats(keys: string[], sinceIso: string, server?: string): { authors: number; servers: number; total: number; serverList: string[] } {
    if (!keys.length) return { authors: 0, servers: 0, total: 0, serverList: [] };
    const ph = keys.map(() => '?').join(',');
    const extra = server ? ' AND server=?' : '';
    const args: string[] = [...keys, sinceIso, ...(server ? [server.toLowerCase()] : [])];
    const r = this.db.prepare(`SELECT COUNT(DISTINCT author) a, COUNT(DISTINCT server) s, COUNT(*) n FROM mentions WHERE key IN (${ph}) AND ts_utc>=?${extra}`).get(...args) as any;
    const list = (this.db.prepare(`SELECT DISTINCT server FROM mentions WHERE key IN (${ph}) AND ts_utc>=?${extra}`).all(...args) as any[]).map(x => x.server);
    return { authors: r.a, servers: r.s, total: r.n, serverList: list };
  }
  /** What our communities discuss most (distinct authors), with the project name if there is one. */
  topMentions(sinceIso: string, limit = 10): { key: string; name?: string; authors: number; servers: number }[] {
    return (this.db.prepare(`SELECT m.key, p.name, COUNT(DISTINCT m.author) a, COUNT(DISTINCT m.server) s FROM mentions m
      LEFT JOIN project_keys k ON k.key=m.key LEFT JOIN projects p ON p.id=k.project_id
      WHERE m.ts_utc>=? GROUP BY m.key ORDER BY a DESC, s DESC LIMIT ?`).all(sinceIso, limit) as any[])
      .map(r => ({ key: String(r.key), name: r.name ?? undefined, authors: Number(r.a), servers: Number(r.s) }));
  }
  projectIdsForKeys(keys: string[]): number[] {
    if (!keys.length) return [];
    const ph = keys.map(() => '?').join(',');
    return [...new Set((this.db.prepare(`SELECT project_id FROM project_keys WHERE key IN (${ph})`).all(...keys) as any[]).map(r => Number(r.project_id)))];
  }
  createProject(name: string, iso: string): number {
    return Number(this.db.prepare('INSERT INTO projects(name, first_seen, last_seen) VALUES (?,?,?)').run(name, iso, iso).lastInsertRowid);
  }
  linkKeys(projectId: number, keys: string[]) { for (const k of keys) this.db.prepare('INSERT OR REPLACE INTO project_keys VALUES (?,?)').run(k, projectId); }
  /** Project merge: all keys move to the smaller id. */
  mergeProjects(into: number, from: number) {
    this.db.prepare('UPDATE project_keys SET project_id=? WHERE project_id=?').run(into, from);
    // The last real verdict (T-11): the surviving card gets the newer of the two (NULL loses)
    this.db.prepare(`UPDATE projects SET last_real_verdict=f.last_real_verdict, last_real_verdict_utc=f.last_real_verdict_utc
      FROM (SELECT last_real_verdict, last_real_verdict_utc FROM projects WHERE id=?) f
      WHERE projects.id=? AND f.last_real_verdict_utc IS NOT NULL AND (projects.last_real_verdict_utc IS NULL OR f.last_real_verdict_utc > projects.last_real_verdict_utc)`).run(from, into);
    this.db.prepare('DELETE FROM projects WHERE id=?').run(from);
  }
  touchProject(id: number, iso: string) { this.db.prepare('UPDATE projects SET last_seen=? WHERE id=?').run(iso, id); }
  project(id: number): any { return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); }
  projectKeys(id: number): string[] { return (this.db.prepare('SELECT key FROM project_keys WHERE project_id=?').all(id) as any[]).map(r => r.key); }
  setProjectVerdict(id: number, v: { name?: string; category?: string; verdict: string; thesis: string; scores: unknown; iso: string; analyzedKeys: string[]; trust: number }) {
    // Analysed keys accumulate (A, B, A — the third time A is no longer news)
    const prev = (this.db.prepare('SELECT analyzed_keys FROM projects WHERE id=?').get(id) as any)?.analyzed_keys;
    const keys = [...new Set([...(prev ? JSON.parse(prev) as string[] : []), ...v.analyzedKeys])];
    this.db.prepare('UPDATE projects SET name=COALESCE(?, name), category=COALESCE(?, category), last_verdict=?, last_thesis=?, scores=?, last_analysis_utc=?, analyzed_keys=?, last_trust=? WHERE id=?')
      .run(v.name ?? null, v.category ?? null, v.verdict, v.thesis, JSON.stringify(v.scores), v.iso, JSON.stringify(keys), v.trust, id);
    // The real verdict is kept separately: the seen mark and others do not overwrite it (T-11)
    if (REAL_VERDICTS.has(v.verdict)) this.db.prepare('UPDATE projects SET last_real_verdict=?, last_real_verdict_utc=? WHERE id=?').run(v.verdict, v.iso, id);
  }
  /** The card's last real verdict (T-11); for old rows — last_verdict if it is a real one. */
  projectRealVerdict(id: number): { verdict: string; atIso: string } | undefined {
    const p = this.db.prepare('SELECT last_verdict, last_analysis_utc, last_real_verdict, last_real_verdict_utc FROM projects WHERE id=?').get(id) as any;
    if (p?.last_real_verdict && p.last_real_verdict_utc) return { verdict: p.last_real_verdict, atIso: p.last_real_verdict_utc };
    return p && REAL_VERDICTS.has(p.last_verdict) && p.last_analysis_utc ? { verdict: p.last_verdict, atIso: p.last_analysis_utc } : undefined;
  }
  /** All source names (servers, channels, authors) — so none of them gets into a public post. */
  sourceNames(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT server AS n FROM messages UNION SELECT DISTINCT channel FROM messages UNION SELECT DISTINCT author FROM messages').all() as any[];
    return rows.map(r => String(r.n ?? '')).filter(n => n.replace(/\W/g, '').length >= 3);
  }
  saveAnalysis(a: { iso: string; msgId: string; projectId?: number; model: string; trigger: string; verdict: string; confidence: number; json: unknown; costUsd: number }) {
    this.db.prepare('INSERT INTO analyses(ts_utc, msg_id, project_id, model, trigger, verdict, confidence, json, cost_usd) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(a.iso, a.msgId, a.projectId ?? null, a.model, a.trigger, a.verdict, a.confidence, JSON.stringify(a.json), a.costUsd);
  }
  saveGate(g: { msgId: string; iso: string; server: string; channel: string; cls: string; escalate: boolean; score: number; triggers: unknown; costUsd: number }) {
    this.db.prepare('INSERT INTO gate_log VALUES (?,?,?,?,?,?,?,?,?)').run(g.msgId, g.iso, g.server, g.channel, g.cls, g.escalate ? 1 : 0, g.score, JSON.stringify(g.triggers), g.costUsd);
  }
  addSpend(day: string, model: string, usd: number) {
    this.db.prepare('INSERT INTO llm_spend VALUES (?,?,?) ON CONFLICT(day, model) DO UPDATE SET usd = usd + excluded.usd').run(day, model, usd);
  }
  spendOn(day: string): [string, number][] { return (this.db.prepare('SELECT model, usd FROM llm_spend WHERE day=?').all(day) as any[]).map(r => [r.model, r.usd]); }
  analysesOn(day: string): { verdict: string; n: number }[] {
    return this.db.prepare('SELECT verdict, COUNT(*) n FROM analyses WHERE substr(ts_utc,1,10)=? GROUP BY verdict').all(day) as any[];
  }

  addWatch(projectId: number, msgId: string, dueUtc: string, reason: string) {
    const dup = this.db.prepare('SELECT 1 FROM watch WHERE project_id=? AND due_utc=? AND done=0').get(projectId, dueUtc);
    if (!dup) this.db.prepare('INSERT INTO watch(project_id, msg_id, due_utc, reason) VALUES (?,?,?,?)').run(projectId, msgId, dueUtc, reason);
  }
  watchCount24h(projectId: number, sinceIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM watch WHERE project_id=? AND due_utc>=?').get(projectId, sinceIso) as any).n;
  }
  defaultRechecks24h(sinceIso: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM watch WHERE reason LIKE 'watch without a time%' AND due_utc>=?").get(sinceIso) as any).n;
  }
  dueWatch(nowIso: string): { id: number; project_id: number; msg_id: string; due_utc: string; reason: string }[] {
    return this.db.prepare('SELECT * FROM watch WHERE done=0 AND due_utc<=? ORDER BY due_utc').all(nowIso) as any[];
  }
  doneWatch(id: number) { this.db.prepare('UPDATE watch SET done=1 WHERE id=?').run(id); }
  message(id: string): { id: string; ts_utc: string; server: string; channel: string; author: string; text: string } | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as any;
  }
  /** dedup — the key "kind|target|time": a repeat analysis of the same action does not schedule it twice. */
  addScheduled(dueUtc: string, msg: unknown, intent: unknown, trust: unknown, ctx: unknown, dedup: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO scheduled(due_utc, msg_json, intent_json, trust_json, ctx_json, dedup) VALUES (?,?,?,?,?,?)').run(dueUtc, JSON.stringify(msg), JSON.stringify(intent), JSON.stringify(trust), JSON.stringify(ctx), dedup);
    return Number(r.changes) > 0;
  }
  dueScheduled(nowIso: string): any[] { return this.db.prepare('SELECT * FROM scheduled WHERE done=0 AND due_utc<=? ORDER BY due_utc').all(nowIso) as any[]; }
  doneScheduled(id: number) { this.db.prepare('UPDATE scheduled SET done=1 WHERE id=?').run(id); }
  addPostDraft(iso: string, kind: string, text: string) { this.db.prepare('INSERT INTO post_drafts(ts_utc, kind, text, status) VALUES (?,?,?,?)').run(iso, kind, text, 'draft'); }
  // ---------- X post queue ----------
  private postCols = false;
  private ensurePostCols() {
    if (this.postCols) return;
    for (const c of ['image TEXT', 'x_id TEXT', 'error TEXT', 'tg_msg INTEGER', 'posted_utc TEXT', 'auto_at TEXT', 'thought_keys TEXT']) { try { this.db.exec(`ALTER TABLE post_drafts ADD COLUMN ${c}`); } catch { /* already exists */ } }
    this.postCols = true;
  }
  addPost(iso: string, kind: string, text: string): number {
    this.ensurePostCols();
    return Number(this.db.prepare('INSERT INTO post_drafts(ts_utc, kind, text, status) VALUES (?,?,?,?)').run(iso, kind, text, 'pending').lastInsertRowid);
  }
  updatePost(id: number, f: Partial<Record<'status' | 'image' | 'x_id' | 'error' | 'posted_utc' | 'auto_at' | 'thought_keys', string> & { tg_msg: number | null }>) {
    this.ensurePostCols();
    const keys = Object.keys(f).filter(k => ['status', 'image', 'x_id', 'error', 'posted_utc', 'auto_at', 'tg_msg', 'thought_keys'].includes(k));
    if (!keys.length) return;
    this.db.prepare(`UPDATE post_drafts SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map(k => (f as any)[k] ?? null), id);
  }
  getPost(id: number): { id: number; ts_utc: string; kind: string; text: string; status: string; image?: string; tg_msg?: number; thought_keys?: string | null } | undefined {
    this.ensurePostCols();
    return this.db.prepare('SELECT * FROM post_drafts WHERE id=?').get(id) as any;
  }
  /**
   * Posts promised auto-publishing without a reply in Telegram (T-05): they wait for the button and have an auto_at deadline.
   * A post without auto_at (created before the timer was enabled, or "button only") never gets here.
   */
  autoPosts(): { id: number; ts_utc: string; auto_at: string }[] { this.ensurePostCols(); return this.db.prepare("SELECT id, ts_utc, auto_at FROM post_drafts WHERE status='awaiting' AND auto_at IS NOT NULL ORDER BY id").all() as any[]; }
  /** Posts in the given status (publishing — the X request was sent, no answer yet). */
  postsByStatus(status: string): { id: number; text: string }[] { this.ensurePostCols(); return this.db.prepare('SELECT id, text FROM post_drafts WHERE status=? ORDER BY id').all(status) as any[]; }
  /** How many posts of a kind were created since a moment (any status: the limit applies to Telegram drafts too). */
  postsOfKind(kind: string, sinceIso: string): number { this.ensurePostCols(); return (this.db.prepare('SELECT COUNT(*) n FROM post_drafts WHERE kind=? AND ts_utc>=?').get(kind, sinceIso) as any).n; }
  /** The time of the last message from the intake server (for the silence watchdog). */
  lastMessageUtc(): string | undefined { return (this.db.prepare('SELECT MAX(ts_utc) t FROM messages').get() as any)?.t ?? undefined; }
  postsOn(day: string): number { this.ensurePostCols(); return (this.db.prepare("SELECT COUNT(*) n FROM post_drafts WHERE status='posted' AND substr(posted_utc,1,10)=?").get(day) as any).n; }

  purgeOldText(cutoffIso: string) { this.db.prepare("UPDATE messages SET text='' WHERE ts_utc < ?").run(cutoffIso); }
}
