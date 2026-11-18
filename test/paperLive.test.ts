// E-10: the executor in live. Auto events are off (the monitor is called by hand), time is virtual.
import { describe, it, expect, vi } from 'vitest';
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
const base = (o: Partial<Decision>): Decision => ({ action: 'skip', sizeUsd: 0, chain: 'base', reasons: [], trust, intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: TOKEN }, ...o });
const buy = (sizeUsd = 2, token = TOKEN): Decision => base({ action: 'buy_token', sizeUsd, estGasUsd: 0.02, intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: token },
  check: { ok: true, chain: 'base', address: token, priceUsd: 0.001, reasons: [] }, exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-10-30T08:00:00.000Z' } });

function setup() {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t) { sent.push(t); } }, clock);
  paper.liveMode = 'live';
  const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.001 }; }, async rug() { return undefined; } };
  return { clock, store, risk, paper, sent, market };
}

describe('E-10 blocker 3: in live, actions without a live executor never touch the risk ledger', () => {
  it('open_perp / prediction_buy / dapp_session / paper NFT mint / nft_buy without live NFT → execution blocked, equity, cash and positions unchanged', async () => {
    const e = setup();
    e.paper.trader = { async buyToken() { throw new Error('must not be called'); } } as any;
    const cash0 = e.risk.cashUsd, eq0 = e.risk.equityUsd;
    const perp = base({ action: 'open_perp', sizeUsd: 1, chain: 'unknown', perp: { asset: 'BTC', side: 'long', entry: 100, notionalUsd: 3, leverage: 3, marginUsd: 1, stop: 97, takeProfit: 106, feePct: 0.05 } });
    const pred = base({ action: 'prediction_buy', sizeUsd: 1, chain: 'polygon', prediction: { slug: 's', question: 'q', outcome: 'Yes', tokenId: '1', shares: 2, price: 0.5, feeRate: 0, endUtc: '2026-11-01T00:00:00.000Z' } as any });
    const dapp = base({ action: 'dapp_session', sizeUsd: 1, estGasUsd: 0.02 });
    const mint = base({ action: 'contract_call', sizeUsd: 1, estGasUsd: 0.02, nft: { slug: 'drop', contract: '0x' + '5'.repeat(40), priceEth: 0.0004, sellFeesPct: 5, plan: { style: 'flip' } } as any });
    const nftBuy = base({ action: 'nft_buy', sizeUsd: 1, estGasUsd: 0.02, nftBuy: { slug: 'col', contract: '0x' + '5'.repeat(40), priceEth: 0.0004, sellFeesPct: 5, plan: { style: 'flip' } } as any });
    for (const d of [perp, pred, dapp, mint, nftBuy]) {
      await expect(e.paper.execute(MSG, d, 1)).rejects.toThrow(/journal only/);
    }
    expect(e.risk.cashUsd).toBe(cash0); expect(e.risk.equityUsd).toBe(eq0); expect(e.risk.positions.length).toBe(0);
    expect(e.store.openPositions().length).toBe(0);
    expect(e.paper.perpOpen.size + e.paper.predOpen.size + e.paper.nftOpen.size).toBe(0);
  });
  it('in paper mode the same decisions still open paper positions (no regression)', async () => {
    const e = setup(); e.paper.liveMode = 'paper';
    const perp = base({ action: 'open_perp', sizeUsd: 1, chain: 'unknown', perp: { asset: 'BTC', side: 'long', entry: 100, notionalUsd: 3, leverage: 3, marginUsd: 1, stop: 97, takeProfit: 106, feePct: 0.05 } });
    await e.paper.execute(MSG, perp, 1);
    expect(e.paper.perpOpen.size).toBe(1);
  });
});

