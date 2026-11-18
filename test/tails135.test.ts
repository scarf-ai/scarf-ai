// Incoming #135 items 2–4: a token post without a CA does not go out; the actual buy spend on Solana; a Solana sale without an outcome in inFlight().
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { LiveTrader } from '../src/live/trader.js';
import { SolSender } from '../src/live/jupiter.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const EVM = '0x4444444444444444444444444444444444444444';
const SOL = '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: 'ape' };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (chain: string, token: string): Decision => ({ action: 'buy_token', sizeUsd: 2, chain, reasons: [], trust, estGasUsd: 0.02, publicNote: 'Liquidity is real.',
  intent: { kind: 'token_call', chain, urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: token, ticker: 'TKN' },
  check: { ok: true, chain, address: token, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-10-30T08:00:00.000Z' } } as any);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

function setup() {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t) { sent.push(t); } }, clock);
  const market = (priceUsd: number, chain: string): MarketClient => ({ async market() { return { chain: chain as any, priceUsd }; }, async rug() { return undefined; } });
  const drafts = () => sent.filter(t => t.startsWith('🐦 Post draft ('));
  return { clock, risk, paper, sent, market, drafts };
}

describe('#135 item 2: a token entry or exit post without a CA line is not created', () => {
  it('a Solana address on an EVM chain: the position is opened and closed, no posts, the owner gets a message with the reason — for both entry and exit', async () => {
    const e = setup();
    const errs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await e.paper.execute(MSG, buy('base', SOL), 1);
      expect(e.paper.open.size).toBe(1); // the trade happened — only the post is forbidden
      expect(e.drafts().length).toBe(0);
      expect(e.sent.at(-1)).toBe(`🐦 Trade post $TKN (entry) not created: contract address «${SOL}» does not fit chain base. A token post without a CA is not published — check the trade's chain.`);
      await e.paper.monitor(e.market(0.0002, 'base'), { tokensOnly: true });
      expect(e.paper.open.size).toBe(0);
      expect(e.drafts().length).toBe(0);
      expect(e.sent.at(-1)).toMatch(/Trade post \$TKN \(exit\) not created: contract address .*. does not fit chain base/);
      expect(errs.mock.calls.filter(c => /post not created/.test(String(c[0]))).length).toBe(2);
    } finally { errs.mockRestore(); }
  });

  it('an EVM address on the solana chain — refused too; the event does not reach the post queue', async () => {
    const e = setup();
    const queued: unknown[] = [];
    e.paper.poster = { async queue(ev: unknown) { queued.push(ev); } } as any;
    const errs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await e.paper.execute(MSG, buy('solana', EVM), 1);
      expect(queued.length).toBe(0);
      expect(e.sent.at(-1)).toMatch(/does not fit chain solana/);
    } finally { errs.mockRestore(); }
  });

  it('a correct address — the post goes out with the CA line, as before; posts without a token (perp) are not affected', async () => {
    const e = setup();
    await e.paper.execute(MSG, buy('base', EVM), 1);
    expect(e.drafts().length).toBe(1); expect(e.drafts()[0].endsWith(`\nCA: ${EVM} (base)`)).toBe(true);
    const perp: Decision = { action: 'open_perp', sizeUsd: 1, chain: 'unknown', reasons: [], trust, intent: { kind: 'perp_trade', chain: 'unknown', urls: [], summary: 's', stance: 'buy', confidence: 0.9 },
      perp: { asset: 'BTC', side: 'long', entry: 100, notionalUsd: 3, leverage: 3, marginUsd: 1, stop: 97, takeProfit: 106, feePct: 0.05 } } as any;
    await e.paper.execute(MSG, perp, 2);
    expect(e.drafts().length).toBe(2);
  });
});

