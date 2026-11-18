// #134: wiring of #133 in HQ files — wallet reconciliation sees paper.inFlight() together with trackCalls, the bridge is held by legSent,
// bridge sources are only reconciled chains. Assembled the same way as in src/index.ts (reconcileInFlight, bridgeLegSent, bridgeSources).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { Reconciler } from '../src/live/reconcile.js';
import { Funding, BRIDGE_COOLDOWN_MS, type RelayClient } from '../src/live/bridge.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import { BRIDGE_HOLD_MS, InFlight, bridgeLegSent, bridgeSources, reconcileChains, reconcileInFlight, trackCalls } from '../src/liveWiring.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const ETH = 4000;
const W = new Wallets(newKeyMaterial(0));
const ADDR = '0x1111111111111111111111111111111111111111';
const EVM = '0x4444444444444444444444444444444444444444';
const HB = '0x' + 'a'.repeat(64), HS = '0x' + 'c'.repeat(64);
const RAW = 2000n * 10n ** 18n;
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-15T08:00:00.000Z', text: 'ape' };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (chain: string, token: string): Decision => ({ action: 'buy_token', sizeUsd: 2, chain, reasons: [], trust, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain, urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: token },
  check: { ok: true, chain, address: token, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-16T08:00:00.000Z' } } as any);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const cfg = (chain: string) => ({ chain, id: 1, native: 'ETH', rpc: `http://${chain}`, send: [`http://${chain}`], priorityMatters: false });

/** Reconciliation nodes read the same balances ($ per chain) that the bridge sees: there is one treasury wallet. */
const rpcOf = (bal: Record<string, number>) => async (u: string, m: string) => {
  if (m === 'eth_getBalance') return '0x' + BigInt(Math.round(((bal[u.slice(7)] ?? 0) / ETH) * 1e18)).toString(16);
  if (m === 'eth_getTransactionCount') return '0x7';
  throw new Error(m);
};

/** Reconciliation as in index.ts: ledger cash $50, tolerance 15% ($7.50), second-pass confirmation off. */
function reconciler(bal: Record<string, number>, inFlight: () => string[]) {
  const halts: string[] = []; const notes: string[] = [];
  const r = new Reconciler({ chains: { base: cfg('base'), robinhood: cfg('robinhood') } as any, evmAddress: ADDR, nativeUsd: async () => ETH,
    ledger: () => ({ cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 }), inFlight, toleranceShare: 0.15, toleranceUsd: 3,
    rpc: rpcOf(bal) as any, confirmMs: 0 },
  { notify: async (t) => { notes.push(t); }, halt: (why) => { halts.push(why); }, halted: () => halts.length > 0 });
  return { r, halts, notes };
}

function executor() {
  const clock = new VirtualClock(Date.UTC(2026, 10, 15, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send() {} }, clock);
  paper.liveMode = 'live';
  return paper;
}

describe('#134: reconciliation sees a sale "in flight" after the call returns', () => {
  it('the sale returned "in flight" — trackCalls no longer sees it, paper.inFlight() does: no false stop; after the outcome the mismatch is caught', async () => {
    const paper = executor();
    let settle!: (s: string) => void; let handler: any;
    paper.trader = { setLateOutcomeHandler(h: any) { handler = h; }, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: HB, note: 'got' }; },
      async sellToken() { return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: HS, soldRaw: RAW / 2n, note: 'sell pending' }; },
      settleTx: () => new Promise<string>(r => { settle = r; }) } as any;
    const flying = new InFlight(() => Date.UTC(2026, 10, 15, 8));
    trackCalls(paper.trader!, 'buyToken', 'buy', flying);
    trackCalls(paper.trader!, 'sellToken', 'sell', flying);
    await paper.execute(MSG, buy('base', EVM), 1);
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: 0.0025 }; }, async rug() { return undefined; } };
    await paper.monitor(market, { tokensOnly: true });

    // The proceeds are already in the wallet, the ledger is not updated yet: $65 against $50 cash — outside the tolerance
    const bal = { base: 65, robinhood: 0 };
    expect(flying.list()).toEqual([]); // the sellToken call returned
    const old = reconciler(bal, () => flying.list()); // wiring before #134 — trackCalls only
    expect((await old.r.run('periodic')).status).toBe('mismatch'); expect(old.halts).toHaveLength(1);

    const inFlight = reconcileInFlight({ tracked: flying, executor: paper });
    expect(inFlight()).toEqual([`sale base:${EVM} ${HS.slice(0, 10)}…`]);
    const now = reconciler(bal, inFlight);
    const rep = await now.r.run('periodic');
    expect(rep.status).toBe('skipped'); expect(rep.why).toMatch(/in flight: sale base:/);
    expect(now.halts).toEqual([]);
    expect(await now.r.acceptCurrent()).toMatch(/^Baseline not accepted: in flight sale/);

    // The outcome is recorded — nothing in flight; the same mismatch is caught as before
    for (let i = 0; i < 3; i++) { settle('unknown'); await tick(5); }
    await tick();
    handler({ chain: 'base', hash: HS, addr: '0xabc', nonce: 4, kind: 'expired', state: 'mined', receipt: { status: '0x1' }, treasury: true }); await tick();
    expect(inFlight()).toEqual([]);
    expect((await now.r.run('periodic')).status).toBe('mismatch'); expect(now.halts).toHaveLength(1);
  });
});

