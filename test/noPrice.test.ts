// Incoming #126 item 3 (the owner's decision 2026-11-17: the rule is up to Execution, priority — asset safety).
// A position without a price (example numbers: 8 h / 36 h / 15 min): 8 h blind → market exit (live); 36 h and the sale failed → write-off in the ledger; a price source failure — nothing.
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor, NO_PRICE_DEFAULT, noPriceProblem, noPriceRules } from '../src/exec/paper.js';
import { readFileSync } from 'node:fs';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const TOKEN = '0x4444444444444444444444444444444444444444';
const REF = PaperExecutor.PRICE_REF.base!;
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: 'ape' };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust, estGasUsd: 0.02,
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: TOKEN, ticker: 'TKN' },
  check: { ok: true, chain: 'base', address: TOKEN, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-30T08:00:00.000Z' } } as any);
const RAW = 2000n * 10n ** 18n;
const H = 3600_000;

function setup(mode: 'paper' | 'live') {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t) { sent.push(t); } }, clock);
  paper.liveMode = mode;
  const st = { tokenPrice: 0.001 as number | undefined, refPrice: 1800 as number | undefined, sell: { ok: false, mode: 'live', proceedsUsd: 0, note: 'route: no route found' } as any, sells: 0 };
  const market: MarketClient = { async market(a: string) { const px = a === REF ? st.refPrice : st.tokenPrice; return px ? { chain: 'base', priceUsd: px } : undefined; }, async rug() { return undefined; } };
  if (mode === 'live') paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
    async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
    async sellToken() { st.sells++; return st.sell; } } as any;
  /** A monitor pass every step ms, n times. */
  const run = async (n: number, stepMs: number) => { for (let i = 0; i < n; i++) { clock.advance(stepMs); await paper.monitor(market, { tokensOnly: true }); } };
  const posts = () => sent.filter(t => t.startsWith('🐦 Post draft ('));
  return { clock, store, risk, paper, sent, st, market, run, posts };
}

describe('#126 item 3: a position without a price — live', () => {
  it('up to 8 h without a price — nothing; at hour 8 — a warning and a market exit of the whole position; proceeds credited, position closed', async () => {
    const e = setup('live');
    await e.paper.execute(MSG, buy(), 1);
    const cash0 = e.risk.cashUsd;
    e.st.tokenPrice = undefined;
    await e.run(1, 60_000);     // first pass without a price: the countdown started
    await e.run(8, H - 60_000); // another 7 h 52 min blind
    expect(e.st.sells).toBe(0); expect(e.paper.open.size).toBe(1); expect(e.sent.some(t => /no price for/.test(t))).toBe(false);
    e.st.sell = { ok: true, mode: 'live', proceedsUsd: 1.4, soldRaw: RAW, tx: '0x' + 'c'.repeat(64), note: 'sold' };
    await e.run(1, 10 * 60_000); // 8 h 3 min
    expect(e.st.sells).toBe(1);
    expect(e.sent.some(t => /\$TKN \(base, 0x4444.*\): no price for 8 h while the price source works.*Exiting the position at market/.test(t))).toBe(true);
    expect(e.paper.open.size).toBe(0); expect(e.risk.positions.length).toBe(0);
    expect(e.risk.cashUsd - cash0).toBeCloseTo(1.4, 6);
    expect(e.sent.some(t => /LIVE SELL \$TKN no price for 8h — exit at market, received \$1\.40/.test(t))).toBe(true);
    expect(e.posts().at(-1)!.split('\n')[1]).toMatch(/^Closed \$TKN/); // the sale is real — the close post is true
  });

  it('the sale fails: attempts at most once every 15 minutes; at hour 36 — a write-off in the ledger, no "Closed" post, the owner gets the address and quantity', async () => {
    const e = setup('live');
    await e.paper.execute(MSG, buy(), 1);
    const cash0 = e.risk.cashUsd; const posts0 = e.posts().length;
    e.st.tokenPrice = undefined;
    await e.run(1, 60_000);          // the countdown started
    await e.run(1, 8 * H);           // 8 h → first attempt
    expect(e.st.sells).toBe(1);
    await e.run(13, 60_000);         // 13 minutes: monitor passes without new attempts
    expect(e.st.sells).toBe(1);
    await e.run(1, 3 * 60_000);      // 16 minutes after the first — the second
    expect(e.st.sells).toBe(2);
    expect(e.sent.filter(t => /market exit without a price did not go through: route: no route found/.test(t)).length).toBe(1); // one reason — one message
    expect(e.paper.open.size).toBe(1);
    await e.run(1, 28 * H);          // 36 h without a price
    expect(e.paper.open.size).toBe(0); expect(e.risk.positions.length).toBe(0); expect(e.store.openPositions().length).toBe(0);
    expect(e.risk.cashUsd).toBe(cash0); // cash unchanged: no money came in
    expect(e.risk.todayPnl()).toBeCloseTo(-2.02, 6); // loss = cost basis
    const msg = e.sent.at(-1)!;
    expect(msg).toMatch(/⛔ \$TKN \(base\): no price for 36 h, the sale failed — the position is written off in the ledger at zero, loss \$2\.02\./);
    expect(msg).toMatch(new RegExp(`The tokens remain on the treasury wallet: 2000 units, token address ${TOKEN}\\. The agent no longer watches them`));
    expect(e.posts().length).toBe(posts0); // no public "Closed" about tokens that were not sold
  });

  it('the sale went "in flight" — the position waits for its outcome, no retry and no write-off', async () => {
    const e = setup('live');
    (e.paper.trader as any).settleTx = () => new Promise(() => undefined);
    await e.paper.execute(MSG, buy(), 1);
    e.st.tokenPrice = undefined;
    e.st.sell = { ok: false, mode: 'live', proceedsUsd: 1.4, pending: true, tx: '0x' + 'c'.repeat(64), soldRaw: RAW, note: 'sell pending' };
    await e.run(1, 60_000); await e.run(1, 8 * H);
    expect(e.st.sells).toBe(1);
    await e.run(3, 20 * H);
    expect(e.st.sells).toBe(1); expect(e.paper.open.size).toBe(1);
    expect(e.paper.inFlight().length).toBe(1);
  });
});

