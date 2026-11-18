// "Why the agent decided this": all messages, analyses and decisions by ticker, address or name (reads the log only).
// Run on the server: cd /opt/agent && npm run why -- KEG
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { loadConfig } from '../config.js';

const q = process.argv.slice(2).join(' ').trim().replace(/^\$/, '');
if (q.length < 2) { console.log('Give a ticker, address or name: npm run why -- KEG'); process.exit(1); }
const hours = Number(process.env.WHY_HOURS ?? 72);
const cfg = loadConfig();
const db = new DatabaseSync(join(cfg.dataDir, 'agent.sqlite'), { readOnly: true });
const since = new Date(Date.now() - hours * 3600_000).toISOString();
const like = `%${q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;

const short = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);
const parse = (s: string | null) => { try { return JSON.parse(s ?? 'null'); } catch { return null; } };

// 1. Messages with a mention
const msgs = db.prepare(`SELECT id, ts_utc, server, channel, author, text FROM messages
  WHERE ts_utc >= ? AND lower(text) LIKE ? ESCAPE '\\' ORDER BY ts_utc LIMIT 30`).all(since, like) as any[];
// 2. Analyses: of these messages + batches and re-checks where the name is in the model answer
const ids = msgs.map(m => m.id);
const analyses = db.prepare(`SELECT a.ts_utc, a.msg_id, a.model, a.trigger, a.verdict, a.confidence, a.json, a.cost_usd FROM analyses a
  WHERE a.ts_utc >= ? AND (a.msg_id IN (${ids.map(() => '?').join(',') || "''"}) OR lower(a.json) LIKE ? ESCAPE '\\') ORDER BY a.ts_utc`).all(since, ...ids, like) as any[];
// 3. Code decisions (filters, risk control, trades)
const decisions = db.prepare(`SELECT ts_utc, message_id, server, channel, author, chain, token, action, size_usd, trust_score, price_at_decision, reasons FROM decisions
  WHERE ts_utc >= ? AND (message_id IN (${ids.map(() => '?').join(',') || "''"}) OR lower(token) LIKE ? ESCAPE '\\') ORDER BY ts_utc`).all(since, ...ids, like) as any[];

console.log(`«${q}» over ${hours} h (UTC): messages ${msgs.length}, analyses ${analyses.length}, decisions ${decisions.length}\n`);
const events: { t: string; line: string }[] = [];
for (const m of msgs) events.push({ t: m.ts_utc, line: `💬 ${m.ts_utc.slice(5, 16).replace('T', ' ')}  ${m.server}/#${m.channel}/${m.author}\n   ${short(m.text, 300)}` });
for (const a of analyses) {
  const j = parse(a.json) ?? {};
  const why = j.thesis ?? j.reason ?? '';
  const risks = Array.isArray(j.risks) && j.risks.length ? `\n   risks: ${j.risks.slice(0, 4).join(' | ')}` : '';
  const proj = Array.isArray(j.projects) ? j.projects.filter((p: any) => `${p.ref} ${p.name ?? ''}`.toLowerCase().includes(q.toLowerCase())).map((p: any) => `\n   on project ${p.name ?? p.ref}: ${p.verdict} — ${short(p.thesis, 300)}`).join('') : '';
  events.push({ t: a.ts_utc, line: `🧠 ${a.ts_utc.slice(5, 16).replace('T', ' ')}  ${String(a.model).replace('claude-', '')} [${a.trigger}] → ${a.verdict} (${a.confidence}) $${Number(a.cost_usd).toFixed(4)}\n   ${short(why, 600)}${risks}${proj}` });
}
for (const d of decisions) {
  const reasons = (parse(d.reasons) ?? []) as string[];
  events.push({ t: d.ts_utc, line: `⚙️ ${d.ts_utc.slice(5, 16).replace('T', ' ')}  code: ${d.action}${d.size_usd ? ` $${d.size_usd}` : ''} · ${d.chain} · score ${d.trust_score}${d.price_at_decision ? ` · price $${d.price_at_decision}` : ''}\n   ${reasons.join('; ').slice(0, 500)}` });
}
events.sort((a, b) => a.t.localeCompare(b.t));
console.log(events.map(e => e.line).join('\n\n') || 'Nothing found. Try the contract address or WHY_HOURS=168 npm run why -- …');
