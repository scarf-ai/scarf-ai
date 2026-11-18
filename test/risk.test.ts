import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { DEFAULT_RISK, loadConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState, sizeAction, assertWithinLimits, estimateGasUsd, shareForTier, haltReason } from '../src/risk/risk.js';
import type { Tier, Chain } from '../src/types.js';

describe('risk limits with $10 (example DEFAULT_RISK)', () => {
  it('tier caps: follow $4.50, fast $2, full $0.80, journal 0 (example shares)', () => {
    const c = new VirtualClock(); const st = new RiskState(DEFAULT_RISK, c);
    expect(sizeAction(DEFAULT_RISK, st, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 }).sizeUsd).toBe(4.5);
    expect(sizeAction(DEFAULT_RISK, st, { tier: 'fast', chain: 'solana', estGasUsd: 0.02 }).sizeUsd).toBe(2);
    expect(sizeAction(DEFAULT_RISK, st, { tier: 'full', chain: 'solana', estGasUsd: 0.02 }).sizeUsd).toBe(0.8);
    expect(sizeAction(DEFAULT_RISK, st, { tier: 'journal', chain: 'solana', estGasUsd: 0.02 }).ok).toBe(false);
  });
  it('ethereum mint gas ($5) is skipped on $10 capital', () => {
    const c = new VirtualClock(); const st = new RiskState(DEFAULT_RISK, c);
    const gas = estimateGasUsd('ethereum', 2490, { min: 0.0017, max: 0.0021 });
    expect(gas).toBeCloseTo(5.23, 2);
    const r = sizeAction(DEFAULT_RISK, st, { tier: 'follow', chain: 'ethereum', estGasUsd: gas });
    expect(r.ok).toBe(false);
  });
  it('daily loss stop until next UTC day, then resumes', () => {
    const c = new VirtualClock(Date.UTC(2026, 9, 22, 10)); const st = new RiskState(DEFAULT_RISK, c);
    st.recordPnl(-3.1); // > 20% of $10 bucket (example daily stop)
    expect(sizeAction(DEFAULT_RISK, st, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 }).ok).toBe(false);
    c.advance(14 * 3600_000); // the next UTC day
    expect(sizeAction(DEFAULT_RISK, st, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 }).ok).toBe(true);
  });
  it('hard stop below 55% of start (example)', () => {
    const c = new VirtualClock(); const st = new RiskState(DEFAULT_RISK, c);
    st.recordPnl(-5.01);
    expect(st.hardStopped).toBe(true);
    expect(() => assertWithinLimits(DEFAULT_RISK, st, 'follow', 1, 0.01)).toThrow();
  });
  it('fuzz: no size ever exceeds tier cap or cash', () => {
    const tiers: Tier[] = ['ignore', 'journal', 'full', 'fast', 'follow'];
    const chains: Chain[] = ['solana', 'robinhood', 'ethereum', 'base', 'arbitrum', 'unknown'];
    let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 5000; i++) {
      const c = new VirtualClock(); const st = new RiskState(DEFAULT_RISK, c, 1 + rnd() * 500);
      st.cashUsd = st.equityUsd * rnd();
      if (rnd() < 0.3) st.recordPnl(-rnd() * st.equityUsd * 0.6);
      const tier = tiers[Math.floor(rnd() * tiers.length)], chain = chains[Math.floor(rnd() * chains.length)];
      const gas = rnd() * 10;
      const r = sizeAction(DEFAULT_RISK, st, { tier, chain, estGasUsd: gas });
      if (r.ok) {
        expect(r.sizeUsd).toBeLessThanOrEqual(st.bucketUsd * shareForTier(DEFAULT_RISK, tier) + 1e-9);
        expect(r.sizeUsd + gas).toBeLessThanOrEqual(st.cashUsd + 1e-9);
        expect(() => assertWithinLimits(DEFAULT_RISK, st, tier, r.sizeUsd, gas)).not.toThrow();
      } else expect(r.sizeUsd).toBe(0);
    }
  });
});

