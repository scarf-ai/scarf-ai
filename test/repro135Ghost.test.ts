// Final package, #135 item 1: an unreadable receipt status. Red = the defect is present.
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { EvmSender } from '../src/live/evm.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;
const H = ('0x' + 'c'.repeat(64)) as `0x${string}`;
const EVM = '0x4444444444444444444444444444444444444444';
const RAW = 2000n * 10n ** 18n;
const noStatus = (h: string) => ({ blockNumber: '0x10', transactionHash: h, logs: [] }); // there is a receipt, no status field
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

describe('F1: sender — an unreadable receipt: no "in flight" record, no address block, a late outcome will never come', () => {
  it('send() → pending: true, but hasPending(address) is empty and awaitOutcome returns mined right away (not expired) — nobody to finish the outcome', async () => {
    const acct = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
    let late = 0;
    const rpc = async (_u: string, m: string, p: any[]) => {
      if (m === 'eth_sendRawTransaction') return '0x';
      if (m === 'eth_getTransactionReceipt') return noStatus(p[0]);
      if (m === 'eth_getTransactionCount') return '0x3';
      if (m === 'eth_estimateGas') return '0x5208';
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1', timestamp: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x1';
      if (m === 'eth_getTransactionByHash') return { hash: p[0] };
      throw new Error(m);
    };
    const s = new EvmSender(chain as any, rpc as any); s.onLateOutcome = () => { late++; };
    const r = await s.send(acct, { to: EVM as `0x${string}`, data: '0x', value: 0n } as any);
    expect(r.pending).toBe(true);
    // The outcome is "unknown" per #135 — so the address must stay blocked (like a ghost) until the outcome is known
    expect.soft(s.hasPending(acct.address)).toBeDefined(); // red: undefined — new sales/buys from the address are not held back
    const o = await s.awaitOutcome(r.hash, 1_000, { last: true });
    expect.soft(o.state).not.toBe('mined'); // "in flight" for the caller; red: mined → settleTx "unknown" forever, and the outcome will not reach the subscriber
    expect.soft(late).toBeGreaterThan(0); // red: 0
  });
});

describe('F2: executor — a sale with an unreadable receipt is sold again an hour later', () => {
  it('pending → settleTx unknown ×3 → givenUp, 1 h freeze → after 61 min the monitor sells again', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 16, 8));
    const risk = new RiskState(DEFAULT_RISK, clock);
    const paper = new PaperExecutor(DEFAULT_RISK, risk, new Store(':memory:'), { async send() {} }, clock);
    paper.liveMode = 'live';
    const f: typeof fetch = (async (_u: any, init: any) => {
      const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
      if (b.method === 'eth_getTransactionReceipt') return res(noStatus(b.params[0]));
      if (b.method === 'eth_getTransactionCount') return res('0x3');
      if (b.method === 'eth_getTransactionByHash') return res({ hash: b.params[0] });
      throw new Error(b.method);
    }) as any;
    const real = new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
    let sells = 0;
    paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
      // this is how the trader answers for a receipt without a status (evm.ts → pending); per F1 the real sender does not block the address
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, note: `tx pending (no receipt yet): ${H}` }; },
      settleTx: (c: any, tx: string, o: any) => real.settleTx(c, tx, o) } as any;
    const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-16T08:00:00.000Z', text: 'ape' };
    const d: Decision = { action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] } as any, estGasUsd: 0.02,
      intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM } as any,
      check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
      exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-17T08:00:00.000Z' } } as any;
    await paper.execute(MSG, d, 1);
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
    await paper.monitor(market, { tokensOnly: true }); await tick(150);
    expect(sells).toBe(1);
    clock.advance(61 * 60_000);
    await paper.monitor(market, { tokensOnly: true });
    expect(sells).toBe(1); // red: 2 — the first sale may have gone through, the second sells once more
  });
});