describe('#126 item 3: a price source failure — not a "dead token"', () => {
  for (const mode of ['live', 'paper'] as const) {
    it(`${mode}: the chain reference token has no price either → no sale and no write-off even in 48 h; the source came back — the countdown restarts from zero`, async () => {
      const e = setup(mode);
      await e.paper.execute(MSG, buy(), 1);
      e.st.tokenPrice = undefined; e.st.refPrice = undefined; // DexScreener answers nobody
      await e.run(48, H);
      expect(e.st.sells).toBe(0); expect(e.paper.open.size).toBe(1); expect(e.sent.some(t => /no price for/.test(t))).toBe(false);
      e.st.refPrice = 1800; // the source is back, the token still has no price
      await e.run(5, H);
      expect(e.st.sells).toBe(0); expect(e.paper.open.size).toBe(1); // only 5 h of a live source have passed
    });
  }

  it('the price came back before the deadline — the countdown is reset: a new 8 h starts over', async () => {
    const e = setup('live');
    await e.paper.execute(MSG, buy(), 1);
    e.st.tokenPrice = undefined;
    await e.run(5, H);
    e.st.tokenPrice = 0.001; await e.run(1, 60_000);
    e.st.tokenPrice = undefined;
    await e.run(5, H);
    expect(e.st.sells).toBe(0); expect(e.paper.open.size).toBe(1);
  });

  it('a chain without a reference token — the source is considered unknown: no action', async () => {
    const e = setup('live');
    await e.paper.execute(MSG, { ...buy(), chain: 'polygon', intent: { ...buy().intent, chain: 'polygon' } } as any, 1);
    e.st.tokenPrice = undefined;
    await e.run(30, H);
    expect(e.st.sells).toBe(0); expect(e.paper.open.size).toBe(1);
  });
});

describe('#126 item 3: paper', () => {
  it('nothing to sell with: at hour 8 a warning with the write-off deadline; at hour 36 — write-off at zero, the limit slot is free', async () => {
    const e = setup('paper');
    await e.paper.execute(MSG, buy(), 1);
    const cash0 = e.risk.cashUsd; const cost = e.risk.positions[0].costUsd;
    e.st.tokenPrice = undefined;
    await e.run(1, 60_000); await e.run(1, 8 * H);
    expect(e.sent.at(-1)).toMatch(/no price for 8 h while the price source works.*Nothing to sell with on paper; after 28 h without a price I will write it off at zero/);
    expect(e.paper.open.size).toBe(1);
    await e.run(1, 28 * H);
    expect(e.paper.open.size).toBe(0); expect(e.risk.positions.length).toBe(0);
    expect(e.risk.cashUsd).toBe(cash0); expect(e.risk.todayPnl()).toBeCloseTo(-cost, 6);
    expect(e.sent.at(-1)).toMatch(/⛔ \$TKN \(base\): no price for 36 h — the position is written off in the ledger at zero/);
    expect(e.sent.at(-1)).not.toMatch(/wallet/);
  });

  it('an error inside processing does not crash the monitor: other positions are still tracked', async () => {
    const e = setup('live');
    await e.paper.execute(MSG, buy(), 1);
    e.st.tokenPrice = undefined;
    (e.paper.trader as any).sellToken = async () => { throw new Error('boom'); };
    const errs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await e.run(1, 60_000); await e.run(1, 8 * H);
      expect(errs.mock.calls.some(c => /\[no-price\].*boom/.test(String(c[0])))).toBe(true);
      expect(e.paper.open.size).toBe(1);
    } finally { errs.mockRestore(); }
  });
});

