// E-09 (#45): resetting the paper ledger before live. Paper capital and paper positions must not carry over into live:
//  - with a live starting capital in risk.json above the saved paper capital the agent would immediately trigger the hard stop;
//  - the monitor in live would start "selling" paper positions for real.
// What the command does (on the server, over SSH, with the agent STOPPED):
//   1) checks that the agent is stopped, that the journal has no open live positions and that risk.json already has the right capital;
//   2) makes a full copy of the database next to it (agent.sqlite.paper-<UTC time>) and verifies it against the original;
//   3) in one transaction closes the open paper positions (with a reason mark) and deletes the risk state —
//      on the next start the agent takes the starting capital from risk.json.
// Everything else in the database (messages, decisions, analyses, trust, blacklist, model spend) stays.
// The command does not touch the review journal (server/data/review/) or the keystore.
//   cd /opt/agent && npx --no-install tsx src/exec/ledgerReset.ts --capital 50          (asks for yes)
//   cd /opt/agent && npx --no-install tsx src/exec/ledgerReset.ts --capital 50 --check  (only show, change nothing)
// A command for the FIRST live start: if the journal already has LIVE trades — refusal (the ledger is real); override — --after-live, deliberately.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { Store } from '../store/db.js';
import { ReviewLog } from '../review/log.js';

export interface LedgerResetDeps {
  dbPath: string;
  reviewDir: string;
  /** Starting capital from risk.json that the agent will take after the reset. */
  initialCapitalUsd: number;
  /** Capital the owner expects to see in the live ledger (the --capital argument). */
  expectCapitalUsd: number | undefined;
  /** Only show the state and what would be done. */
  checkOnly: boolean;
  /**
   * The journal already had LIVE trades (closed) — so live has run, and the reset would wipe the REAL ledger (capital, stops, daily result).
   * Default — refusal; override — only with the explicit --after-live flag, deliberately.
   */
  allowAfterLive?: boolean;
  /** Whether the agent service is running; undefined — could not check (no systemctl). */
  agentActive(): boolean | undefined;
  ask(question: string): Promise<string>;
  print(line: string): void;
  now(): number;
}

export const RESET_REASON = 'paper ledger reset before live (E-09)';
const usd = (n: unknown) => `$${Number(n).toFixed(2)}`;
/** Tables whose row counts are used to verify the copy against the original. */
const VERIFY_TABLES = ['messages', 'decisions', 'positions', 'risk_state', 'analyses', 'trust_downgrades', 'blacklist'] as const;

/** The command runs as root: the files it creates are handed to the database's file owner — otherwise the agent could not write to them. */
function keepOwner(uid: number, gid: number, paths: string[]) {
  for (const f of paths) {
    if (!existsSync(f)) continue;
    try { chownSync(f, uid, gid); } catch (e: any) { if (e?.code !== 'EPERM') throw e; } // not root — the files are ours anyway
  }
}
function counts(store: Store): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of VERIFY_TABLES) out[t] = Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  return out;
}

