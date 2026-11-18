// E-09 (#45): resetting the paper ledger before live — with a database copy, copy verification and refusals where the reset is dangerous.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { runLedgerReset, parseArgs, agentActiveFromSystemctl, RESET_REASON, type LedgerResetDeps } from '../src/exec/ledgerReset.js';

const NOW = Date.UTC(2026, 10, 11, 10, 45, 0);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The database after a paper week: capital $10 → $8.5, hard stop, two open paper positions, one closed, other tables with data. */
function paperDb(opts: { live?: boolean; operatorHalt?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scarf-reset-')); dirs.push(dir);
  const dbPath = join(dir, 'agent.sqlite');
  const store = new Store(dbPath);
  const pos = (id: string, mode: string) => store.savePosition({ id, decisionId: 1, chain: 'base', token: '0x' + '4'.repeat(40), costUsd: 2, qty: 1000, entryPrice: 0.002, openedUtc: '2026-11-05T10:00:00.000Z', mode,
    state: { id, token: '0x' + '4'.repeat(40), chain: 'base', entryPrice: 0.002, qty: 1000, qtyLeft: 1000, costUsd: 2, peakPrice: 0.002, tp1Done: false, openedAtMs: 0, stopPrice: 0.001, tp1Price: 0.004, tp1Share: 0.5, trailingPct: 30, timeStopAtMs: 0 } });
  pos('base:a:1', 'paper'); pos('base:b:2', 'paper'); pos('base:c:3', 'paper');
  store.updatePosition('base:c:3', 0, 1.5, {}, '2026-11-06T10:00:00.000Z', 'stop-loss');
  if (opts.live) pos('base:d:4', 'live');
  store.saveRiskState({ equityUsd: 8.5, cashUsd: 4.5, dayPnl: [['2026-11-10', -1.5]], hardStopped: true, operatorHalt: !!opts.operatorHalt,
    positions: [{ id: 'base:a:1', chain: 'base', token: 'a', costUsd: 2, openedAtUtc: 'x' }, { id: 'base:b:2', chain: 'base', token: 'b', costUsd: 2, openedAtUtc: 'x' }] }, '2026-11-10T20:00:00.000Z');
  store.addBlacklist('0xBAD', '2026-11-01T00:00:00.000Z');
  store.saveDowngrade('author:x', -3, '2026-11-01T00:00:00.000Z');
  store.db.close();
  return { dir, dbPath, reviewDir: join(dir, 'review') };
}
function deps(p: { dbPath: string; reviewDir: string }, o: Partial<LedgerResetDeps> = {}) {
  const out: string[] = [];
  const d: LedgerResetDeps = { dbPath: p.dbPath, reviewDir: p.reviewDir, initialCapitalUsd: 40, expectCapitalUsd: 40, checkOnly: false,
    agentActive: () => false, ask: async () => 'yes', print: (l) => out.push(l), now: () => NOW, ...o };
  return { d, out };
}
const backups = (dir: string) => readdirSync(dir).filter(f => f.startsWith('agent.sqlite.paper-'));
/** What the agent reads at startup: the risk state and open positions. */
function startupView(dbPath: string) {
  const store = new Store(dbPath);
  const clock = new VirtualClock(NOW);
  const risk = new RiskState({ ...DEFAULT_RISK, initialCapitalUsd: 40 }, clock);
  const saved = store.loadRiskState(); if (saved) risk.restore(saved); // as in index.ts
  const paper = new PaperExecutor({ ...DEFAULT_RISK, initialCapitalUsd: 40 }, risk, store, { async send() {} }, clock);
  paper.restore();
  const v = { equity: risk.equityUsd, cash: risk.cashUsd, hardStopped: risk.hardStopped, riskPositions: risk.positions.length, open: paper.open.size,
    closedRows: store.db.prepare('SELECT id, exit_reason, closed_utc, qty_left FROM positions ORDER BY id').all() as any[],
    blacklist: store.blacklistItems(), downgrades: store.downgrades() };
  store.db.close();
  return v;
}

describe('E-09: resetting the paper ledger before live', () => {
  it('before the reset the agent would start with paper capital, a hard stop and paper positions; after — $40, no positions and no stop', async () => {
    const p = paperDb();
    const before = startupView(p.dbPath);
    expect([before.equity, before.hardStopped, before.riskPositions, before.open]).toEqual([8.5, true, 2, 2]);
    const { d, out } = deps(p);
    expect(await runLedgerReset(d)).toBe(0);
    const after = startupView(p.dbPath);
    expect([after.equity, after.cash, after.hardStopped, after.riskPositions, after.open]).toEqual([40, 40, false, 0, 0]);
    // paper positions are not deleted but closed with a reason; the one closed earlier is untouched
    expect(after.closedRows.map(r => [r.id, r.exit_reason])).toEqual([['base:a:1', RESET_REASON], ['base:b:2', RESET_REASON], ['base:c:3', 'stop-loss']]);
    expect(after.closedRows[0].closed_utc).toBe('2026-11-11T10:45:00.000Z');
    // the rest of the agent's memory is in place
    expect(after.blacklist).toEqual(['0xbad']); expect(after.downgrades).toEqual([['author:x', -3]]);
    expect(out.some(l => /Ledger reset: paper positions closed 2/.test(l))).toBe(true);
    expect(out.some(l => /will begin at \$40\.00/.test(l))).toBe(true);
  });

  it('the database copy lies next to it, is readable and holds the ledger BEFORE the reset; restoring the copy restores the previous state', async () => {
    const p = paperDb();
    const { d, out } = deps(p);
    expect(await runLedgerReset(d)).toBe(0);
    expect(backups(p.dir)).toEqual(['agent.sqlite.paper-20261111-104500']);
    const b = startupView(join(p.dir, 'agent.sqlite.paper-20261111-104500'));
    expect([b.equity, b.hardStopped, b.riskPositions, b.open]).toEqual([8.5, true, 2, 2]);
    expect(out.some(l => /Copy saved and verified: .*agent\.sqlite\.paper-20261111-104500/.test(l))).toBe(true);
    expect(out.some(l => /Restore as it was/.test(l))).toBe(true);
    // the operator record in the review log
    const log = readFileSync(join(p.reviewDir, '2026-11-11.jsonl'), 'utf8');
    expect(log).toMatch(/"cmd":"ledger reset"/); expect(log).toMatch(/"closedPaperPositions":2/); expect(log).toMatch(/"prevEquityUsd":8\.5/);
  });

  it('refusals change nothing: the agent is running; the answer is not "yes"; risk.json with a different capital; --capital not given', async () => {
    for (const o of [{ agentActive: () => true }, { ask: async () => 'y' }, { ask: async () => '' }, { initialCapitalUsd: 10 }, { expectCapitalUsd: undefined }] as Partial<LedgerResetDeps>[]) {
      const p = paperDb();
      const { d, out } = deps(p, o);
      expect(await runLedgerReset(d)).toBe(1);
      const v = startupView(p.dbPath);
      expect([v.equity, v.hardStopped, v.riskPositions, v.open]).toEqual([8.5, true, 2, 2]);
      expect(backups(p.dir)).toEqual([]);
      expect(out.some(l => /nothing changed|Usage/i.test(l))).toBe(true);
    }
    const p = paperDb(); const { d, out } = deps(p, { initialCapitalUsd: 10 });
    await runLedgerReset(d);
    expect(out[0]).toMatch(/server\/config\/risk\.json has starting capital \$10\.00, but you passed --capital 40/);
  });

  it('an open LIVE position in the journal → refusal: we do not lose real money to the reset', async () => {
    const p = paperDb({ live: true });
    const { d, out } = deps(p);
    expect(await runLedgerReset(d)).toBe(1);
    expect(out.some(l => /1 open non-paper positions \(base:d:4 \[live\]\)/.test(l))).toBe(true);
    expect(startupView(p.dbPath).open).toBe(3); expect(backups(p.dir)).toEqual([]);
  });

  it('--check only shows; does not check the service and asks nothing', async () => {
    const p = paperDb();
    let asked = 0;
    const { d, out } = deps(p, { checkOnly: true, agentActive: () => true, ask: async () => { asked++; return 'yes'; } });
    expect(await runLedgerReset(d)).toBe(0);
    expect(asked).toBe(0); expect(backups(p.dir)).toEqual([]);
    expect(startupView(p.dbPath).equity).toBe(8.5);
    expect(out.some(l => /capital \$8\.50, cash \$4\.50/.test(l))).toBe(true);
    expect(out.some(l => /--check mode: nothing changed\. The reset would close 2 paper positions/.test(l))).toBe(true);
  });

  it('a repeat run and a run without a database — "nothing to do", code 0; operator stop — a reminder to send /stop again', async () => {
    const p = paperDb({ operatorHalt: true });
    const first = deps(p);
    expect(await runLedgerReset(first.d)).toBe(0);
    expect(first.out.some(l => /The operator stop \(\/stop\) was on and was reset together with the ledger/.test(l))).toBe(true);
    const second = deps(p, { now: () => NOW + 60_000 });
    expect(await runLedgerReset(second.d)).toBe(0);
    expect(second.out.some(l => /The ledger is already clean/.test(l))).toBe(true);
    expect(backups(p.dir).length).toBe(1); // no second copy is created
    const none = deps({ dbPath: join(p.dir, 'nope.sqlite'), reviewDir: p.reviewDir });
    expect(await runLedgerReset(none.d)).toBe(0);
    expect(none.out[0]).toMatch(/nothing to reset — the agent will start the ledger at \$40\.00/);
    expect(existsSync(join(p.dir, 'nope.sqlite'))).toBe(false);
  });

  it('systemctl did not answer clearly → a warning, reset only after yes; argument parsing', async () => {
    const p = paperDb();
    const { d, out } = deps(p, { agentActive: () => undefined });
    expect(await runLedgerReset(d)).toBe(0);
    expect(out.some(l => /Could not check the agent service/.test(l))).toBe(true);
    expect(agentActiveFromSystemctl('inactive\n')).toBe(false); expect(agentActiveFromSystemctl('active\n')).toBe(true); expect(agentActiveFromSystemctl('')).toBeUndefined();
    expect(parseArgs(['--capital', '40'])).toEqual({ capital: 40, check: false, afterLive: false });
    expect(parseArgs(['--check', '--capital', '40'])).toEqual({ capital: 40, check: true, afterLive: false });
    expect(parseArgs(['--capital=40', '--after-live'])).toEqual({ capital: 40, check: false, afterLive: true });
    expect(parseArgs(['--capital', 'abc'])).toEqual({ capital: undefined, check: false, afterLive: false });
    expect(parseArgs([])).toEqual({ capital: undefined, check: false, afterLive: false });
  });
});

describe('E-09, acceptance #96 round 1: protecting the real ledger', () => {
  const liveWeekDb = () => {
    const dir = mkdtempSync(join(tmpdir(), 'scarf-reset-live-')); dirs.push(dir);
    const dbPath = join(dir, 'agent.sqlite');
    const store = new Store(dbPath);
    store.savePosition({ id: 'base:live:1', decisionId: 1, chain: 'base', token: '0x' + '4'.repeat(40), costUsd: 25, qty: 1000, entryPrice: 0.002, openedUtc: '2026-11-15T10:00:00.000Z', mode: 'live', state: { id: 'base:live:1' } });
    store.updatePosition('base:live:1', 0, 4, {}, '2026-11-19T10:00:00.000Z', 'stop-loss'); // a closed LIVE trade: live has already run
    store.saveRiskState({ equityUsd: 24, cashUsd: 24, dayPnl: [['2026-11-20', -21]], hardStopped: true, operatorHalt: true, positions: [] }, '2026-11-20T09:00:00.000Z');
    store.db.close();
    return { dir, dbPath, reviewDir: join(dir, 'review') };
  };
  const riskView = (dbPath: string) => { const st = new Store(dbPath); const r = new RiskState({ ...DEFAULT_RISK, initialCapitalUsd: 40 }, new VirtualClock(NOW)); const sv = st.loadRiskState(); if (sv) r.restore(sv); const v = { equity: r.equityUsd, hardStopped: r.hardStopped, operatorHalt: r.operatorHalt, rows: st.db.prepare('SELECT id, mode, exit_reason FROM positions ORDER BY id').all() as any[] }; st.db.close(); return v; };

  it('round 3 (A/B1): live ran without a single positions.mode=live row — only live decisions, mint gas via risk.spend, /stop → refusal; with --after-live — reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scarf-reset-dec-')); dirs.push(dir);
    const dbPath = join(dir, 'agent.sqlite');
    const st = new Store(dbPath);
    st.db.prepare(`INSERT INTO decisions(message_id, ts_utc, kind, chain, action, size_usd, mode) VALUES ('m1','2026-11-19T10:00:00.000Z','nft_mint','base','contract_call',15,'live')`).run();
    const r = new RiskState({ ...DEFAULT_RISK, initialCapitalUsd: 40 }, new VirtualClock(Date.UTC(2026, 10, 19, 10)));
    r.onChange = (snap) => st.saveRiskState(snap, '2026-11-19T10:00:00.000Z');
    r.spend(3.2); r.setOperatorHalt(true); // a failed live mint: gas charged, no position; /stop
    st.db.close();
    const p = { dbPath, reviewDir: join(dir, 'review') };
    const { d, out } = deps(p, { now: () => Date.UTC(2026, 10, 20, 10, 45) });
    expect(await runLedgerReset(d)).toBe(1);
    expect(out.some(l => /Refused: the journal has 1 decisions and 0 positions in live mode — live has already run/.test(l))).toBe(true);
    expect(riskView(dbPath)).toMatchObject({ equity: 36.8, operatorHalt: true });
    expect(backups(dir)).toEqual([]);
    const forced = deps(p, { now: () => Date.UTC(2026, 10, 20, 10, 45), allowAfterLive: true });
    expect(await runLedgerReset(forced.d)).toBe(0);
    expect(riskView(dbPath).equity).toBe(40);
  });

  it('round 3 (B2): the database is held by another writer → "Refused: the database is busy", no stack trace, the ledger untouched', async () => {
    const p = paperDb();
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const other = new DatabaseSync(p.dbPath);
    const { d, out } = deps(p, { ask: async () => { other.exec('BEGIN IMMEDIATE'); return 'yes'; } });
    let code: number | undefined; let thrown: unknown;
    try { code = await runLedgerReset(d); } catch (e) { thrown = e; } finally { try { other.exec('ROLLBACK'); } catch { /* */ } other.close(); }
    expect(thrown).toBeUndefined(); expect(code).toBe(1);
    expect(out.some(l => /Refused: the database is busy with another process/.test(l))).toBe(true);
    expect(startupView(p.dbPath).equity).toBe(8.5);
  }, 20_000);

  it('item 2 (R1): after a live week (there are closed LIVE trades, no open ones) the command refuses and erases nothing; the bypass is only --after-live', async () => {
    const p = liveWeekDb();
    const { d, out } = deps(p, { now: () => Date.UTC(2026, 10, 20, 10, 45) });
    expect(await runLedgerReset(d)).toBe(1);
    expect(out.some(l => /Refused: the journal has 0 decisions and 1 positions in live mode — live has already run/.test(l))).toBe(true);
    const v = riskView(p.dbPath);
    expect([v.equity, v.hardStopped, v.operatorHalt]).toEqual([24, true, true]); // the real ledger is intact
    expect(backups(p.dir)).toEqual([]);
    const forced = deps(p, { now: () => Date.UTC(2026, 10, 20, 10, 45), allowAfterLive: true });
    expect(await runLedgerReset(forced.d)).toBe(0);
    expect(riskView(p.dbPath).equity).toBe(40);
    expect(readFileSync(join(p.reviewDir, '2026-11-20.jsonl'), 'utf8')).toMatch(/"afterLive":true/);
  });

  it('item 1 (R2): after the reset the command does NOT tell you to start the agent — only chown; start — after the deposit and .env; "Restore as it was" mentions risk.json and "before the first live start" (item 4, L3)', async () => {
    const p = paperDb();
    const { d, out } = deps(p);
    expect(await runLedgerReset(d)).toBe(0);
    expect(out.some(l => /systemctl start agent/.test(l))).toBe(false);
    expect(out.some(l => /^Next: chown .* DO NOT START THE AGENT until the deposit is made/.test(l))).toBe(true);
    const back = out.find(l => /^Restore as it was/.test(l))!;
    expect(back).toMatch(/before the first live start/i); expect(back).toMatch(/risk\.json/); expect(back).toMatch(/\$8\.50/);
  });

  it('item 3 (R3): a LIVE position that appeared while waiting for "yes" → rollback inside the transaction, nothing changed; only paper ones are closed', async () => {
    const p = paperDb();
    const { d, out } = deps(p, { agentActive: () => undefined, ask: async () => { const s2 = new Store(p.dbPath); s2.savePosition({ id: 'base:LIVE:9', decisionId: 1, chain: 'base', token: '0x' + '4'.repeat(40), costUsd: 25, qty: 1000, entryPrice: 0.002, openedUtc: '2026-11-11T10:44:40.000Z', mode: 'live', state: {} }); s2.db.close(); return 'yes'; } });
    expect(await runLedgerReset(d)).toBe(1);
    expect(out.some(l => /Refused: while the command waited for confirmation, non-paper positions appeared in the journal \(base:LIVE:9 \[live\]\)/.test(l))).toBe(true);
    const v = startupView(p.dbPath);
    expect(v.equity).toBe(8.5); expect(v.open).toBe(3); // nothing closed: the two paper ones and the live row are open, as they were
    expect(v.closedRows.filter(r => r.exit_reason === RESET_REASON).length).toBe(0);
    expect(v.closedRows.find(r => r.id === 'base:LIVE:9').exit_reason).toBeNull();
    // A paper position opened in parallel (no live) — is closed together with the rest, the mode='paper' filter does not touch other rows
    const p2 = paperDb();
    const s3 = new Store(p2.dbPath); s3.savePosition({ id: 'base:shadow:7', decisionId: 1, chain: 'base', token: 'x', costUsd: 1, qty: 1, entryPrice: 1, openedUtc: '2026-11-11T10:00:00.000Z', mode: 'shadow', state: {} }); s3.db.close();
    const r2 = deps(p2);
    expect(await runLedgerReset(r2.d)).toBe(1); // a non-paper open row (shadow) — refusal before the question and without a database copy
    expect(r2.out.some(l => /open non-paper positions \(base:shadow:7 \[shadow\]\)/.test(l))).toBe(true);
    expect(backups(p2.dir)).toEqual([]);
  });

  it('the risk state was saved less than a minute ago → refusal (the agent seems to be running)', async () => {
    const p = paperDb();
    const { d, out } = deps(p, { now: () => Date.parse('2026-11-10T20:00:30.000Z') });
    expect(await runLedgerReset(d)).toBe(1);
    expect(out.some(l => /was saved 30 s ago — the agent seems to be running/.test(l))).toBe(true);
    expect(startupView(p.dbPath).equity).toBe(8.5); expect(backups(p.dir)).toEqual([]);
  });

  it('R4: the copy\'s permissions are the same as the original (0600), not by umask', async () => {
    const p = paperDb();
    const { chmodSync, statSync } = await import('node:fs');
    chmodSync(p.dbPath, 0o600);
    const old = process.umask(0o022);
    try { expect(await runLedgerReset(deps(p).d)).toBe(0); } finally { process.umask(old); }
    const copy = backups(p.dir)[0];
    expect((statSync(join(p.dir, copy)).mode & 0o777).toString(8)).toBe('600');
  });
});
