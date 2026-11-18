// S-06 (#87, #66, #139): risk stops on the money path — number checks, floating result in the snapshot, daily stop option C, stop reason.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RISK, loadConfig, type RiskConfig } from '../src/config.js';
import { noPriceBlockProblem, riskProblemsAlert } from '../src/risk/riskCheck.js';
import { spawnSync } from 'node:child_process';
import { noPriceProblem } from '../src/exec/paper.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState, sizeAction, assertWithinLimits, haltReason } from '../src/risk/risk.js';
import { operatorCommands, statusText, dailyStopFigures, type OperatorStatus } from '../src/notify/commands.js';

const dir = mkdtempSync(join(tmpdir(), 'risk-s06-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
/** loadConfig with risk.json from a string (null — no file). */
function load(json: string | null) {
  const p = join(dir, `risk-${n++}.json`);
  if (json !== null) writeFileSync(p, json);
  return () => loadConfig({ AGENT_ROOT: dir, AGENT_RISK_JSON: p } as NodeJS.ProcessEnv).risk;
}
const follow = (cfg: RiskConfig, st: RiskState) => sizeAction(cfg, st, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 });

describe('#87 item 1 (S-06 review): an invalid number — "exits only" mode on approved numbers, not a startup refusal', () => {
  it('each invalid field: a problem with the field name, the value replaced by the approved one from DEFAULT_RISK, new entries closed', () => {
    const cases: [string, RegExp, (r: RiskConfig) => unknown, unknown][] = [
      ['{"dailyLossStopShareOfDayStart": "0,2"}', /dailyLossStopShareOfDayStart="0,2"/, r => r.dailyLossStopShareOfDayStart, DEFAULT_RISK.dailyLossStopShareOfDayStart],
      ['{"dailyLossStopShare": "0,2"}', /dailyLossStopShare="0,2"/, r => r.dailyLossStopShareOfDayStart, DEFAULT_RISK.dailyLossStopShareOfDayStart],
      ['{"hardStopEquityShare": null}', /hardStopEquityShare=null/, r => r.hardStopEquityShare, DEFAULT_RISK.hardStopEquityShare],
      ['{"hardStopEquityShare": "0.55"}', /hardStopEquityShare="0.55"/, r => r.hardStopEquityShare, DEFAULT_RISK.hardStopEquityShare],
      ['{"initialCapitalUsd": 0}', /initialCapitalUsd=0/, r => r.initialCapitalUsd, DEFAULT_RISK.initialCapitalUsd],
      ['{"initialCapitalUsd": 1e999}', /initialCapitalUsd=Infinity/, r => r.initialCapitalUsd, DEFAULT_RISK.initialCapitalUsd],
      ['{"huntBucketShare": 1.5}', /huntBucketShare=1.5/, r => r.huntBucketShare, DEFAULT_RISK.huntBucketShare],
      ['{"perActionShareByTier": {"follow": "0.45"}}', /perActionShareByTier\.follow="0.45"/, r => r.perActionShareByTier.follow, DEFAULT_RISK.perActionShareByTier.follow],
      ['{"maxOpenPositions": 2.5}', /maxOpenPositions=2.5/, r => r.maxOpenPositions, DEFAULT_RISK.maxOpenPositions],
      ['{"maxGasShareOfCapital": -0.12}', /maxGasShareOfCapital=-0.12/, r => r.maxGasShareOfCapital, DEFAULT_RISK.maxGasShareOfCapital],
      ['{"minActionUsd": "1"}', /minActionUsd="1"/, r => r.minActionUsd, DEFAULT_RISK.minActionUsd],
      ['{"live": {"mintMaxShareOfEquity": "0,25"}}', /live\.mintMaxShareOfEquity="0,25"/, r => r.live.mintMaxShareOfEquity, DEFAULT_RISK.live.mintMaxShareOfEquity],
      ['{"live": {"bridgeMaxShareOfEquity": 1.5}}', /live\.bridgeMaxShareOfEquity=1.5/, r => r.live.bridgeMaxShareOfEquity, DEFAULT_RISK.live.bridgeMaxShareOfEquity],
      ['{"live": {"slippageBps": 10000}}', /live\.slippageBps=10000/, r => r.live.slippageBps, DEFAULT_RISK.live.slippageBps],
      ['{"live": {"mintMaxWallets": 0}}', /live\.mintMaxWallets=0/, r => r.live.mintMaxWallets, DEFAULT_RISK.live.mintMaxWallets],
      ['{"memecoinExit": {"stopLossPct": "40"}}', /memecoinExit\.stopLossPct="40"/, r => r.memecoinExit.stopLossPct, DEFAULT_RISK.memecoinExit.stopLossPct],
      ['{"careful": {"sizeFactor": 2, "exit": {"stopLossPct": 100}}}', /careful\.sizeFactor=2.*careful\.exit\.stopLossPct=100/, r => [r.careful.sizeFactor, r.careful.exit.stopLossPct], [DEFAULT_RISK.careful.sizeFactor, DEFAULT_RISK.careful.exit.stopLossPct]],
      ['{"perp": {"maxLeverage": 1e999}}', /perp\.maxLeverage=Infinity/, r => r.perp.maxLeverage, DEFAULT_RISK.perp.maxLeverage],
      ['{"mintCapExcludesGas": "true"}', /mintCapExcludesGas="true"/, r => r.mintCapExcludesGas, DEFAULT_RISK.mintCapExcludesGas],
    ];
    for (const [json, re, pick, want] of cases) {
      const r = load(json)();
      expect(r.riskProblems!.join('; '), json).toMatch(re);
      expect(pick(r), json).toEqual(want);
      const st = new RiskState(r, new VirtualClock());
      expect(st.halted(), json).toBe(true);
      expect(haltReason(r, st)).toMatch(/^risk\.json: .* — new entries off until the file is fixed \(exits keep running\)$/);
    }
  });
  it('memecoinClasses, memecoinEntry, noPrice blocks: only a message, their own fallback, no general entry stop (HQ decision, review O3)', () => {
    const base = JSON.parse(readFileSync(join(__dirname, '../test/fixtures/risk.example.json'), 'utf8'));
    const cases: [object, RegExp, boolean, RegExp | null][] = [
      [{ memecoinClasses: { ...base.memecoinClasses, maxOpenMoonbags: 2.5 } }, /memecoinClasses: maxOpenMoonbags/, false, /\. New memecoins are not bought until fixed; open positions follow the exit plan saved at entry; other entries work\. Fix/],
      [{ memecoinEntry: { ...base.memecoinEntry, shareOfCapital: '0,08' } }, /memecoinEntry: shareOfCapital/, false, /\. Memecoins are not bought; other entries work\. Fix/],
      [{ memecoinEntry: { ...base.memecoinEntry, ageRuleExemptMinTrust: null } }, /^$/, false, null], // null is allowed
      [{ noPrice: { ...base.noPrice, exitHours: 1e999 } }, /noPrice: exitHours/, false, /\. The "position without a price" rule runs on approved numbers; other entries work\. Fix/],
    ];
    for (const [over, re, halts, alert] of cases) {
      const r = load(JSON.stringify({ ...base, ...over }))();
      expect(r.riskProblems!.join('; '), JSON.stringify(over)).toMatch(re);
      expect(new RiskState(r, new VirtualClock()).halted(), JSON.stringify(over)).toBe(halts);
      if (alert) expect(riskProblemsAlert(r.riskProblems!)).toMatch(alert);
    }
  });
  it('the copy of the noPrice check matches noPriceProblem (src/exec/paper.ts)', () => {
    for (const b of [undefined, null, 5, { exitHours: 8, writeOffHours: 36, retryMinutes: 15 }, { exitHours: 0.1, writeOffHours: 36, retryMinutes: 15 },
      { exitHours: 8, writeOffHours: 2, retryMinutes: 15 }, { exitHours: 8, writeOffHours: 36, retryMinutes: '15' }, { exitHours: 8, writeOffHours: 721, retryMinutes: 15 }])
      expect(noPriceBlockProblem(b), JSON.stringify(b)).toBe(noPriceProblem({ ...DEFAULT_RISK, noPrice: b } as RiskConfig));
  });
  it('the old field: not checked when the new one is present (null, "0,3" do not interfere), one log line; without the new one — recalculation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const old of [null, '0,28', 0.28]) {
      const r = load(JSON.stringify({ dailyLossStopShareOfDayStart: 0.2, dailyLossStopShare: old }))();
      expect(r.riskProblems, String(old)).toEqual([]);
      expect(r.dailyLossStopShareOfDayStart).toBe(0.2);
      expect('dailyLossStopShare' in r).toBe(false);
    }
    expect(warn.mock.calls.filter(c => /dailyLossStopShare is not read/.test(String(c[0]))).length).toBe(3); // one line per load
    warn.mockRestore();
  });
  it('a valid file, the repository file and no file — no problems; a JSON syntax error — as before, an exception', () => {
    expect(load('{"initialCapitalUsd": 60, "hardStopEquityShare": 0.55}')().riskProblems).toEqual([]);
    expect(loadConfig({ AGENT_ROOT: join(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk.riskProblems).toEqual([]);
    expect('dailyLossStopShare' in JSON.parse(readFileSync(join(__dirname, '../test/fixtures/risk.example.json'), 'utf8'))).toBe(false); // the old field was removed from the file
    expect(load(null)().riskProblems).toEqual([]);
    expect(load('{"initialCapitalUsd": 60,}')).toThrow(SyntaxError);
    expect(load('[1]')().riskProblems).toEqual(['the file is not a JSON object']);
  });
  it('exits work with an invalid file: a position close is accounted for, the stop on new entries holds', () => {
    const r = load('{"initialCapitalUsd": 60, "dailyLossStopShareOfDayStart": "0,2"}')();
    const st = new RiskState(r, new VirtualClock());
    st.openPosition({ id: 'p', chain: 'solana', token: 'T', costUsd: 20, openedAtUtc: '2026-11-18T00:00:00Z' });
    st.closePosition('p', 13);
    expect(st.equityUsd).toBeCloseTo(53, 9);
    expect(st.halted()).toBe(true);
  });
});

describe('#87 item 2: the floating result survives a restart', () => {
  const cfg50: RiskConfig = { ...DEFAULT_RISK, initialCapitalUsd: 60 };
  it('−6 closed and −8 floating: the stop is on even after restore, before the first monitor pass', () => {
    const c = new VirtualClock(Date.UTC(2026, 10, 18, 10));
    const st = new RiskState(cfg50, c);
    st.openPosition({ id: 'p1', chain: 'solana', token: 'T', costUsd: 20, openedAtUtc: c.iso() });
    st.recordPnl(-6); st.setUnrealized(-8);
    expect(st.dailyStopActive()).toBe(true);
    const st2 = new RiskState(cfg50, c); st2.restore(JSON.parse(JSON.stringify(st.snapshot()))); // as via the DB
    expect(st2.unrealizedUsd).toBe(-8);
    expect(st2.dailyStopActive()).toBe(true);
    expect(follow(cfg50, st2).ok).toBe(false);
    st2.setUnrealized(0); // monitor: the position recovered
    expect(st2.dailyStopActive()).toBe(false);
  });
  it('an old snapshot without the field and a snapshot without positions — floating result 0', () => {
    const st = new RiskState(cfg50, new VirtualClock());
    st.restore({ equityUsd: 50, cashUsd: 30, dayPnl: [], hardStopped: false, positions: [{ id: 'p', chain: 'solana', token: 'T', costUsd: 20, openedAtUtc: '2026-11-18T00:00:00Z' }] });
    expect(st.unrealizedUsd).toBe(0);
    st.restore({ equityUsd: 50, cashUsd: 50, dayPnl: [], hardStopped: false, positions: [], unrealizedUsd: -5 });
    expect(st.unrealizedUsd).toBe(0);
  });
});

describe('#87 item 1: a non-numeric threshold in risk.ts — the stop is on, not off', () => {
  it('daily share NaN / string: new entries closed without any loss', () => {
    for (const v of [NaN, '0,2', null, 0, -0.3]) {
      const cfg = { ...DEFAULT_RISK, dailyLossStopShareOfDayStart: v } as unknown as RiskConfig;
      const st = new RiskState(cfg, new VirtualClock());
      expect(st.dailyStopActive(), String(v)).toBe(true);
      expect(st.halted()).toBe(true);
      const r = follow(cfg, st);
      expect(r.ok).toBe(false);
      expect(r.reasons[0]).toMatch(/^risk\.json: dailyLossStopShareOfDayStart=/);
      expect(() => assertWithinLimits(cfg, st, 'follow', 1, 0.01)).toThrow(/halted/);
    }
  });
  it('hard stop share or capital NaN: new entries closed', () => {
    for (const over of [{ hardStopEquityShare: NaN }, { hardStopEquityShare: '0.55' }, { initialCapitalUsd: NaN }]) {
      const cfg = { ...DEFAULT_RISK, ...over } as unknown as RiskConfig;
      const st = new RiskState(cfg, new VirtualClock(), 10);
      expect(st.halted(), JSON.stringify(over)).toBe(true);
      expect(haltReason(cfg, st)).toMatch(/^risk\.json: /);
    }
  });
  it('floating result NaN (monitor failure) does not turn the daily stop off', () => {
    const st = new RiskState(DEFAULT_RISK, new VirtualClock());
    st.setUnrealized(NaN);
    expect(st.dailyStopActive()).toBe(true);
    st.setUnrealized(0);
    expect(st.dailyStopActive()).toBe(false);
  });
});

describe('#66 option C: daily stop from the bucket at 00:00 UTC, field dailyLossStopShareOfDayStart', () => {
  // Example: capital $60 with a daily stop of 0.2 gives a $12 threshold (example fixture numbers, not real ones)
  const live = { ...loadConfig({ AGENT_ROOT: join(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk, initialCapitalUsd: 60 }; // test/fixtures/risk.example.json from the repository
  const at = (h: number, m = 0) => new VirtualClock(Date.UTC(2026, 10, 18, h, m));
  /** The first loss (step $0.01) at which the daily stop turns on: closed or floating only. */
  function firstStop(cfg: RiskConfig, equity: number, kind: 'realized' | 'floating'): number {
    for (let cents = 1; cents <= equity * 100; cents++) {
      const st = new RiskState(cfg, at(10), equity);
      if (kind === 'realized') st.recordPnl(-cents / 100); else st.setUnrealized(-cents / 100);
      if (st.dailyStopActive()) return cents / 100;
    }
    return Infinity;
  }

  it('risk.json: 0.2 — a closed loss and a floating-only −$12.00 at $60 turn the stop on, −$11.99 does not', () => {
    expect(live.dailyLossStopShareOfDayStart).toBe(0.2);
    expect(firstStop(live, 60, 'realized')).toBe(12);
    expect(firstStop(live, 60, 'floating')).toBe(12);
    const st = new RiskState(live, at(10)); st.setUnrealized(-12);
    const r = follow(live, st);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toBe('daily loss stop: -12.00 USD today (limit −12.00) — no new entries until 00:00 UTC');
  });
  it('the boundary with a 1e-9 tolerance: a loss of exactly 20 % turns the stop on ($10 → −2.00, not −2.01)', () => {
    for (const e of [10, 20, 40, 50, 80, 200]) expect(firstStop(live, e, 'realized'), `$${e}`).toBe(Math.round(0.2 * e * 100) / 100);
  });
  it('bucket ≠ capital: huntBucketShare 0.5 at $60 — the stop from −$6', () => {
    expect(firstStop({ ...live, huntBucketShare: 0.5 }, 60, 'realized')).toBe(6);
  });
  it('the threshold is fixed for the day, the UTC day change takes the new capital at 00:00', () => {
    const c = at(9); const st = new RiskState(live, c);
    st.recordPnl(-3); st.recordPnl(1); st.recordPnl(-2);
    expect(st.dailyStopLimitUsd()).toBeCloseTo(12, 9);
    st.recordPnl(-7.99); expect(st.dailyStopActive()).toBe(false); // −11,99
    st.recordPnl(-0.01); expect(st.dailyStopActive()).toBe(true);  // −12,00
    c.advance(15 * 3600_000); // 00:00 of the next day
    expect(st.dailyStopActive()).toBe(false);
    expect(st.dailyStopLimitUsd()).toBeCloseTo(0.2 * 48, 9); // capital at 00:00 — $48.00
  });
  it('a restart mid-day: the same threshold and the same stop', () => {
    const c = at(12); const st = new RiskState(live, c);
    st.openPosition({ id: 'p', chain: 'solana', token: 'T', costUsd: 10, openedAtUtc: c.iso() });
    st.recordPnl(-6); st.setUnrealized(-6);
    expect(st.dailyStopActive()).toBe(true); // −12.00 (card #87: −6 closed and −6 floating)
    const st2 = new RiskState(live, c); st2.restore(JSON.parse(JSON.stringify(st.snapshot())));
    expect(st2.dailyStopLimitUsd()).toBeCloseTo(12, 9);
    expect(st2.dailyStopActive()).toBe(true);
  });
  it('a floating loss carries over 00:00 and counts for the new day', () => {
    const c = at(23, 50); const st = new RiskState(live, c);
    st.openPosition({ id: 'p', chain: 'solana', token: 'T', costUsd: 20, openedAtUtc: c.iso() });
    st.setUnrealized(-12);
    expect(st.dailyStopActive()).toBe(true);
    c.advance(20 * 60_000); // 00:10 UTC
    expect(st.todayPnl()).toBe(0);
    expect(st.dailyStopActive()).toBe(true);
    st.setUnrealized(-11.99); expect(st.dailyStopActive()).toBe(false);
  });
  it('the previous risk.json with only the old field (example 0.25): the previous threshold (s / (1 + s)), not 25 % from 00:00', () => {
    const old = load('{"initialCapitalUsd": 10, "dailyLossStopShare": 0.25}')();
    expect(old.dailyLossStopShareOfDayStart).toBeCloseTo(0.25 / 1.25, 12);
    expect(firstStop(old, 10, 'realized')).toBe(2); // not −2.50
    expect(firstStop(old, 60, 'realized')).toBe(12); // not −15.00
    const st = new RiskState(old, at(10)); st.recordPnl(-2.5); // review example: the code before the PR forbade the entry, PR #66 allowed a $3.75 trade
    expect(follow(old, st).ok).toBe(false);
  });
  it('no file — default 0.2; both fields in the file — the new one is read', () => {
    expect(load(null)().dailyLossStopShareOfDayStart).toBe(0.2);
    expect(DEFAULT_RISK.dailyLossStopShareOfDayStart).toBe(0.2);
    expect('dailyLossStopShare' in DEFAULT_RISK).toBe(false);
    const both = load('{"dailyLossStopShare": 0.28, "dailyLossStopShareOfDayStart": 0.2}')();
    expect(both.dailyLossStopShareOfDayStart).toBe(0.2);
  });
  it('property: the new rule (example 0.2 from 00:00) is not softer than the previous one (example 0.28 of the bucket after the loss) — 20 000 cases', () => {
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let oldStops = 0;
    for (let i = 0; i < 20000; i++) {
      const e0 = 1 + rnd() * 499, bucket = [1, 0.8, 0.5][Math.floor(rnd() * 3)];
      const cfg = { ...live, huntBucketShare: bucket };
      const st = new RiskState(cfg, at(10), e0);
      let r = 0;
      for (let k = 0, m = 1 + Math.floor(rnd() * 4); k < m; k++) { const x = (rnd() * 0.5 - 0.3) * e0; r += x; st.recordPnl(x); }
      const f = (rnd() * 0.5 - 0.4) * e0; st.setUnrealized(f);
      const oldStop = r + Math.min(0, f) <= -0.28 * (e0 + r) * bucket;
      if (oldStop) { oldStops++; expect(st.dailyStopActive(), `e0=${e0} r=${r} f=${f} b=${bucket}`).toBe(true); }
    }
    expect(oldStops).toBeGreaterThan(1000);
  });
});

describe('#139: the reason for the stop on new entries', () => {
  const restored = (st: RiskState) => { const s2 = new RiskState(DEFAULT_RISK, new VirtualClock()); s2.restore(JSON.parse(JSON.stringify(st.snapshot()))); return s2; };
  it('turning on with a reason — in the snapshot, after restore and in the refusal text; lifting erases it', () => {
    const st = new RiskState(DEFAULT_RISK, new VirtualClock());
    st.setOperatorHalt(true, 'reconcile: cash mismatch base $3.10');
    expect(st.snapshot().operatorHaltReason).toBe('reconcile: cash mismatch base $3.10');
    const st2 = restored(st);
    expect(st2.operatorHaltReason).toBe('reconcile: cash mismatch base $3.10');
    expect(follow(DEFAULT_RISK, st2).reasons[0]).toBe('halted by operator (reconcile: cash mismatch base $3.10) — new entries off until /resume');
    st2.setOperatorHalt(false);
    expect(st2.operatorHaltReason).toBeUndefined();
    expect(restored(st2).operatorHaltReason).toBeUndefined();
  });
  it('turning on again without a reason does not erase the previous one; a new reason replaces it', () => {
    const st = new RiskState(DEFAULT_RISK, new VirtualClock());
    st.setOperatorHalt(true, '/stop'); st.setOperatorHalt(true);
    expect(st.operatorHaltReason).toBe('/stop');
    st.setOperatorHalt(true, 'reconcile: x');
    expect(st.operatorHaltReason).toBe('reconcile: x');
  });
  it('an old snapshot without the field — a stop without a reason; a reason without a stop is not restored', () => {
    const st = new RiskState(DEFAULT_RISK, new VirtualClock());
    st.restore({ equityUsd: 10, cashUsd: 10, dayPnl: [], hardStopped: false, positions: [], operatorHalt: true });
    expect(st.operatorHalt).toBe(true);
    expect(st.operatorHaltReason).toBeUndefined();
    expect(haltReason(DEFAULT_RISK, st)).toBe('halted by operator (reason not recorded) — new entries off until /resume');
    st.restore({ equityUsd: 10, cashUsd: 10, dayPnl: [], hardStopped: false, positions: [], operatorHalt: false, operatorHaltReason: '/stop' });
    expect(st.operatorHaltReason).toBeUndefined();
  });
});

describe('#139: /status shows why the stop on new entries is on', () => {
  const NOW = Date.UTC(2026, 10, 18, 12);
  // as in src/index.ts: status and /stop go to a real RiskState
  function wired() {
    const risk = new RiskState(DEFAULT_RISK, new VirtualClock(NOW));
    const status = (): OperatorStatus => ({ mode: 'live', equityUsd: risk.equityUsd, markedEquityUsd: risk.markedEquityUsd, cashUsd: risk.cashUsd, positions: [],
      operatorHalted: risk.operatorHalt, operatorHaltReason: risk.operatorHaltReason, dailyStop: risk.dailyStopActive(), hardStopped: risk.hardStopped });
    const run = operatorCommands({ status, setOperatorHalt: (on, reason) => risk.setOperatorHalt(on, reason), now: () => NOW });
    return { risk, run };
  }
  it('/stop records the reason "/stop", /status shows it, /resume erases it', async () => {
    const { risk, run } = wired();
    await run('/stop');
    expect(risk.operatorHaltReason).toBe('/stop');
    expect(await run('/status')).toContain('Stop on new entries (/stop): on — reason: /stop');
    await run('/resume');
    expect(await run('/status')).toContain('Stop on new entries (/stop): off\n');
  });
  it('a reconciliation auto-stop — /status shows the reconciliation reason; an old stop without a reason — "not recorded"', async () => {
    const { risk, run } = wired();
    risk.setOperatorHalt(true, 'reconcile: wallet reconciliation not done 3 times in a row');
    expect(await run('/status')).toContain('Stop on new entries (/stop): on — reason: reconcile: wallet reconciliation not done 3 times in a row');
    const s: OperatorStatus = { mode: 'paper', equityUsd: 10, markedEquityUsd: 10, cashUsd: 10, positions: [], operatorHalted: true, dailyStop: false, hardStopped: false };
    expect(statusText(s, NOW)).toContain('Stop on new entries (/stop): on — reason: not recorded');
  });
});

describe('#139: wiring in src/index.ts', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  it('the reconciliation auto-stop passes the reason, /status gets it, /stop — its own', () => {
    expect(src).toMatch(/if \(!risk\.operatorHalt\) risk\.setOperatorHalt\(true, `reconcile: \$\{reason\}`\);/);
    expect(src).toMatch(/operatorHaltReason: risk\.operatorHaltReason/);
    expect(src).toMatch(/setOperatorHalt: \(on, reason\) => risk\.setOperatorHalt\(on, reason\)/);
  });
});

describe('S-06 review: an invalid risk.json — a message to the owner and working emergency tools', () => {
  const root = join(__dirname, '..');
  it('src/index.ts: after notifier — the service journal, the review log and Telegram with the riskProblemsAlert text', () => {
    const src = readFileSync(join(root, 'src/index.ts'), 'utf8');
    const iNotifier = src.indexOf('const notifier: typeof tgRaw'), iAlert = src.indexOf('if (cfg.risk.riskProblems?.length)'), iJobs = src.indexOf('startJobs({');
    expect(iNotifier).toBeGreaterThan(0); expect(iAlert).toBeGreaterThan(iNotifier); expect(iAlert).toBeLessThan(iJobs);
    const block = src.slice(iAlert, src.indexOf('\n}\n', iAlert));
    expect(block).toMatch(/console\.error\(/);
    expect(block).toMatch(/review\.write\('config', \{ file: 'risk\.json', problems: cfg\.risk\.riskProblems \}\)/);
    expect(block).toMatch(/notifier\.send\(riskProblemsAlert\(cfg\.risk\.riskProblems\)\)/);
    expect(riskProblemsAlert(['hardStopEquityShare="0,55" — must be a share 0 < x ≤ 1'])).toBe('⛔ risk.json is invalid: hardStopEquityShare="0,55" — must be a share 0 < x ≤ 1. New entries are closed, open positions are managed on approved numbers. Fix the file and run systemctl restart agent');
  });
  it('npm run risk -- status with an invalid file starts and prints the problem', () => {
    const d = mkdtempSync(join(tmpdir(), 'risk-s06-tool-')); const f = join(d, 'risk.json');
    writeFileSync(f, '{"initialCapitalUsd": 60, "hardStopEquityShare": "0,55"}');
    const r = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/tools/risk.ts'), 'status'],
      { cwd: d, input: '', encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, AGENT_ROOT: root, AGENT_RISK_JSON: f, AGENT_DATA_DIR: join(d, 'data') } });
    rmSync(d, { recursive: true, force: true });
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.stdout).toMatch(/⚠️ risk\.json is invalid: hardStopEquityShare="0,55"/);
    expect(r.stdout).toMatch(/No journal/); // reached the command itself
  }, 90_000);
  it('ledgerReset prints the risk.json problems and does not fail on load', () => {
    const src = readFileSync(join(root, 'src/exec/ledgerReset.ts'), 'utf8');
    const main = src.slice(src.lastIndexOf('import.meta.url === pathToFileURL'));
    expect(main).toMatch(/const cfg = loadConfig\(\);\n.*\n\s*for \(const p of cfg\.risk\.riskProblems \?\? \[\]\) console\.log/);
  });
});

describe('S-06 review, nice-to-have 5: /status and the startup message show the daily stop in numbers', () => {
  const NOW = Date.UTC(2026, 10, 18, 12);
  const live = { ...loadConfig({ AGENT_ROOT: join(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk, initialCapitalUsd: 60 };
  it('"Daily stop: off — today −$4.10 of −$12.00" from a real RiskState', async () => {
    const risk = new RiskState(live, new VirtualClock(NOW));
    risk.recordPnl(-1.6);
    risk.openPosition({ id: 'p', chain: 'solana', token: 'T', costUsd: 10, openedAtUtc: '2026-11-18T10:00:00Z' });
    risk.setUnrealized(-2.5);
    const status = (): OperatorStatus => ({ mode: 'live', equityUsd: risk.equityUsd, markedEquityUsd: risk.markedEquityUsd, cashUsd: risk.cashUsd, positions: [],
      operatorHalted: false, dailyStop: risk.dailyStopActive(), dailyStopPnlUsd: risk.dailyStopPnlUsd(), dailyStopLimitUsd: risk.dailyStopLimitUsd(), hardStopped: false });
    const run = operatorCommands({ status, setOperatorHalt: () => {}, now: () => NOW });
    expect(await run('/status')).toContain('\nDaily stop: off — today −$4.10 of −$12.00\n');
    risk.setUnrealized(-10.4);
    expect(await run('/status')).toContain('\nDaily stop: on — today −$12.00 of −$12.00\n');
  });
  it('without numbers the line is as before; NaN — "unknown"; profit with a + sign', () => {
    const s: OperatorStatus = { mode: 'paper', equityUsd: 10, markedEquityUsd: 10, cashUsd: 10, positions: [], operatorHalted: false, dailyStop: false, hardStopped: false };
    expect(statusText(s, NOW)).toContain('\nDaily stop: off\n');
    expect(dailyStopFigures(NaN, 12)).toBe('unknown of −$12.00');
    expect(dailyStopFigures(1.25, 12)).toBe('+$1.25 of −$12.00');
    expect(dailyStopFigures(0, 2.0999999999999996)).toBe('$0.00 of −$2.10');
  });
  it('src/index.ts: /status gets the numbers, the startup message — the daily stop line', () => {
    const src = readFileSync(join(__dirname, '../src/index.ts'), 'utf8');
    expect(src).toMatch(/dailyStopPnlUsd: risk\.dailyStopPnlUsd\(\), dailyStopLimitUsd: risk\.dailyStopLimitUsd\(\)/);
    expect(src).toMatch(/started \(\$\{cfg\.mode\}\)[^\n]*Daily stop: \$\{risk\.dailyStopActive\(\) \? '⛔ on' : 'off'\}, today \$\{dailyStopFigures\(risk\.dailyStopPnlUsd\(\), risk\.dailyStopLimitUsd\(\)\)\}/);
  });
});
