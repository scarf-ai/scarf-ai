// #135 G1: a sale hold with an unreadable receipt is raised again after every restart — it is lifted by the owner's /release command
// after checking the wallet: sold — count the sale exactly once; not-sold — lift the hold and the address block, the position is under the monitor again.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import { operatorCommands, statusText, type OperatorStatus } from '../src/notify/commands.js';
import { startTelegramControl, STALE_RESUME_MS, OPERATOR_COMMANDS } from '../src/notify/telegramControl.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;
const H = ('0x' + 'c'.repeat(64)) as `0x${string}`;
const EVM = '0x4444444444444444444444444444444444444444';
const RAW = 2000n * 10n ** 18n;
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const W = new Wallets(newKeyMaterial(0));
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-18T08:00:00.000Z', text: 'ape' };
const D: Decision = { action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] } as any, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: EVM } as any,
  check: { ok: true, chain: 'base', address: EVM, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-19T08:00:00.000Z' } } as any;

/** A real sender: there is a receipt, no status (G1 from /tmp/hq/repro-ex2-b/ghostForever.test.ts). */
const realTrader = () => {
  const f: typeof fetch = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
    if (b.method === 'eth_getTransactionReceipt') return res({ blockNumber: '0x10', transactionHash: b.params[0], logs: [] });
    if (b.method === 'eth_getTransactionCount') return res('0x4');
    if (b.method === 'eth_getTransactionByHash') return res({ hash: b.params[0] });
    throw new Error(b.method);
  }) as any;
  return new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
};

/** A sale goes "in flight" with an unreadable receipt, then two restarts on the same database — the hold is raised again. */
async function ghostForever() {
  const clock = new VirtualClock(Date.UTC(2026, 10, 18, 8));
  const store = new Store(':memory:'); const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = []; let sells = 0; let real!: LiveTrader;
  const mk = () => {
    const p = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t: string) { sent.push(t); } }, clock); p.liveMode = 'live';
    real = realTrader(); const r = real;
    p.trader = { setLateOutcomeHandler: (h: any) => r.setLateOutcomeHandler(h), clearGhost: (c: any, h: any) => r.clearGhost(c, h), ghostBlocks: () => r.ghostBlocks(),
      settleTx: (c: any, t: string, o: any) => r.settleTx(c, t, o), settleRestored: (c: any, t: string, f: string, n: number) => r.settleRestored(c, t, f, n),
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, nonce: 3, from: W.evmTreasury.address, note: 'tx mined, receipt status unreadable' }; } } as any;
    return p;
  };
  let px = 0.0025;
  const market: MarketClient = { async market() { return { chain: 'base', priceUsd: px }; }, async rug() { return undefined; } };
  const p1 = mk(); await p1.execute(MSG, D, 1); await p1.monitor(market, { tokensOnly: true }); await tick();
  expect(sells).toBe(1);
  const cashBefore = risk.cashUsd;
  clock.advance(24 * 3600_000); const p2 = mk(); p2.restore(); await tick(400);
  clock.advance(24 * 3600_000); const p3 = mk(); p3.restore(); await tick(400);
  expect(p3.inFlight()).toHaveLength(1); // the hold is raised again — no way out without the command
  expect(real.ghostBlocks()).toEqual([{ chain: 'base', hash: H }]);
  return { p3, store, risk, sent, real, market, sells: () => sells, setPx: (v: number) => { px = v; }, cashBefore };
}