describe('#134: a bridge with a sent leg', () => {
  function bridge(status: () => string) {
    let now = Date.UTC(2026, 10, 15, 8);
    const bal: Record<string, number> = { base: 50, robinhood: 0, arbitrum: 0 };
    const sent: any[] = [];
    const evm = (c: string) => ({ cfg: { id: ({ base: 8453, robinhood: 4663, arbitrum: 42161 } as any)[c], rpc: `http://${c}` },
      async balance() { return BigInt(Math.round(((bal[c] ?? 0) / ETH) * 1e18)); },
      async send(_me: any, tx: any) { sent.push({ c, ...tx }); bal[c] -= Number(tx.value) / 1e18 * ETH; return { ok: true, hash: '0xabc', pending: false }; } }) as any;
    const quotes: any[] = [];
    const relay: RelayClient = {
      async quote(q) { quotes.push(q); const usd = Number(q.amount) / 1e18 * ETH;
        return { requestId: 'r1', details: { currencyOut: { amountUsd: String(usd * 0.99) }, recipient: q.recipient },
          steps: [{ id: 'quote-and-deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { to: '0x1111111111111111111111111111111111111111', data: '0x', value: q.amount.toString(), chainId: 8453 }, check: { endpoint: '/s', method: 'GET' } }] }] } as any; },
      async status() { return status(); },
    };
    const rc = reconcileChains({ base: cfg('base'), robinhood: cfg('robinhood'), arbitrum: cfg('arbitrum') } as any, ['robinhood'], 'base');
    const f = new Funding({ relay, evm, wallets: W, nativeUsd: async () => ETH, home: 'base', sources: bridgeSources(rc), maxShareOfEquity: 0.6, equityUsd: () => 100,
      waitMs: 10, sleep: async () => {}, now: () => now,
      fetchImpl: (async () => new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', logs: [] }] }] }))) as any } as any);
    const paper = executor();
    paper.trader = { setLateOutcomeHandler() {}, funding: f } as any;
    const flying = new InFlight(() => now);
    trackCalls(f, 'ensure', 'bridge', flying, { holdOnFailMs: BRIDGE_HOLD_MS, holdIf: bridgeLegSent });
    const inFlight = reconcileInFlight({ tracked: flying, executor: paper });
    return { f, bal, sent, quotes, flying, inFlight, paper, advance: (ms: number) => { now += ms; } };
  }

  it('the leg went out, Relay did not confirm: during the bridge and after it until the pause ends — reconciliation postponed, no stop; after the pause with no money — a mismatch', async () => {
    let during: Awaited<ReturnType<Reconciler['run']>> | undefined;
    let rec!: ReturnType<typeof reconciler>;
    const b = bridge(() => 'pending');
    rec = reconciler(b.bal, b.inFlight);
    // While waiting for the Relay status: reconciliation is "in flight"
    const relayStatus = (b.f as any).d.relay.status;
    (b.f as any).d.relay.status = async (...a: any[]) => { during ??= await rec.r.run('periodic'); return relayStatus(...a); };
    const r = await b.f.ensure('robinhood', 29, 'live');
    expect(r.ok).toBe(false); expect(r.legSent).toBe(true);
    expect(b.sent).toHaveLength(1); expect(b.bal.base).toBeLessThan(25); expect(b.bal.robinhood).toBe(0); // money between chains
    expect(during?.status).toBe('skipped'); expect(during?.why).toMatch(/in flight: bridge/);
    // After the return: the HQ mark is held by legSent, the executor shows the bridge pause — both are visible to reconciliation
    expect(b.flying.list()).toEqual([expect.stringMatching(/^bridge \(outcome unclear until \d\d:\d\d UTC\)$/)]);
    expect(b.paper.inFlight()).toEqual([expect.stringMatching(/^bridge to robinhood: paused until \d\d:\d\d:\d\d UTC/)]);
    const after = await rec.r.run('periodic');
    expect(after.status).toBe('skipped'); expect(rec.halts).toEqual([]);
    expect(await rec.r.acceptCurrent()).toMatch(/^Baseline not accepted: in flight bridge/);
    // The pause ended, the money never arrived — nothing in flight, the mismatch is caught as before
    b.advance(Math.max(BRIDGE_HOLD_MS, BRIDGE_COOLDOWN_MS) + 1);
    expect(b.inFlight()).toEqual([]);
    expect((await rec.r.run('periodic')).status).toBe('mismatch'); expect(rec.halts).toHaveLength(1);
  });

  it('refusal before sending (no source in the list) — no legSent, the mark is not held; a bridge from a chain outside reconciliation is not used', async () => {
    const b = bridge(() => 'success');
    b.bal.base = 5; b.bal.arbitrum = 80; // arbitrum is the richest, but is not reconciled
    const r = await b.f.ensure('robinhood', 29, 'live');
    expect(r.ok).toBe(false); expect(r.note).toMatch(/no chain has/); expect(r.legSent).toBeUndefined();
    expect(b.sent).toEqual([]); expect(b.quotes).toEqual([]); expect(b.bal.arbitrum).toBe(80);
    expect(b.inFlight()).toEqual([]);
  });

  it('a source is in the list — it is taken, not a richer chain outside reconciliation', async () => {
    const b = bridge(() => 'success');
    b.bal.arbitrum = 500;
    const r = await b.f.ensure('robinhood', 29, 'live');
    expect(b.quotes[0].from).toBe('base'); expect(b.sent.every(s => s.c === 'base')).toBe(true);
    expect(r.legSent).toBe(true); expect(b.bal.arbitrum).toBe(500);
  });
});

describe('#134: bridgeSources and reconcileInFlight', () => {
  it('bridge sources = reconciled chains: live + the deposit chain, Solana — only if it is live; chains without RPC — no', () => {
    const all = { base: cfg('base'), robinhood: cfg('robinhood'), arbitrum: cfg('arbitrum') } as any;
    expect(bridgeSources(reconcileChains(all, ['robinhood'], 'base'))).toEqual(['robinhood', 'base']);
    expect(bridgeSources(reconcileChains(all, ['robinhood', 'solana'], 'base'))).toEqual(['robinhood', 'base', 'solana']);
    expect(bridgeSources(reconcileChains({ base: all.base }, ['robinhood'], 'base'))).toEqual(['base']); // robinhood without RPC — not reconciled
  });

  it('list = trackCalls + executor + mint + treasury transactions, repeats — once; empty when there is nothing', () => {
    const flying = new InFlight(() => 0);
    let exec: string[] = []; let mint = 0; let tx: string[] = [];
    const f = reconcileInFlight({ tracked: flying, executor: { inFlight: () => exec }, mintReservedUsd: () => mint, treasuryTx: () => tx });
    expect(f()).toEqual([]);
    flying.begin('sell'); exec = ['sale base:0xabc 0xcccc…', 'sale base:0xabc 0xcccc…']; mint = 1.5; tx = ['treasury transaction base 0x12…'];
    expect(f()).toEqual(['sell', 'sale base:0xabc 0xcccc…', 'mint (reserve $1.50)', 'treasury transaction base 0x12…']);
  });

  it('src/index.ts wires exactly this: executor: paper, holdIf: bridgeLegSent, sources: bridgeSources(rc)', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/reconcileInFlight\(\{ tracked: flying, executor: paper,/);
    expect(src).toMatch(/trackCalls\(paper\.trader\.funding, 'ensure', 'bridge', flying, \{ holdOnFailMs: BRIDGE_HOLD_MS, holdIf: bridgeLegSent \}\)/);
    expect(src).toMatch(/sources: bridgeSources\(rc\)/);
    expect(src).not.toMatch(/bridgeMayHaveSent/);
  });
});
