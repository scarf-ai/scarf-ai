// Review #113 round 3: N2 — a ladder step sold "in flight": breakeven and the step counter turn on only after confirmation.
// The repro-a convention: red = the defect is present. The harness — as in test/lateLedger.test.ts (sellSetup).
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const TOKEN = '0x4444444444444444444444444444444444444444';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: `ape ${TOKEN}` };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const RAW = 2000n * 10n ** 18n;
const HS = '0x' + 'c'.repeat(64);
const buy = (): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: TOKEN },
  check: { ok: true, chain: 'base', address: TOKEN, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00055, tp1Price: 0.0012, tp1Share: 0.2, trailingPct: 35, timeStopAtUtc: '2026-11-01T08:00:00.000Z', hardTimeStop: true, timeStopMinGainPct: 0,
    tokenClass: 'call', breakevenAfterTp1: true, ladder: [[1.2, 0.2], [1.8, 0.2], [2.7, 0.2], [4.05, 0.2]], checks: [[20, 0.75], [45, 0.7], [90, 0.65], [300, 0.85]] } } as any); // example plan
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

describe('N2: pending ladder sale → state applied on confirmation only', () => {
  for (const outcome of ['ok', 'failed'] as const) it(`outcome ${outcome}`, async () => {
    const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
    const risk = new RiskState(DEFAULT_RISK, clock);
    const paper = new PaperExecutor(DEFAULT_RISK, risk, new Store(':memory:'), { async send() {} }, clock);
    paper.liveMode = 'live';
    let settle!: (st: string) => void; const settled = new Promise<string>(r => { settle = r; });
    const t: any = { handler: undefined, acks: [] as string[], sells: 0,
      setLateOutcomeHandler(h: any) { this.handler = h; }, clearGhost(_c: string, h: string) { this.acks.push(h); },
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
      async sellToken() { this.sells++; return { ok: false, mode: 'live', proceedsUsd: 3.5, pending: true, tx: HS, soldRaw: RAW * 6000n / 10000n, note: 'sell pending' }; },
      settleTx: () => settled };
    paper.trader = t;
    await paper.execute(MSG, buy(), 1);
    const p = [...paper.open.values()][0];
    const entry = p.entryPrice;
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: entry * 3.5 }; }, async rug() { return undefined; } } as any;
    await paper.monitor(market, { tokensOnly: true }); // rungs 1–3 in one sale, pending
    expect(t.sells).toBe(1);
    expect([p.rungsDone ?? 0, p.tp1Done, p.stopPrice < entry]).toEqual([0, false, true]); // rolled back while in flight
    settle(outcome); await tick();
    if (outcome === 'ok') {
      expect(p.rungsDone).toBe(3); expect(p.tp1Done).toBe(true);
      expect(p.stopPrice).toBeCloseTo(entry, 15);                // breakeven after the first sale
      expect(p.qtyLeft).toBeCloseTo(2000 * (1 - 0.6), 6);
    } else {
      expect([p.rungsDone ?? 0, p.tp1Done, p.qtyLeft]).toEqual([0, false, 2000]);
      expect(p.stopPrice).toBeLessThan(entry);
    }
  });
});