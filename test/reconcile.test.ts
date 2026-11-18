// E-03 (#13), minimal version: reconciling ledger cash with the treasury native balances; a nonce gap at startup.
import { describe, it, expect, vi } from 'vitest';
import { reconcile, reconcileText, Reconciler, type ReconcileDeps, type ReconcileLedger } from '../src/live/reconcile.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const cfg = (chain: string, rpc: string) => ({ chain, id: 1, native: 'ETH', rpc, send: [rpc], priorityMatters: false });
const wei = (eth: number) => '0x' + BigInt(Math.round(eth * 1e18)).toString(16);

/** Nodes: balance and nonce counters per chain; Solana — getBalance. */
function world(o: { base?: number; robinhood?: number; sol?: number; pending?: Record<string, number>; latest?: number; fail?: string } = {}) {
  const bal: Record<string, number> = { 'http://base': o.base ?? 0.01, 'http://rh': o.robinhood ?? 0.0025 };
  const st = { ...o, bal };
  const rpc = async (u: string, m: string, params: any[]) => {
    if (st.fail === u) throw new TypeError('fetch failed');
    if (m === 'eth_getBalance') return wei(st.bal[u]);
    if (m === 'eth_getTransactionCount') return '0x' + (params[1] === 'pending' ? (st.pending?.[u] ?? st.latest ?? 7) : (st.latest ?? 7)).toString(16);
    if (m === 'getBalance') return { context: { slot: 1 }, value: Math.round((st.sol ?? 0) * 1e9) };
    throw new Error(m);
  };
  return { st, rpc };
}
function deps(w: ReturnType<typeof world>, o: Partial<ReconcileDeps> = {}, ledger = { cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 }): ReconcileDeps {
  return { chains: { base: cfg('base', 'http://base'), robinhood: cfg('robinhood', 'http://rh') } as any, evmAddress: ADDR,
    nativeUsd: async (c) => (c === 'solana' ? 200 : 4000), ledger: () => ledger, toleranceShare: 0.15, toleranceUsd: 3, rpc: w.rpc as any, confirmMs: 0, ...o };
}