describe('E-10 item 6: a live buy "in flight" reserves cash and blocks a second buy of the same token until it settles', () => {
  it('pending buy → second signal refused, cash reserved; after settle the position opens once', async () => {
    const e = setup();
    let settle!: (r: any) => void;
    const settled = new Promise<any>(r => { settle = r; });
    let buys = 0;
    e.paper.trader = {
      async buyToken() { buys++; return { ok: false, pending: true, tx: '0x' + 'a'.repeat(64), qty: 0, raw: 0n, decimals: 18, spentUsd: 0, mode: 'live', note: 'tx pending' }; },
      settleBuy: () => settled,
    } as any;
    await expect(e.paper.execute(MSG, buy(2), 1)).rejects.toThrow(/pending .* position will be recorded/);
    expect(e.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5);
    // the same token again — the second buy does not go out
    await expect(e.paper.execute(MSG, buy(2), 2)).rejects.toThrow(/still pending .* not buying twice/);
    expect(buys).toBe(1);
    // another token within the level cap ($5), but cash net of the reserve does not allow it ($6 − 2.01 reserve < 4.5)
    const other = '0x' + '7'.repeat(40);
    e.risk.cashUsd = 6;
    await expect(e.paper.execute(MSG, buy(4.5, other), 3)).rejects.toThrow(/cash reserved by pending buys/);
    expect(buys).toBe(1);
    // the buy landed in a block → one position, reserve released
    settle({ ok: true, mode: 'live', qty: 2000, raw: 2000n * 10n ** 18n, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'late: got 2000' });
    await new Promise(r => setTimeout(r, 20));
    expect(e.paper.pendingBuyUsd()).toBe(0);
    expect(e.risk.positions.length).toBe(1);
    expect(e.store.openPositions().length).toBe(1);
  });
  it('M-3: unknown outcome is polled up to 3×10 min on EVM (18×10 on Solana); still unknown → token blocked and cash reserved; a late receipt opens the position; a dropped tx frees both', async () => {
    const pend = { ok: false, pending: true, mode: 'live', qty: 0, raw: 0n, decimals: 0, spentUsd: 0, tx: '0x' + 'a'.repeat(64), note: 'still no receipt after 10 min' };
    const mk = (outcomes: any[]) => ({
      async buyToken() { return { ok: false, pending: true, tx: '0x' + 'a'.repeat(64), qty: 0, raw: 0n, decimals: 18, spentUsd: 0, mode: 'live', note: 'tx pending' }; },
      calls: 0, lastFlags: [] as boolean[], async settleBuy(a: any) { this.calls++; this.lastFlags.push(!!a.last); return outcomes.length > 1 ? outcomes.shift() : outcomes[0]; },
    });
    // 1) always unknown → 3 polls of 10 min (wait limit 30 min, the owner's decision 2026-11-11), the reserve and the block stay
    const e = setup(); const tr = mk([pend]); e.paper.trader = tr as any;
    await expect(e.paper.execute(MSG, buy(2), 1)).rejects.toThrow(/pending/);
    await new Promise(r => setTimeout(r, 50));
    expect(tr.calls).toBe(3);
    expect(tr.lastFlags).toEqual([false, false, true]); // the last poll hands the outcome to the sender's background
    expect(e.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5);
    await expect(e.paper.execute(MSG, buy(2), 2)).rejects.toThrow(/still pending .* not buying twice/);
    expect(e.sent.some(t => /within 30 min/.test(t))).toBe(true);
    // 2) the receipt came on the third poll — position recorded, reserve released
    const e2 = setup(); e2.paper.trader = mk([pend, pend, { ok: true, mode: 'live', qty: 2000, raw: 2000n * 10n ** 18n, decimals: 18, spentUsd: 2.02, tx: pend.tx, note: 'late: got 2000' }]) as any;
    await expect(e2.paper.execute(MSG, buy(2), 1)).rejects.toThrow(/pending/);
    await new Promise(r => setTimeout(r, 50));
    expect(e2.paper.pendingBuyUsd()).toBe(0); expect(e2.risk.positions.length).toBe(1);
    // 3) dropped — reserve released, no position
    const e3 = setup(); e3.paper.trader = mk([{ ...pend, pending: false, note: 'dropped: no node knows the tx' }]) as any;
    await expect(e3.paper.execute(MSG, buy(2), 1)).rejects.toThrow(/pending/);
    await new Promise(r => setTimeout(r, 50));
    expect(e3.paper.pendingBuyUsd()).toBe(0); expect(e3.risk.positions.length).toBe(0);
  });
});

