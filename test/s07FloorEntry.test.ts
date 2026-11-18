// Incoming #126 item 1 (S-07 V2 tail): the position floor is computed from the actual entry price, like the ladder and behavior checks.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor, PAPER_SLIPPAGE, stopFromEntry } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';

const TOKEN = '0x4444444444444444444444444444444444444444';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: 'ape' };
const trust = { score: 8, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const PX = 0.001;
/** The exit plan as decide returns it: levels computed from the decision price PX. v2 — with a token class (S-07 V2). */
const buy = (v2: boolean): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: TOKEN },
  check: { ok: true, chain: 'base', address: TOKEN, priceUsd: PX, reasons: [] },
  exitPlan: { stopPrice: PX * 0.55, stopPct: 45, tp1Price: PX * 1.2, tp1Share: 0.2, tpX: 1.2, trailingPct: 35, timeStopAtUtc: '2026-11-01T08:00:00.000Z', hardTimeStop: true,
    ...(v2 ? { tokenClass: 'call', breakevenAfterTp1: true, ladder: [[1.2, 0.2], [1.8, 0.2]], checks: [[15, 0.9]] } : {}) } } as any); // example plan

function setup(mode: 'paper' | 'live') {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock);
  paper.liveMode = mode;
  return { paper };
}

describe('#126 item 1: the V2 floor — from the actual entry price', () => {
  it('live, entry 8 % above the decision price (slippage): the floor is exactly −45 % from entry, not −49 %', async () => {
    const e = setup('live');
    const entry = PX * 1.08; // bought higher
    e.paper.trader = { async buyToken() { return { ok: true, mode: 'live', qty: 2 / entry, raw: 10n ** 18n, decimals: 18, spentUsd: 2, tx: '0x' + 'b'.repeat(64), note: 'got' }; } } as any;
    await e.paper.execute(MSG, buy(true), 1);
    const p = [...e.paper.open.values()][0];
    expect(p.entryPrice).toBeCloseTo(entry, 12);
    expect(p.stopPrice).toBeCloseTo(entry * 0.55, 12);
    expect(p.stopPrice / p.entryPrice).toBeCloseTo(0.55, 12); // before: PX*0.55 / (PX*1.08) = 0.509 → floor −49.1 %
    // the ladder and checks — from the same price: the levels are consistent with each other
    expect(p.ladder![0].price).toBeCloseTo(entry * 1.2, 12);
    expect(p.checks![0].minPrice).toBeCloseTo(entry * 0.9, 12);
  });

  it('paper (entry = decision price + 1 %): the floor is −45 % from entry', async () => {
    const e = setup('paper');
    await e.paper.execute(MSG, buy(true), 1);
    const p = [...e.paper.open.values()][0];
    expect(p.entryPrice).toBeCloseTo(PX * (1 + PAPER_SLIPPAGE), 12);
    expect(p.stopPrice).toBeCloseTo(p.entryPrice * 0.55, 12);
  });

  it('the previous exit scheme (a plan without a token class) does not change: the floor is the price from the plan', async () => {
    const e = setup('paper');
    await e.paper.execute(MSG, buy(false), 1);
    const p = [...e.paper.open.values()][0];
    expect(p.stopPrice).toBe(PX * 0.55);
  });

  it('stopFromEntry: without a percent, with a percent outside (0, 100) or with a zero entry — the price from the plan', () => {
    expect(stopFromEntry({ stopPrice: 7, stopPct: 50, tokenClass: 'call' }, 20)).toBe(10);
    expect(stopFromEntry({ stopPrice: 7, tokenClass: 'call' }, 20)).toBe(7);
    expect(stopFromEntry({ stopPrice: 7, stopPct: 0, tokenClass: 'call' }, 20)).toBe(7);
    expect(stopFromEntry({ stopPrice: 7, stopPct: 100, tokenClass: 'call' }, 20)).toBe(7);
    expect(stopFromEntry({ stopPrice: 7, stopPct: NaN, tokenClass: 'call' }, 20)).toBe(7);
    expect(stopFromEntry({ stopPrice: 7, stopPct: 50, tokenClass: 'call' }, 0)).toBe(7);
    expect(stopFromEntry({ stopPrice: 7, stopPct: 50 }, 20)).toBe(7);
  });
});