describe('E-03 (minimum): reconciling the ledger with the treasury wallet', () => {
  it('matches: $40 on Base + $10 on Robinhood against $50 cash; text with numbers per chain', async () => {
    const r = await reconcile(deps(world()), 'startup');
    expect(r.status).toBe('ok'); expect(r.walletUsd).toBeCloseTo(50, 6); expect(r.toleranceUsd).toBeCloseTo(7.5, 6);
    const t = reconcileText(r, { equityUsd: 50, positionsCostUsd: 0 });
    expect(t).toMatch(/✅ Wallet reconciliation: matches/);
    expect(t).toMatch(/base: 0\.010000 ≈ \$40\.00 · robinhood: 0\.002500 ≈ \$10\.00 — total \$50\.00/);
    expect(t).toMatch(/Ledger: cash \$50\.00, in positions \$0\.00, capital \$50\.00; tolerance \$7\.50/);
  });

  it('part of the capital in positions: cash is reconciled, not capital; Solana is included in the sum', async () => {
    const w = world({ base: 0.009, robinhood: 0, sol: 0.05 }); // $36 + $0 + $10
    const r = await reconcile(deps(w, { sol: { address: 'So1', rpc: 'http://sol' } }, { cashUsd: 46, equityUsd: 50, positionsCostUsd: 4, pendingBuyUsd: 0 }), 'periodic');
    expect(r.status).toBe('ok'); expect(r.walletUsd).toBeCloseTo(46, 6);
    expect(r.lines.map(l => l.chain)).toEqual(['base', 'robinhood', 'solana']);
  });

  it('an ETH price move within the tolerance — not an alarm; beyond it — a mismatch', async () => {
    expect((await reconcile(deps(world(), { nativeUsd: async () => 3600 }), 'periodic')).status).toBe('ok'); // $45 with a $7.50 tolerance
    const r = await reconcile(deps(world(), { nativeUsd: async () => 3000 }), 'periodic'); // $37.50
    expect(r.status).toBe('mismatch');
    expect(r.problems[0]).toMatch(/treasury wallet holds \$37\.50, ledger cash \$50\.00 — mismatch −\$12\.50 with tolerance \$7\.50/);
  });

  it('the deposit did not arrive (wallet empty) or the wallet holds noticeably more than the ledger → mismatch; a small cash uses the minimum $ tolerance', async () => {
    const empty = await reconcile(deps(world({ base: 0, robinhood: 0 })), 'startup');
    expect(empty.status).toBe('mismatch'); expect(empty.problems[0]).toMatch(/mismatch −\$50\.00/);
    const more = await reconcile(deps(world({ base: 0.02 })), 'startup'); // $90
    expect(more.status).toBe('mismatch'); expect(more.problems[0]).toMatch(/mismatch \+\$40\.00/);
    const small = await reconcile(deps(world({ base: 0.002, robinhood: 0 }), {}, { cashUsd: 6, equityUsd: 6, positionsCostUsd: 0, pendingBuyUsd: 0 }), 'startup'); // $8 against $6, tolerance max($3, $0.90)
    expect(small.status).toBe('ok'); expect(small.toleranceUsd).toBe(3);
  });

  it('nonce gap: at startup — a problem (a transaction from the previous run without accounting); while running — reconciliation is postponed', async () => {
    const w = world({ pending: { 'http://base': 9 }, latest: 7 });
    const s = await reconcile(deps(w), 'startup');
    expect(s.status).toBe('mismatch');
    expect(s.problems[0]).toMatch(/transactions sent before the restart that are not yet in a block: base: 2 \(nonce 7…8\)/);
    const p = await reconcile(deps(w), 'periodic');
    expect(p.status).toBe('skipped'); expect(p.why).toMatch(/transactions in flight \(base: 2/);
    expect(reconcileText(s, { equityUsd: 50, positionsCostUsd: 0 })).toMatch(/base: 0\.010000 ≈ \$40\.00 \(in flight: 2\)/);
  });

  it('money in flight: the executor flag postpones reconciliation; the buy reserve — an adjustment, not a skip; a node failure or no price — "not done", not a mismatch', async () => {
    const flying = await reconcile(deps(world(), { inFlight: () => ['buy 0x4444… (Relay bridge)'] }), 'periodic');
    expect(flying.status).toBe('skipped'); expect(flying.why).toMatch(/in flight: buy 0x4444… \(Relay bridge\)/);
    // #117 item 3: at startup the position monitor is already running — an ongoing sale postpones the startup reconciliation too (it was not noticed before)
    const atStart = await reconcile(deps(world(), { inFlight: () => ['buy'] }), 'startup');
    expect(atStart.status).toBe('skipped'); expect(atStart.why).toMatch(/in flight: buy/);
    // a $2.01 reserve is pending, wallet = cash → matches (adjustment within tolerance); the wallet already without $2 → matches too (spent on the buy)
    const pend = await reconcile(deps(world(), {}, { cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 2.01 }), 'periodic');
    expect(pend.status).toBe('ok');
    const down = await reconcile(deps(world({ fail: 'http://rh' })), 'startup');
    expect(down.status).toBe('skipped'); expect(down.why).toMatch(/robinhood: node did not answer: fetch failed/); expect(down.unknownChains).toEqual(['robinhood']);
    const noPx = await reconcile(deps(world(), { nativeUsd: async () => undefined }), 'startup');
    expect(noPx.status).toBe('skipped'); expect(noPx.why).toMatch(/no native coin price for base/);
    const pxThrows = await reconcile(deps(world(), { nativeUsd: async () => { throw new Error('dex down'); } }), 'startup');
    expect(pxThrows.status).toBe('skipped');
    // an empty chain without a price does not hinder reconciliation
    const partial = await reconcile(deps(world({ base: 0.0125, robinhood: 0 }), { nativeUsd: async (c) => (c === 'base' ? 4000 : undefined) }), 'startup');
    expect(partial.status).toBe('ok');
    const none = await reconcile(deps(world(), { evmAddress: undefined }), 'startup');
    expect(none.status).toBe('skipped'); expect(none.why).toMatch(/no chain to reconcile/);
  });
});

describe('E-03 (minimum): Reconciler — stop on new entries and messages to the owner', () => {
  function rig(w: ReturnType<typeof world>, o: Partial<ReconcileDeps> = {}) {
    const sent: string[] = []; const halts: string[] = []; let halted = false;
    const r = new Reconciler(deps(w, o), { notify: async (t) => { sent.push(t); }, halt: (why) => { halts.push(why); halted = true; }, halted: () => halted });
    return { r, sent, halts };
  }
  it('startup: matched — one message with numbers, no stop; after that on "matches" — silence', async () => {
    const x = rig(world());
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await x.r.run('startup');
      expect(x.sent.length).toBe(1); expect(x.sent[0]).toMatch(/✅ Wallet reconciliation: matches/); expect(x.halts).toEqual([]);
      await x.r.run('periodic'); await x.r.run('periodic');
      expect(x.sent.length).toBe(1);
    } finally { log.mockRestore(); }
  });

  it('mismatch → stop on new entries and one message; the same mismatch again — the stop is confirmed, the message is not repeated; matched — a message, the stop is not lifted by itself', async () => {
    const w = world();
    const x = rig(w);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await x.r.run('startup');
      w.st.bal['http://base'] = 0.004; // $24 left the wallet without accounting
      await x.r.run('periodic');
      expect(x.halts.length).toBe(1); expect(x.halts[0]).toMatch(/mismatch −\$24\.00/);
      expect(x.sent.length).toBe(2);
      expect(x.sent[1]).toMatch(/⛔ Wallet reconciliation does NOT match:[\s\S]*New entries stopped \(like \/stop\), position exits work[\s\S]*\/resume/);
      w.st.bal['http://base'] = 0.0041; // the same problems, slightly different numbers
      await x.r.run('periodic');
      expect(x.halts.length).toBe(2); expect(x.sent.length).toBe(2);
      w.st.bal['http://base'] = 0.01;
      await x.r.run('periodic');
      expect(x.sent.length).toBe(3); expect(x.sent[2]).toMatch(/matches[\s\S]*The stop on new entries is NOT lifted — lift it yourself: \/resume/);
      expect(x.halts.length).toBe(2);
    } finally { log.mockRestore(); }
  });

  it('a nonce gap at startup → stop and a message; reconciliation failed — at startup a message without a stop, while running — one message after three failures in a row; a Telegram failure does not break reconciliation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const g = rig(world({ pending: { 'http://rh': 8 }, latest: 7 }));
      await g.r.run('startup');
      expect(g.halts.length).toBe(1); expect(g.sent[0]).toMatch(/sent before the restart[\s\S]*robinhood: 1 \(nonce 7…7\)/);
      const w = world({ fail: 'http://base' });
      const x = rig(w);
      await x.r.run('startup');
      expect(x.halts).toEqual([]); expect(x.sent.length).toBe(1); expect(x.sent[0]).toMatch(/Wallet reconciliation not done: base: node did not answer[\s\S]*New entries are not stopped/);
      await x.r.run('periodic'); expect(x.sent.length).toBe(1);
      await x.r.run('periodic'); expect(x.sent.length).toBe(2); expect(x.sent[1]).toMatch(/Failed 3 times in a row/);
      await x.r.run('periodic'); expect(x.sent.length).toBe(2);
      const bad = new Reconciler(deps(world({ base: 0 })), { notify: async () => { throw new Error('telegram down'); }, halt: () => undefined, halted: () => true });
      expect((await bad.run('startup')).status).toBe('mismatch');
      expect(errs.mock.calls.some(c => /notify failed/.test(String(c[0])))).toBe(true);
    } finally { log.mockRestore(); errs.mockRestore(); }
  });
});

