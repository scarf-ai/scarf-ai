// #135 item 1 (rule #114 "roll back only on an explicit 0x0"): a receipt without a readable status — outcome unknown, "in flight".
// Not a failure: do not roll the position back, do not sell again, do not release the buy reserve.
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
const HB = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const EVM = '0x4444444444444444444444444444444444444444';
const RAW = 2000n * 10n ** 18n;
const NO_STATUS = undefined; // no status field
const receiptWith = (status: unknown) => ({ blockNumber: '0x10', transactionHash: H, logs: [], ...(status === NO_STATUS ? {} : { status }) });
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

/** A real LiveTrader: the node returns a receipt with the given status. */
function trader(status: unknown) {
  const f: typeof fetch = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
    if (b.method === 'eth_getTransactionReceipt') return res({ ...receiptWith(status), transactionHash: b.params[0] });
    if (b.method === 'eth_getTransactionCount') return res('0x3');
    if (b.method === 'eth_getTransactionByHash') return res({ hash: b.params[0] });
    throw new Error(b.method);
  }) as any;
  return new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
}

describe('#135: evm.ts broadcast — receipt status', () => {
  const send = (status: unknown) => {
    const rpc = async (_u: string, m: string, p: any[]) => {
      if (m === 'eth_sendRawTransaction') return H;
      if (m === 'eth_getTransactionReceipt') return { ...receiptWith(status), transactionHash: p[0] };
      throw new Error(m);
    };
    return new EvmSender(chain as any, rpc as any).broadcast('0x01', H, { waitMs: 2_000 });
  };
  it('no status / null / "0x01" → not ok and "in flight" (pending); an explicit 0x0 → failure (not pending); 0x1 → ok', async () => {
    for (const st of [NO_STATUS, null, '0x01', 1]) {
      const r = await send(st);
      expect([r.ok, r.pending], JSON.stringify(st)).toEqual([false, true]);
    }
    const rev = await send('0x0'); expect([rev.ok, rev.pending]).toEqual([false, false]);
    const ok = await send('0x1'); expect([ok.ok, ok.pending]).toEqual([true, false]);
  });
});

describe('#135 finishing: send() with an unreadable receipt — a ghost (address block, late outcome), expired to the caller', () => {
  const acct = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
  async function sendWith(status: unknown) {
    const rpc = async (_u: string, m: string, p: any[]) => {
      if (m === 'eth_sendRawTransaction') return '0x';
      if (m === 'eth_getTransactionReceipt') return { ...receiptWith(status), transactionHash: p[0] };
      if (m === 'eth_getTransactionCount') return '0x3';
      if (m === 'eth_estimateGas') return '0x5208';
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1', timestamp: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x1';
      if (m === 'eth_getTransactionByHash') return { hash: p[0] };
      throw new Error(m);
    };
    const s = new EvmSender(chain as any, rpc as any);
    const late: { kind: string; state: string; addr: string; nonce: number }[] = [];
    s.onLateOutcome = (rec, o, kind) => { late.push({ kind, state: o.state, addr: rec.addr, nonce: rec.nonce }); };
    const r = await s.send(acct, { to: EVM as `0x${string}`, data: '0x', value: 0n } as any);
    return { s, r, late, outcome: await s.awaitOutcome(r.hash, 1_000) };
  }
  it('no status → a late "ghost" outcome with the address and nonce, the address is blocked, awaitOutcome → expired', async () => {
    const x = await sendWith(NO_STATUS);
    expect(x.r.pending).toBe(true);
    expect(x.late).toEqual([{ kind: 'ghost', state: 'mined', addr: acct.address.toLowerCase(), nonce: x.r.nonce! }]);
    expect(x.s.hasPending(acct.address)?.ghost).toBe(true);
    expect(x.outcome.state).toBe('expired');
  });
  it('0x1 and 0x0 → as before: mined to the caller, no late outcome and no block', async () => {
    for (const st of ['0x1', '0x0']) {
      const x = await sendWith(st);
      expect(x.late, st).toEqual([]); expect(x.s.hasPending(acct.address), st).toBeUndefined(); expect(x.outcome.state, st).toBe('mined');
    }
  });
});

