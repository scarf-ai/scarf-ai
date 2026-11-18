// #135 F3: a hold on a sale "in flight" survives a restart. The record is in the position state in the database; restore() holds the position and
// checks the outcome by hash once: ok — count once, an explicit failure — lift the hold, unknown — hold and tell the owner.
import { describe, it, expect, vi } from 'vitest';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const H = '0x' + 'c'.repeat(64);
const EVM = '0x4444444444444444444444444444444444444444';
const RAW = 2000n * 10n ** 18n;
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-17T08:00:00.000Z', text: 'ape' };
const buy = (): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] }, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM },
  check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-18T08:00:00.000Z' } } as any);
const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };

/** First run: a buy, the TP1 sale goes "in flight" and no outcome comes. Then — a "restart" on the same database. */
async function world() {
  const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = [];
  const mk = () => { const p = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t: string) { sent.push(t); } }, clock); p.liveMode = 'live'; return p; };
  const calls = { sells: 0, settles: [] as string[] };
  const trader = (settle: () => string) => ({ setLateOutcomeHandler() {}, clearGhost() {},
    async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
    async sellToken() { calls.sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, note: 'sell pending' }; },
    async settleTx(_c: string, tx: string) { calls.settles.push(tx); return settle(); } }) as any;
  const p1 = mk(); p1.trader = trader(() => 'unknown');
  await p1.execute(MSG, buy(), 1);
  await p1.monitor(market, { tokensOnly: true }); await tick(150);
  expect(calls.sells).toBe(1);
  const restart = async (settle: () => string) => { const p2 = mk(); p2.trader = trader(settle); calls.settles = []; p2.restore(); await tick(); return p2; };
  return { store, risk, sent, calls, restart, clock };
}

describe('#135 F3: a sale "in flight" — in the database', () => {
  it('a sent sale is recorded in the position state (hash, quantity, position chain, after); after counting — removed', async () => {
    const w = await world();
    const st = JSON.parse(w.store.openPositions()[0].state);
    expect(st.sellsInFlight).toEqual([expect.objectContaining({ tx: H, qty: 1000, soldRaw: (RAW / 2n).toString(), reason: expect.stringMatching(/take-profit|ladder|tp/i) })]);
    expect(st.chain).toBe('base');
    const p2 = await w.restart(() => 'ok');
    const row = w.store.openPositions()[0];
    expect(JSON.parse(row.state).sellsInFlight).toBeUndefined();
    expect(row.qty_left).toBe(1000);
    expect(p2.inFlight()).toEqual([]);
  });
});

describe('#135 F3: restart', () => {
  it('outcome unknown → the position is sold neither by the monitor (even after 61 min) nor by exitToken; a message to the owner; the hash is checked once', async () => {
    const w = await world();
    const p2 = await w.restart(() => 'unknown');
    expect(w.calls.settles).toEqual([H]);
    await p2.monitor(market, { tokensOnly: true });
    w.clock.advance(61 * 60_000);
    await p2.monitor(market, { tokensOnly: true });
    expect(await p2.exitToken(EVM, 'manual', market)).toBe(false);
    expect(w.calls.sells).toBe(1);
    expect(w.sent.find(t => /After restart: sale .* tx 0xc+ — outcome unknown, check the wallet; not touching the position/.test(t))).toBeDefined();
    expect(p2.inFlight()).toEqual([`sale base:${EVM} ${H.slice(0, 10)}…`]);
  });

  it('landed (ok) → the sale is counted once (remainder 1000, proceeds $2.50 in cash); the step is not sold again', async () => {
    const w = await world();
    const cash0 = w.risk.cashUsd;
    const p2 = await w.restart(() => 'ok');
    expect(w.risk.cashUsd - cash0).toBeCloseTo(2.5, 6);
    await p2.monitor(market, { tokensOnly: true });
    expect(w.calls.sells).toBe(1);
    expect(w.sent.find(t => /After restart: sale .* landed in a block — counted once/.test(t))).toBeDefined();
  });

  it('an explicit failure (0x0) → the hold is lifted, the monitor sells the step again — once', async () => {
    const w = await world();
    const p2 = await w.restart(() => 'failed');
    expect(JSON.parse(w.store.openPositions()[0].state).sellsInFlight).toBeUndefined();
    await p2.monitor(market, { tokensOnly: true });
    expect(w.calls.sells).toBe(2);
  });

  it('Solana: a record removed after the wait limit (the previous Solana rule) is removed in the database too — a restart does not hold it', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const store = new Store(':memory:'); const risk = new RiskState(DEFAULT_RISK, clock);
    const p = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p.liveMode = 'live';
    let settles = 0;
    p.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 9, spentUsd: 2.02, tx: 'SIGB', note: 'got' }; },
      async sellToken() { return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: 'SIG1', soldRaw: RAW / 2n, note: 'send: may still land' }; },
      async settleTx() { settles++; return 'unknown'; } } as any;
    const d = buy(); d.chain = 'solana'; d.intent.chain = 'solana'; (d.check as any).chain = 'solana';
    await p.execute(MSG, d, 1);
    const sol: MarketClient = { async market() { return { chain: 'solana', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
    await p.monitor(sol, { tokensOnly: true }); await tick(80);
    expect(settles).toBe(18);
    expect(JSON.parse(store.openPositions()[0].state).sellsInFlight).toBeUndefined();
    const p2 = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p2.liveMode = 'live'; p2.trader = p.trader; p2.restore(); await tick();
    expect(settles).toBe(18); expect(p2.inFlight()).toEqual([]);
  });

  it('without a sale record the restart checks nothing and holds nothing (as before)', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const store = new Store(':memory:'); const risk = new RiskState(DEFAULT_RISK, clock);
    let settles = 0;
    const p = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p.liveMode = 'live';
    p.trader = { setLateOutcomeHandler() {}, clearGhost() {}, async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
      async settleTx() { settles++; return 'ok'; } } as any;
    await p.execute(MSG, buy(), 1);
    const p2 = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p2.liveMode = 'live'; p2.trader = p.trader; p2.restore(); await tick();
    expect(settles).toBe(0); expect(p2.inFlight()).toEqual([]);
  });
});

