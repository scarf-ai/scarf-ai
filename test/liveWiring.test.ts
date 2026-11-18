// T-08 (#104): live wiring in index.ts — fresh ETH price (#47), live chains (#97), paper leftovers (E-09), reconciliation (#99), /reconcile.
import { describe, it, expect, vi } from 'vitest';
import {
  CONFIG_EXIT, ETH_PRICE_MAX_AGE_MS, FreshPrice, InFlight, ReconcileScheduler, STARTUP_HALT_REASON, isGoodPrice, paperLeftovers,
  paperLeftoversText, planLiveChains, reconcileChains, refreshPrice, selfRescheduling, trackCalls, type Timers,
} from '../src/liveWiring.js';
import { parseReconcileTolerance, loadConfig } from '../src/config.js';
import { Reconciler, type ReconcileReport } from '../src/live/reconcile.js';
import { operatorCommands, type OperatorStatus } from '../src/notify/commands.js';
import { startTelegramControl, parseArgs, STALE_RESUME_MS } from '../src/notify/telegramControl.js';

const T0 = Date.parse('2026-11-12T10:00:00Z');

/** Manual timers: set remembers, fire runs them one by one; at any moment you can see how many are armed. */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>(); let id = 0; const sets: number[] = [];
  const t: Timers & { fireNext(): void; count(): number; sets: number[] } = {
    set(fn, ms) { pending.set(++id, { fn, ms }); sets.push(ms); return id; },
    clear(h) { pending.delete(h as number); },
    fireNext() { const [k, v] = [...pending.entries()][0]; pending.delete(k); v.fn(); },
    count() { return pending.size; },
    sets,
  };
  return t;
}
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const report = (status: ReconcileReport['status'], why?: string): ReconcileReport =>
  ({ status, why, problems: status === 'mismatch' ? ['mismatch'] : [], walletUsd: 50, ledgerCashUsd: 50, diffUsd: 0, toleranceUsd: 3, lines: [] });

describe('#47: fresh ETH price', () => {
  it('fresh — up to 10 min inclusive; 10 min + 1 ms — no longer', () => {
    let now = T0; const p = new FreshPrice(() => now);
    expect(p.fresh()).toBeUndefined(); // not received yet — no default price
    expect(p.accept(3000)).toBe(true);
    expect(p.fresh()).toBe(3000);
    now = T0 + ETH_PRICE_MAX_AGE_MS; expect(p.fresh()).toBe(3000);
    now = T0 + ETH_PRICE_MAX_AGE_MS + 1; expect(p.fresh()).toBeUndefined();
    expect(p.last()).toBe(3000); // the last real one stays for paper valuations
  });

  it('NaN, 0, negative, Infinity, string — not stored and not passed to the trader', () => {
    const noted: number[] = []; const p = new FreshPrice(() => T0, (px) => noted.push(px));
    for (const bad of [NaN, 0, -1, -0, Infinity, -Infinity, '3000', undefined, null]) expect(p.accept(bad)).toBe(false);
    expect(p.fresh()).toBeUndefined(); expect(p.last()).toBeUndefined(); expect(noted).toEqual([]);
    p.accept(3100); p.accept(NaN);
    expect(p.fresh()).toBe(3100); expect(noted).toEqual([3100]);
    expect(isGoodPrice(1e-9)).toBe(true); expect(isGoodPrice(Number.MAX_VALUE)).toBe(true);
  });

  it('every new valid price goes to the trader (noteNativePrice); an onFresh failure does not break price intake', () => {
    const noted: number[] = []; let now = T0;
    const p = new FreshPrice(() => now, (px) => { noted.push(px); if (px === 2) throw new Error('boom'); });
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    p.accept(1); now += 60_000; p.accept(2); now += 60_000; p.accept(3);
    errs.mockRestore();
    expect(noted).toEqual([1, 2, 3]); expect(p.fresh()).toBe(3);
  });

  it('update failure: the old price ages and after 10 min buys have no price; an invalid answer is a failure too', async () => {
    let now = T0; const p = new FreshPrice(() => now); const log: string[] = [];
    expect(await refreshPrice(p, async () => 2900, (s) => log.push(s))).toBe(true);
    now += 2 * 60_000;
    expect(await refreshPrice(p, async () => { throw new Error('dexscreener 503'); }, (s) => log.push(s))).toBe(false);
    expect(p.fresh()).toBe(2900); // 2 min — still fresh
    now = T0 + ETH_PRICE_MAX_AGE_MS + 1;
    expect(await refreshPrice(p, async () => NaN, (s) => log.push(s))).toBe(false);
    expect(p.fresh()).toBeUndefined();
    expect(log.join('\n')).toMatch(/refresh failed — dexscreener 503/);
    expect(log.join('\n')).toMatch(/live buys in ETH chains are refused until a fresh price arrives/);
    now += 1000;
    expect(await refreshPrice(p, async () => 3050, (s) => log.push(s))).toBe(true);
    expect(p.fresh()).toBe(3050);
  });
});

