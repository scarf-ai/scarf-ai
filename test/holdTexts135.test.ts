// #135 F3 item 4: ghost block texts without "restart clears" as a way out; an hourly reminder while a hold
// or a ghost block is pending; the reconciliation stop reason under a ghost block is the wallet, not RPC.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import { Reconciler } from '../src/live/reconcile.js';
import { treasuryTxLine } from '../src/liveWiring.js';
import type { MarketClient } from '../src/checks/token.js';

const HG = '0x' + 'e'.repeat(64);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;

function executor(trader: any) {
  const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, new RiskState(DEFAULT_RISK, clock), new Store(':memory:'), { async send(t: string) { sent.push(t); } }, clock);
  paper.liveMode = 'live'; paper.trader = trader;
  return { paper, clock, sent };
}

describe('#135 F3: ghost block texts', () => {
  it('an outcome without a pair in the ledger → "blocked until reconciliation", the chain\'s stops do not work, after checking the wallet — /release with the hash (G1); no "restart clears"', async () => {
    let handler: any;
    const e = executor({ setLateOutcomeHandler(h: any) { handler = h; }, clearGhost() {} });
    e.paper.attachLateOutcomes();
    for (const receipt of [{ status: '0x1' }, { blockNumber: '0x1' }]) {
      handler({ chain: 'base', hash: HG, addr: '0xabc', nonce: 4, kind: 'ghost', state: 'mined', receipt, treasury: true }); await tick();
      const m = e.sent.at(-1)!;
      expect(m).toMatch(/blocked until reconciliation \(E-03\): while the block stands, stops on this chain's positions do not work/);
      // with no sale in the ledger there is nothing to count — only the "not-sold" hint (review R1, nice-to-have)
      expect(m).toMatch(/Check the wallet; after checking: \/release 0xe+ not-sold \(lift the block\)/);
      expect(m).not.toMatch(/restart clears/); expect(m).not.toMatch(/ sold \(/);
    }
  });

  it('trader refusal under a ghost block: "check the wallet… after checking: /release <tx> sold | not-sold", no "restart clears"; ghostBlocks() sees the block', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const t = new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500,
      fetchImpl: (async () => { throw new Error('no rpc in this test'); }) as any });
    expect(t.ghostBlocks()).toEqual([]);
    t.sender('base')!.ghostMined.set(HG, { addr: W.evmTreasury.address.toLowerCase(), hash: HG as `0x${string}`, nonce: 3 });
    expect(t.ghostBlocks()).toEqual([{ chain: 'base', hash: HG }]);
    const b = await t.buyToken({ chain: 'base', token: '0x' + '3'.repeat(40), sizeUsd: 2 }, 'live');
    const s = await t.sellToken({ chain: 'base', token: '0x' + '3'.repeat(40), share: 1, amountRaw: 10n }, 'live');
    for (const r of [b, s]) {
      expect(r.ok).toBe(false);
      expect(r.note).toMatch(/check the wallet \(E-03\); after checking: \/release 0xe+ sold \| not-sold/); expect(r.note).not.toMatch(/restart clears/);
    }
  });
});

