// Inbound #117 item 1: the executor's public "in flight" list — buys and sales without a recorded outcome (EVM and Solana) and the bridge.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const EVM = '0x4444444444444444444444444444444444444444';
const SOL = '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: 'ape' };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (chain: string, token: string): Decision => ({ action: 'buy_token', sizeUsd: 2, chain, reasons: [], trust, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain, urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: token },
  check: { ok: true, chain, address: token, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-10-30T08:00:00.000Z' } } as any);
const HB = '0x' + 'a'.repeat(64), HS = '0x' + 'c'.repeat(64);
const RAW = 2000n * 10n ** 18n;
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const pendBuy = (tx: string) => ({ ok: false, pending: true, mode: 'live', qty: 0, raw: 0n, decimals: 18, spentUsd: 0, tx, note: 'tx pending' });

function setup() {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock);
  paper.liveMode = 'live';
  return { paper, clock };
}

describe('#117 item 1: PaperExecutor.inFlight()', () => {
  it('empty when nothing is pending; without a trader — also empty', () => {
    const e = setup();
    expect(e.paper.inFlight()).toEqual([]);
    e.paper.trader = { setLateOutcomeHandler() {} } as any;
    expect(e.paper.inFlight()).toEqual([]);
  });

  it('a buy "in flight" (EVM and Solana) is visible until the outcome is recorded, then disappears; outcome unknown — stays with a mark', async () => {
    const e = setup();
    const settles: Record<string, (r: any) => void> = {};
    e.paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken(p: any) { return pendBuy(p.chain === 'solana' ? 'SIGBUY1' : HB); },
      settleBuy: (a: any) => new Promise(r => { settles[a.tx] = r; }) } as any;
    await expect(e.paper.execute(MSG, buy('base', EVM), 1)).rejects.toThrow(/pending/);
    await expect(e.paper.execute(MSG, buy('solana', SOL), 2)).rejects.toThrow(/pending/);
    expect(e.paper.inFlight()).toEqual([
      `buy base:${EVM} ${HB.slice(0, 10)}… (reserve $2.01)`,
      `buy solana:${SOL.toLowerCase()} SIGBUY1… (reserve $2.01)`,
    ]);
    settles[HB]({ ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: HB, note: 'late: got 2000' }); await tick();
    expect(e.paper.inFlight()).toEqual([`buy solana:${SOL.toLowerCase()} SIGBUY1… (reserve $2.01)`]);
    // Solana: polls ran out with no outcome — the record stays, with a mark
    for (let i = 0; i < 18; i++) { settles['SIGBUY1']({ ...pendBuy('SIGBUY1') }); await tick(2); }
    await tick();
    expect(e.paper.inFlight()).toEqual([`buy solana:${SOL.toLowerCase()} SIGBUY1… (reserve $2.01, outcome unknown)`]);
  });

  it('a sale "in flight" is visible until the outcome is recorded; after the wait deadline — with a mark, until the late outcome arrives', async () => {
    const e = setup();
    let settle!: (s: string) => void; let handler: any;
    e.paper.trader = { setLateOutcomeHandler(h: any) { handler = h; }, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: HB, note: 'got' }; },
      async sellToken() { return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: HS, soldRaw: RAW / 2n, note: 'sell pending' }; },
      settleTx: () => new Promise<string>(r => { settle = r; }) } as any;
    await e.paper.execute(MSG, buy('base', EVM), 1);
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
    await e.paper.monitor(market, { tokensOnly: true });
    expect(e.paper.inFlight()).toEqual([`sale base:${EVM} ${HS.slice(0, 10)}…`]);
    for (let i = 0; i < 3; i++) { settle('unknown'); await tick(5); } // the wait deadline has passed
    await tick();
    expect(e.paper.inFlight()).toEqual([`sale base:${EVM} ${HS.slice(0, 10)}… (outcome unknown)`]);
    handler({ chain: 'base', hash: HS, addr: '0xabc', nonce: 4, kind: 'expired', state: 'mined', receipt: { status: '0x1' }, treasury: true }); await tick();
    expect(e.paper.inFlight()).toEqual([]);
  });

  it('a bridge in transit gets into the list from Funding.inTransit()', () => {
    const e = setup();
    e.paper.trader = { setLateOutcomeHandler() {}, funding: { inTransit: () => ['bridge to robinhood: paused until 09:15:00 UTC (status refund, request r1)'] } } as any;
    expect(e.paper.inFlight()).toEqual(['bridge to robinhood: paused until 09:15:00 UTC (status refund, request r1)']);
  });
});