// S-04 (#33): risk rules for live. The public copy has the example fixture test/fixtures/risk.example.json (= server/config/risk.example.json);
// the copy's owner sets their own numbers in server/config/risk.json.
describe('risk.example.json for live (S-04)', () => {
  const live = loadConfig({ AGENT_ROOT: resolve(__dirname, '..'), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk;
  const LIVE_CHAINS: Chain[] = ['base', 'robinhood', 'arbitrum', 'solana']; // E-08 (#43): the first-day live chains
  it('example file holds the documented example values', () => {
    expect(live.initialCapitalUsd).toBe(100);
    expect(live.live).toEqual({ slippageBps: 500, bridgeMaxShareOfEquity: 0.5, mintMaxShareOfEquity: 0.25, mintMaxWallets: 8 });
    expect(live.perActionShareByTier).toEqual({ follow: 0.45, fast: 0.2, full: 0.08 });
    // daily stop — option C: a share of the bucket at 00:00 UTC; the old field is not in the file
    expect([live.minActionUsd, live.maxGasShareOfCapital, live.maxGasShareOfAction, live.maxOpenPositions, live.dailyLossStopShareOfDayStart, live.hardStopEquityShare])
      .toEqual([0.3, 0.12, 0.25, 6, 0.2, 0.55]);
    expect('dailyLossStopShare' in live).toBe(false);
    expect(live.riskProblems).toEqual([]); // the repository file is valid in full (S-06)
  });
  it('every tier on every live chain sizes above minActionUsd and passes the gas rules', () => {
    const want: Record<string, number> = { follow: 45, fast: 20, full: 8 };
    for (const chain of LIVE_CHAINS) for (const tier of ['follow', 'fast', 'full'] as Tier[]) {
      const st = new RiskState(live, new VirtualClock());
      const gas = estimateGasUsd(chain, 3000) * 2; // entry + exit, as in decide()
      const r = sizeAction(live, st, { tier, chain, estGasUsd: gas });
      expect(r, `${chain}/${tier}`).toMatchObject({ ok: true, sizeUsd: want[tier] });
      expect(gas).toBeLessThanOrEqual(r.sizeUsd * live.maxGasShareOfAction);
      // a "careful" source: size ×careful.sizeFactor (intel/router.ts) — also above the minimum
      expect(r.sizeUsd * live.careful.sizeFactor).toBeGreaterThanOrEqual(live.minActionUsd);
    }
  });
  it('hard stop at $55; daily stop at −$20 (20 % of the day start, variant C; example numbers)', () => {
    const c = new VirtualClock(Date.UTC(2026, 10, 9, 10));
    const a = new RiskState(live, c); a.recordPnl(-44.99); expect(a.hardStopped).toBe(false); a.recordPnl(-0.02); expect(a.hardStopped).toBe(true);
    // Option C: 0.2 × $100 at 00:00 UTC = $20
    const b = new RiskState(live, c); b.recordPnl(-19.99); expect(b.dailyStopActive()).toBe(false); b.recordPnl(-0.01); expect(b.dailyStopActive()).toBe(true);
  });
  it('paper ledger of $10 restored under a $100 config hard-stops at once — reset (E-09, #45) must go first', () => {
    const st = new RiskState(live, new VirtualClock());
    st.restore({ equityUsd: 10, cashUsd: 10, dayPnl: [], hardStopped: false, positions: [] });
    st.setUnrealized(0);
    expect(st.hardStopped).toBe(true);
  });
});

// #58 (E-08 #43): the operator stop from Telegram — new entries closed, survives a restart, lifted by /resume.
describe('operator halt (/stop)', () => {
  it('blocks new entries with a reason, survives snapshot/restore, lifts on resume', () => {
    const c = new VirtualClock(); const st = new RiskState(DEFAULT_RISK, c);
    const saved: unknown[] = []; st.onChange = (s) => saved.push(s);
    st.setOperatorHalt(true);
    expect(saved.length).toBe(1); // the change is saved to the DB right away
    expect(st.halted()).toBe(true);
    const r = sizeAction(DEFAULT_RISK, st, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 });
    expect(r).toMatchObject({ ok: false, sizeUsd: 0 });
    expect(r.reasons[0]).toMatch(/halted by operator/);
    expect(() => assertWithinLimits(DEFAULT_RISK, st, 'follow', 1, 0.01, { opensPosition: true })).toThrow(/halted/);
    // exits are not blocked: closing a position goes through
    st.openPosition({ id: 'p1', chain: 'solana', token: 'T', costUsd: 1, openedAtUtc: c.iso() });
    st.closePosition('p1', 1.5);
    expect(st.positions.length).toBe(0);
    // restart
    const st2 = new RiskState(DEFAULT_RISK, c); st2.restore(st.snapshot());
    expect(st2.operatorHalt).toBe(true);
    expect(sizeAction(DEFAULT_RISK, st2, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 }).ok).toBe(false);
    // /resume
    st2.setOperatorHalt(false);
    expect(st2.halted()).toBe(false);
    expect(sizeAction(DEFAULT_RISK, st2, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 }).ok).toBe(true);
  });
  it('old snapshot without the field restores as not halted; hard stop keeps priority in the reason', () => {
    const c = new VirtualClock(); const st = new RiskState(DEFAULT_RISK, c);
    st.restore({ equityUsd: 10, cashUsd: 10, dayPnl: [], hardStopped: false, positions: [] });
    expect(st.operatorHalt).toBe(false);
    st.setOperatorHalt(true); st.recordPnl(-6);
    expect(st.hardStopped).toBe(true);
    expect(haltReason(DEFAULT_RISK, st)).toMatch(/^hard stop/);
    st.setOperatorHalt(false);
    expect(st.halted()).toBe(true); // /resume does not lift the hard stop
  });
});

// S-07 (#102): the moonbag "tail" does not take a trading slot
describe('moonbag-only positions do not block new entries', () => {
  it('maxOpenPositions counts only active positions; flag survives snapshot/restore', () => {
    const c = new VirtualClock(); const st = new RiskState(DEFAULT_RISK, c);
    for (let i = 0; i < DEFAULT_RISK.maxOpenPositions; i++) st.openPosition({ id: `p${i}`, chain: 'solana', token: `T${i}`, costUsd: 0.1, openedAtUtc: c.iso() });
    expect(sizeAction(DEFAULT_RISK, st, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 }).ok).toBe(false);
    st.markMoonbagOnly('p0');
    expect(st.activeCount()).toBe(DEFAULT_RISK.maxOpenPositions - 1);
    expect(sizeAction(DEFAULT_RISK, st, { tier: 'follow', chain: 'solana', estGasUsd: 0.02 }).ok).toBe(true);
    expect(() => assertWithinLimits(DEFAULT_RISK, st, 'follow', 1, 0.01, { opensPosition: true, token: 'NEW' })).not.toThrow();
    const st2 = new RiskState(DEFAULT_RISK, c); st2.restore(st.snapshot());
    expect(st2.moonbagCount()).toBe(1);
  });
});