describe('#135 F3: hourly reminder', () => {
  const market: MarketClient = { async market() { return undefined; }, async rug() { return undefined; } };
  it('ghost block: silence when it appears (its own message already went out), a reminder after an hour and every hour; block lifted — silence', async () => {
    let ghosts = [{ chain: 'base', hash: HG }];
    const e = executor({ setLateOutcomeHandler() {}, clearGhost() {}, ghostBlocks: () => ghosts });
    await e.paper.monitor(market, { tokensOnly: true });
    e.clock.advance(59 * 60_000); await e.paper.monitor(market, { tokensOnly: true });
    expect(e.sent).toEqual([]);
    e.clock.advance(2 * 60_000); await e.paper.monitor(market, { tokensOnly: true });
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0]).toMatch(/^⏰ Reminder \(hourly, 09:01 UTC\): ghost block on base \(tx 0xe+\) — stops on this chain's positions do not work\. Check the wallet; after checking, for each: \/release <tx> sold or \/release <tx> not-sold\.$/);
    e.clock.advance(30 * 60_000); await e.paper.monitor(market, { tokensOnly: true }); expect(e.sent).toHaveLength(1);
    e.clock.advance(31 * 60_000); await e.paper.monitor(market, { tokensOnly: true }); expect(e.sent).toHaveLength(2);
    ghosts = [];
    e.clock.advance(3 * 3600_000); await e.paper.monitor(market, { tokensOnly: true }); expect(e.sent).toHaveLength(2);
  });

  it('a hold on a sale with an unknown outcome (after restart) → a reminder about the position after an hour', async () => {
    const store = new Store(':memory:');
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const risk = new RiskState(DEFAULT_RISK, clock);
    const sent: string[] = [];
    store.savePosition({ id: 'p1', decisionId: 1, chain: 'base', token: '0x' + '4'.repeat(40), costUsd: 2, qty: 2000, entryPrice: 0.001, openedUtc: clock.iso(), mode: 'live',
      state: { id: 'p1', chain: 'base', token: '0x' + '4'.repeat(40), symbol: 'MEME', qty: 2000, qtyLeft: 2000, costUsd: 2, entry: 0.001, openedAtMs: clock.now(),
        sellsInFlight: [{ tx: HG, qty: 1000, proceeds: 2.5, reason: 'take-profit 1', price: 0.0025, sentUtc: clock.iso() }] } });
    const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t: string) { sent.push(t); } }, clock);
    paper.liveMode = 'live';
    paper.trader = { setLateOutcomeHandler() {}, clearGhost() {}, async settleTx() { return 'unknown'; } } as any;
    paper.restore(); await tick();
    await paper.monitor(market, { tokensOnly: true });
    clock.advance(61 * 60_000); await paper.monitor(market, { tokensOnly: true });
    expect(sent.at(-1)).toMatch(/⏰ Reminder .*sale MEME \(base\) tx 0xe+ — outcome unknown, stops on this position do not work/);
  });
});

describe('#135 F3: reconciliation stop reason under a ghost block', () => {
  function rec(flying: string[]) {
    const notes: string[] = []; const halts: string[] = [];
    const r = new Reconciler({ chains: {}, nativeUsd: async () => 4000, ledger: () => ({ cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 }),
      inFlight: () => flying, toleranceShare: 0.15, toleranceUsd: 3, confirmMs: 0 },
    { notify: async (t) => { notes.push(t); }, halt: (w) => { halts.push(w); }, halted: () => halts.length > 0 });
    return { r, notes, halts };
  }
  it('src/index.ts builds treasury transaction lines via treasuryTxLine', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(tx\) out\.push\(treasuryTxLine\(c, tx\)\)/);
  });
  it('the "in flight" line for a ghost has its own mark; a regular treasury transaction — as before', () => {
    expect(treasuryTxLine('base', { hash: HG, ghost: true })).toBe(`ghost block base ${HG} (check the wallet; after checking — /release ${HG} sold or not-sold)`);
    expect(treasuryTxLine('base', { hash: HG })).toBe('treasury transaction base 0xeeeeeeee…');
  });
  it('a ghost block holds up reconciliation → advice "check the wallet", not "check RPC"; the stop reason is the ghost block', async () => {
    const x = rec([treasuryTxLine('base', { hash: HG, ghost: true })]);
    for (let i = 0; i < 6; i++) await x.r.run('periodic');
    expect(x.notes[0]).toMatch(/New entries are not stopped yet — ghost block: check the wallet; after checking — \/release <tx> sold or not-sold \(hash — in \/status\), then \/reconcile;/);
    expect(x.notes.join('\n')).not.toMatch(/check RPC|Check RPC|Check the RPC/);
    expect(x.halts).toEqual(['wallet reconciliation not done 6 times in a row (ghost block: check the wallet; after checking — /release <tx> sold or not-sold (hash — in /status), then /reconcile)']);
    expect(x.notes.at(-1)).toMatch(/Reason — ghost block: check the wallet/);
    // review: under a ghost, sales on this chain are refused too — "exits work" would be untrue
    expect(x.notes.at(-1)).toMatch(/new entries stopped \(like \/stop\), exits on base do not work while the block stands \(stops on that chain's positions will not fire\)/);
    expect(x.notes.at(-1)).not.toMatch(/exits work/);
  });
  it('without a ghost — texts as before ("check RPC")', async () => {
    const x = rec(['treasury transaction base 0xeeeeeeee…']);
    for (let i = 0; i < 6; i++) await x.r.run('periodic');
    expect(x.notes[0]).toMatch(/— check RPC;/); expect(x.halts).toEqual(['wallet reconciliation not done 6 times in a row']);
    expect(x.notes.at(-1)).toMatch(/Check the RPCs of the live chains/); expect(x.notes.at(-1)).toMatch(/new entries stopped \(like \/stop\), exits work\./);
  });
});
