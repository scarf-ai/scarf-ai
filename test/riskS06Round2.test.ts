// S-06 review, round 2 (moved from the reviewer's reproduction; a block as a string — per round 3): each RISK_RULES number with a bad value — the approved value from DEFAULT_RISK and new entries closed.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RISK, loadConfig } from '../src/config.js';
import { RISK_RULES } from '../src/risk/riskCheck.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState, sizeAction, assertWithinLimits } from '../src/risk/risk.js';

const dir = mkdtempSync(join(tmpdir(), 'rv-risk2-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const load = (json: string) => { const p = join(dir, `r${n++}.json`); writeFileSync(p, json); return loadConfig({ AGENT_ROOT: dir, AGENT_RISK_JSON: p } as NodeJS.ProcessEnv).risk; };
const get = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o);
const nest = (p: string, v: string) => p.split('.').reduceRight((acc, k) => `{"${k}": ${acc}}`, v);
const BAD = ['"0,25"', 'null', '"NaN"', '1e999', '-1e999', '-1', '"1"', '[]', '{}', 'true'];

describe('round 2: all RISK_RULES fields × bad values', () => {
  it('field = DEFAULT_RISK, riskProblems names the field, sizeAction/assertWithinLimits closed', () => {
    const keys = new Set<string>();
    const walk = (o: any, pre = '') => { for (const [k, v] of Object.entries(o)) v && typeof v === 'object' ? walk(v, `${pre}${k}.`) : keys.add(pre + k); };
    walk(DEFAULT_RISK);
    expect([...keys].filter(k => !RISK_RULES.some(r => r[0] === k))).toEqual([]); // not a single DEFAULT_RISK number without a check
    let checked = 0;
    for (const [path] of RISK_RULES) for (const bad of BAD) {
      const def = get(DEFAULT_RISK, path);
      if (JSON.stringify(def) === bad) continue; // true for booleans — a valid value
      if (typeof def === 'boolean' && (bad === 'true')) continue;
      const cfg = load(nest(path, bad));
      expect(get(cfg, path), `${path}=${bad}`).toBe(def);
      expect(cfg.riskProblems!.join(';'), `${path}=${bad}`).toContain(path);
      const st = new RiskState(cfg, new VirtualClock(Date.UTC(2026, 10, 18, 10)), 50);
      expect(st.halted(), `${path}=${bad}`).toBe(true);
      expect(sizeAction(cfg, st, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 }).ok).toBe(false);
      expect(() => assertWithinLimits(cfg, st, 'follow', 1, 0.01)).toThrow(/halted/);
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
  });
  it('a block that is not an object, file null/array, the old field as a string — entries closed, numbers approved', () => {
    for (const j of ['{"live": "0,5"}', '{"careful": {"exit": "x"}}', 'null', '[]', '{"dailyLossStopShare": "0,25"}', '{"memecoinClasses": "x"}']) {
      const cfg = load(j);
      expect(cfg.live, j).toMatchObject(DEFAULT_RISK.live); expect(cfg.careful.exit, j).toMatchObject(DEFAULT_RISK.careful.exit);
      expect(cfg.dailyLossStopShareOfDayStart, j).toBe(0.2);
      expect(new RiskState(cfg, new VirtualClock(), 100).halted(), j).toBe(j !== '{"memecoinClasses": "x"}'); // round 3: a block as a string — a stop and a message; memecoinClasses — its own fallback (O3)
      if (j.includes('"live"')) expect(cfg.riskProblems).toContain('live="0,5" — must be a block { … }');
      if (j.includes('"exit"')) expect(cfg.riskProblems).toContain('careful.exit="x" — must be a block { … }');
    }
  });
});

// Round 3, nice-to-have
describe('nice-to-have: a block as a string and mintMaxWallets 8.5', () => {
  it('"live": "0,5" and "careful": "x" — in riskProblems, numbers approved', () => {
    const a = load('{"live": "0,5"}'); expect(a.riskProblems).toEqual(['live="0,5" — must be a block { … }']); expect(a.live).toEqual(DEFAULT_RISK.live);
    const b = load('{"careful": "x"}'); expect(b.riskProblems).toEqual(['careful="x" — must be a block { … }']); expect(b.careful).toEqual(DEFAULT_RISK.careful);
    expect(new RiskState(a, new VirtualClock()).halted()).toBe(true);
  });
  it('live.mintMaxWallets 8.5 — a problem, approved (example) 8', () => {
    const c = load('{"live": {"mintMaxWallets": 8.5}}');
    expect(c.riskProblems).toEqual(['live.mintMaxWallets=8.5 — needs integer 1…1000']); expect(c.live.mintMaxWallets).toBe(8);
  });
});