// Acceptance #142, O1: a position written off or sold in this pass must not also remain in the unrealized loss
describe('#142 O1: the loss of a position without a price is counted once', () => {
  const CFG50 = { ...DEFAULT_RISK, initialCapitalUsd: 57.5 }; // example: follow 0.45 × $57.50 fits $24.70
  const big = (): Decision => ({ ...buy(), sizeUsd: 24.7 } as Decision);

  it('paper, capital $57.50, position $24.70: write-off after 36 h → unrealized 0, no hard stop (HQ reproduction)', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const risk = new RiskState(CFG50, clock);
    const paper = new PaperExecutor(CFG50, risk, new Store(':memory:'), { async send() {} }, clock);
    const market: MarketClient = { async market(a: string) { return a === REF ? { chain: 'base', priceUsd: 3000 } : undefined; }, async rug() { return undefined; } };
    await paper.execute(MSG, big(), 1);
    await paper.monitor(market, { tokensOnly: true });          // countdown started
    expect(risk.unrealizedUsd).toBeLessThan(-24);               // while the position is open and without a price — the remainder counts as a loss
    expect(risk.hardStopped).toBe(false);
    clock.advance(36 * H + 60_000);
    await paper.monitor(market, { tokensOnly: true });          // write-off
    expect(paper.open.size).toBe(0);
    expect(risk.unrealizedUsd).toBeCloseTo(0, 9);
    expect(risk.hardStopped).toBe(false);
    expect(risk.markedEquityUsd).toBeCloseTo(risk.equityUsd, 9); // the loss is counted once — in realized
  });

  it('live: a sale without a price went through in this pass → unrealized 0; the sale failed → the remainder still counts as a loss', async () => {
    const e = setup('live');
    await e.paper.execute(MSG, buy(), 1);
    e.st.tokenPrice = undefined;
    await e.run(1, 60_000);
    await e.run(1, 8 * H);                                      // the attempt failed — the position is open
    expect(e.paper.open.size).toBe(1); expect(e.risk.unrealizedUsd).toBeCloseTo(-2.02, 6);
    e.st.sell = { ok: true, mode: 'live', proceedsUsd: 1.4, soldRaw: RAW, tx: '0x' + 'c'.repeat(64), note: 'sold' };
    await e.run(1, 16 * 60_000);                                // the retry went through
    expect(e.paper.open.size).toBe(0); expect(e.risk.unrealizedUsd).toBeCloseTo(0, 9);
    expect(e.risk.todayPnl()).toBeCloseTo(1.4 - 2.02, 6);
  });
});