describe('timer re-armed in finally', () => {
  it('the next run — only after the current one ends; an exception does not stop the timer; stop — clears it', async () => {
    const t = manualTimers(); let calls = 0; const errs: string[] = [];
    let release!: () => void;
    const loop = selfRescheduling('x', async () => {
      calls++;
      if (calls === 1) await new Promise<void>(r => { release = r; });
      if (calls === 2) throw new Error('boom');
    }, 600_000, t, (s) => errs.push(s));
    expect(t.count()).toBe(1);
    t.fireNext(); await flush();
    expect(calls).toBe(1); expect(t.count()).toBe(0); // a pass is running — a second one is not armed (not setInterval)
    release(); await flush();
    expect(t.count()).toBe(1);
    t.fireNext(); await flush(); // throws
    expect(calls).toBe(2); expect(errs[0]).toMatch(/x: run failed — boom/); expect(t.count()).toBe(1);
    t.fireNext(); await flush();
    expect(calls).toBe(3); expect(t.count()).toBe(1);
    expect(t.sets.every(ms => ms === 600_000)).toBe(true);
    loop.stop(); expect(t.count()).toBe(0);
  });
});

describe('#97: live buy chains (AGENT_LIVE_CHAINS)', () => {
  it('not set — the default list in any mode', () => {
    const p = planLiveChains(undefined, 'live');
    expect(p.traderList).toBeUndefined(); expect(p.chains).toEqual(['base', 'robinhood', 'arbitrum', 'solana']);
    expect(p.line).toBe('live buy chains: base, robinhood, arbitrum, solana (default)'); expect(p.fatal).toBeUndefined();
  });
  it('the list goes to the trader and to the log line', () => {
    const p = planLiveChains(' Base, robinhood ,base', 'live');
    expect(p.traderList).toEqual(['base', 'robinhood']); expect(p.line).toBe('live buy chains: base, robinhood (AGENT_LIVE_CHAINS)'); expect(p.fatal).toBeUndefined();
  });
  it('typo or empty list: live — startup error; paper/shadow — a warning and the default list', () => {
    for (const raw of ['etherium', 'base,etherium', '', ' , ']) {
      const live = planLiveChains(raw, 'live');
      expect(live.fatal, raw).toMatch(raw.includes('etherium') ? /unknown chain "etherium"/ : /set but empty/);
      for (const mode of ['paper', 'shadow'] as const) {
        const p = planLiveChains(raw, mode);
        expect(p.fatal).toBeUndefined(); expect(p.traderList).toBeUndefined(); expect(p.warn).toMatch(/using the default list/);
      }
    }
    expect(CONFIG_EXIT).toBe(78);
  });
});

describe('E-09: paper leftovers in the ledger before live', () => {
  it('open positions not in live mode are counted (paper, empty, null)', () => {
    expect(paperLeftovers([])).toBe(0);
    expect(paperLeftovers([{ mode: 'live' }, { mode: 'live' }])).toBe(0);
    expect(paperLeftovers([{ mode: 'paper' }, { mode: 'live' }, { mode: null }, {}])).toBe(3);
    const t = paperLeftoversText(3);
    expect(t).toMatch(/3 open positions not in live mode/); expect(t).toMatch(/live deployment guide, section 6, step 0/);
    expect(paperLeftoversText(1)).toMatch(/1 open position not/); expect(paperLeftoversText(5)).toMatch(/5 open positions/);
  });
});

