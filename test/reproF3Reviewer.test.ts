// Review F3 (#135, a hold after a restart), 2026-11-17. repro-a: red = the defect is present.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { Reconciler } from '../src/live/reconcile.js';
import { treasuryTxLine } from '../src/liveWiring.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const EVM = '0x4444444444444444444444444444444444444444', H = '0x' + 'c'.repeat(64), RAW = 2000n * 10n ** 18n;
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-17T08:00:00.000Z', text: 'ape' };
const buy = (): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] }, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM },
  check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-18T08:00:00.000Z' } } as any);
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } } as any;

describe('F3: hold survives restart; outcome once', () => {
  it('sell pending → restart → no resale (unknown, even after 2 h) → late 0x1 applied once; repeat delivery no-op', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8)); const store = new Store(':memory:');
    const risk = new RiskState(DEFAULT_RISK, clock);
    const p1 = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock); p1.liveMode = 'live';
    p1.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
      async sellToken() { return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, note: 'sell pending', nonce: 7, from: '0xabc' }; },
      settleTx: () => new Promise(() => undefined) } as any;
    await p1.execute(MSG, buy(), 1);
    await p1.monitor(market, { tokensOnly: true });
    // restart
    const r2 = new RiskState(DEFAULT_RISK, clock); r2.restore(risk.snapshot());
    const sent: string[] = []; let handler: any; let sells = 0; const asked: any[] = [];
    const p2 = new PaperExecutor(DEFAULT_RISK, r2, store, { async send(t) { sent.push(t); } }, clock); p2.liveMode = 'live';
    p2.trader = { setLateOutcomeHandler(h: any) { handler = h; }, clearGhost() {},
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 0, note: 'x' }; },
      async settleRestored(...a: any[]) { asked.push(a); return 'unknown'; }, async settleTx() { return 'unknown'; } } as any;
    p2.attachLateOutcomes?.();
    p2.restore(); await tick();
    expect(asked).toEqual([['base', H, '0xabc', 7]]);
    expect(sent.some(t => /After restart: sale .* outcome unknown/.test(t))).toBe(true);
    clock.advance(2 * 3600_000);
    await p2.monitor(market, { tokensOnly: true }); await p2.monitor(market, { tokensOnly: true });
    expect(sells).toBe(0);
    expect(await p2.exitToken(EVM, 'analyst: sell', market)).toBe(false);
    const cash0 = r2.cashUsd;
    handler({ chain: 'base', hash: H, addr: '0xabc', nonce: 7, kind: 'expired', state: 'mined', receipt: { status: '0x1' }, treasury: true }); await tick();
    handler({ chain: 'base', hash: H, addr: '0xabc', nonce: 7, kind: 'expired', state: 'mined', receipt: { status: '0x1' }, treasury: true }); await tick();
    const pos = [...p2.open.values()][0];
    expect(pos.qtyLeft).toBe(1000); expect(r2.cashUsd - cash0).toBeCloseTo(2.5, 5);
    expect(pos.sellsInFlight ?? []).toEqual([]);
    expect(JSON.parse(store.openPositions()[0].state).sellsInFlight ?? []).toEqual([]);
  });
});

describe('F3: reconcile halt text with a ghost block is truthful', () => {
  it('halt message must not claim that exits work while the ghost blocks the chain', async () => {
    const notes: string[] = []; const halts: string[] = [];
    const r = new Reconciler({ chains: { base: { chain: 'base', id: 8453, native: 'ETH', rpc: 'http://b', send: ['http://b'], priorityMatters: false } } as any, evmAddress: '0x1111111111111111111111111111111111111111',
      nativeUsd: async () => 4000, ledger: () => ({ cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 }),
      inFlight: () => [treasuryTxLine('base', { hash: '0x' + 'e'.repeat(64), ghost: true })], toleranceShare: 0.15, toleranceUsd: 3, rpc: (async () => { throw new Error('x'); }) as any, confirmMs: 0 },
    { notify: async (t) => { notes.push(t); }, halt: (w) => { halts.push(w); }, halted: () => halts.length > 0 });
    for (let i = 0; i < 6; i++) await r.run('periodic');
    console.log(notes.at(-1));
    expect(halts.length).toBe(1);
    expect(notes.at(-1)).not.toMatch(/exits work/);
  });
});