describe('E-10 blocker 1 (executor side): an approve in flight is not a sale', () => {
  it('monitor: sell result with approveTx only (no pending/tx) leaves the position open, cash unchanged, one notification per reason', async () => {
    const e = setup();
    let sells = 0;
    e.paper.trader = {
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: 2000n * 10n ** 18n, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 0, note: 'approve pending 0xdead — sell retried after it confirms', approveTx: '0x' + 'd'.repeat(64) }; },
    } as any;
    await e.paper.execute(MSG, buy(2), 1);
    expect(e.risk.positions.length).toBe(1);
    const cash = e.risk.cashUsd;
    // the price fell below the stop → the monitor tries to sell; approve "in flight" — the position stays, the money is not "returned"
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0005 }; }, async rug() { return undefined; } };
    await e.paper.monitor(market, { tokensOnly: true });
    await e.paper.monitor(market, { tokensOnly: true });
    await e.paper.monitor(market, { tokensOnly: true });
    expect(sells).toBe(3);
    expect(e.risk.positions.length).toBe(1); expect(e.risk.cashUsd).toBe(cash);
    expect(e.store.openPositions().length).toBe(1);
    expect(e.sent.filter(t => /did not go through/.test(t)).length).toBe(1); // the same reason — one message
  });
});

describe('E-10 round 2: a Telegram failure while resolving a sale outcome does not crash the process or lose the position', () => {
  it('settleTx → unknown, the notifier throws → the position is frozen for an hour, the exception is caught', async () => {
    const e = setup();
    e.paper.trader = {
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: 2000n * 10n ** 18n, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
      async sellToken() { return { ok: false, mode: 'live', proceedsUsd: 1, pending: true, tx: '0x' + 'c'.repeat(64), soldRaw: 2000n * 10n ** 18n, note: 'sell pending' }; },
      async settleTx() { return 'unknown'; },
    } as any;
    await e.paper.execute(MSG, buy(2), 1);
    let boom = 0;
    (e.paper as any).notifier = { async send(t: string) { if (/within 30 min|without a receipt/.test(t)) { boom++; throw new Error('telegram down'); } e.sent.push(t); } };
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0005 }; }, async rug() { return undefined; } };
    const unhandled: unknown[] = []; const h = (r: unknown) => unhandled.push(r); process.on('unhandledRejection', h);
    try {
      await e.paper.monitor(market, { tokensOnly: true });
      await new Promise(r => setTimeout(r, 50));
      expect(boom).toBeGreaterThan(0);
      expect(unhandled.length).toBe(0); // nothing leaked upwards — the process is alive
      const pos = [...e.paper.open.values()][0];
      expect(pos).toBeDefined(); expect(pos.exitingUntilMs).toBeGreaterThan(e.clock.now()); // the position is alive and frozen
    } finally { process.off('unhandledRejection', h); }
  });
});