describe('#135 G1: /release lifts a hold that survives restarts', () => {
  it('G1 via /release not-sold: the hold and the address block are lifted, the database record removed, "in flight" empty, the position is sold again', async () => {
    const w = await ghostForever();
    const reply = await w.p3.release(H, 'not-sold');
    expect(reply).toMatch(/Hold on sale .* tx 0xc+ lifted on the owner's command \(did not go through\): the position is under the monitor again, the address block is lifted/);
    expect(w.p3.inFlight()).toEqual([]);
    expect(w.real.ghostBlocks()).toEqual([]);
    expect(JSON.parse(w.store.openPositions()[0].state).sellsInFlight).toBeUndefined();
    w.setPx(0.0001); await w.p3.monitor(w.market, { tokensOnly: true }); await tick();
    expect(w.sells()).toBeGreaterThan(1);
    expect(w.risk.cashUsd).toBe(w.cashBefore); // the sale accounting did not change
  });

  it('/release sold: the sale is counted exactly once (from the saved record, with a mark); a repeated command and a late outcome — no second count', async () => {
    const w = await ghostForever();
    const reply = await w.p3.release(H, 'sold');
    expect(reply).toMatch(/Sale .* tx 0xc+ counted on the owner's command: 1000 units, proceeds estimated as of sending \$2\.50/);
    expect(w.risk.cashUsd - w.cashBefore).toBeCloseTo(2.5, 6);
    const row = w.store.openPositions()[0];
    expect(row.qty_left).toBe(1000); expect(JSON.parse(row.state).sellsInFlight).toBeUndefined();
    expect(w.real.ghostBlocks()).toEqual([]);
    expect(w.p3.inFlight()).toEqual([]);
    expect(await w.p3.release(H, 'sold')).toMatch(/^No hold or block found with hash 0xc+\. No pending holds or blocks\./);
    // a late outcome of the same transaction (receipt 0x1) after counting on command — already in the ledger, no second count
    await (w.p3 as any).onLateOutcome({ chain: 'base', hash: H, addr: W.evmTreasury.address.toLowerCase(), nonce: 3, kind: 'expired', state: 'mined', receipt: { status: '0x1' }, treasury: true });
    expect(w.risk.cashUsd - w.cashBefore).toBeCloseTo(2.5, 6); expect(w.store.openPositions()[0].qty_left).toBe(1000);
  });

  it('an unknown hash — refusal with a hint and the list of pending ones; a sale still awaited — refusal "still waiting for an outcome"', async () => {
    const w = await ghostForever();
    expect(await w.p3.release('0xdead', 'not-sold')).toMatch(new RegExp(`^No hold or block found with hash 0xdead\\. Pending: ${H}\\. Format: /release <tx> sold \\| not-sold\\.`));
    expect(w.p3.inFlight()).toHaveLength(1);
    // a sale whose outcome the caller still awaits — not a hold
    const clock = new VirtualClock(Date.UTC(2026, 10, 18, 8));
    const p = new PaperExecutor(DEFAULT_RISK, new RiskState(DEFAULT_RISK, clock), new Store(':memory:'), { async send() {} }, clock); p.liveMode = 'live';
    p.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'a'.repeat(64), note: 'got' }; },
      async sellToken() { return { ok: false, mode: 'live', proceedsUsd: 2.5, pending: true, tx: H, soldRaw: RAW / 2n, note: 'sell pending' }; },
      settleTx: () => new Promise(() => undefined) } as any;
    await p.execute(MSG, D, 1); await p.monitor(w.market, { tokensOnly: true });
    expect(await p.release(H, 'not-sold')).toMatch(/^Sale 0xc+ is still waiting for an outcome/);
  });

  it('a ghost block without a sale in the ledger: sold — refusal (nothing to count), not-sold — the block is lifted', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 18, 8));
    const p = new PaperExecutor(DEFAULT_RISK, new RiskState(DEFAULT_RISK, clock), new Store(':memory:'), { async send() {} }, clock); p.liveMode = 'live';
    const real = realTrader();
    real.sender('base')!.ghostMined.set(H, { addr: W.evmTreasury.address.toLowerCase(), hash: H, nonce: 3 });
    p.trader = real;
    expect(p.holds()).toEqual([{ tx: H, chain: 'base', kind: 'ghost', text: `ghost block on base (tx ${H}) — stops on this chain's positions do not work` }]);
    expect(await p.release(H, 'sold')).toMatch(/there is no sale in the ledger — nothing to count\. To lift the address block: \/release 0xc+ not-sold/);
    expect(real.ghostBlocks()).toHaveLength(1);
    expect(await p.release(H, 'not-sold')).toMatch(/^✅ Address block for 0xc+ \(base\) lifted on the owner's command\. The ledger did not change/);
    expect(real.ghostBlocks()).toEqual([]);
  });
});

