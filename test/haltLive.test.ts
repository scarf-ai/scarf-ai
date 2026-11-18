// E-08 (#43): stop for new entries (/stop → operatorHalt) and the list of live-buy chains (AGENT_LIVE_CHAINS).
// Auto-events are off (the monitor is called by hand), time is virtual.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState, haltReason } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { LiveTrader, DEFAULT_LIVE_SWAP_CHAINS, liveSwapChainsFromEnv } from '../src/live/trader.js';
import { NftLive } from '../src/live/nftLive.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const TOKEN = '0x4444444444444444444444444444444444444444';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: `ape ${TOKEN}` };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (chain = 'base', token = TOKEN): Decision => ({ action: 'buy_token', sizeUsd: 2, chain, reasons: [], trust, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain, urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: token },
  check: { ok: true, chain, address: token, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-10-30T08:00:00.000Z' } } as any);
const RAW = 2000n * 10n ** 18n;

function setup() {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t) { sent.push(t); } }, clock);
  paper.liveMode = 'live';
  const calls = { buy: 0, sell: 0 };
  paper.trader = {
    async buyToken() { calls.buy++; return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
    async sellToken() { calls.sell++; return { ok: true, mode: 'live', proceedsUsd: 1.2, soldRaw: RAW, tx: '0x' + 'c'.repeat(64), note: 'sold' }; },
  } as any;
  const market = (priceUsd: number): MarketClient => ({ async market() { return { chain: 'base', priceUsd }; }, async rug() { return undefined; } });
  return { clock, store, risk, paper, sent, calls, market };
}

describe('E-08: operator stop (/stop) — new entries rejected, exits and the position monitor work', () => {
  it('under stop a buy is rejected before reaching the trader; the ledger is untouched; after /resume the buy goes through', async () => {
    const e = setup();
    e.risk.setOperatorHalt(true, '/stop'); // #139: the reason is passed by /stop (src/index.ts)
    const cash0 = e.risk.cashUsd;
    expect(haltReason(DEFAULT_RISK, e.risk)).toMatch(/halted by operator \(\/stop\)/); // the reason that goes into the decision log
    await expect(e.paper.execute(MSG, buy(), 1)).rejects.toThrow(/risk: trading halted/);
    expect(e.calls.buy).toBe(0); expect(e.risk.cashUsd).toBe(cash0); expect(e.risk.positions.length).toBe(0); expect(e.store.openPositions().length).toBe(0);
    e.risk.setOperatorHalt(false);
    await e.paper.execute(MSG, buy(), 2);
    expect(e.calls.buy).toBe(1); expect(e.risk.positions.length).toBe(1);
  });

  it('under stop the monitor keeps tracking an open position: valuation updates, the stop-loss really sells, the position closes', async () => {
    const e = setup();
    await e.paper.execute(MSG, buy(), 1);
    e.risk.setOperatorHalt(true);
    await e.paper.monitor(e.market(0.0009), { tokensOnly: true }); // price below entry but above the stop: revaluation only
    expect(e.calls.sell).toBe(0); expect(e.risk.unrealizedUsd).toBeLessThan(0); expect(e.paper.open.size).toBe(1);
    await e.paper.monitor(e.market(0.0005), { tokensOnly: true }); // below the 0.00065 stop
    expect(e.calls.sell).toBe(1); expect(e.paper.open.size).toBe(0); expect(e.risk.positions.length).toBe(0);
    expect(e.sent.some(t => /LIVE SELL/.test(t))).toBe(true);
    expect(e.risk.operatorHalt).toBe(true); // an exit does not lift the stop
  });

  it('under stop an urgent exit on an analyst alert (exitToken) works too', async () => {
    const e = setup();
    await e.paper.execute(MSG, buy(), 1);
    e.risk.setOperatorHalt(true);
    expect(await e.paper.exitToken(TOKEN, 'rug alert', e.market(0.0009))).toBe(true);
    expect(e.calls.sell).toBe(1); expect(e.paper.open.size).toBe(0);
  });

  it('under stop a live NFT mint is not armed: the minter guard answers with the operator stop reason', async () => {
    const e = setup();
    e.risk.setOperatorHalt(true, '/stop'); // #139: the reason is passed by /stop (src/index.ts)
    const sender ={ cfg: { chain: 'base', id: 8453 }, async getFees() { return { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, at: 0 }; } };
    const nl = new NftLive({ trader: { sender: () => sender } as any, wallets: new Wallets(newKeyMaterial(25)),
      cfg: { maxWallets: 20, maxShareOfEquity: 0.3, minMultipleForMany: 1.5, pSuccess: 0.6, gasPerMint: 250_000n, priorityMultiplier: 3 },
      equityUsd: () => 100, ethUsd: () => 4000, notify: async () => {},
      calldata: async (_s: string, minter: string) => ({ to: ('0x' + '5'.repeat(40)) as `0x${string}`, data: ('0x161ac21f' + minter.slice(2).padStart(64, '0')) as `0x${string}`, value: 500_000_000_000_000n }),
      guard: () => haltReason(DEFAULT_RISK, e.risk) }); // as in index.ts
    const d: any = { chain: 'base', nft: { slug: 'drop', contract: '0x' + '5'.repeat(40), priceEth: 0.0005, sellFeesPct: 5, plan: { style: 'flip' },
      publicStartUtc: new Date(Date.now() + 3600_000).toISOString(), maxPerWallet: 1, exitEstimateEth: 0.005, leftForPublic: 1000 } };
    expect(await nl.schedule(d, 'live')).toMatch(/mint blocked by risk control: halted by operator \(\/stop\)/);
    expect(nl.reserved()).toBe(0); // nothing armed and nothing reserved
  });
});

