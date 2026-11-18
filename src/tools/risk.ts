// The hard stop (capital below the threshold from risk.json) is lifted only by the owner — on the server, over SSH (HQ decision, O-05 #44):
//   systemctl stop agent
//   cd /opt/agent && npm run risk -- unhalt        (asks for yes)
//   chown -R agent:agent /opt/agent/server/data && systemctl start agent
// A running agent keeps the risk state in memory and rewrites it to the DB on every change, so
// the stop can be lifted only while the agent is stopped — the script checks this itself.
//   npm run risk -- status                           (view only; no need to stop the agent)
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { chownSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { Store } from '../store/db.js';
import { ReviewLog } from '../review/log.js';

export interface RiskToolDeps {
  dbPath: string;
  reviewDir: string;
  initialCapitalUsd: number;
  hardStopEquityShare: number;
  /** S-06: risk.json problems (cfg.risk.riskProblems). Invalid initialCapitalUsd or hardStopEquityShare — unhalt refuses: the threshold is unknown. */
  riskProblems?: string[];
  /** Whether the agent service is running; undefined — could not check (no systemctl). */
  agentActive(): boolean | undefined;
  ask(question: string): Promise<string>;
  print(line: string): void;
  now(): number;
}

const usd = (n: number) => `$${Number(n).toFixed(2)}`;

/** The script runs as root: SQLite files (-wal, -shm) and log files it creates are handed to the DB file's owner — otherwise the agent cannot write to them. */
function keepOwner(uid: number, gid: number, paths: string[]) {
  for (const f of paths) {
    if (!existsSync(f)) continue;
    try { chownSync(f, uid, gid); } catch (e: any) { if (e?.code !== 'EPERM') throw e; } // not root — the files are ours anyway
  }
}

export async function runRiskTool(cmd: string | undefined, d: RiskToolDeps): Promise<number> {
  if (cmd !== 'status' && cmd !== 'unhalt') { d.print('Usage: npm run risk -- status | unhalt'); return 1; }
  if (!existsSync(d.dbPath)) { d.print(`No journal (${d.dbPath}): the agent has not run yet.`); return 1; }
  const owner = statSync(d.dbPath);
  const reviewFile = join(d.reviewDir, `${new Date(d.now()).toISOString().slice(0, 10)}.jsonl`);
  const store = new Store(d.dbPath);
  try {
    store.db.exec('PRAGMA busy_timeout=5000');
    const row = store.db.prepare('SELECT json, updated_utc FROM risk_state WHERE id=1').get() as { json: string; updated_utc: string } | undefined;
    if (!row) { d.print('No risk state in the journal: the agent has not run yet.'); return 1; }
    const s = JSON.parse(row.json);
    const threshold = d.initialCapitalUsd * d.hardStopEquityShare;
    d.print(`Capital without open positions: ${usd(s.equityUsd)}, cash ${usd(s.cashUsd)}, open positions: ${(s.positions ?? []).length}`);
    d.print(`Hard stop threshold: ${usd(threshold)} (${Math.round(d.hardStopEquityShare * 100)} % of the starting ${usd(d.initialCapitalUsd)})`);
    d.print(`Hard stop: ${s.hardStopped ? 'ON' : 'no'} · state saved ${String(row.updated_utc).slice(0, 16).replace('T', ' ')} UTC`);
    if (cmd === 'status') return 0;

    if (!s.hardStopped) { d.print('No hard stop — nothing to lift.'); return 0; }
    const badThreshold = (d.riskProblems ?? []).filter(p => /^(initialCapitalUsd|hardStopEquityShare)=/.test(p));
    if (badThreshold.length) { d.print(`Refused: risk.json is invalid — ${badThreshold.join('; ')}. The hard stop threshold is unknown. Fix server/config/risk.json and retry.`); return 1; }
    const active = d.agentActive();
    if (active) { d.print('The agent is running — it will overwrite the change. Stop it first: systemctl stop agent'); return 1; }
    if (active === undefined) d.print('⚠️ Could not check the agent service: systemctl gave no clear answer. Continue only if the agent is definitely stopped (systemctl status agent --no-pager → "Active: inactive").');
    if (s.equityUsd < threshold) d.print(`⚠️ Capital ${usd(s.equityUsd)} is still below the threshold ${usd(threshold)}: on the first recalculation the agent will turn the hard stop on again. Top up the account or reset the ledger first.`);
    else if ((s.positions ?? []).length) d.print(`The capital above counts only closed trades. The agent compares capital including open positions (${(s.positions ?? []).length}) with the threshold: if they are in the red, the stop may turn on again.`);
    const answer = (await d.ask('Lift the hard stop? Type yes: ')).trim();
    if (answer !== 'yes') { d.print('Cancelled, nothing changed.'); return 1; }

    s.hardStopped = false;
    const iso = new Date(d.now()).toISOString();
    store.saveRiskState(s, iso);
    new ReviewLog(d.reviewDir, d.now).write('operator', { cmd: 'risk unhalt', equityUsd: s.equityUsd, cashUsd: s.cashUsd, thresholdUsd: threshold });
    d.print('Hard stop lifted. Restore permissions and start the agent: chown -R agent:agent /opt/agent/server/data && systemctl start agent');
    return 0;
  } finally {
    store.db.close();
    keepOwner(owner.uid, owner.gid, [d.dbPath, `${d.dbPath}-wal`, `${d.dbPath}-shm`, d.reviewDir, reviewFile]);
  }
}

/**
 * Output of `systemctl is-active agent` → whether the agent is running. A systemctl failure (no D-Bus, no permissions) gives empty output
 * or an error text — that is "unknown" (undefined), not "stopped": otherwise the stop could be lifted under a running agent.
 */
export function agentActiveFromSystemctl(stdout: string): boolean | undefined {
  const state = stdout.trim().split('\n')[0]?.trim();
  if (state === 'active' || state === 'activating' || state === 'reloading' || state === 'refreshing') return true;
  if (state === 'inactive' || state === 'failed' || state === 'deactivating') return false;
  return undefined;
}

function systemdAgentActive(): boolean | undefined {
  try { return agentActiveFromSystemctl(execFileSync('systemctl', ['is-active', 'agent'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e: any) { return e?.code === 'ENOENT' ? undefined : agentActiveFromSystemctl(String(e?.stdout ?? '')); } // not active → exit code ≠ 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  // S-06: an invalid risk.json does not block the emergency tool — only a warning (invalid fields replaced by approved values)
  for (const p of cfg.risk.riskProblems ?? []) console.log(`⚠️ risk.json is invalid: ${p} (approved value used; the agent is in "exits only" mode)`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // stdin closed (run with < /dev/null, SSH drop) — that is a cancel, not an endless wait
  const ask = (q: string) => new Promise<string>(res => { rl.once('close', () => res('')); rl.question(q).then(res, () => res('')); });
  const code = await runRiskTool(process.argv[2], {
    dbPath: join(cfg.dataDir, 'agent.sqlite'), reviewDir: join(cfg.dataDir, 'review'),
    initialCapitalUsd: cfg.risk.initialCapitalUsd, hardStopEquityShare: cfg.risk.hardStopEquityShare, riskProblems: cfg.risk.riskProblems,
    agentActive: systemdAgentActive, ask, print: (l) => console.log(l), now: () => Date.now(),
  }).finally(() => rl.close());
  process.exit(code);
}