describe('#135 G1: the Telegram command and /status', () => {
  const base: OperatorStatus = { mode: 'live', equityUsd: 50, markedEquityUsd: 50, cashUsd: 48, positions: [], operatorHalted: false, dailyStop: false, hardStopped: false };
  it('/release parses "<tx> sold|not-sold", otherwise a hint; without an executor — "only in live"; /status shows holds with hashes', async () => {
    const calls: string[] = [];
    const cmd = operatorCommands({ status: () => ({ ...base, holds: [{ tx: H, text: `sale MEME (base) tx ${H} — outcome unknown` }] }), setOperatorHalt() {}, now: () => 0,
      release: async (tx, v) => { calls.push(`${tx} ${v}`); return 'ok'; } });
    expect(await cmd('/release', `${H} not-sold`)).toBe('ok');
    expect(await cmd('/release', `${H} sold`)).toBe('ok');
    expect(calls).toEqual([`${H} not-sold`, `${H} sold`]);
    for (const a of ['', H, `${H} maybe`, `${H} sold now`]) expect(await cmd('/release', a)).toMatch(/^Did not understand .\/release.*\/release <tx> sold — the sale went through/);
    expect(calls).toHaveLength(2);
    expect(await operatorCommands({ status: () => ({ ...base, mode: 'paper' }), setOperatorHalt() {}, now: () => 0 })('/release', `${H} sold`)).toMatch(/works only in live/);
    const st = await cmd('/status');
    expect(st).toMatch(new RegExp(`Holds \\(outcome unknown, 1\\) — after checking the wallet /release <tx> sold \\| not-sold:\\n• sale MEME \\(base\\) tx ${H}`));
    expect(statusText(base, 0)).not.toMatch(/Holds/);
  });

  it('Telegram: /release is in the command list; a command older than 5 minutes is not executed', async () => {
    expect(OPERATOR_COMMANDS).toContain('/release');
    const OWNER_CHAT = '111'; const NOW = Date.UTC(2026, 10, 18, 9);
    const msg = (id: number, text: string, dateMs = NOW) => ({ update_id: id, message: { chat: { id: Number(OWNER_CHAT) }, text, date: Math.floor(dateMs / 1000) } });
    const updates = [msg(1, `/release ${H} sold`, NOW - STALE_RESUME_MS - 1000), msg(2, `/release ${H} not-sold`)];
    const sent: any[] = []; let given = false;
    const fetchImpl = (async (url: string, init: any) => {
      const m = String(url).split('/').pop();
      if (m === 'getUpdates') { const result = given ? [] : updates; given = true; if (!result.length) await new Promise(r => setTimeout(r, 5)); return { json: async () => ({ ok: true, result }) }; }
      if (m === 'sendMessage') sent.push(JSON.parse(init.body));
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    const calls: string[] = [];
    const ctl = startTelegramControl('T', OWNER_CHAT, { onCallback: async () => 'OK', onCommand: async (c, a) => { calls.push(`${c}|${a ?? ''}`); return 'ok'; } }, { fetchImpl, now: () => NOW });
    await new Promise(r => setTimeout(r, 40)); ctl.stop();
    expect(calls).toEqual([`/release|${H} not-sold`]);
    expect(sent.map(s => s.text)).toEqual([expect.stringMatching(/^\/release from .* UTC was not executed: it sat in the queue for more than 5 minutes/), 'ok']);
  });

  it('src/index.ts: /status gets the holds, /release is wired only in live', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/holds: paper\.holds\(\)\.map\(h => \(\{ tx: h\.tx, text: h\.text \}\)\)/);
    expect(src).toMatch(/release: execution === 'live' \? \(tx, v\) => paper\.release\(tx, v\) : undefined/);
  });
});