describe('#142: the rule numbers — the noPrice block in risk.json', () => {
  it('test/fixtures/risk.example.json has the example 8 h / 36 h / 15 min; the block is valid', () => {
    const raw = JSON.parse(readFileSync(new URL('../test/fixtures/risk.example.json', import.meta.url), 'utf8'));
    expect(raw.noPrice).toEqual({ exitHours: 8, writeOffHours: 36, retryMinutes: 15 });
    expect(noPriceProblem({ ...DEFAULT_RISK, ...raw })).toBeUndefined();
    expect(NO_PRICE_DEFAULT).toEqual(raw.noPrice);
  });

  it('no block — the approved numbers; block set — its numbers; invalid block — the reason and the approved numbers (the rule is not turned off)', () => {
    expect(noPriceRules(DEFAULT_RISK)).toEqual({ exitMs: 8 * H, writeOffMs: 36 * H, retryMs: 900_000 });
    expect(noPriceRules({ ...DEFAULT_RISK, noPrice: { exitHours: 2, writeOffHours: 8, retryMinutes: 5 } } as any)).toEqual({ exitMs: 2 * H, writeOffMs: 8 * H, retryMs: 300_000 });
    for (const [bad, why] of [
      [{ exitHours: 0, writeOffHours: 36, retryMinutes: 15 }, /exitHours/], [{ exitHours: 8, writeOffHours: 3, retryMinutes: 15 }, /writeOffHours must not be below exitHours/],
      [{ exitHours: 8, writeOffHours: 36, retryMinutes: 0 }, /retryMinutes/], [{ exitHours: '8', writeOffHours: 36, retryMinutes: 15 }, /exitHours/], [null, /object/],
    ] as const) {
      const cfg = { ...DEFAULT_RISK, noPrice: bad } as any;
      expect(noPriceProblem(cfg)).toMatch(why);
      expect(noPriceRules(cfg)).toEqual({ exitMs: 8 * H, writeOffMs: 36 * H, retryMs: 900_000 });
    }
  });

  it('the block numbers apply: 2 h → sale, 8 h → write-off; invalid block — a message to the owner at startup', async () => {
    const cfg = { ...DEFAULT_RISK, noPrice: { exitHours: 2, writeOffHours: 8, retryMinutes: 5 } } as any;
    const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8)); const sent: string[] = [];
    const paper = new PaperExecutor(cfg, new RiskState(cfg, clock), new Store(':memory:'), { async send(t) { sent.push(t); } }, clock);
    paper.liveMode = 'live'; let sells = 0;
    paper.trader = { setLateOutcomeHandler() {}, clearGhost() {},
      async buyToken() { return { ok: true, mode: 'live', qty: 2000, raw: RAW, decimals: 18, spentUsd: 2.02, tx: '0x' + 'b'.repeat(64), note: 'got' }; },
      async sellToken() { sells++; return { ok: false, mode: 'live', proceedsUsd: 0, note: 'route: no route found' }; } } as any;
    const market: MarketClient = { async market(a: string) { return a === REF ? { chain: 'base', priceUsd: 1800 } : undefined; }, async rug() { return undefined; } };
    const step = async (ms: number) => { clock.advance(ms); await paper.monitor(market, { tokensOnly: true }); };
    await paper.execute(MSG, buy(), 1);
    await step(60_000); await step(H); expect(sells).toBe(0);
    await step(H); expect(sells).toBe(1);                 // 2 h
    await step(4 * 60_000); expect(sells).toBe(1);        // 5 min pause
    await step(2 * 60_000); expect(sells).toBe(2);
    await step(6 * H); expect(paper.open.size).toBe(0);   // 8 h → write-off
    const bad = { ...DEFAULT_RISK, noPrice: { exitHours: 40, writeOffHours: 36, retryMinutes: 15 } } as any; const said: string[] = [];
    new PaperExecutor(bad, new RiskState(bad, clock), new Store(':memory:'), { async send(t) { said.push(t); } }, clock).restore();
    await new Promise(r => setTimeout(r, 5));
    expect(said.some(t => /the noPrice block was rejected: writeOffHours must not be below exitHours.*sell after 8 h, write off after 36 h, retry every 15 min/.test(t))).toBe(true);
  });
});

describe('#142 O1: the same with a regular stop sale', () => {
  it('paper, capital $57.50, position $24.70: the price fell below the stop in one pass → the loss once, no hard stop', async () => {
    const cfg = { ...DEFAULT_RISK, initialCapitalUsd: 57.5 };
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const risk = new RiskState(cfg, clock);
    const paper = new PaperExecutor(cfg, risk, new Store(':memory:'), { async send() {} }, clock);
    let px = 0.00066; // above the 0.00065 stop: the position is down a third, no sale
    const market: MarketClient = { async market() { return { chain: 'base', priceUsd: px }; }, async rug() { return undefined; } };
    await paper.execute(MSG, { ...buy(), sizeUsd: 24.7 } as Decision, 1);
    await paper.monitor(market, { tokensOnly: true });
    expect(paper.open.size).toBe(1); expect(risk.unrealizedUsd).toBeLessThan(-8);
    px = 0.0002; clock.advance(60_000); // −80 % in a minute: stop sale
    await paper.monitor(market, { tokensOnly: true });
    expect(paper.open.size).toBe(0);
    expect(risk.equityUsd).toBeGreaterThan(57.5 * 0.55); // real capital above the hard stop threshold ($31.63)
    expect(risk.unrealizedUsd).toBeCloseTo(0, 9);
    expect(risk.hardStopped).toBe(false);             // before the fix: old valuation −$8 + recorded loss −$20 → a false stop
  });
});