describe('#99: reconciliation tolerance — no default value', () => {
  const env = (share?: string, usd?: string) => ({ ...(share !== undefined ? { AGENT_RECONCILE_TOLERANCE_SHARE: share } : {}), ...(usd !== undefined ? { AGENT_RECONCILE_TOLERANCE_USD: usd } : {}) }) as NodeJS.ProcessEnv;
  it('valid values and bounds', () => {
    expect(parseReconcileTolerance(env('0.15', '3'))).toEqual({ ok: true, share: 0.15, usd: 3 });
    expect(parseReconcileTolerance(env('0', '0'))).toEqual({ ok: true, share: 0, usd: 0 });
    expect(parseReconcileTolerance(env('0.5', '100'))).toEqual({ ok: true, share: 0.5, usd: 100 });
    expect(parseReconcileTolerance(env(' 0.2 ', '5'))).toEqual({ ok: true, share: 0.2, usd: 5 });
  });
  it('one or both missing, NaN, negative, 0.51, 101, 0x, 1e3, Infinity — refusal naming the variable', () => {
    const bad: [string | undefined, string | undefined, RegExp][] = [
      [undefined, undefined, /AGENT_RECONCILE_TOLERANCE_SHARE is not set.*AGENT_RECONCILE_TOLERANCE_USD is not set/],
      [undefined, '3', /AGENT_RECONCILE_TOLERANCE_SHARE is not set/],
      ['0.15', undefined, /AGENT_RECONCILE_TOLERANCE_USD is not set/],
      ['', '3', /SHARE is not set/],
      ['abc', '3', /SHARE="abc" — must be a number from 0 to 0.5/],
      ['NaN', '3', /SHARE="NaN"/],
      ['-0.1', '3', /SHARE="-0.1"/],
      ['0.51', '3', /SHARE="0.51"/],
      ['0.15', '101', /USD="101" — must be a number from 0 to 100/],
      ['0.15', '-1', /USD="-1"/],
      ['0.15', '0x10', /USD="0x10"/],
      ['0.15', '1e1', /USD="1e1"/],
      ['0.15', 'Infinity', /USD="Infinity"/],
    ];
    for (const [s, u, re] of bad) {
      const r = parseReconcileTolerance(env(s, u));
      expect(r.ok, `${s} ${u}`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(re);
    }
  });
  it('loadConfig does not fail without the settings (paper/shadow do not need them) and returns the parse', () => {
    const c = loadConfig({ AGENT_ROOT: process.cwd(), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv);
    expect(c.reconcileTolerance.ok).toBe(false);
    const c2 = loadConfig({ AGENT_ROOT: process.cwd(), AGENT_RECONCILE_TOLERANCE_SHARE: '0.1', AGENT_RECONCILE_TOLERANCE_USD: '3' } as NodeJS.ProcessEnv);
    expect(c2.reconcileTolerance).toEqual({ ok: true, share: 0.1, usd: 3 });
  });
});

describe('#99: reconciliation chains and "in flight"', () => {
  const cfg = (chain: string) => ({ chain, id: 1, native: 'ETH', rpc: `http://${chain}`, send: [], priorityMatters: false }) as any;
  const all = { ethereum: cfg('ethereum'), base: cfg('base'), arbitrum: cfg('arbitrum'), bsc: cfg('bsc'), robinhood: cfg('robinhood') };
  it('only live chains (+ the deposit chain); Solana — by flag; a live chain without RPC — in missing', () => {
    const r = reconcileChains(all, ['base', 'robinhood', 'solana'], 'base');
    expect(Object.keys(r.evm).sort()).toEqual(['base', 'robinhood']); expect(r.solana).toBe(true); expect(r.missing).toEqual([]);
    const r2 = reconcileChains({ base: all.base }, ['base', 'arbitrum'], 'ethereum');
    expect(Object.keys(r2.evm)).toEqual(['base']); expect(r2.solana).toBe(false); expect(r2.missing.sort()).toEqual(['arbitrum', 'ethereum']);
    const r3 = reconcileChains(all, ['arbitrum'], 'base');
    expect(Object.keys(r3.evm).sort()).toEqual(['arbitrum', 'base']);
  });
  it('trackCalls: the label is visible while the call runs; removed after success and after an exception; result and this — unchanged', async () => {
    const f = new InFlight();
    const obj = { k: 2, async buy(x: number) { await new Promise(r => setTimeout(r, 5)); return x * this.k; }, async fail() { throw new Error('nope'); } };
    trackCalls(obj, 'buy', 'buy', f); trackCalls(obj, 'fail', 'bridge', f);
    const p1 = obj.buy(3); const p2 = obj.buy(4);
    expect(f.list()).toEqual(['buy ×2']);
    expect(await p1).toBe(6); expect(await p2).toBe(8);
    expect(f.list()).toEqual([]);
    const p3 = obj.fail(); expect(f.list()).toEqual(['bridge']);
    await expect(p3).rejects.toThrow('nope'); expect(f.list()).toEqual([]);
  });
});

describe('#99: reconciliation schedule', () => {
  function sched(run: (ph: 'startup' | 'periodic') => Promise<ReconcileReport>, o: { halted?: boolean; timeoutMs?: number } = {}) {
    const st = { halted: o.halted ?? false, reasons: [] as string[], said: [] as string[] };
    const t = manualTimers();
    const s = new ReconcileScheduler({ run, halted: () => st.halted, halt: (r) => { st.halted = true; st.reasons.push(r); },
      notify: async (x) => { st.said.push(x); }, log: () => {}, startupTimeoutMs: o.timeoutMs ?? 30_000, timers: t });
    return { s, st, t };
  }

  it('startup matched — no stop, no messages from the schedule; mismatch — the stop and the message are done by Reconciler itself', async () => {
    const a = sched(async () => report('ok'));
    expect(await a.s.startup()).toBe('ok'); expect(a.st.halted).toBe(false); expect(a.st.said).toEqual([]);
    const b = sched(async () => report('mismatch'));
    expect(await b.s.startup()).toBe('mismatch'); expect(b.st.reasons).toEqual([]); expect(b.st.said).toEqual([]);
  });

  it('"not done" at startup — a stop with the reason and a clarification; the first successful reconciliation — one line that the owner lifts the stop', async () => {
    let next: ReconcileReport = report('skipped', 'no native coin price for base');
    const { s, st, t } = sched(async () => next);
    expect(await s.startup()).toBe('skipped');
    expect(st.halted).toBe(true);
    expect(st.reasons[0]).toBe(`${STARTUP_HALT_REASON}: no native coin price for base`);
    expect(st.said).toHaveLength(1); expect(st.said[0]).toMatch(/Clarification to the message above: in live without reconciliation new entries are stopped/);
    // Reconciler messages get a line about the startup stop while it is in force
    await s.relay('ℹ️ Failed 3 times in a row. New entries are not stopped yet');
    expect(st.said[1]).toMatch(/New entries are stopped now: the stop set at startup/);
    s.start();
    t.fireNext(); await flush(); // "not done" again — lifts nothing, we write nothing ourselves
    expect(st.said).toHaveLength(2); expect(st.halted).toBe(true);
    next = report('ok');
    t.fireNext(); await flush();
    expect(st.halted).toBe(true); // does not lift by itself
    expect(st.said).toHaveLength(3); expect(st.said[2]).toMatch(/Wallet reconciliation passed.*is not lifted automatically — lift it: \/resume/);
    t.fireNext(); await flush();
    expect(st.said).toHaveLength(3); // the reminder — once
    await s.relay('x'); expect(st.said[3]).toBe('x'); // the startup stop line is no longer added
    s.stop();
  });

  it('did not finish within 30 s — "reconciliation not done" stop; a late result does not overlap the timer; the owner lifted the stop — no reminder', async () => {
    let resolveStartup!: (r: ReconcileReport) => void; let calls = 0;
    const { s, st, t } = sched((ph) => { calls++; return ph === 'startup' ? new Promise(r => { resolveStartup = r; }) : Promise.resolve(report('ok')); });
    const out = s.startup();
    await flush(); t.fireNext(); // 30 s timer
    expect(await out).toBe('timeout');
    expect(st.halted).toBe(true); expect(st.reasons[0]).toMatch(/did not finish within 30 s/);
    expect(st.said[0]).toMatch(/⛔ Wallet reconciliation at startup did not finish within 30 s\. New entries are stopped/);
    s.start(); t.fireNext(); await flush();
    expect(calls).toBe(1); // the startup pass is still running — a second one does not start
    const manual = s.runNow(); expect(calls).toBe(1); // /reconcile during a pass — the same pass
    st.halted = false; // the owner: /resume
    resolveStartup(report('ok')); expect((await manual).status).toBe('ok'); await flush();
    expect(st.said).toHaveLength(1); // the stop is already lifted — nothing to remind about
    s.stop();
  }, 10_000);

  it('a pass threw — the process is alive, the timer is re-armed; passes do not overlap (runNow during a pass — the same pass)', async () => {
    let n = 0; let release!: () => void;
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { s, t } = sched(async () => {
      n++;
      if (n === 1) throw new Error('rpc exploded');
      if (n === 2) await new Promise<void>(r => { release = r; });
      return report('ok');
    });
    s.start();
    t.fireNext(); await flush();
    expect(n).toBe(1); expect(t.count()).toBe(1);
    expect(errs.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/reconcile periodic: run failed — rpc exploded/);
    t.fireNext(); await flush();
    expect(n).toBe(2); expect(t.count()).toBe(0);
    const manual = s.runNow(); const manual2 = s.runNow();
    expect(n).toBe(2);
    release(); await manual; await manual2; await flush();
    expect(n).toBe(2); expect(t.count()).toBe(1);
    errs.mockRestore(); s.stop();
  });

  it('with a real Reconciler: no ETH price at startup → "not done" → stop on new entries until /resume', async () => {
    const said: string[] = []; let halted = false; const reasons: string[] = [];
    const rpc = async (_u: string, m: string) => (m === 'eth_getBalance' ? '0x' + (10n ** 16n).toString(16) : '0x7');
    let sched!: ReconcileScheduler;
    const rec = new Reconciler({ chains: { base: { chain: 'base', id: 8453, native: 'ETH', rpc: 'http://base', send: [], priorityMatters: true } }, evmAddress: '0x1111111111111111111111111111111111111111',
      nativeUsd: async () => undefined, ledger: () => ({ cashUsd: 40, equityUsd: 40, positionsCostUsd: 0, pendingBuyUsd: 0 }), toleranceShare: 0.15, toleranceUsd: 3, rpc: rpc as any, confirmMs: 0 },
    { notify: (t) => sched.relay(t), halt: (r) => { halted = true; reasons.push(r); }, halted: () => halted });
    sched = new ReconcileScheduler({ run: (ph) => rec.run(ph), halted: () => halted, halt: (r) => { halted = true; reasons.push(r); }, notify: async (t) => { said.push(t); }, log: () => {} });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await sched.startup()).toBe('skipped');
    logs.mockRestore();
    expect(halted).toBe(true);
    expect(said[0]).toMatch(/ℹ️ Wallet reconciliation not done: no native coin price for base/);
    expect(said[1]).toMatch(/Clarification to the message above/);
    expect(reasons[0]).toMatch(/wallet reconciliation at startup failed/);
  });
});

describe('/reconcile — the owner command', () => {
  const status = (): OperatorStatus => ({ mode: 'live', equityUsd: 50, markedEquityUsd: 50, cashUsd: 50, positions: [], operatorHalted: false, dailyStop: false, hardStopped: false });
  const base = { status, setOperatorHalt: () => {}, now: () => T0 };

  it('without reconciliation (paper/shadow) — an honest answer; accept calls acceptCurrent and returns its text as is; /reconcile — the reconciliation result', async () => {
    expect(await operatorCommands({ ...base, status: () => ({ ...status(), mode: 'paper' }) })('/reconcile', 'accept')).toMatch(/in paper mode — it works only in live/);
    const accept = vi.fn(async () => 'Base not accepted: a buy is in flight — money moves outside the ledger, the base would be wrong. Repeat after the outcome.');
    const run = vi.fn(async () => '✅ Wallet reconciliation: matches');
    const logged: any[] = [];
    const cmd = operatorCommands({ ...base, reconcile: { run, accept }, log: (k, d) => logged.push({ k, ...d }) });
    expect(await cmd('/reconcile', 'accept')).toBe('Base not accepted: a buy is in flight — money moves outside the ledger, the base would be wrong. Repeat after the outcome.');
    expect(accept).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
    expect(await cmd('/reconcile')).toBe('✅ Wallet reconciliation: matches'); expect(run).toHaveBeenCalledTimes(1);
    expect(await cmd('/reconcile', 'acept')).toMatch(/Did not understand .\/reconcile acept./); expect(accept).toHaveBeenCalledTimes(1);
    expect(await cmd('/help')).toMatch(/\/reconcile accept — accept the current balance as the base/);
    expect(logged.map(l => `${l.cmd} ${l.args ?? ''}`.trim())).toEqual(['/reconcile accept', '/reconcile', '/reconcile acept', '/help']);
  });

  it('a long reconciliation does not hold the Telegram poll: answer "will send separately", the result — a separate message; failure — as text', async () => {
    const late: string[] = []; let release!: (t: string) => void;
    const cmd = operatorCommands({ ...base, replyWaitMs: 10, sendLate: async (t) => { late.push(t); },
      reconcile: { run: () => new Promise(r => { release = r; }), accept: async () => { throw new Error('rpc down'); } } });
    expect(await cmd('/reconcile')).toMatch(/still running.*I will send the result in a separate message/);
    release('⛔ Wallet reconciliation does NOT match'); await new Promise(r => setTimeout(r, 5));
    expect(late).toEqual(['Reconciliation on command: ⛔ Wallet reconciliation does NOT match']);
    expect(await cmd('/reconcile', 'accept')).toBe('Error (Accept base): rpc down');
  });

  it('only from the owner chat; the argument arrives; a stale accept is not executed', async () => {
    const OWNER_CHAT = '111'; const NOW = T0;
    const msg = (id: number, chat: string, text: string, dateMs = NOW) => ({ update_id: id, message: { chat: { id: Number(chat) }, text, date: Math.floor(dateMs / 1000) } });
    const updates = [msg(1, '999', '/reconcile accept'), msg(2, OWNER_CHAT, '/reconcile@scarf_bot Accept', NOW - STALE_RESUME_MS - 1000), msg(3, OWNER_CHAT, '/reconcile accept'), msg(4, OWNER_CHAT, '/reconcile')];
    const sent: any[] = []; let given = false;
    const fetchImpl = (async (url: string, init: any) => {
      const m = String(url).split('/').pop();
      if (m === 'getUpdates') { const result = given ? [] : updates; given = true; if (!result.length) await new Promise(r => setTimeout(r, 5)); return { json: async () => ({ ok: true, result }) }; }
      if (m === 'sendMessage') sent.push(JSON.parse(init.body));
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    const calls: string[] = []; const logged: any[] = [];
    const ctl = startTelegramControl('T', OWNER_CHAT, { onCallback: async () => 'OK', onCommand: async (c, a) => { calls.push(`${c}|${a ?? ''}`); return `ok ${c} ${a ?? ''}`.trim(); } },
      { fetchImpl, now: () => NOW, log: (k, d) => logged.push({ k, ...d }) });
    await new Promise(r => setTimeout(r, 40)); ctl.stop();
    expect(calls).toEqual(['/reconcile|accept', '/reconcile|']);
    expect(sent.every(s => s.chat_id === OWNER_CHAT)).toBe(true);
    expect(sent.map(s => s.text)).toEqual([expect.stringMatching(/\/reconcile accept from .* UTC was not executed: it sat in the queue for more than 5 minutes/), 'ok /reconcile accept', 'ok /reconcile']);
    expect(logged.map(l => `${l.k} ${l.cmd} ${l.reason}`)).toEqual(['operator_rejected /reconcile not the owner chat', 'operator_rejected /reconcile accept stale /reconcile accept']);
    expect(logged[0].chatId).toBe('999');
    expect(parseArgs('/reconcile@scarf_bot  Accept ')).toBe('accept');
  });
});