describe('E-10 round 3: a swap rejected by all nodes, and late outcomes in the executor', () => {
  const R = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const w64 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
  const topicAddr = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();

  it('item 4 (PaperExecutor + LiveTrader): a sale rejected by all nodes — one message with the reason, without "⏳ sent" and "did not reach the network" every 50 s', async () => {
    const { LiveTrader } = await import('../src/live/trader.js');
    const { Wallets, newKeyMaterial } = await import('../src/live/keystore.js');
    const e = setup();
    const W = new Wallets(newKeyMaterial(0)); const me = W.evmTreasury.address; const amount = 2000n * 10n ** 18n;
    const sent: string[] = [];
    const kyber = { async swap(p: any) { return { to: R as `0x${string}`, data: '0xe21fd0e9' as `0x${string}`, value: 0n, amountIn: p.amountIn, amountOut: 10n ** 15n, minOut: 9n * 10n ** 14n, router: R }; } };
    const f: typeof fetch = async (_u: any, init: any) => {
      const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ result }));
      switch (b.method) {
        case 'eth_call': { const sel = String(b.params[0].data).slice(0, 10);
          if (sel === '0x70a08231') return res(w64(amount)); if (sel === '0xdd62ed3e') return res(w64(amount)); if (sel === '0x313ce567') return res(w64(18n)); throw new Error(sel); }
        case 'eth_gasPrice': return res('0x1');
        case 'eth_simulateV1': return res([{ calls: [{ status: '0x1', gasUsed: '0x5208', logs: [{ address: TOKEN, topics: [T, topicAddr(me), topicAddr(R)], data: w64(amount) }, { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [T, topicAddr(R), topicAddr(me)], data: w64(10n ** 15n) }] }] }]);
        case 'eth_getBlockByNumber': return res({ baseFeePerGas: '0x1' });
        case 'eth_maxPriorityFeePerGas': return res('0x1');
        case 'eth_getTransactionCount': return res('0x3');
        case 'eth_sendRawTransaction': { sent.push(b.params[0]); return new Response(JSON.stringify({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } })); }
        case 'eth_getTransactionReceipt': return res(null);
        case 'eth_getTransactionByHash': return res(null);
        default: throw new Error(b.method);
      }
    };
    const trader = new LiveTrader({ wallets: W, chains: { base: { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } } as any, nativeUsd: async () => 4000, slippageBps: 500, kyber, fetchImpl: f });
    trader.buyToken = (async () => ({ ok: true, mode: 'live', qty: 2000, raw: amount, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' })) as any;
    e.paper.trader = trader;
    await e.paper.execute(MSG, buy(2), 1);
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0005 }; }, async rug() { return undefined; } };
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 4; i++) { const m = e.paper.monitor(market, { tokensOnly: true }); await vi.advanceTimersByTimeAsync(15_000); await m; }
      const msgs = e.sent.filter(t => /sale|Sale/.test(t));
      expect(msgs.some(t => /insufficient funds/.test(t))).toBe(true); // the reason is visible
      expect(msgs.some(t => /sent \(/.test(t))).toBe(false); // this is not a "sale in flight"
      expect(msgs.some(t => /did not reach the network/.test(t))).toBe(false);
      expect(msgs.filter(t => /did not go through/.test(t)).length).toBe(1); // one reason — one message (dedup by reason without the hash)
      expect(e.risk.positions.length).toBe(1); // the position is in place
      expect(sent.length).toBeGreaterThanOrEqual(1);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('a late buy receipt after the wait limit (via the executor subscription) records the position, releases the reserve and the ghost', async () => {
    const e = setup();
    let handler: any;
    const RAW = 2000n * 10n ** 18n;
    e.paper.trader = {
      setLateOutcomeHandler(h: any) { handler = h; },
      clearGhostCalls: 0, clearGhost() { this.clearGhostCalls++; },
      async buyToken() { return { ok: false, pending: true, tx: '0x' + 'a'.repeat(64), qty: 0, raw: 0n, decimals: 18, spentUsd: 0, mode: 'live', note: 'tx pending' }; },
      async settleBuy() { return { ok: false, pending: true, mode: 'live', qty: 0, raw: 0n, decimals: 0, spentUsd: 0, tx: '0x' + 'a'.repeat(64), note: 'stuck' }; },
      async buyFromLateReceipt() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'late: got 2000' }; },
    } as any;
    expect(handler).toBeDefined(); // the trader setter subscribed the executor
    await expect(e.paper.execute(MSG, buy(2), 1)).rejects.toThrow(/pending/);
    await new Promise(r => setTimeout(r, 50));
    expect(e.paper.pendingBuyUsd()).toBeCloseTo(2.01, 5); // all polls "unknown" → the reserve stayed
    handler({ chain: 'base', hash: '0x' + 'a'.repeat(64), addr: 'x', nonce: 3, kind: 'expired', receipt: { status: '0x1' } });
    await new Promise(r => setTimeout(r, 20));
    expect(e.risk.positions.length).toBe(1); expect(e.paper.pendingBuyUsd()).toBe(0);
    expect((e.paper.trader as any).clearGhostCalls).toBe(1);
    expect(e.sent.some(t => /Late receipt.*position recorded/.test(t))).toBe(true);
    // an outcome without a pair in the ledger — only an alarm
    handler({ chain: 'base', hash: '0x' + 'e'.repeat(64), addr: 'x', nonce: 9, kind: 'ghost', receipt: { status: '0x1' } });
    await new Promise(r => setTimeout(r, 20));
    expect(e.sent.some(t => /it has no pair in the ledger/.test(t))).toBe(true);
  });
});