describe('E-03, acceptance #100 round 1', () => {
  const quiet = () => { const a = vi.spyOn(console, 'log').mockImplementation(() => undefined); const b = vi.spyOn(console, 'error').mockImplementation(() => undefined); return () => { a.mockRestore(); b.mockRestore(); }; };
  function rig(w: ReturnType<typeof world>, o: Partial<ReconcileDeps> = {}, ledger?: () => ReconcileLedger) {
    const sent: string[] = []; const halts: string[] = []; let halted = false;
    const d = deps(w, o); if (ledger) d.ledger = ledger;
    const r = new Reconciler(d, { notify: async (t) => { sent.push(t); }, halt: (why) => { halts.push(why); halted = true; }, halted: () => halted });
    return { r, sent, halts, resume: () => { halted = false; }, isHalted: () => halted };
  }

  it('item 1 (C5/R1): after /resume the same mismatch turns the stop on again — WITH a message and a hint; acceptCurrent accepts the baseline, and this mismatch no longer turns the stop on', async () => {
    const off = quiet();
    try {
      const w = world({ base: 0.0125, robinhood: 0 }); // 0.0125 ETH = $50 at $4000
      let px = 4000;
      const x = rig(w, { nativeUsd: async () => px });
      await x.r.run('startup'); expect(x.sent.length).toBe(1);
      px = 3360; // ETH −16 % without a single trade: $42, tolerance $7.50
      await x.r.run('periodic');
      expect(x.isHalted()).toBe(true); expect(x.sent.length).toBe(2);
      x.resume(); // the owner checked the wallet (intact) and lifted the stop
      await x.r.run('periodic');
      expect(x.isHalted()).toBe(true); expect(x.sent.length).toBe(3); // the stop again — and the message again, with a hint
      expect(x.sent[2]).toMatch(/The stop was lifted \(\/resume\), but the mismatch remained[\s\S]*\/reconcile accept/);
      const ack = await x.r.acceptCurrent();
      expect(ack).toMatch(/Baseline accepted: wallet \$42\.00 \(base 0\.012500, robinhood 0\.000000\), cash \$50\.00, the difference of −\$8\.00 now counts as normal/);
      expect(x.r.baseline).toMatchObject({ native: { base: 0.0125, robinhood: 0 }, cashUsd: 50 });
      x.resume();
      await x.r.run('periodic'); await x.r.run('periodic');
      expect(x.isHalted()).toBe(false); expect(x.sent.length).toBe(3); // the answer about the accepted baseline already went as a command reply; matches — silence, no stop
      w.st.bal['http://base'] = 0.0095; // but a real shortfall of another $10 ($31.92 against the $42 baseline) — is caught
      await x.r.run('periodic');
      expect(x.isHalted()).toBe(true); expect(x.sent.at(-1)).toMatch(/mismatch −\$10\.08 with tolerance \$7\.50 \(against the accepted baseline: wallet then \$42\.00 at today's prices, cash \$50\.00\)/);
    } finally { off(); }
  });

  it('item 2 (C7/R5): money in flight — the executor flag postpones reconciliation; without the flag a mismatch is confirmed by a second pass, and if the ledger caught up — no stop', async () => {
    const off = quiet();
    try {
      const w = world({ base: 0.0125, robinhood: 0 });
      let flying: string[] = []; let cash = 50;
      const slept: number[] = [];
      const x = rig(w, { inFlight: () => flying, confirmMs: 60_000, sleep: async (ms) => { slept.push(ms); w.st.bal['http://base'] = 0.0125; cash = 50; } }, () => ({ cashUsd: cash, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 }));
      await x.r.run('startup');
      // the bridge took $10 from Base, a buy is running: the executor raised the flag
      w.st.bal['http://base'] = 0.01; flying = ['buy 0x4444… (Relay bridge)'];
      expect((await x.r.run('periodic')).status).toBe('skipped'); expect(x.isHalted()).toBe(false);
      // no flag (e.g. arming a mint): the first pass sees −$15, a minute later the money is back — the second pass matches, no stop
      flying = []; w.st.bal['http://base'] = 0.00875;
      const r = await x.r.run('periodic');
      expect(slept).toEqual([60_000]); expect(r.status).toBe('ok'); expect(x.isHalted()).toBe(false);
      // the ledger changed while polling the nodes — postpone
      let n = 0;
      const y = rig(world({ base: 0.0125, robinhood: 0 }), {}, () => ({ cashUsd: n++ === 0 ? 50 : 40, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 }));
      expect((await y.r.run('periodic')).why).toMatch(/the ledger changed during reconciliation/);
    } finally { off(); }
  });

  it('item 3 (C6/R2/R3/R4): a node failure on one chain does not break the others (last known balance); an hour without reconciliation → a stop and a reminder every hour; recovery — a message; a pending reserve does not turn reconciliation off', async () => {
    const off = quiet();
    try {
      // C6: Ethereum does not answer, Base is empty — after the first successful reconciliation the Ethereum balance is known, Base is reconciled and gives a stop
      const w = world({ base: 0.0125, robinhood: 0 });
      const x = rig(w, { chains: { ethereum: cfg('ethereum', 'http://eth'), base: cfg('base', 'http://base') } as any });
      w.st.bal['http://eth'] = 0;
      await x.r.run('startup'); expect(x.sent[0]).toMatch(/✅/);
      w.st.fail = 'http://eth'; w.st.bal['http://base'] = 0; // the Base wallet is empty, the Ethereum node is down
      await x.r.run('periodic');
      expect(x.isHalted()).toBe(true); expect(x.sent.at(-1)).toMatch(/ethereum: by the last known balance, node did not answer[\s\S]*mismatch −\$50\.00/);
      // R2: all nodes are down from the very start — after 3 skips a message, after 6 (an hour) a stop, then a reminder every 6; recovery — a message
      const w2 = world({ fail: 'http://base' }); w2.st.fail = 'http://base';
      const y = rig(w2, { chains: { base: cfg('base', 'http://base') } as any });
      await y.r.run('startup'); expect(y.sent.length).toBe(1); // "not done … Will retry in 10 minutes"
      for (let i = 0; i < 5; i++) await y.r.run('periodic'); // skips 2..6
      expect(y.sent.length).toBe(3); expect(y.sent[1]).toMatch(/Failed 3 times in a row/); expect(y.sent[2]).toMatch(/not done for 60 minutes in a row — new entries stopped/);
      expect(y.isHalted()).toBe(true); expect(y.halts.length).toBe(1);
      for (let i = 0; i < 6; i++) await y.r.run('periodic'); // another hour: one reminder
      expect(y.sent.length).toBe(4); expect(y.sent[3]).toMatch(/120 minutes in a row/);
      w2.st.fail = undefined; w2.st.bal['http://base'] = 0.0125;
      await y.r.run('periodic');
      expect(y.sent.length).toBe(5); expect(y.sent[4]).toMatch(/✅[\s\S]*Reconciliation is running again\. The stop on new entries is NOT lifted — lift it yourself: \/resume/);
      // R3: no price at startup, matched 10 minutes later → "✅ matches" arrives
      let px: number | undefined;
      const z = rig(world({ base: 0.0125, robinhood: 0 }), { nativeUsd: async () => px });
      expect((await z.r.run('startup')).status).toBe('skipped'); px = 4000;
      expect((await z.r.run('periodic')).status).toBe('ok'); expect(z.sent.length).toBe(2); expect(z.sent[1]).toMatch(/✅ Wallet reconciliation: matches[\s\S]*running again/);
      // R4: a pending $2.01 reserve, the wallet is EMPTY → the mismatch is visible (adjusted for the reserve still −$47.99)
      const v = rig(world({ base: 0, robinhood: 0 }), {}, () => ({ cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 2.01 }));
      await v.r.run('periodic'); expect(v.isHalted()).toBe(true); expect(v.sent[0]).toMatch(/\(buy reserve \$2\.01\) — mismatch −\$50\.00/);
    } finally { off(); }
  });

  it('item 4: cash is reconciled, not capital; the tolerance is from cash', async () => {
    // cash $30, in positions $20, wallet $30 → ok; wallet $50 → mismatch (+$20 with a $4.50 tolerance = 15 % of cash)
    const L = { cashUsd: 30, equityUsd: 50, positionsCostUsd: 20, pendingBuyUsd: 0 };
    const ok = await reconcile(deps(world({ base: 0.0075, robinhood: 0 }), {}, L), 'periodic');
    expect(ok.status).toBe('ok'); expect(ok.toleranceUsd).toBeCloseTo(4.5, 6);
    const bad = await reconcile(deps(world({ base: 0.0125, robinhood: 0 }), {}, L), 'periodic');
    expect(bad.status).toBe('mismatch'); expect(bad.diffUsd).toBeCloseTo(20, 6); expect(bad.problems[0]).toMatch(/cash \$30\.00 — mismatch \+\$20\.00 with tolerance \$4\.50/);
  });

  it('item 5: the node error text is escaped for Telegram HTML', async () => {
    const w = world(); const rpc = w.rpc;
    const bad = { ...w, rpc: async (u: string, m: string, p: any[]) => { if (u === 'http://rh') throw new Error(`${m}: <html><body>502 Bad Gateway</body></html>`); return rpc(u, m, p); } };
    const r = await reconcile(deps(bad as any), 'startup');
    expect(r.status).toBe('skipped');
    const t = reconcileText(r, { equityUsd: 50, positionsCostUsd: 0 });
    expect(t).toContain('&lt;html&gt;'); expect(t).not.toMatch(/<html>/);
  });
});

describe('E-03, acceptance #100 round 2', () => {
  const quiet = () => { const a = vi.spyOn(console, 'log').mockImplementation(() => undefined); const b = vi.spyOn(console, 'error').mockImplementation(() => undefined); return () => { a.mockRestore(); b.mockRestore(); }; };
  function rig(w: ReturnType<typeof world>, o: Partial<ReconcileDeps> = {}, ledger?: () => ReconcileLedger) {
    const sent: string[] = []; const halts: string[] = []; let halted = false;
    const d = deps(w, o); if (ledger) d.ledger = ledger;
    const r = new Reconciler(d, { notify: async (t) => { sent.push(t); }, halt: (why) => { halts.push(why); halted = true; }, halted: () => halted });
    return { r, sent, halts, resume: () => { halted = false; }, isHalted: () => halted };
  }
  const one = (w: ReturnType<typeof world>, o: Partial<ReconcileDeps> = {}) => ({ ...o, chains: { base: cfg('base', 'http://base') } as any });

  it('item 1 (A1/B1): a stale balance never yields "matches": a single chain, the node is down, the wallet is drained → every pass "not done", a stop after an hour, reminders; a malformed node answer — the same path', async () => {
    const off = quiet();
    try {
      const w = world({ base: 0.0125 });
      const x = rig(w, one(w));
      expect((await x.r.run('startup')).status).toBe('ok');
      w.st.fail = 'http://base'; w.st.bal['http://base'] = 0; // the node is down, the wallet is empty
      const st = new Set<string>();
      for (let i = 0; i < 144; i++) st.add((await x.r.run('periodic')).status); // a day
      expect([...st]).toEqual(['skipped']);
      expect(x.isHalted()).toBe(true); expect(x.halts.length).toBe(24); // a stop on the 6th skip and a reminder every hour
      expect(x.sent.length).toBe(1 + 1 + 24); // startup, "3 times in a row", 24 reminders with the stop
      expect(x.sent[1]).toMatch(/base: node did not answer: fetch failed — by the last known balance \(base\) there is no mismatch, but without a node answer this is not a reconciliation[\s\S]*Failed 3 times in a row/);
      expect(x.sent[2]).toMatch(/base: 0\.012500 ≈ \$50\.00 \(last known\)[\s\S]*60 minutes in a row — new entries stopped/);
      // the stale line takes part in the mismatch: the second chain answered and is empty → mismatch, not a skip
      const w2 = world({ base: 0.0125, robinhood: 0 });
      const y = rig(w2);
      await y.r.run('startup'); w2.st.fail = 'http://rh'; w2.st.bal['http://base'] = 0;
      const m = await y.r.run('periodic');
      expect(m.status).toBe('mismatch'); expect(m.staleChains).toEqual(['robinhood']); expect(y.isHalted()).toBe(true);
      // a malformed node answer (BigInt throws): at startup "not done", with a known balance — a stale line, not "matches"
      const w3 = world({ base: 0.0125 }); const rpc = w3.rpc;
      const bad = { ...w3, rpc: async (u: string, m: string, p: any[]) => (m === 'eth_getBalance' && w3.st.fail === 'bad' ? 'not-a-number' : rpc(u, m, p)) };
      const z = rig(bad as any, one(w3));
      await z.r.run('startup'); w3.st.fail = 'bad';
      const g = await z.r.run('periodic');
      expect(g.status).toBe('skipped'); expect(g.why).toMatch(/node response not parsed: Cannot convert not-a-number to a BigInt/);
      expect((await reconcile(deps(bad as any, one(w3)), 'startup')).status).toBe('skipped');
    } finally { off(); }
  });

  it('item 2 (A2): the baseline is in coins per chain: after an ETH rebound $11 leaving the wallet is caught; a normal buy (cash and wallet together) matches', async () => {
    const off = quiet();
    try {
      const w = world({ base: 0.0125 }); let px = 3350; let cash = 50; // ETH −16 %: wallet $41.88 with $50 cash
      const x = rig(w, one(w, { nativeUsd: async () => px }), () => ({ cashUsd: cash, equityUsd: 50, positionsCostUsd: 50 - cash, pendingBuyUsd: 0 }));
      expect(await x.r.acceptCurrent()).toMatch(/Baseline accepted: wallet \$41\.88 \(base 0\.012500\), cash \$50\.00, the difference of −\$8\.1[23]/);
      px = 3700; // ETH rebounded: wallet $46.25 — this does not concern the baseline
      let r = await x.r.run('periodic'); expect(r.status).toBe('ok'); expect(r.diffUsd).toBeCloseTo(0, 6); expect(r.baselineWalletUsd).toBeCloseTo(46.25, 6);
      w.st.bal['http://base'] -= 11 / 3700; // $11 left without accounting
      r = await x.r.run('periodic');
      expect(r.status).toBe('mismatch'); expect(r.diffUsd).toBeCloseTo(-11, 6); expect(x.isHalted()).toBe(true);
      expect(x.sent.at(-1)).toMatch(/mismatch −\$11\.00 with tolerance \$7\.50 \(against the accepted baseline: wallet then \$46\.25 at today's prices, cash \$50\.00\)[\s\S]*Baseline accepted: wallet then \$46\.25/);
      // a $10 buy: cash −$10, $10 left the wallet at the current price — matches with the baseline
      w.st.bal['http://base'] += 11 / 3700; w.st.bal['http://base'] -= 10 / 3700; cash = 40;
      expect((await x.r.run('periodic')).status).toBe('ok');
      // without a baseline the same state (ETH −16 %) — a mismatch, as before
      px = 3350; w.st.bal['http://base'] = 0.0125; cash = 50;
      expect((await reconcile(deps(w, one(w, { nativeUsd: async () => px })), 'periodic')).status).toBe('mismatch');
    } finally { off(); }
  });

  it('item 3 (A3/B2): acceptCurrent refuses while a buy/bridge is running, a reserve is pending, the treasury has a transaction in flight or a node did not answer; after the refusal a theft is visible', async () => {
    const off = quiet();
    try {
      const w = world({ base: 0.0125 }); let flying: string[] = []; const L = { cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 };
      const x = rig(w, one(w, { inFlight: () => flying, toleranceShare: 0.08, toleranceUsd: 2 }), () => L);
      expect((await x.r.run('startup')).status).toBe('ok');
      w.st.bal['http://base'] -= 10 / 4000; // the bridge took $10, the ledger is not updated
      flying = ['bridge base→robinhood'];
      expect(await x.r.acceptCurrent()).toMatch(/Baseline not accepted: in flight bridge base→robinhood/);
      flying = []; L.pendingBuyUsd = 10;
      expect(await x.r.acceptCurrent()).toMatch(/Baseline not accepted: a buy reserve of \$10\.00 is pending/);
      L.pendingBuyUsd = 0; w.st.pending = { 'http://base': 8 };
      expect(await x.r.acceptCurrent()).toMatch(/Baseline not accepted: the treasury has transactions in flight \(base: 1 \(nonce 7…7\)\)/);
      w.st.pending = undefined; w.st.fail = 'http://base';
      expect(await x.r.acceptCurrent()).toMatch(/Baseline not accepted: base: node did not answer/);
      w.st.fail = undefined;
      expect(x.r.baseline).toBeUndefined();
      // the buy is recorded: cash $40, wallet $40; then $10 are stolen → mismatch (without a false +$10 baseline)
      L.cashUsd = 40; L.positionsCostUsd = 10;
      expect((await x.r.run('periodic')).status).toBe('ok');
      w.st.bal['http://base'] -= 10 / 4000;
      expect((await x.r.run('periodic')).status).toBe('mismatch'); expect(x.isHalted()).toBe(true);
      // when everything has arrived — the baseline is accepted
      w.st.bal['http://base'] += 10 / 4000;
      expect(await x.r.acceptCurrent()).toMatch(/Baseline accepted/);
    } finally { off(); }
  });

  it('item 4 (A4): a tolerance that turns reconciliation off — an exception in reconcile and in the constructor', async () => {
    const w = world({ base: 0 }); const L = () => ({ cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 });
    for (const [share, min] of [[1, 3], [5, 3], [-0.1, 3], [NaN, 3], [0.15, Infinity], [0.15, -1], [0.15, NaN]] as const) {
      await expect(reconcile(deps(w, one(w, { toleranceShare: share, toleranceUsd: min }), L()), 'periodic')).rejects.toThrow(/reconcile: tolerance/);
      expect(() => new Reconciler(deps(w, { toleranceShare: share, toleranceUsd: min }, L()), { notify: async () => undefined, halt: () => undefined, halted: () => false })).toThrow(/reconcile: tolerance/);
    }
    expect((await reconcile(deps(w, one(w, { toleranceShare: 0, toleranceUsd: 0 }), L()), 'periodic')).status).toBe('mismatch');
  });

  it('item 5 (A5/B4): the halted hook is required — without it the constructor throws', () => {
    const w = world();
    expect(() => new Reconciler(deps(w), { notify: async () => undefined, halt: () => undefined } as any)).toThrow(/hook halted is required/);
    expect(() => new Reconciler(deps(w), { notify: async () => undefined, halted: () => false } as any)).toThrow(/hook halt is required/);
  });

  it('nice-to-have: an exception from the ledger/flags — a skip, not a promise rejection; overlapping passes — one pass; a hung price — "not done" by the deadline', async () => {
    const off = quiet();
    try {
      // A6: inFlight throws → run() resolves "not done", counted as a skip
      const x = rig(world(), { inFlight: () => { throw new Error('executor state'); } });
      const r = await x.r.run('periodic');
      expect(r.status).toBe('skipped'); expect(r.why).toMatch(/reconciliation failure: executor state/);
      await x.r.run('periodic'); await x.r.run('periodic');
      expect(x.sent.length).toBe(1); expect(x.sent[0]).toMatch(/reconciliation failure: executor state[\s\S]*Failed 3 times in a row/);
      // A7: six simultaneous calls — one pass and one skip, no stop
      const w = world({ fail: 'http://base' });
      const y = rig(w, one(w));
      const all = await Promise.all(Array.from({ length: 6 }, () => y.r.run('periodic')));
      expect(new Set(all).size).toBe(1); expect(y.halts).toEqual([]); expect(y.sent).toEqual([]);
      expect(await y.r.acceptCurrent()).toMatch(/Baseline not accepted: base: node did not answer/);
      // the price does not answer: a wait deadline → "no price", not an eternal wait
      const z = await reconcile(deps(world(), { nativeUsd: () => new Promise(() => undefined), priceTimeoutMs: 20 }), 'startup');
      expect(z.status).toBe('skipped'); expect(z.why).toMatch(/no native coin price for base/);
    } finally { off(); }
  });
});

describe('#117 item 4: an operation that started while reading nodes inside acceptCurrent', () => {
  function rigRace(startDuringReads: () => void, flying: () => string[], L: { cashUsd: number; equityUsd: number; positionsCostUsd: number; pendingBuyUsd: number }) {
    const w = world({ base: 0.0125, robinhood: 0 });
    const read = w.rpc;
    let armed = false;
    const rpc = async (u: string, m: string, p: any[]) => { if (armed) startDuringReads(); return read(u, m, p); };
    const d = deps(w, { rpc: rpc as any, inFlight: flying, toleranceShare: 0.08, toleranceUsd: 2 });
    d.ledger = () => L;
    const r = new Reconciler(d, { notify: async () => {}, halt: () => undefined, halted: () => false });
    return { r, arm: () => { armed = true; }, disarm: () => { armed = false; } };
  }
  const silent = () => { const a = vi.spyOn(console, 'log').mockImplementation(() => undefined); const b = vi.spyOn(console, 'error').mockImplementation(() => undefined); return () => { a.mockRestore(); b.mockRestore(); }; };

  it('a buy or bridge started while balances were being read → the baseline is not accepted; after the outcome — accepted', async () => {
    const off = silent();
    try {
      let list: string[] = [];
      const L = { cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 };
      const x = rigRace(() => { list = ['buy']; }, () => list, L);
      expect((await x.r.run('startup')).status).toBe('ok');
      x.arm();
      expect(await x.r.acceptCurrent()).toMatch(/Baseline not accepted: an operation started during reconciliation \(buy\)/);
      expect(x.r.baseline).toBeUndefined();
      x.disarm(); list = [];
      expect(await x.r.acceptCurrent()).toMatch(/Baseline accepted/);
    } finally { off(); }
  });

  it('a buy reserve appeared during reading (the outcome is not recorded yet) → the baseline is not accepted', async () => {
    const off = silent();
    try {
      const L = { cashUsd: 50, equityUsd: 50, positionsCostUsd: 0, pendingBuyUsd: 0 };
      const x = rigRace(() => { L.pendingBuyUsd = 2.01; }, () => [], L);
      expect((await x.r.run('startup')).status).toBe('ok');
      x.arm();
      expect(await x.r.acceptCurrent()).toMatch(/Baseline not accepted: an operation started during reconciliation \(a buy in flight\)/);
      expect(x.r.baseline).toBeUndefined();
    } finally { off(); }
  });
});

describe('#117 item 3: an operation during reconciliation — "not done", not a false mismatch (both at startup and by timer)', () => {
  for (const phase of ['startup', 'periodic'] as const) {
    it(`${phase}: a sale started while nodes were being read and moved the balance → reconciliation postponed; without the check there would be a mismatch`, async () => {
      const w = world({ base: 0.0125, robinhood: 0 }); // $50 on the wallet, $50 cash
      const read = w.rpc; let list: string[] = [];
      const rpc = async (u: string, m: string, p: any[]) => {
        // the very first balance check: a sale is already running, the wallet money is different, the ledger is still the old one
        if (m === 'eth_getBalance' && !list.length) { list = ['sale base:0x4444…']; w.st.bal['http://base'] = 0.02; }
        return read(u, m, p);
      };
      const r = await reconcile(deps(w, { rpc: rpc as any, inFlight: () => list, toleranceShare: 0.08, toleranceUsd: 2 }), phase);
      expect(r.status).toBe('skipped');
      expect(r.why).toMatch(/an operation started during reconciliation \(sale base:0x4444…\) — will reconcile after the outcome/);
      expect(r.problems).toEqual([]);
      // the same picture without the "in flight" list — mismatch +$30 (as it would be without the check)
      const w2 = world({ base: 0.02, robinhood: 0 });
      expect((await reconcile(deps(w2, { toleranceShare: 0.08, toleranceUsd: 2 }), phase)).status).toBe('mismatch');
    });
  }

  it('NftLive.inFlight(): sweeping leftovers from burner wallets is visible while running and disappears after', async () => {
    const { NftLive } = await import('../src/live/nftLive.js');
    const { Wallets, newKeyMaterial } = await import('../src/live/keystore.js');
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    // a sender whose balance read waits: the sweep is "running" until the test releases it
    const sender: any = { cfg: { chain: 'base', id: 8453 }, async balance() { await gate; return 0n; }, async getFees() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, at: 0 }; } };
    const nl = new NftLive({ trader: { sender: () => sender } as any, wallets: new Wallets(newKeyMaterial(2)),
      cfg: { maxWallets: 20, maxShareOfEquity: 0.3, minMultipleForMany: 1.5, pSuccess: 0.6, gasPerMint: 250_000n, priorityMultiplier: 3 },
      equityUsd: () => 100, ethUsd: () => 4000, notify: async () => {} });
    expect(nl.inFlight()).toEqual([]);
    const p = nl.sweepIdle('base');
    expect(nl.inFlight()).toEqual(['sweeping leftovers from burner wallets (base)']);
    release();
    await p.catch(() => 0);
    expect(nl.inFlight()).toEqual([]);
  });
});
