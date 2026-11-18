// T-08, round 2 (review 2026-11-12): M-A1 entry at a stale ETH price, M-B1 startup hang, M-B2 bridge "in flight" after a failure,
// S1 escaping of the /reconcile reply, S2 accept before a restart, S3 AGENT_FUND_HOME. The reviewers' reproductions were moved here too.
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState } from '../src/risk/risk.js';
import { decide, Blacklist } from '../src/decide/decide.js';
import { prefilter } from '../src/extract/prefilter.js';
import { Funding, BRIDGE_COOLDOWN_MS, type RelayClient } from '../src/live/bridge.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import {
  BRIDGE_HOLD_MS, FreshPrice, InFlight, LiveEntryGuard, ReconcileScheduler, bounded, guardedExecutor, planFundHome, refreshPrice, trackCalls,
} from '../src/liveWiring.js';
import { operatorCommands, unescHtml, type OperatorStatus } from '../src/notify/commands.js';
import { startTelegramControl } from '../src/notify/telegramControl.js';

const pendingAfter = async <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => 'settled'), new Promise(r => setTimeout(() => r('pending'), ms))]);

describe('M-A1: in live an entry on an ETH chain — only at a fresh ETH price at decision time', () => {
  const mk = (ethUsd: () => number, clock: VirtualClock) => ({ cfg: DEFAULT_RISK, risk: new RiskState(DEFAULT_RISK, clock), clock, blacklist: new Blacklist(), ethUsd,
    market: { async market() { return undefined; }, async rug() { return undefined; } } as any });
  const intent: any = { kind: 'nft_buy', chain: 'base', urls: [], summary: 'buy floor', stance: 'buy', confidence: 0.9, collection: 'col' };
  const trust: any = { score: 9, tier: 'follow', basis: 'author', notes: [] };
  const ctx: any = { mainTextAddresses: new Set(), analyst: true, nftBuy: { slug: 'col', contract: '0x' + '5'.repeat(40), chain: 'base', floorEth: 0.0017, sellFeesPct: 5 } };
  const msg: any = { id: 'm1' };
  function setup() {
    const clock = new VirtualClock(Date.UTC(2026, 10, 12, 8));
    const price = new FreshPrice(() => clock.now());
    const guard = new LiveEntryGuard(price); guard.openEntries();
    const executed: string[] = [];
    const exec = guardedExecutor({ async execute(_m, d) { executed.push(`${d.action} ${d.chain}`); }, async exitToken() { return true; } }, guard, () => {});
    return { clock, price, guard, exec, executed };
  }

  it('review: price from 12 min ago — decide approves at the last one, execution refuses (also after a fresh one arrived)', async () => {
    const { clock, price, guard, exec, executed } = setup();
    price.accept(2500); clock.advance(12 * 60_000);
    const d = await decide(intent, trust, prefilter('buy col floor'), mk(guard.ethUsd, clock), ctx);
    expect(d.action).toBe('nft_buy'); // decide.ts untouched: approves at the last price
    price.accept(3200);               // the update arrived while execution waited for the lock
    await expect(exec.execute(msg, d, 1)).rejects.toThrow(/no fresh ETH price at decision time/);
    expect(executed).toEqual([]);
  });

  it('review: the price was never received — the fallback 2500 does not reach the buy', async () => {
    const { clock, guard, exec, executed } = setup();
    const d = await decide(intent, trust, prefilter('buy col floor'), mk(guard.ethUsd, clock), ctx);
    expect(d.action).toBe('nft_buy');
    await expect(exec.execute(msg, d, 1)).rejects.toThrow(/no fresh ETH price/);
    expect(executed).toEqual([]);
  });

  it('fresh price — the entry goes; stale by execution or up > 2 % — refusal; Solana and exits do not need the ETH price', async () => {
    const { clock, price, guard, exec, executed } = setup();
    price.accept(2600); // $4.42 ≤ cap $4.50 (example: follow 0.45 × $10)
    const d = await decide(intent, trust, prefilter('buy col floor'), mk(guard.ethUsd, clock), ctx);
    await exec.execute(msg, d, 1);
    expect(executed).toEqual(['nft_buy base']);
    guard.ethUsd(); price.accept(2700); // +3,8 %
    await expect(exec.execute(msg, { ...d }, 2)).rejects.toThrow(/ETH price rose 3\.8% since the decision/);
    guard.ethUsd(); clock.advance(10 * 60_000 + 1);
    await expect(exec.execute(msg, { ...d }, 3)).rejects.toThrow(/no fresh ETH price/);
    // A token buy on Base (gas from the ETH price) — also guarded; on Solana — not
    await expect(exec.execute(msg, { ...d, action: 'buy_token', chain: 'base' }, 4)).rejects.toThrow(/no fresh ETH price/);
    await exec.execute(msg, { ...d, action: 'buy_token', chain: 'solana' }, 5);
    await exec.execute(msg, { ...d, action: 'journal_only', chain: 'base' }, 6);
    expect(executed).toEqual(['nft_buy base', 'buy_token solana', 'journal_only base']);
    expect(await exec.exitToken!('0x1', 'x', {} as any)).toBe(true);
  });

  it('until the startup reconciliation ends, all entries are closed (exits and the journal — not)', async () => {
    const clock = new VirtualClock(); const price = new FreshPrice(() => clock.now()); price.accept(3000);
    const guard = new LiveEntryGuard(price); guard.ethUsd();
    const executed: string[] = [];
    const exec = guardedExecutor({ async execute(_m, d) { executed.push(d.action); } }, guard, () => {});
    await expect(exec.execute(msg, { action: 'buy_token', chain: 'solana' } as any, 1)).rejects.toThrow(/startup wallet reconciliation not finished/);
    await exec.execute(msg, { action: 'skip', chain: 'base' } as any, 2);
    guard.openEntries();
    await exec.execute(msg, { action: 'buy_token', chain: 'solana' } as any, 3);
    expect(executed).toEqual(['skip', 'buy_token']);
  });
});

