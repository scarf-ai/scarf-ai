// Acceptance #48, round 4, item 1 (reviewer repro): the CALLER declared the transaction "dropped" (its resolveLost), while the background is still
// polling for the receipt. The receipt arrives in this window → before, settleMined silently rewrote 'dropped' to 'mined' with no ghost and no delivery.
// Now: a ghost (address block) + the late outcome to the subscriber. Separate file: the clock runs for hours.
import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmSender } from '../src/live/evm.js';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import type { Decision, RawMessage } from '../src/types.js';

const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://r', send: ['http://r'], priorityMatters: true } as const;
const acc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const TX = { to: '0x000000000000000000000000000000000000dEaD' as const, value: 1n, gas: 21_000n };
const RECEIPT = { status: '0x1', blockNumber: '0x10', logs: [] };

function node() {
  // known: our nodes know the hash (pool); mined: receipt. known=false → pending counter = nonce (3): by the rules this is "dropped".
  const st = { mined: false, known: true };
  const rpc = async (_u: string, m: string, params: any[]) => {
    if (m === 'eth_sendRawTransaction') return params[0];
    if (m === 'eth_getTransactionCount') return st.mined ? '0x4' : params[1] === 'latest' ? '0x3' : st.known ? '0x4' : '0x3';
    if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
    if (m === 'eth_maxPriorityFeePerGas') return '0x1';
    if (m === 'eth_getTransactionReceipt') return st.mined ? RECEIPT : null;
    if (m === 'eth_getTransactionByHash') return st.known || st.mined ? { hash: params[0] } : null;
    throw new Error(m);
  };
  return { st, rpc };
}

describe('#48 round 4 item 1: the caller declared "dropped", the background saw the receipt right after', () => {
  for (const minedAfterDroppedMs of [500, 2_000, 6_000, 12_000, 3 * 60_000]) it(`receipt ${minedAfterDroppedMs} ms after "dropped" → ghost (address block) and the late outcome to the subscriber`, async () => {
    vi.useFakeTimers();
    try {
      const n = node();
      const s = new EvmSender({ ...chain } as any, n.rpc as any);
      const late: { state: string; kind: string; hash: string }[] = [];
      s.onLateOutcome = (rec, o, kind) => late.push({ state: o.state, kind, hash: rec.hash });
      const p = s.send(acc, TX); await vi.advanceTimersByTimeAsync(50_000); const r = await p;
      expect(r.pending).toBe(true);
      const h = r.hash.toLowerCase();
      await vi.advanceTimersByTimeAsync(50_000); // background: first resolveLost (known → unknown), then raceReceipt(60 s)
      expect(s.pendingTx.has(h)).toBe(true);
      n.st.known = false; // our nodes evicted the transaction from the pool; it is alive on someone else's node
      const caller = s.awaitOutcome(r.hash, 3_000); // caller: deadline passed → resolveLost → two checks 30 s apart → "dropped"
      let droppedAt: number | undefined;
      for (let i = 0; i < 400 && droppedAt === undefined; i++) { await vi.advanceTimersByTimeAsync(250); if (s.outcomes.get(h)?.state === 'dropped') droppedAt = Date.now(); }
      expect(droppedAt).toBeDefined();
      expect((await caller).state).toBe('dropped'); // the executor released the reserve / returned the position to the monitor
      await vi.advanceTimersByTimeAsync(minedAfterDroppedMs);
      n.st.mined = true; // the transaction lands in a block right after
      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000 + 10 * 60_000);
      expect(s.outcomes.get(h)?.state).toBe('mined');
      expect(s.ghostMined.size).toBe(1); // the address is blocked until confirmed by the ledger
      expect(s.hasPending(acc.address)?.ghost).toBe(true);
      expect(late).toEqual([{ state: 'mined', kind: 'ghost', hash: r.hash }]); // exactly one delivery
    } finally { vi.useRealTimers(); }
  }, 60_000);
});

