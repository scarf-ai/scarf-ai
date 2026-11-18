// G1 /release: not-sold for a sale a node still holds; then it lands in a block. Red = the defect is present.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const H = ('0x' + 'c'.repeat(64)) as `0x${string}`;
const EVM = '0x4444444444444444444444444444444444444444';
const RAW = 2000n * 10n ** 18n;
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));
describe('R1: /release not-sold, and the transaction later landed in a block — the sale is not counted, the step is sold a second time', () => {
  it('pending → "outcome unknown" → /release not-sold → a late 0x1 receipt → monitor', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 18, 8));
    const risk = new RiskState(DEFAULT_RISK, clock);
    const p = new PaperExecutor(DEFAULT_RISK, risk, new Store(':memory:'), { async send() {} }, clock); p.liveMode = 'live';
    let late: ((e: any) => void) | undefined; let sells = 0;
    p.trader = { setLateOutcomeHandler(h: any) { late = h; }, clearGhost() {}, ghostBlocks() { return []; },
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: sells === 1 ? H : ('0x' + 'd'.repeat(64)), soldRaw: RAW / 2n, nonce: 3, from: '0xabc', note: 'tx pending (no receipt yet)' }; },
      async settleTx() { return 'unknown'; } } as any;
    const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-18T08:00:00.000Z', text: 'ape' };
    const d: Decision = { action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] } as any, estGasUsd: 0.02,
      intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM } as any,
      check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
      exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-19T08:00:00.000Z' } } as any;
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
    await p.execute(MSG, d, 1); await p.monitor(market, { tokensOnly: true }); await tick();
    expect(p.holds().map(x => x.tx)).toEqual([H]);                       // pending: the wallet has not changed yet
    expect(await p.release(H, 'not-sold')).toMatch(/lifted/);             // the owner: the tokens are in the wallet → "did not go through"
    late!({ chain: 'base', hash: H, addr: '0xabc', nonce: 3, kind: 'expired', state: 'mined', receipt: { status: '0x1', logs: [] }, treasury: true });
    await tick();
    const pos = [...p.open.values()][0];
    expect.soft(pos.qtyLeft).toBeLessThan(2000);                          // red: 2000 — the landed sale did not get into the ledger
    await p.monitor(market, { tokensOnly: true }); await tick();
    expect(sells).toBe(1);                                                // red: 2 — the same step was sent a second time
  });
});