/** Exit code: 0 — the reset is done (or there is nothing to reset / --check mode); 1 — refusal, nothing changed. */
export async function runLedgerReset(d: LedgerResetDeps): Promise<number> {
  if (d.expectCapitalUsd === undefined || !(d.expectCapitalUsd > 0)) {
    d.print('Usage: npx --no-install tsx src/exec/ledgerReset.ts --capital <live starting capital, $> [--check]');
    return 1;
  }
  // Order matters: first the new risk.json, then the reset. Otherwise after the start the ledger would begin with the wrong amount
  if (d.initialCapitalUsd !== d.expectCapitalUsd) {
    d.print(`Refused: server/config/risk.json has starting capital ${usd(d.initialCapitalUsd)}, but you passed --capital ${d.expectCapitalUsd}.`);
    d.print('First put a risk.json with the right capital on the server (the server deployment guide, "Update", item 6), then repeat the command. Nothing changed.');
    return 1;
  }
  if (!existsSync(d.dbPath)) {
    d.print(`No journal (${d.dbPath}): nothing to reset — the agent will start the ledger at ${usd(d.initialCapitalUsd)}.`);
    return 0;
  }
  const owner = statSync(d.dbPath);
  const stamp = new Date(d.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261111-104500
  const backupPath = `${d.dbPath}.paper-${stamp}`;
  const reviewFile = join(d.reviewDir, `${new Date(d.now()).toISOString().slice(0, 10)}.jsonl`);
  const store = new Store(d.dbPath);
  try {
    store.db.exec('PRAGMA busy_timeout=5000');
    const row = store.db.prepare('SELECT json, updated_utc FROM risk_state WHERE id=1').get() as { json: string; updated_utc: string } | undefined;
    const s = row ? JSON.parse(row.json) : undefined;
    const open = store.openPositions() as { id: string; mode: string; cost_usd: number }[];
    // Everything that is not paper (live, shadow, empty mode) is not ours: the reset does not touch such rows, and with them it refuses
    const liveOpen = open.filter(p => p.mode !== 'paper');
    // Live has already run — a sign from the database (the command does not read the .env file): decisions made in live (pipeline/router write mode='live'),
    // or live positions. Live changes risk accounting even without positions: gas of a failed live mint (risk.spend), /stop, stops from positions
    // that are marked paper in live (perps, predictions) — so the positions rows alone are not enough
    const liveDecisions = Number((store.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE mode='live'`).get() as { n: number }).n);
    const livePositions = Number((store.db.prepare(`SELECT COUNT(*) AS n FROM positions WHERE mode='live'`).get() as { n: number }).n);
    const liveEver = liveDecisions + livePositions;
    const paperOpen = open.length - liveOpen.length;
    const pendingScheduled = Number((store.db.prepare('SELECT COUNT(*) AS n FROM scheduled WHERE done=0').get() as { n: number }).n);

    if (s) {
      d.print(`Ledger now: capital ${usd(s.equityUsd)}, cash ${usd(s.cashUsd)}, positions in the risk state: ${(s.positions ?? []).length}; saved ${String(row!.updated_utc).slice(0, 16).replace('T', ' ')} UTC`);
      d.print(`Hard stop: ${s.hardStopped ? 'ON' : 'no'} · operator stop (/stop): ${s.operatorHalt ? 'ON' : 'no'}`);
    } else d.print('No risk state in the journal.');
    d.print(`Open positions in the journal: ${open.length} (paper ${open.length - liveOpen.length}, live ${liveOpen.length})`);
    d.print(`After the reset the agent will start the ledger at ${usd(d.initialCapitalUsd)} (risk.json), with no positions.`);
    if (pendingScheduled) d.print(`ℹ️ The journal has ${pendingScheduled} deferred decisions (scheduled table) — the reset does not touch them: at their due time the agent will decide again, by the live rules.`);

    // Real positions must not be reset: the tokens would remain on the wallet without accounting and without a stop
    if (liveOpen.length) {
      d.print(`Refused: the journal has ${liveOpen.length} open non-paper positions (${liveOpen.slice(0, 3).map(p => `${p.id} [${p.mode ?? '?'}]`).join(', ')}${liveOpen.length > 3 ? ', …' : ''}). This may be real money — the reset would lose it. Nothing changed; write to the "Execution" chat.`);
      return 1;
    }
    // Live has already run: the risk state is real capital, stops and the daily result, not paper accounting
    if (liveEver && !d.allowAfterLive) {
      d.print(`Refused: the journal has ${liveDecisions} decisions and ${livePositions} positions in live mode — live has already run, and the risk state is now real (capital, hard stop, /stop, daily result). This command is for resetting the PAPER ledger before the first live start. Nothing changed. If a reset after live is needed deliberately — repeat with the --after-live flag and write to the "Execution" chat.`);
      return 1;
    }
    if (!s && !open.length) { d.print('The ledger is already clean — nothing to do.'); return 0; }
    if (d.checkOnly) { d.print(`--check mode: nothing changed. The reset would close ${paperOpen} paper positions, delete the risk state and keep a copy of the database next to it (${backupPath.split('/').pop()}).`); return 0; }

    const active = d.agentActive();
    if (active) { d.print('Refused: the agent is running — it will overwrite the ledger from memory. Stop it first: systemctl stop agent. Nothing changed.'); return 1; }
    if (active === undefined) d.print('⚠️ Could not check the agent service: systemctl did not answer clearly. Continue only if the agent is definitely stopped (systemctl status agent --no-pager → "Active: inactive").');
    // The risk state changed less than a minute ago — something is writing it (the agent running outside the service?): leave it alone
    if (row && d.now() - Date.parse(row.updated_utc) < 60_000) { d.print(`Refused: the risk state was saved ${Math.round((d.now() - Date.parse(row.updated_utc)) / 1000)} s ago — the agent seems to be running. Stop it and retry in a minute. Nothing changed.`); return 1; }
    const answer = (await d.ask(`Reset the paper ledger (a copy of the database will be kept)? Type yes: `)).trim();
    if (answer !== 'yes') { d.print('Cancelled, nothing changed.'); return 1; }

    // 1) Copy: VACUUM INTO writes a consistent snapshot including what is still in the WAL. Verify before any changes
    if (existsSync(backupPath)) { d.print(`Refused: the copy file already exists (${backupPath}). Repeat the command in a minute. Nothing changed.`); return 1; }
    const before = counts(store);
    store.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    try { chmodSync(backupPath, owner.mode & 0o777); } catch { /* permissions as the original — best effort */ } // the database holds a week of private Discord
    const copy = new Store(backupPath);
    let copyOk = false;
    try {
      const copied = counts(copy);
      const copyRow = copy.db.prepare('SELECT json FROM risk_state WHERE id=1').get() as { json: string } | undefined;
      copyOk = VERIFY_TABLES.every(t => copied[t] === before[t]) && (copyRow?.json ?? null) === (row?.json ?? null)
        && String((copy.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check) === 'ok';
    } finally { copy.db.close(); }
    // Opening the copy for verification may have created -wal/-shm next to it: they are not needed in the archive
    for (const ext of ['-wal', '-shm']) { try { unlinkSync(`${backupPath}${ext}`); } catch { /* no file */ } }
    if (!copyOk) { d.print(`Refused: the copy ${backupPath} did not match the database on verification. The ledger was NOT changed; do not use the copy, write to the "Execution" chat.`); return 1; }
    d.print(`Copy saved and verified: ${backupPath}`);

    // 2) Reset — in one transaction: all or nothing. Inside the transaction positions are re-read: while we waited for "yes", a
    //    LIVE position may have appeared (the agent started outside the service) — then roll back. ONLY paper ones are closed
    const iso = new Date(d.now()).toISOString();
    let closedPaper = 0;
    try { store.db.exec('BEGIN IMMEDIATE'); }
    catch (e) { d.print(`Refused: the database is busy with another process (${String((e as Error)?.message ?? e).slice(0, 80)}) — the agent or another command is writing to it. Stop them and retry. Nothing changed; the copy ${backupPath} remains, it can be deleted.`); return 1; }
    try {
      const nowOpen = store.openPositions() as { id: string; mode: string }[];
      const nowLive = nowOpen.filter(p => p.mode !== 'paper');
      if (nowLive.length) { store.db.exec('ROLLBACK'); d.print(`Refused: while the command waited for confirmation, non-paper positions appeared in the journal (${nowLive.map(p => `${p.id} [${p.mode}]`).slice(0, 3).join(', ')}) — is the agent running? Nothing changed; the copy ${backupPath} remains.`); return 1; }
      closedPaper = Number(store.db.prepare(`UPDATE positions SET closed_utc=?, exit_reason=? WHERE closed_utc IS NULL AND mode='paper'`).run(iso, RESET_REASON).changes);
      store.db.prepare('DELETE FROM risk_state').run();
      store.db.exec('COMMIT');
    } catch (e) { try { store.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }

    // 3) Check the result the same way the agent reads it at startup
    const left = store.openPositions().length;
    const state = store.loadRiskState();
    if (left !== 0 || state !== undefined) { d.print(`⚠️ After the reset the journal still has: open positions ${left}, risk state ${state ? 'present' : 'absent'}. Do not start the agent, write to the "Execution" chat. Copy: ${backupPath}`); return 1; }
    new ReviewLog(d.reviewDir, d.now).write('operator', { cmd: 'ledger reset', closedPaperPositions: closedPaper, prevEquityUsd: s?.equityUsd, prevCashUsd: s?.cashUsd, prevHardStopped: s?.hardStopped,
      prevOperatorHalt: s?.operatorHalt, startCapitalUsd: d.initialCapitalUsd, backup: backupPath, afterLive: !!liveEver });
    d.print(`Ledger reset: paper positions closed ${closedPaper}, risk state deleted. After the start the agent will begin at ${usd(d.initialCapitalUsd)}.`);
    if (s?.operatorHalt) d.print('⚠️ The operator stop (/stop) was on and was reset together with the ledger. If you need it — send /stop in Telegram right after starting the agent.');
    d.print('Next: chown -R agent:agent /opt/agent/server/data. DO NOT START THE AGENT until the deposit is made and the three live lines are added to .env (the live deployment guide, section 6, steps 1–2): a start in paper will open paper positions again, and in live the monitor would sell them for real. If you did start it — repeat the reset.');
    d.print(`Restore as it was — only BEFORE the first live start, with the agent stopped, and together with the previous risk.json (otherwise with capital ${usd(d.initialCapitalUsd)} in risk.json and ${usd(s?.equityUsd ?? 0)} in the ledger the agent will immediately trigger the hard stop): rm -f ${d.dbPath}-wal ${d.dbPath}-shm && cp ${backupPath} ${d.dbPath}`);
    return 0;
  } finally {
    store.db.close();
    keepOwner(owner.uid, owner.gid, [d.dbPath, `${d.dbPath}-wal`, `${d.dbPath}-shm`, backupPath, d.reviewDir, reviewFile]);
  }
}

/**
 * The `systemctl is-active agent` answer → whether the agent is running. Empty output or error text — "don't know" (undefined), not "stopped":
 * otherwise the ledger would be reset under a running agent. (The same rule as in src/tools/risk.ts.)
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

export function parseArgs(argv: string[]): { capital: number | undefined; check: boolean; afterLive: boolean } {
  const i = argv.indexOf('--capital');
  const eq = argv.find(a => a.startsWith('--capital='));
  const raw = i >= 0 ? argv[i + 1] : eq?.slice('--capital='.length);
  const capital = raw !== undefined && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : undefined;
  return { capital, check: argv.includes('--check'), afterLive: argv.includes('--after-live') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  // S-06: an invalid risk.json does not block the reset — only a warning (invalid fields are replaced with approved ones)
  for (const p of cfg.risk.riskProblems ?? []) console.log(`⚠️ risk.json is invalid: ${p} (the approved value is used)`);
  const args = parseArgs(process.argv.slice(2));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // stdin is closed (run with < /dev/null, SSH dropped) — that is a cancellation, not an endless wait
  const ask = (q: string) => new Promise<string>(res => { rl.once('close', () => res('')); rl.question(q).then(res, () => res('')); });
  const code = await runLedgerReset({
    dbPath: join(cfg.dataDir, 'agent.sqlite'), reviewDir: join(cfg.dataDir, 'review'),
    initialCapitalUsd: cfg.risk.initialCapitalUsd, expectCapitalUsd: args.capital, checkOnly: args.check, allowAfterLive: args.afterLive,
    agentActive: systemdAgentActive, ask, print: (l) => console.log(l), now: () => Date.now(),
  }).finally(() => rl.close());
  process.exit(code);
}