describe('#135 item 3: a Solana buy — the actual spend from the transaction, not the decision size', () => {
  const OWNER = { toBase58: () => 'Owner1111111111111111111111111111111111111' };
  const OTHER = { toBase58: () => 'Other1111111111111111111111111111111111111' };
  const sender = (tx: unknown) => { const s = new SolSender('http://sol', []); (s as any).read = { async getTransaction() { return tx; } }; return s; };

  it('SolSender.spentLamportsInTx: pre − post on the owner account; v0 and the legacy format; no meta, no owner, a non-positive spend → undefined', async () => {
    const meta = { preBalances: [5_000_000_000, 70_000_000], postBalances: [4_984_660_000, 70_000_000] };
    expect(await sender({ meta, transaction: { message: { staticAccountKeys: [OWNER, OTHER] } } }).spentLamportsInTx('S', OWNER.toBase58())).toBe(15_340_000n);
    expect(await sender({ meta, transaction: { message: { accountKeys: [OTHER, OWNER] } } }).spentLamportsInTx('S', OTHER.toBase58())).toBe(15_340_000n);
    expect(await sender(null).spentLamportsInTx('S', OWNER.toBase58())).toBeUndefined();
    expect(await sender({ meta: null, transaction: { message: { staticAccountKeys: [OWNER] } } }).spentLamportsInTx('S', OWNER.toBase58())).toBeUndefined();
    expect(await sender({ meta, transaction: { message: { staticAccountKeys: [OTHER] } } }).spentLamportsInTx('S', OWNER.toBase58())).toBeUndefined();
    expect(await sender({ meta: { preBalances: [1], postBalances: [9] }, transaction: { message: { staticAccountKeys: [OWNER] } } }).spentLamportsInTx('S', OWNER.toBase58())).toBeUndefined();
    expect(await sender({ meta: { preBalances: [7], postBalances: [7] }, transaction: { message: { staticAccountKeys: [OWNER] } } }).spentLamportsInTx('S', OWNER.toBase58())).toBeUndefined();
  });

  function trader(solUsd: number | undefined) {
    const t = new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: {}, solRpc: { rpc: 'http://sol', send: [] }, nativeUsd: async () => solUsd, slippageBps: 500 });
    const sol: any = (t as any).sol;
    sol.settle = async () => 'ok';
    sol.receivedInTx = async () => 123_000n;
    (t as any).solDecimals = async () => 6;
    return { t, sol };
  }
  const args = { chain: 'solana' as const, token: 'Mint111111111111111111111111111111111111111', sizeUsd: 2, tx: 'SIG', decimals: 6 };

  it('a late buy: 0.01534 SOL left at $150 → spend $2.301 (swap + fee + account rent), not $2', async () => {
    const { t, sol } = trader(150);
    sol.spentLamportsInTx = async () => 15_340_000n;
    const r = await t.settleBuy(args);
    expect(r.ok).toBe(true); expect(r.spentUsd).toBeCloseTo(2.301, 6);
    expect(r.note).toBe('late: got 0.123 (spent 0.015340 SOL)');
    expect(r.spentUsd / r.qty).toBeCloseTo(2.301 / 0.123, 6); // the entry price — from the actual spend
  });

  it('the transaction is unreadable, the read throws or there is no SOL price → spend = the decision size, the buy is not broken, the reason in note', async () => {
    const a = trader(150); a.sol.spentLamportsInTx = async () => undefined;
    let r = await a.t.settleBuy(args); expect(r.ok).toBe(true); expect(r.spentUsd).toBe(2); expect(r.note).toMatch(/spent: decision size, tx not readable yet/);
    a.sol.spentLamportsInTx = async () => { throw new Error('rpc down'); };
    r = await a.t.settleBuy(args); expect(r.ok).toBe(true); expect(r.spentUsd).toBe(2); expect(r.note).toMatch(/spent: decision size, tx read failed: rpc down/);
    const b = trader(undefined); b.sol.spentLamportsInTx = async () => 15_340_000n;
    r = await b.t.settleBuy(args); expect(r.ok).toBe(true); expect(r.spentUsd).toBe(2); expect(r.note).toMatch(/spent: decision size, no SOL price/);
  });
});

describe('#135 item 4: a Solana sale without an outcome within the wait limit', () => {
  it('before the deadline it is visible in inFlight(); after the deadline the record is removed — it is not in the list, the owner gets "check the wallet manually"', async () => {
    const e = setup(); e.paper.liveMode = 'live';
    let settle!: (s: string) => void;
    e.paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: 2000n * 10n ** 6n, decimals: 6, spentUsd: 2.3, tx: 'SIGB', note: 'got' }; },
      async sellToken() { return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: 'SIGS', soldRaw: 1000n * 10n ** 6n, note: 'send: may still land' }; },
      settleTx: () => new Promise<string>(r => { settle = r; }) } as any;
    await e.paper.execute(MSG, buy('solana', SOL), 1);
    await e.paper.monitor(e.market(0.0025, 'solana'), { tokensOnly: true });
    expect(e.paper.inFlight()).toEqual([`sale solana:${SOL.toLowerCase()} SIGS…`]);
    for (let i = 0; i < 18; i++) { settle('unknown'); await tick(3); }
    await tick();
    expect(e.paper.inFlight()).toEqual([]);
    expect(e.sent.at(-1)).toMatch(/Sale SIGS was neither confirmed nor rejected within 3 h — check the wallet manually/);
  });
});
