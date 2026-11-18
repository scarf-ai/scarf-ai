// Reviewer reproduction (round 2, F3 from /tmp/hq/repro-live-b/r135.test.ts): a restart during a sale "in flight". Red = the defect is present.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const H = ('0x' + 'c'.repeat(64)) as `0x${string}`;
const EVM = '0x4444444444444444444444444444444444444444';
const RAW = 2000n * 10n ** 18n;
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));


describe('F3 (round 2): a restart during a sale "in flight" with an unknown outcome — the position is sold again', () => {
  it('a pending sale (no outcome yet) → restart (restore on the same database) → the monitor sells the same step once more', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const store = new Store(':memory:');
    const risk = new RiskState(DEFAULT_RISK, clock);
    const mk = () => { const p = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p.liveMode = 'live'; return p; };
    let sells = 0;
    const stub = () => ({ setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, note: 'tx mined, receipt status unreadable' }; },
      async settleTx() { return 'unknown'; } }) as any;
    const p1 = mk(); p1.trader = stub();
    const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-17T08:00:00.000Z', text: 'ape' };
    const d: Decision = { action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] } as any, estGasUsd: 0.02,
      intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM } as any,
      check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
      exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-18T08:00:00.000Z' } } as any;
    await p1.execute(MSG, d, 1);
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
    await p1.monitor(market, { tokensOnly: true }); await tick(150);
    expect(sells).toBe(1);
    // restart: the executor memory and the sender address block (ghostMined) are lost, the position is restored from the database
    const p2 = mk(); p2.trader = stub(); p2.restore();
    await p2.monitor(market, { tokensOnly: true });
    expect(sells).toBe(1); // red: 2 — the same take-profit is sold a second time, although the outcome of the first is unknown
  });
});
