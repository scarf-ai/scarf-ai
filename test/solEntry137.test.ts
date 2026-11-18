// #137: Solana — the entry price by the swap amount itself; the rent of a new token account (~0.002 SOL) and the fee — into the cost basis separately
// (cash = capital is preserved). The floor, the ladder and breakeven (#132) — from the real entry price.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import type { Decision, RawMessage } from '../src/types.js';

const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
const SOL_USD = 150;
// a $2 swap at $150/SOL = 13 333 333 lamports; + account rent 2 039 280 + fee 5 000 + priority 100 000
const SWAP_LAMPORTS = 13_333_333n, RENT = 2_039_280n, FEES = 105_000n;
const SPENT = SWAP_LAMPORTS + RENT + FEES;

function solTrader() {
  const t = new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: {}, solRpc: { rpc: 'http://sol', send: [] }, nativeUsd: async () => SOL_USD, slippageBps: 500 });
  const sol: any = (t as any).sol;
  sol.settle = async () => 'ok'; sol.receivedInTx = async () => 123_000n; sol.spentLamportsInTx = async () => SPENT;
  sol.verifySwap = async () => ({ ok: true }); sol.simulate = async () => ({ ok: true }); sol.send = async () => ({ sig: 'SIG1', ok: true });
  let reads = 0; sol.tokenBalance = async () => (reads++ === 0 ? 0n : 123_000n);
  (t as any).solDecimals = async () => 6;
  let asked = 0n;
  (t as any).jup = { build: async (q: any) => { asked = q.amount; return { tx: {}, inAmount: q.amount, outAmount: 123_000n, minOut: 100_000n }; } };
  return { t, asked: () => asked };
}

describe('#137: the Solana trader returns the swap amount separately from the spend', () => {
  it('a live buy: swapUsd — exactly the lamports sent to Jupiter; spentUsd — with rent and fee', async () => {
    const { t, asked } = solTrader();
    const r = await t.buyToken({ chain: 'solana', token: MINT, sizeUsd: 2 }, 'live');
    expect(r.ok).toBe(true); expect(asked()).toBe(SWAP_LAMPORTS);
    expect(r.swapUsd).toBeCloseTo(Number(SWAP_LAMPORTS) / 1e9 * SOL_USD, 9); // ≈ $2,00
    expect(r.spentUsd).toBeCloseTo(Number(SPENT) / 1e9 * SOL_USD, 9);          // ≈ $2,32
    expect(r.spentUsd - r.swapUsd!).toBeCloseTo(Number(RENT + FEES) / 1e9 * SOL_USD, 9);
  });

  it('a late buy (settleBuy): swapUsd — the decision size; the spend was not read — swapUsd no more than the spend', async () => {
    const { t } = solTrader();
    const args = { chain: 'solana' as const, token: MINT, sizeUsd: 2, tx: 'SIG', decimals: 6 };
    const r = await t.settleBuy(args);
    expect(r.swapUsd).toBe(2); expect(r.spentUsd).toBeCloseTo(Number(SPENT) / 1e9 * SOL_USD, 9);
    (t as any).sol.spentLamportsInTx = async () => undefined;
    const r2 = await t.settleBuy(args);
    expect(r2.spentUsd).toBe(2); expect(r2.swapUsd).toBe(2);
  });
});

describe('#137: the position — the entry price from the swap, the cost basis with rent', () => {
  const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-18T08:00:00.000Z', text: 'ape' };
  const buy = (chain: string, token: string): Decision => ({ action: 'buy_token', sizeUsd: 2, chain, reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] }, estGasUsd: 0.02,
    intent: { kind: 'token_call', chain, urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: token },
    check: { ok: true, chain, address: token, priceUsd: 0.016, reasons: [] },
    exitPlan: { stopPrice: 0.0104, tp1Price: 0.032, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-19T08:00:00.000Z', stopPct: 35 } } as any);
  function setup() {
    const clock = new VirtualClock(Date.UTC(2026, 10, 18, 8));
    const store = new Store(':memory:'); const risk = new RiskState(DEFAULT_RISK, clock);
    const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); paper.liveMode = 'live';
    return { paper, risk, store };
  }

  it('Solana with rent: entryPrice = swap amount / quantity, costUsd = the whole spend; cash decreased by the whole spend; the floor — from the swap price', async () => {
    const e = setup(); const cash0 = e.risk.cashUsd;
    e.paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 125, raw: 125_000_000n, decimals: 6, spentUsd: 2.3209, swapUsd: 2, tx: 'SIG1', note: 'jupiter: got 125' }; } } as any;
    await e.paper.execute(MSG, buy('solana', MINT), 1);
    const p = [...e.paper.open.values()][0];
    expect(p.entryPrice).toBeCloseTo(2 / 125, 12);   // $0.016 — the real swap price, without rent
    expect(p.costUsd).toBeCloseTo(2.3209, 12);        // rent and fee — in the cost basis
    expect(cash0 - e.risk.cashUsd).toBeCloseTo(2.3209, 9);
    expect(p.stopPrice).toBeLessThan(2 / 125); expect(p.stopPrice).toBeCloseTo((2 / 125) * (1 - 0.35), 9);
    expect(JSON.parse(e.store.openPositions()[0].state).entryPrice).toBeCloseTo(2 / 125, 12);
  });

  it('without swapUsd (EVM) — as before: entry price = spend / quantity', async () => {
    const e = setup();
    const EVM = '0x4444444444444444444444444444444444444444';
    e.paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 125, raw: 125n * 10n ** 18n, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; } } as any;
    await e.paper.execute(MSG, buy('base', EVM), 1);
    const p = [...e.paper.open.values()][0];
    expect(p.entryPrice).toBeCloseTo(2.02 / 125, 12); expect(p.costUsd).toBeCloseTo(2.02, 12);
  });

  it('a late Solana buy (the outcome came later): the same entry price from the swap', async () => {
    const e = setup();
    let settle!: (r: any) => void;
    e.paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: false, pending: true, mode: 'live', qty: 0, raw: 0n, decimals: 6, spentUsd: 0, tx: 'SIGL', note: 'send: may still land' }; },
      settleBuy: () => new Promise(r => { settle = r; }) } as any;
    await expect(e.paper.execute(MSG, buy('solana', MINT), 1)).rejects.toThrow(/pending/);
    settle({ ok: true, mode: 'live', qty: 125, raw: 125_000_000n, decimals: 6, spentUsd: 2.3209, swapUsd: 2, tx: 'SIGL', note: 'late: got 125' });
    await new Promise(r => setTimeout(r, 30));
    const p = [...e.paper.open.values()][0];
    expect(p.entryPrice).toBeCloseTo(2 / 125, 12); expect(p.costUsd).toBeCloseTo(2.3209, 12);
  });
});
