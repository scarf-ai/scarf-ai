// Review #135: a sale with an unreadable status (there is a receipt — the transaction is in a block) after the wait limit and an hour of freeze. repro-a: red = a repeated sale.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const EVM = '0x4444444444444444444444444444444444444444', H = '0x' + 'c'.repeat(64), RAW = 2000n * 10n ** 18n;
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-16T08:00:00.000Z', text: 'ape' };
const buy = (): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] }, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM },
  check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-17T08:00:00.000Z' } } as any);
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

describe('#135: unreadable-status sale is not re-sent after the freeze', () => {
  it('settleTx always «unknown» (mined, status unreadable) → after 61 min the monitor must not sell again', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 16, 8));
    const paper = new PaperExecutor(DEFAULT_RISK, new RiskState(DEFAULT_RISK, clock), new Store(':memory:'), { async send() {} }, clock);
    paper.liveMode = 'live'; let sells = 0;
    paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, note: 'sell pending' }; },
      settleTx: async () => 'unknown' } as any;
    await paper.execute(MSG, buy(), 1);
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } } as any;
    await paper.monitor(market, { tokensOnly: true }); await tick();
    expect(sells).toBe(1);
    clock.advance(61 * 60_000);
    await paper.monitor(market, { tokensOnly: true }); await tick();
    console.log({ sells, inFlight: paper.inFlight() });
    expect(sells).toBe(1);
  });
});