// ── #135 F3, tail: the sale nonce in the database — after a restart the sender decides "dropped / replaced" by hash AND nonce ──────────────
describe('#135 F3: the sale nonce survives a restart', () => {
  const chainCfg = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;
  function realTrader(o: { latest: number; known: boolean }) {
    const f: typeof fetch = (async (_u: any, init: any) => {
      const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
      if (b.method === 'eth_getTransactionCount') return res('0x' + o.latest.toString(16));
      if (b.method === 'eth_getTransactionReceipt') return res(null);
      if (b.method === 'eth_getTransactionByHash') return res(o.known ? { hash: b.params[0] } : null);
      throw new Error(b.method);
    }) as any;
    return new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: { base: chainCfg } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
  }
  const FROM = '0x' + '7'.repeat(40);

  it('trader: the nonce slot is taken by another transaction on all nodes, no receipt of ours → dropped', async () => {
    vi.useFakeTimers();
    try {
      const t = realTrader({ latest: 5, known: false });
      const p = t.settleRestored('base', H, FROM, 3); await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(await p).toBe('dropped');
    } finally { vi.useRealTimers(); }
  });

  it('trader: the nonce is not taken yet, the transaction is in the node pool → unknown; the record is handed to the background, the address is blocked', async () => {
    vi.useFakeTimers();
    try {
      const t = realTrader({ latest: 3, known: true });
      const p = t.settleRestored('base', H, FROM, 3); await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(await p).toBe('unknown');
      expect(t.sender('base')!.hasPending(FROM)?.hash).toBe(H);
      expect(t.sender('base')!.pendingTx.get(H)?.handedOver).toBe('expired');
    } finally { vi.useRealTimers(); }
  });

  async function restartWorld(settle: string) {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const store = new Store(':memory:'); const risk = new RiskState(DEFAULT_RISK, clock);
    let sells = 0; const restored: unknown[][] = [];
    const tr = () => ({ setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: sells === 1 ? H : '0x' + 'd'.repeat(64), soldRaw: RAW / 2n, note: 'sell pending', nonce: 3, from: FROM }; },
      async settleTx() { return 'unknown'; },
      async settleRestored(...a: unknown[]) { restored.push(a); return settle; } }) as any;
    const p1 = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p1.liveMode = 'live'; p1.trader = tr();
    await p1.execute(MSG, buy(), 1);
    await p1.monitor(market, { tokensOnly: true }); await tick(150);
    expect(JSON.parse(store.openPositions()[0].state).sellsInFlight[0]).toMatchObject({ tx: H, nonce: 3, from: FROM });
    const p2 = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p2.liveMode = 'live'; p2.trader = tr(); p2.restore(); await tick();
    return { p2, restored, sells: () => sells };
  }

  it('executor: after a restart the outcome is checked by the saved nonce and address; dropped → the hold is lifted, exactly one new sale', async () => {
    const w = await restartWorld('dropped');
    expect(w.restored).toEqual([['base', H, FROM, 3]]);
    await w.p2.monitor(market, { tokensOnly: true });
    await w.p2.monitor(market, { tokensOnly: true });
    expect(w.sells()).toBe(2);
  });

  it('executor: unknown (nonce not taken) → we hold, no new sale', async () => {
    const w = await restartWorld('unknown');
    await w.p2.monitor(market, { tokensOnly: true });
    expect(w.sells()).toBe(1);
  });
});