describe('E-08: list of live-buy chains (AGENT_LIVE_CHAINS)', () => {
  const chains = { ethereum: { chain: 'ethereum', id: 1, native: 'ETH', kyber: 'ethereum', rpc: 'http://x', send: ['http://x'], priorityMatters: true },
    base: { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://y', send: ['http://y'], priorityMatters: true } } as any;

  it('a chain outside the list: the executor rejects the buy with a reason (it goes into the decision log), not a single node request, the ledger is untouched', async () => {
    const e = setup();
    const rpc: string[] = [];
    const f: typeof fetch = async (_u: any, init: any) => { rpc.push(JSON.parse(init.body).method); throw new Error('no rpc in this test'); };
    e.paper.trader = new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
    const cash0 = e.risk.cashUsd;
    await expect(e.paper.execute(MSG, buy('ethereum'), 1)).rejects.toThrow(/live buy failed: live buys on ethereum are off \(AGENT_LIVE_CHAINS/);
    expect(rpc).toEqual([]); expect(e.risk.cashUsd).toBe(cash0); expect(e.risk.positions.length).toBe(0);
  });

  it('the list from the variable narrows buys: base removed from the list → refusal; selling an open position is not limited by the list', async () => {
    const f: typeof fetch = async () => { throw new Error('no rpc in this test'); };
    const t = new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f, liveSwapChains: liveSwapChainsFromEnv('robinhood') });
    expect((await t.buyToken({ chain: 'base', token: TOKEN, sizeUsd: 2 }, 'live')).note).toMatch(/live buys on base are off \(AGENT_LIVE_CHAINS/);
    expect((await t.sellToken({ chain: 'base', token: TOKEN, share: 1 }, 'live')).note).not.toMatch(/AGENT_LIVE_CHAINS/);
  });

  it('parsing the variable: empty → default list; case and spaces do not matter; an unknown chain is a startup error, not a silent skip', () => {
    expect(liveSwapChainsFromEnv(undefined)).toBeUndefined();
    expect(liveSwapChainsFromEnv('')).toBeUndefined();
    expect(liveSwapChainsFromEnv(' , ')).toBeUndefined();
    expect(liveSwapChainsFromEnv('base,robinhood,arbitrum,solana')).toEqual(DEFAULT_LIVE_SWAP_CHAINS);
    expect(liveSwapChainsFromEnv(' Base , ROBINHOOD,base ')).toEqual(['base', 'robinhood']);
    expect(liveSwapChainsFromEnv('base,ethereum')).toEqual(['base', 'ethereum']); // Ethereum — only by the owner's explicit decision
    expect(() => liveSwapChainsFromEnv('base,etherium')).toThrow(/AGENT_LIVE_CHAINS: unknown chain "etherium"/);
    expect(() => liveSwapChainsFromEnv('base;robinhood')).toThrow(/unknown chain "base;robinhood"/);
    expect(() => liveSwapChainsFromEnv('polygon')).toThrow(/unknown chain "polygon"/); // no live route
  });
});