describe('M-B1: nothing on the startup path waits without a deadline', () => {
  it('review: a hung DexScreener — refreshPrice answers false by its own deadline', async () => {
    const log: string[] = [];
    const p = refreshPrice(new FreshPrice(() => Date.now()), () => new Promise(() => {}), (s) => log.push(s), 30);
    expect(await pendingAfter(p, 500)).toBe('settled');
    expect(await p).toBe(false); expect(log[0]).toMatch(/refresh failed — timeout 30 ms/);
  });

  it('review: a hung Telegram — startup() returns, the stop is set before sending', async () => {
    let halted = false;
    const s = new ReconcileScheduler({ run: () => new Promise(() => {}), halted: () => halted, halt: () => { halted = true; },
      notify: () => new Promise(() => {}), startupTimeoutMs: 20, notifyWaitMs: 30, log: () => {} });
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = s.startup();
    expect(await pendingAfter(p, 500)).toBe('settled');
    errs.mockRestore();
    expect(await p).toBe('timeout'); expect(halted).toBe(true);
    // relay (Reconciler messages) does not hang either
    expect(await pendingAfter(s.relay('x'), 500)).toBe('settled');
  });

  it('bounded: success, refusal and hang — never throws', async () => {
    expect(await bounded(Promise.resolve(1), 50)).toBe('done');
    expect(await bounded(Promise.reject(new Error('x')), 50)).toBe('done');
    expect(await bounded(new Promise(() => {}), 20)).toBe('timeout');
  });
});

