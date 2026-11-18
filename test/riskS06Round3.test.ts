// S-06 review, round 3: O2 (an invalid initialCapitalUsd — no start, code 78, the snapshot is not written, unhalt refuses),
// O3 (an invalid memecoinClasses — the previous exit scheme and a message, no general stop). A block as a string — test/riskS06Round2.test.ts.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig, DEFAULT_RISK } from '../src/config.js';
import { riskConfigProblems, haltingRiskProblems, fatalRiskProblems, riskFatalAlert, riskProblemsAlert } from '../src/risk/riskCheck.js';
import { RiskState } from '../src/risk/risk.js';
import { VirtualClock } from '../src/clock.js';
import { runRiskTool } from '../src/tools/risk.js';
import { Store } from '../src/store/db.js';

const ROOT = join(__dirname, '..');
const branchJson = readFileSync(join(ROOT, 'test/fixtures/risk.example.json'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function fileOf(json: string) { const d = mkdtempSync(join(tmpdir(), 'r3-')); dirs.push(d); const f = join(d, 'risk.json'); writeFileSync(f, json); return { d, f }; }
const load = (json: string) => loadConfig({ AGENT_ROOT: ROOT, AGENT_RISK_JSON: fileOf(json).f } as NodeJS.ProcessEnv).risk;
/** A real start of src/index.ts: cwd — an empty directory (the tree's .env is not read), no Telegram tokens — [telegram:dry], no network. */
function runAgent(json: string) {
  const { d, f } = fileOf(json);
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'src/index.ts')],
    { cwd: d, env: { PATH: process.env.PATH, AGENT_ROOT: ROOT, AGENT_RISK_JSON: f, AGENT_DATA_DIR: join(d, 'data') }, encoding: 'utf8', timeout: 90_000 });
  return { ...r, db: join(d, 'data', 'agent.sqlite') };
}

describe('O2: an invalid initialCapitalUsd — the agent does not start', () => {
  it('a real start: code 78, a message to the owner, the risk snapshot is not written', () => {
    const r = runAgent(JSON.stringify({ ...JSON.parse(branchJson), initialCapitalUsd: '100' }));
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/FATAL: \[risk\.json\] initialCapitalUsd="100"/);
    expect(r.stdout).toMatch(/\[telegram:dry\] ❌ Agent not started: risk\.json is invalid — initialCapitalUsd="100"/);
    if (existsSync(r.db)) { const s = new Store(r.db); expect(s.loadRiskState()).toBeUndefined(); s.db.close(); }
    const unit = readFileSync(join(ROOT, 'server/deploy/agent.service'), 'utf8');
    expect(unit).toMatch(/RestartPreventExitStatus=78/);
  }, 120_000);
  it('a real start with another invalid number ("0,2") — not 78: "exits only" mode, a message to the owner', () => {
    const r = runAgent(JSON.stringify({ ...JSON.parse(branchJson), dailyLossStopShareOfDayStart: '0,2' }));
    expect(r.status).not.toBe(78);
    expect(r.stdout).toMatch(/\[telegram:dry\] ⛔ risk\.json is invalid: dailyLossStopShareOfDayStart="0,2".*New entries are closed/);
  }, 120_000);
  it('classifier: only initialCapitalUsd; the message text', () => {
    const p = load('{"initialCapitalUsd": 1e999, "hardStopEquityShare": "0,55"}').riskProblems!;
    expect(p).toHaveLength(2);
    expect(fatalRiskProblems(p)).toEqual(['initialCapitalUsd=Infinity — needs number > 0']);
    expect(riskFatalAlert(fatalRiskProblems(p))).toBe('❌ Agent not started: risk.json is invalid — initialCapitalUsd=Infinity — needs number > 0. The starting capital cannot be filled in by default: accounting would be written with someone else\'s capital. Fix the file and run systemctl restart agent');
    expect(DEFAULT_RISK.initialCapitalUsd).toBe(10); // the paper default without a file
  });
  it('unhalt refuses with an invalid initialCapitalUsd or hardStopEquityShare; status works', async () => {
    const d = mkdtempSync(join(tmpdir(), 'r3-unhalt-')); dirs.push(d);
    const dbPath = join(d, 'agent.sqlite');
    const st = new Store(dbPath); st.saveRiskState({ equityUsd: 30, cashUsd: 30, dayPnl: [], hardStopped: true, positions: [] }, '2026-11-18T00:00:00.000Z'); st.db.close();
    for (const bad of ['initialCapitalUsd="100" — needs number > 0', 'hardStopEquityShare="0,55" — needs share 0 < x ≤ 1']) {
      const out: string[] = [];
      const deps = { dbPath, reviewDir: join(d, 'review'), initialCapitalUsd: 10, hardStopEquityShare: 0.55, riskProblems: [bad],
        agentActive: () => false, ask: async () => 'yes', print: (l: string) => out.push(l), now: () => Date.UTC(2026, 10, 18) };
      expect(await runRiskTool('unhalt', deps)).toBe(1);
      expect(out.at(-1)).toMatch(/^Refused: risk\.json is invalid — .*The hard stop threshold is unknown/);
      expect(await runRiskTool('status', deps)).toBe(0);
    }
    const s = new Store(dbPath); expect(s.loadRiskState().hardStopped).toBe(true); s.db.close();
  });
});

describe('O3: an invalid memecoinClasses — no general stop, a message (a memecoin buy — test/riskS06Classes.test.ts)', () => {
  it('version "2" as a string: there is a problem, no general stop, a message', () => {
    const j = JSON.parse(branchJson); j.memecoinClasses.version = '2';
    const cfg = load(JSON.stringify(j));
    expect(cfg.riskProblems!.some(p => p.startsWith('memecoinClasses:'))).toBe(true);
    expect(haltingRiskProblems(cfg.riskProblems!)).toEqual([]);
    expect(new RiskState(cfg, new VirtualClock()).halted()).toBe(false);
    expect(riskProblemsAlert(cfg.riskProblems!)).toMatch(/New memecoins are not bought until fixed; open positions follow the exit plan saved at entry; other entries work/);
  });
});

describe('false stops: DEFAULT_RISK and all risk.json versions from history', () => {
  it('DEFAULT_RISK itself passes the check', () => expect(riskConfigProblems(DEFAULT_RISK)).toEqual([]));
  it('every version of server/config/risk.json — no problems', () => {
    let revs: string[] = [];
    try { revs = execFileSync('git', ['-C', ROOT, 'log', '--format=%h', 'HEAD', '--', 'server/config/risk.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean); } catch { /* no git history */ }
    for (const h of revs) expect(load(execFileSync('git', ['-C', ROOT, 'show', `${h}:server/config/risk.json`], { encoding: 'utf8' })).riskProblems, h).toEqual([]);
  });
});
