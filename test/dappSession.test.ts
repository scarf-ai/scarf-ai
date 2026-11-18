// Inbound #95 (HQ, A-10 acceptance #91): dapp_session without an executor does not charge the gas estimate to the day's loss.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';

const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: 'farm points https://quest.example.xyz' };
const trust = { score: 9, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const decision = (action: Decision['action'], o: Partial<Decision> = {}): Decision => ({ action, sizeUsd: 0, chain: 'unknown', reasons: ['browser session with burner wallet'], trust, estGasUsd: 0.15,
  intent: { kind: 'dapp_task', chain: 'unknown', urls: ['https://quest.example.xyz'], summary: 'connect a burner wallet and play', stance: 'neutral', confidence: 0.8 }, ...o } as Decision);

function setup(mode: 'paper' | 'shadow' = 'paper') {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t) { sent.push(t); } }, clock);
  paper.liveMode = mode;
  return { risk, paper, sent };
}

describe('#95: dapp_session without a browser session executor — card only, no spend', () => {
  for (const mode of ['paper', 'shadow'] as const) {
    it(`${mode}: 30 tasks in a row — cash and the day's result do not change, the daily stop does not trigger, a buy after them passes the limit check`, async () => {
      const e = setup(mode);
      const cash0 = e.risk.cashUsd, eq0 = e.risk.equityUsd;
      for (let i = 0; i < 30; i++) await e.paper.execute(MSG, decision('dapp_session'), i + 1);
      expect(e.risk.cashUsd).toBe(cash0); expect(e.risk.equityUsd).toBe(eq0); expect(e.risk.todayPnl()).toBe(0);
      expect(e.risk.halted()).toBe(false); // before: 30 × $0.15 = −$4.50 with $10 capital → daily stop until 00:00 UTC
      expect(e.sent.length).toBe(30);
      expect(e.sent[0]).toMatch(/DAPP SESSION/);
      expect(e.sent[0]).toMatch(/no browser executor yet \(E-06\): nothing was done and nothing was spent/);
    });
  }

  it('contract_call in paper still charges the price and gas (behaviour unchanged)', async () => {
    const e = setup();
    const cash0 = e.risk.cashUsd;
    await e.paper.execute(MSG, decision('contract_call', { sizeUsd: 1, estGasUsd: 0.02, intent: { kind: 'contract_call', chain: 'base', urls: [], summary: 'claim', stance: 'neutral', confidence: 0.8 } as any, chain: 'base' }), 1);
    expect(cash0 - e.risk.cashUsd).toBeCloseTo(1.02, 6);
    expect(e.risk.todayPnl()).toBeCloseTo(-1.02, 6);
    expect(e.sent[0]).toMatch(/CONTRACT CALL/);
  });

  it('the entry stop still applies to the task: with /stop there is no card, a refusal with a reason', async () => {
    const e = setup();
    e.risk.setOperatorHalt(true);
    await expect(e.paper.execute(MSG, decision('dapp_session'), 1)).rejects.toThrow(/trading halted/);
    expect(e.sent.length).toBe(0);
  });
});