describe('M-B2: a bridge that returned non-ok stays "in flight" for the Funding pause', () => {
  const W = new Wallets(newKeyMaterial(0)); const ETH = 4000;
  it('review: Relay status — timeout; money left Base and did not arrive — "bridge" in the list for 15 min, then not', async () => {
    let now = Date.UTC(2026, 10, 12, 8);
    const bal: Record<string, number> = { base: 8, robinhood: 0 };
    const evm = (c: string) => ({ cfg: { id: ({ base: 8453, robinhood: 4663, arbitrum: 42161 } as any)[c], rpc: `http://${c}` },
      async balance() { return BigInt(Math.round(((bal[c] ?? 0) / ETH) * 1e18)); },
      async send(_me: any, tx: any) { bal.base -= Number(tx.value) / 1e18 * ETH; return { ok: true, hash: '0xabc', pending: false }; } }) as any;
    const relay: RelayClient = {
      async quote(q) { const usd = Number(q.amount) / 1e18 * ETH;
        return { requestId: 'r1', details: { currencyOut: { amountUsd: String(usd * 0.99) }, recipient: q.recipient },
          steps: [{ id: 'deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { to: '0x1111111111111111111111111111111111111111', data: '0x', value: q.amount.toString(), chainId: 8453 }, check: { endpoint: '/s', method: 'GET' } }] }] } as any; },
      async status() { return 'pending'; },
    };
    const f = new Funding({ relay, evm, wallets: W, nativeUsd: async () => ETH, home: 'base', maxShareOfEquity: 0.6, equityUsd: () => 10, waitMs: 10, sleep: async () => {}, now: () => now,
      fetchImpl: (async () => new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', logs: [] }] }] }))) as any } as any);
    const flying = new InFlight(() => now);
    trackCalls(f, 'ensure', 'bridge', flying, { holdOnFailMs: BRIDGE_HOLD_MS });
    const r = await f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(false); expect(r.note).toMatch(/status: timeout/);
    expect(bal.base).toBeLessThan(8); expect(bal.robinhood).toBe(0);
    expect(flying.list()).toEqual([expect.stringMatching(/^bridge \(outcome unclear until \d\d:\d\d UTC\)$/)]);
    expect(BRIDGE_HOLD_MS).toBe(BRIDGE_COOLDOWN_MS);
    now += BRIDGE_COOLDOWN_MS - 1; expect(flying.list()).toHaveLength(1);
    now += 2; expect(flying.list()).toEqual([]);
  });

  it('an exception is a hold too; ok — no hold; during the call — the plain label', async () => {
    let now = 0; const flying = new InFlight(() => now);
    let release!: (v: unknown) => void;
    const o = { async ok() { return new Promise(r => { release = r; }); }, async boom() { throw new Error('x'); } };
    trackCalls(o, 'ok', 'bridge', flying, { holdOnFailMs: 1000 }); trackCalls(o, 'boom', 'bridge', flying, { holdOnFailMs: 1000 });
    const p = o.ok(); expect(flying.list()).toEqual(['bridge']);
    release({ ok: true }); await p; expect(flying.list()).toEqual([]);
    await expect(o.boom()).rejects.toThrow('x'); expect(flying.list()).toHaveLength(1);
    now = 1001; expect(flying.list()).toEqual([]);
  });
});

describe('S1: /reconcile escaping', () => {
  const status = (): OperatorStatus => ({ mode: 'live', equityUsd: 50, markedEquityUsd: 50, cashUsd: 50, positions: [], operatorHalted: false, dailyStop: false, hardStopped: false });
  const base = { status, setOperatorHalt: () => {}, now: () => 0 };
  it('a plain-text reply — no &lt;; a separate message (HTML) — escaped exactly once, the error too', async () => {
    const late: string[] = [];
    const cmd = operatorCommands({ ...base, replyWaitMs: 20, sendLate: async (t) => { late.push(t); },
      reconcile: { run: async () => 'node: &lt;html&gt; &amp; co', accept: async () => { throw new Error('a < b & c'); } } });
    expect(await cmd('/reconcile')).toBe('node: <html> & co');
    expect(await cmd('/reconcile', 'accept')).toBe('Error (Accept base): a < b & c');
    let release!: () => void;
    const cmd2 = operatorCommands({ ...base, replyWaitMs: 5, sendLate: async (t) => { late.push(t); },
      reconcile: { run: () => new Promise((_, rej) => { release = () => rej(new Error('a < b & c')); }), accept: async () => 'x' } });
    expect(await cmd2('/reconcile')).toMatch(/still running/);
    release(); await new Promise(r => setTimeout(r, 10));
    expect(late).toEqual(['Reconciliation on command: Error (Reconciliation on command): a &lt; b &amp; c']);
    expect(unescHtml('&amp;lt;')).toBe('&lt;');
  });
});

describe('S2: /reconcile accept sent before the process started is not executed', () => {
  it('a message 2 min before startup (not older than 5 min) — refused; after startup — executed', async () => {
    const OWNER_CHAT = '111'; const START = Date.UTC(2026, 10, 12, 8);
    const msg = (id: number, text: string, dateMs: number) => ({ update_id: id, message: { chat: { id: Number(OWNER_CHAT) }, text, date: Math.floor(dateMs / 1000) } });
    const updates = [msg(1, '/reconcile accept', START - 2 * 60_000), msg(2, '/reconcile accept', START + 1000)];
    const sent: any[] = []; let given = false;
    const fetchImpl = (async (url: string, init: any) => {
      const m = String(url).split('/').pop();
      if (m === 'getUpdates') { const result = given ? [] : updates; given = true; if (!result.length) await new Promise(r => setTimeout(r, 5)); return { json: async () => ({ ok: true, result }) }; }
      if (m === 'sendMessage') sent.push(JSON.parse(init.body));
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    const calls: string[] = []; const logged: any[] = [];
    const ctl = startTelegramControl('T', OWNER_CHAT, { onCallback: async () => 'OK', onCommand: async (c, a) => { calls.push(`${c} ${a}`); return 'ok'; } },
      { fetchImpl, now: () => START + 2000, startedAtMs: START, log: (k, d) => logged.push({ k, ...d }) });
    await new Promise(r => setTimeout(r, 40)); ctl.stop();
    expect(calls).toEqual(['/reconcile accept']);
    expect(sent[0].text).toMatch(/was not executed: it was sent before the agent restarted/);
    expect(logged[0]).toMatchObject({ k: 'operator_rejected', reason: 'accept sent before this process started' });
  });
});

describe('S3: AGENT_FUND_HOME', () => {
  it('not set — base; a known chain — that one; unknown or empty: live — startup error, otherwise a warning and base', () => {
    expect(planFundHome(undefined, 'live')).toEqual({ home: 'base' });
    expect(planFundHome(' Arbitrum ', 'live')).toEqual({ home: 'arbitrum' });
    for (const raw of ['etherium', '', 'toString', 'polygon']) {
      expect(planFundHome(raw, 'live').fatal, raw).toMatch(/AGENT_FUND_HOME: unknown chain/);
      const p = planFundHome(raw, 'shadow'); expect(p.fatal).toBeUndefined(); expect(p.home).toBe('base'); expect(p.warn).toMatch(/using base/);
    }
  });
});

describe('M-A1, round 2: a re-check inside the executor lock, each decision has its own price', () => {
  async function world() {
    const { VirtualClock: VC } = await import('../src/clock.js');
    const { guardCall } = await import('../src/liveWiring.js');
    const clock = new VC(Date.UTC(2026, 10, 12, 8));
    const price = new FreshPrice(() => clock.now());
    const guard = new LiveEntryGuard(price); guard.openEntries();
    const bought: string[] = [];
    const nft: any = {
      async buyFloor(p: { slug: string }) { bought.push(p.slug); return { ok: true, holdings: [], spentEth: 0.001, note: 'bought' }; },
      async schedule() { return 'armed'; },
    };
    guardCall(nft, 'buyFloor', guard, (why) => ({ ok: false, holdings: [], spentEth: 0, note: `refused at execution: ${why}`, pending: false }), () => {});
    guardCall(nft, 'schedule', guard, (why) => `mint not planned: ${why}`, () => {});
    // Executor like PaperExecutor: waits for its lock, then calls buyFloor; {ok:false} → exception → skip without a position
    let lock: Promise<void> = Promise.resolve();
    const inner: any = { async execute(_m: any, d: any) {
      await lock;
      const r = await nft.buyFloor({ slug: d.slug });
      if (!r.ok) throw new Error(`live NFT buy failed: ${r.note}`);
    } };
    const exec = guardedExecutor(inner, guard, () => {});
    return { clock, price, guard, nft, bought, exec, setLock: (p: Promise<void>) => { lock = p; } };
  }

  it('review: decision at a fresh 2500, 12 min in the queue behind the monitor, ETH 3200 → buyFloor is not called, execution refuses', async () => {
    const w = await world(); w.price.accept(2500);
    let release!: () => void; w.setLock(new Promise<void>(r => { release = r; }));
    w.guard.ethUsd(); // decide
    const pending = w.exec.execute({} as any, { action: 'nft_buy', chain: 'base', slug: 'a' } as any, 1);
    w.clock.advance(12 * 60_000); w.price.accept(3200);
    release();
    await expect(pending).rejects.toThrow(/live NFT buy failed: refused at execution: ETH price rose 28\.0% since the decision/);
    expect(w.bought).toEqual([]);
  });

  it('two decisions in the queue: each has its own decision price (a shared field would give both the second one\'s price)', async () => {
    const w = await world(); w.price.accept(2500);
    let release!: () => void; w.setLock(new Promise<void>(r => { release = r; }));
    w.guard.ethUsd(); // decide A at 2500
    const a = w.exec.execute({} as any, { action: 'nft_buy', chain: 'base', slug: 'A' } as any, 1);
    w.clock.advance(60_000); w.price.accept(2540);
    w.guard.ethUsd(); // decide B at 2540
    const b = w.exec.execute({} as any, { action: 'nft_buy', chain: 'base', slug: 'B' } as any, 2);
    w.price.accept(2580); // A: +3.2 % — refused; B: +1.6 % — allowed
    release();
    await expect(a).rejects.toThrow(/ETH price rose 3\.2%/);
    await b;
    expect(w.bought).toEqual(['B']);
  });

  it('price is fine — the original is called; outside a decision — refused; mint: a reason string instead of arming', async () => {
    const w = await world(); w.price.accept(2500);
    w.guard.ethUsd();
    await w.exec.execute({} as any, { action: 'nft_buy', chain: 'base', slug: 'ok' } as any, 1);
    expect(w.bought).toEqual(['ok']);
    expect((await w.nft.buyFloor({ slug: 'x' })).note).toMatch(/no decision context/);
    w.clock.advance(10 * 60_000 + 1);
    expect(await w.guard.withDecision({ px: 2500, fresh: true }, () => w.nft.schedule())).toMatch(/^mint not planned: no fresh ETH price$/);
    w.price.accept(2510);
    expect(await w.guard.withDecision(w.guard.priceFor({ action: 'scheduled' } as any), () => w.nft.schedule())).toBe('armed');
    expect(w.bought).toEqual(['ok']);
  });
});

describe('round 2: the bridge is held only if a leg may have left; tick waits for the startup reconciliation', () => {
  it('bridgeLegSent (#134): hold "bridge" — only non-ok with legSent; refusals before sending and a pause — no; ok — no; not an object — yes', async () => {
    const { bridgeLegSent } = await import('../src/liveWiring.js');
    // Refusals before sending: no legSent flag, whatever the text (incl. a Relay step whose name starts with "quote…")
    for (const r of [{ ok: false, note: 'no arbitrum price' }, { ok: false, note: 'bridge quote base→robinhood: 500' },
      { ok: false, note: 'bridge to robinhood paused until 08:15:00 UTC: x' }, { ok: false, note: 'something new' }])
      expect(bridgeLegSent(r), JSON.stringify(r)).toBe(false);
    for (const r of [{ ok: false, note: 'bridge quote-and-deposit: pending 0xabc', legSent: true }, { ok: false, note: 'bridge base→robinhood status: timeout (request r1)', legSent: true },
      { ok: false, note: 'bridged: x', bridged: { from: 'base', usd: 2 }, legSent: true }, undefined, null, 'x'])
      expect(bridgeLegSent(r), JSON.stringify(r)).toBe(true);
    expect(bridgeLegSent({ ok: true, note: 'bridged: x', legSent: true })).toBe(false);
    let now = 0; const flying = new InFlight(() => now);
    const f = { async ensure(n: string, legSent?: boolean) { return { ok: false, note: n, ...(legSent ? { legSent } : {}) }; } };
    trackCalls(f, 'ensure', 'bridge', flying, { holdOnFailMs: BRIDGE_HOLD_MS, holdIf: bridgeLegSent });
    await f.ensure('bridge: boom'); expect(flying.list()).toEqual([]);
    await f.ensure('bridge quote-and-deposit: pending 0xabc', true); expect(flying.list()).toHaveLength(1);
  });

  it('tick with closed entries touches nothing (deferred actions stay in the queue)', async () => {
    const { serialHandler } = await import('../src/pipeline.js');
    const logs: string[] = [];
    const h = serialHandler({ intel: {} as any, entriesOpen: () => false, log: (s: string) => logs.push(s) } as any);
    await h.tick();
    expect(logs).toEqual(['tick postponed: startup wallet reconciliation not finished']);
  });
});