// End-to-end: executor + trader + sender. The caller (settleBuy) declared the buy "dropped", the background saw the receipt seconds later →
// before: no position, reserve released, no alarm. Now: the position is recorded from the late receipt, or an alarm with a treasury block.
const TOKEN = '0x4444444444444444444444444444444444444444';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: `ape ${TOKEN}` };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (sizeUsd = 2): Decision => ({ action: 'buy_token', sizeUsd, chain: 'base', reasons: [], trust, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: TOKEN },
  check: { ok: true, chain: 'base', address: TOKEN, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-10-30T08:00:00.000Z' } } as any);
const H = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const RAW = 2000n * 10n ** 18n;
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const w64 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const topicAddr = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();

function stack() {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:'); const risk = new RiskState(DEFAULT_RISK, clock); const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t) { sent.push(t); } }, clock); paper.liveMode = 'live';
  const W = new Wallets(newKeyMaterial(0)); const me = W.evmTreasury.address;
  const st = { forgetAt: Infinity, minedAt: Infinity };
  const receipt = () => ({ status: '0x1', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [{ address: TOKEN, topics: [T, topicAddr('0x' + '9'.repeat(40)), topicAddr(me)], data: w64(RAW) }] });
  const f: typeof fetch = async (_u: any, init: any) => {
    const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ result }));
    const mined = Date.now() >= st.minedAt; const known = Date.now() < st.forgetAt || mined;
    if (b.method === 'eth_getTransactionCount') return res(mined ? '0x4' : b.params[1] === 'latest' ? '0x3' : known ? '0x4' : '0x3');
    if (b.method === 'eth_getTransactionReceipt') return res(mined ? receipt() : null);
    if (b.method === 'eth_getTransactionByHash') return res(known ? { hash: b.params[0] } : null);
    throw new Error(b.method);
  };
  const trader = new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
  const s = trader.sender('base')!; paper.trader = trader;
  return { clock, store, risk, paper, sent, me, st, trader, s };
}

describe('#48 round 4 item 1, end-to-end: "dropped" at the caller → receipt in the background → ledger or alarm, but not silence', () => {
  it('nodes forgot the transaction before the caller\'s deadline; receipt in the next seconds after "dropped"', async () => {
    vi.useFakeTimers();
    try {
      const run = async (minedAfterDroppedMs: number) => {
        const x = stack();
        x.trader.buyToken = (async () => { x.s.trackPending(x.me, 3, H); return { ok: false, pending: true, mode: 'live', qty: 0, raw: 0n, decimals: 18, spentUsd: 0, tx: H, note: `tx pending (no receipt yet): ${H}` }; }) as any;
        const t0 = Date.now();
        x.st.forgetAt = t0 + 590_000;
        await expect(x.paper.execute(MSG, buy(), 1)).rejects.toThrow(/pending/);
        let droppedAt: number | undefined;
        while (Date.now() < t0 + 20 * 60_000) {
          if (droppedAt === undefined && x.s.outcomes.get(H)?.state === 'dropped') { droppedAt = Date.now() - t0; x.st.minedAt = Date.now() + minedAfterDroppedMs; }
          await vi.advanceTimersByTimeAsync(droppedAt === undefined || Date.now() - t0 < droppedAt + 120_000 ? 100 : 30_000);
        }
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        return { x, droppedAt };
      };
      for (const d of [0, 300, 1200, 2400, 5000, 180_000]) {
        const r = await run(d);
        const alarm = r.x.sent.some(m => /no pair in the ledger|blocked|Late (buy |sale )?receipt/.test(m));
        const silent = r.x.risk.positions.length === 0 && !alarm && !r.x.s.hasPending(r.x.me);
        expect(r.droppedAt, `d=${d}`).toBeDefined();
        expect(silent, `mined +${d} ms after dropped: IN A BLOCK, NOT IN THE LEDGER, NO ALARM`).toBe(false);
        // The receipt is recognized as a buy: the position is recorded and the block lifted — or the address stays blocked with an alarm
        expect(r.x.risk.positions.length === 1 || !!r.x.s.hasPending(r.x.me), `d=${d}: position or block`).toBe(true);
      }
    } finally { vi.useRealTimers(); }
  }, 300_000);
});
