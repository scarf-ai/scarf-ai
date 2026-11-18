// F3 round 3: a Solana sale "in flight" at the moment of a restart. Red = the defect is present.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
const SIG = '5'.repeat(88);
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));
describe('S1: a Solana sale that never reached the network holds the position forever after a restart (the stop does not work)', () => {
  it('pending → restart ×2, price −90 %, 2 days passed — the position must be sold', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const store = new Store(':memory:'); const risk = new RiskState(DEFAULT_RISK, clock);
    const mk = () => { const p = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p.liveMode = 'live'; return p; };
    let sells = 0;
    // SolSender.settle for a signature that is not on the network (blockhash expired): status null → 'unknown' — never 'dropped'
    const stub = (hang = false) => ({ setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: 2000n * 10n ** 6n, decimals: 6, spentUsd: 2.02, tx: '4'.repeat(88), note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: SIG, soldRaw: 1000n * 10n ** 6n, note: 'tx pending' }; },
      settleTx(_c: any, tx: string) { return hang && tx === SIG ? new Promise(() => {}) : Promise.resolve(tx === SIG ? 'unknown' : 'ok'); } }) as any;
    const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-17T08:00:00.000Z', text: 'ape' };
    const d: Decision = { action: 'buy_token', sizeUsd: 2, chain: 'solana', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] } as any, estGasUsd: 0.02,
      intent: { kind: 'token_call', chain: 'solana', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: MINT } as any,
      check: { ok: true, chain: 'solana', address: MINT, priceUsd: 0.001, reasons: [] },
      exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-18T08:00:00.000Z' } } as any;
    let px = 0.0025;
    const market: MarketClient = { async market() { return { chain: 'solana', priceUsd: px }; }, async rug() { return undefined; } };
    const p1 = mk(); p1.trader = stub(true); await p1.execute(MSG, d, 1); // p1 restarts while waiting for the sale outcome
    await p1.monitor(market, { tokensOnly: true }); await tick();
    expect(sells).toBe(1);                       // the take-profit went "in flight", never reached the network
    // a restart while waiting; then another one a day later
    const p2 = mk(); p2.trader = stub(); p2.restore(); await tick();
    clock.advance(24 * 3600_000);
    const p3 = mk(); p3.trader = stub(); p3.restore(); await tick();
    clock.advance(24 * 3600_000); px = 0.0001; // crash −90 %
    await p3.monitor(market, { tokensOnly: true }); await tick();
    expect(sells).toBeGreaterThan(1); // red: 1 — the position is held, the stop does not fire
  });
});
