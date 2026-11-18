// Manual re-check of a token/project: puts it on the watch list with the deadline "now".
// The running agent rebuilds the dossier within a minute and gives the analyst the original message.
// Run on the server: cd /opt/agent && npm run recheck -- 0x5b2e8a47d1c9f03e6b72a5d84c19e0f37ab2c4f9
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { loadConfig } from '../config.js';

const q = (process.argv[2] ?? '').trim().replace(/^\$/, '');
if (q.length < 2) { console.log('Give an address or a ticker: npm run recheck -- 0x…'); process.exit(1); }
const keys = q.startsWith('0x') ? [`evm:${q.toLowerCase()}`] : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q) ? [`sol:${q}`] : [`ticker:${q.toLowerCase()}`];
const db = new DatabaseSync(join(loadConfig().dataDir, 'agent.sqlite'));
db.exec('PRAGMA busy_timeout=5000');
const ph = keys.map(() => '?').join(',');
const pk = db.prepare(`SELECT k.project_id id, p.name FROM project_keys k JOIN projects p ON p.id=k.project_id WHERE k.key IN (${ph}) LIMIT 1`).get(...keys) as any;
if (!pk) { console.log(`Project "${q}" not found in the log. The agent has not seen messages about it yet.`); process.exit(1); }
// The original message: the latest mention of this key
const m = db.prepare(`SELECT msg_id, server, channel, author, ts_utc FROM mentions WHERE key IN (${ph}) ORDER BY ts_utc DESC LIMIT 1`).get(...keys) as any;
if (!m) { console.log('No source message for the re-check.'); process.exit(1); }
const now = new Date().toISOString();
db.prepare('INSERT INTO watch(project_id, msg_id, due_utc, reason) VALUES (?,?,?,?)').run(pk.id, m.msg_id, now, 'manual recheck requested by the owner');
console.log(`Queued: ${pk.name} — from message ${m.server}/#${m.channel}/${m.author} at ${m.ts_utc.slice(0, 16).replace('T', ' ')} UTC.`);
console.log('The agent will analyse it within a minute. Watch: journalctl -u agent -f -o cat');