// ── Review F3, round 3: Solana after a restart — the running-process rule (3 h from sending), not a hold forever ─────────
describe('#135 F3: a Solana sale raised after a restart', () => {
  const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
  const SIG = '5'.repeat(88);
  async function solWorld(sentAgoMs: number, settle: string) {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 12));
    const store = new Store(':memory:'); const risk = new RiskState(DEFAULT_RISK, clock);
    const sent: string[] = []; let calls = 0, sells = 0;
    store.savePosition({ id: 'p1', decisionId: 1, chain: 'solana', token: MINT, costUsd: 2, qty: 2000, entryPrice: 0.001, openedUtc: clock.iso(), mode: 'live',
      state: { id: 'p1', chain: 'solana', token: MINT, symbol: 'MEME', qty: 2000, qtyLeft: 2000, costUsd: 2, entry: 0.001, openedAtMs: clock.now() - 6 * 3600_000,
        stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-19T08:00:00.000Z', peakPrice: 0.001,
        sellsInFlight: [{ tx: SIG, qty: 1000, proceeds: 2.5, reason: 'take-profit 1', price: 0.0025, sentUtc: new Date(clock.now() - sentAgoMs).toISOString() }] } });
    const p = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t: string) { sent.push(t); } }, clock); p.liveMode = 'live';
    p.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 0, note: 'x' }; },
      async settleTx() { calls++; return settle; } } as any;
    const cash0 = risk.cashUsd;
    p.restore(); await tick(80);
    return { p, store, sent, clock, calls: () => calls, sells: () => sells, cash0, risk };
  }
  const sol: MarketClient = { async market() { return { chain: 'solana', priceUsd: 0.0001 }; }, async rug() { return undefined; } }; // crash — stop

  it('sent 5 h ago, the signature is not found → one check, the hold is lifted (in the database too), not touched for an hour, then one sale', async () => {
    const w = await solWorld(5 * 3600_000, 'unknown');
    expect(w.calls()).toBe(1);
    expect(JSON.parse(w.store.openPositions()[0].state).sellsInFlight).toBeUndefined();
    expect(w.sent.at(-1)).toMatch(/After restart: sale MEME tx 5+ was not confirmed within 3 h of sending .* I will not touch the position for an hour, then the monitor will sell again/);
    await w.p.monitor(sol, { tokensOnly: true }); expect(w.sells()).toBe(0);
    w.clock.advance(61 * 60_000);
    await w.p.monitor(sol, { tokensOnly: true }); expect(w.sells()).toBe(1);
  });

  it('sent 1 h ago → checked until 3 h from sending (12 polls of 10 min), then lifted', async () => {
    const w = await solWorld(3600_000, 'unknown');
    expect(w.calls()).toBe(12);
    expect(w.sent[0]).toMatch(/outcome still unknown, watching until 14:00 UTC \(3 h from sending\)/);
    expect(w.p.inFlight()).toEqual([]);
  });

  it('found in history: confirmed → the sale is counted once; a revert (err) → the hold is lifted without counting', async () => {
    const ok = await solWorld(5 * 3600_000, 'ok');
    expect(ok.risk.cashUsd - ok.cash0).toBeCloseTo(2.5, 6); expect(ok.store.openPositions()[0].qty_left).toBe(1000);
    expect(ok.sent.some(t => /landed in a block — counted once/.test(t))).toBe(true);
    const bad = await solWorld(5 * 3600_000, 'failed');
    expect(bad.risk.cashUsd).toBe(bad.cash0); expect(bad.p.inFlight()).toEqual([]);
    expect(JSON.parse(bad.store.openPositions()[0].state).sellsInFlight).toBeUndefined();
  });
});