describe('#135 finishing: the buy refusal text for a receipt without a status (trader.ts:187)', () => {
  it('a receipt exists, the status is unreadable → not "no receipt yet" but "receipt status unreadable", pending', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const TOKEN = '0x3333333333333333333333333333333333333333';
    const R = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
    const me = '0x' + '0'.repeat(24) + W.evmTreasury.address.slice(2).toLowerCase();
    const kyber = { async swap(p: any) { return { to: R as `0x${string}`, data: '0xe21fd0e9' as `0x${string}`, value: p.amountIn, amountIn: p.amountIn, amountOut: 5n * 10n ** 18n, minOut: 4n * 10n ** 18n, router: R }; } };
    const f: typeof fetch = (async (_u: any, init: any) => {
      const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
      if (b.method === 'eth_call') return res('0x' + (18).toString(16).padStart(64, '0'));
      if (b.method === 'eth_gasPrice') return res('0x1');
      if (b.method === 'eth_getBalance') return res('0x' + (10n ** 20n).toString(16));
      if (b.method === 'eth_simulateV1') return res([{ calls: [{ status: '0x1', gasUsed: '0x5208', logs: [{ address: TOKEN, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '1'.repeat(64), me], data: '0x' + (5n * 10n ** 18n).toString(16) }] }] }]);
      throw new Error(b.method);
    }) as any;
    const t = new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, kyber, fetchImpl: f });
    (t.sender('base') as any).send = async () => ({ hash: H, receipt: receiptWith(NO_STATUS), ok: false, pending: true, acceptedBy: ['lane0'], ms: { sign: 0 } });
    const r = await t.buyToken({ chain: 'base', token: TOKEN, sizeUsd: 2 }, 'live');
    expect(r.ok).toBe(false); expect(r.pending).toBe(true); expect(r.tx).toBe(H);
    expect(r.note).toMatch(/^tx mined, receipt status unreadable \(null\): 0xc+ — outcome unknown/); expect(r.note).not.toMatch(/no receipt yet/);
  });
});

describe('#135: trader.ts settleTx and settleBuy — receipt status', () => {
  it('settleTx: a receipt without a status → unknown (not failed); 0x0 → failed; 0x1 → ok', async () => {
    expect(await trader(NO_STATUS).settleTx('base', H)).toBe('unknown');
    expect(await trader(null).settleTx('base', H)).toBe('unknown');
    expect(await trader('0x0').settleTx('base', H)).toBe('failed');
    expect(await trader('0x1').settleTx('base', H)).toBe('ok');
  });

  it('settleBuy: a receipt without a status → "in flight" (pending), not "reverted"; 0x0 → reverted without pending', async () => {
    const args = { chain: 'base' as const, token: EVM, sizeUsd: 2, tx: H, decimals: 18 };
    const u = await trader(NO_STATUS).settleBuy(args);
    expect(u.ok).toBe(false); expect(u.pending).toBe(true); expect(u.note).toMatch(/receipt status unreadable/); expect(u.note).not.toMatch(/reverted/);
    const r = await trader('0x0').settleBuy(args);
    expect(r.ok).toBe(false); expect(r.pending).toBe(false); expect(r.note).toBe('reverted');
  });
});

describe('#135: through the executor — an unreadable status does not turn into a failure', () => {
  const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-16T08:00:00.000Z', text: 'ape' };
  const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
  const buy = (): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust, estGasUsd: 0.02,
    intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM },
    check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
    exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-17T08:00:00.000Z' } } as any);
  function executor() {
    const clock = new VirtualClock(Date.UTC(2026, 10, 16, 8));
    const store = new Store(':memory:');
    const risk = new RiskState(DEFAULT_RISK, clock);
    const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock);
    paper.liveMode = 'live';
    return { paper, risk };
  }

  it('sale: a receipt without a status → no second sale, the sale stays "in flight"', async () => {
    const { paper } = executor();
    const real = trader(NO_STATUS);
    let sells = 0;
    paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: HB, note: 'got' }; },
      // This is how the trader now answers for a receipt without a status (evm.ts: pending) — the sale is "in flight"
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, note: `sell pending: ${H}` }; },
      settleTx: (c: any, tx: string, o: any) => real.settleTx(c, tx, o) } as any;
    await paper.execute(MSG, buy(), 1);
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
    await paper.monitor(market, { tokensOnly: true });
    expect(sells).toBe(1);
    await tick(100); // the settleTx polls are done
    await paper.monitor(market, { tokensOnly: true });
    expect(sells).toBe(1);
    expect(paper.inFlight()).toEqual([`sale base:${EVM.toLowerCase()} ${H.slice(0, 10)}… (outcome unknown)`]);
  });

  it('buy: a receipt without a status → the reserve is not released, the position is not recorded as a failure; no repeat buy', async () => {
    const { paper, risk } = executor();
    const real = trader(NO_STATUS);
    let buys = 0;
    paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { buys++; return { ok: false, pending: true, mode: 'live', qty: 0, raw: 0n, decimals: 18, spentUsd: 0, tx: H, note: `tx pending: ${H}` }; },
      settleBuy: (a: any) => real.settleBuy(a) } as any;
    await expect(paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
    await tick(100);
    expect(paper.pendingBuyUsd()).toBeGreaterThan(2);
    expect(paper.inFlight()).toEqual([expect.stringMatching(/^buy base:0x4444.* \(reserve \$[\d.]+, outcome unknown\)$/)]);
    expect(risk.positions).toEqual([]);
    await expect(paper.execute(MSG, buy(), 2)).rejects.toThrow(/still pending/);
    expect(buys).toBe(1);
  });
});
