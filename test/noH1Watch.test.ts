// #128 O1: memecoins skipped in a row for "no 1h price change" — one message to the owner (at most once a day); a send failure
// of the invalid memecoinEntry block message goes to the service journal, not silence.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadConfig, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { Blacklist, decide } from '../src/decide/decide.js';
import { NoH1Watch } from '../src/decide/entry.js';
import { prefilter } from '../src/extract/prefilter.js';
import type { Intent, TrustResult } from '../src/types.js';

const CFG = loadConfig({ AGENT_ROOT: process.cwd(), AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk;
const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
const MIN = 60_000, H = 3600_000;
const flush = () => new Promise(r => setTimeout(r, 0));

function watch(start = Date.UTC(2026, 10, 16, 8)) {
  let now = start; const sent: string[] = [];
  const w = new NoH1Watch({ notify: async (t) => { sent.push(t); }, now: () => now });
  return { w, sent, step: (ms: number) => { now += ms; } };
}

describe('#128: NoH1Watch', () => {
  it('5 in a row without a 1h change → one message; then silence for a day; after a day again', async () => {
    const x = watch();
    // 2 h step: the 6 h window never holds more than 3 checks, but 3 in a row in the window is already "all in 6 h"; so a 7 h step — the streak only
    for (let i = 0; i < 4; i++) { x.w.note(true); x.step(7 * H); }
    await flush(); expect(x.sent).toEqual([]);
    x.w.note(true); await flush();
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]).toMatch(/1h price change unavailable: 5 memecoins in a row/); expect(x.sent[0]).toMatch(/UTC/); expect(x.sent[0]).toMatch(/are not bought/);
    for (let i = 0; i < 3; i++) { x.step(7 * H); x.w.note(true); } // 21 h after the message
    await flush(); expect(x.sent).toHaveLength(1);
    x.step(4 * H); x.w.note(true); await flush(); // 25 h
    expect(x.sent).toHaveLength(2);
  });

  it('a check with a 1h change resets the streak', async () => {
    const x = watch();
    for (let i = 0; i < 4; i++) { x.w.note(true); x.step(7 * H); }
    x.w.note(false); x.step(7 * H);
    for (let i = 0; i < 4; i++) { x.w.note(true); x.step(7 * H); }
    await flush(); expect(x.sent).toEqual([]);
  });

  it('all checks in 6 h without a change and there are ≥ 3 → a message; if the window had a check with a change — no', async () => {
    const a = watch();
    a.w.note(true); a.step(30 * MIN); a.w.note(true); await flush(); expect(a.sent).toEqual([]);
    a.step(30 * MIN); a.w.note(true); await flush(); expect(a.sent).toHaveLength(1);
    const b = watch();
    b.w.note(false); b.step(MIN); b.w.note(true); b.w.note(true); b.w.note(true); await flush(); expect(b.sent).toEqual([]);
    b.step(6 * H); b.w.note(true); await flush(); expect(b.sent).toHaveLength(1); // the check with a change left the window
  });

  it('a send failure (refusal or exception) — console.error, not an exception', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = new NoH1Watch({ notify: async () => { throw new Error('telegram down'); }, now: () => 0 });
      for (let i = 0; i < 5; i++) r.note(true);
      const s = new NoH1Watch({ notify: () => { throw new Error('sync boom'); }, now: () => 0 });
      expect(() => { for (let i = 0; i < 5; i++) s.note(true); }).not.toThrow();
      await flush();
      expect(err.mock.calls.map(c => String(c[0]))).toEqual([expect.stringMatching(/sync boom/), expect.stringMatching(/telegram down/)]);
    } finally { err.mockRestore(); }
  });

  it('review: fresh pairs (< 60 min) have no 1h change, old ones do — the message about the fresh half still comes; once a day', async () => {
    const x = watch();
    // alternating: an old pair with a 1h change (resets the overall streak), a fresh one without; 7 h step — the 6 h window does not fire
    for (let i = 0; i < 4; i++) { x.w.note(false, 30 * 60); x.step(7 * H); x.w.note(true, 5); x.step(7 * H); }
    await flush(); expect(x.sent).toEqual([]);
    x.w.note(false, 30 * 60); x.step(7 * H); x.w.note(true, 5); await flush();
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]).toMatch(/For fresh pairs \(younger than 60 min\) the 1h price change is unavailable: 5 in a row/); expect(x.sent[0]).toMatch(/UTC/);
    x.step(7 * H); x.w.note(true, 5); await flush(); expect(x.sent).toHaveLength(1); // once a day
  });

  it('review: fresh pairs without a 1h change but fewer than the threshold, and an unknown age does not count as fresh; both counters at once — one message', async () => {
    const a = watch();
    for (let i = 0; i < 6; i++) { a.w.note(false, 30 * 60); a.step(7 * H); a.w.note(true, undefined); a.step(7 * H); }
    await flush(); expect(a.sent).toEqual([]); // age unknown — not "fresh"
    const b = watch();
    for (let i = 0; i < 5; i++) { b.w.note(true, 5); b.step(7 * H); }
    await flush();
    expect(b.sent).toHaveLength(1); expect(b.sent[0]).toMatch(/^⚠️ 1h price change unavailable: 5 memecoins in a row/);
    b.step(7 * H); b.w.note(true, 5); await flush(); expect(b.sent).toHaveLength(1); // the fresh counter is marked as sent too
  });
});

describe('#128: the watcher sees entry checks in decide()', () => {
  const intent = { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.7 } as Intent;
  const fast: TrustResult = { score: 7, tier: 'fast', basis: 'author', notes: [] };
  it('5 memecoins without priceChange.h1 → 5 skips "no 1h price change" and one message; with a 1h change — no message', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 10, 16, 8));
    const sent: string[] = [];
    const run = async (h1?: number) => {
      const market = { market: async () => ({ chain: 'solana' as const, symbol: 'X', priceUsd: 0.0003, liquidityUsd: 43_000, fdvUsd: 250_000, pairAgeMinutes: 30 * 60,
        buys24h: 2300, sells24h: 2000, ...(h1 === undefined ? {} : { priceChangeH1Pct: h1 }) }), rug: async () => ({ risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] }) };
      const dd = { cfg: CFG, risk: new RiskState(CFG, clock), market, clock, blacklist: new Blacklist(), ethUsd: () => 3000,
        entryWatch: w };
      return decide(intent, fast, prefilter(`buy ${MINT}`), dd as any, { mainTextAddresses: new Set([MINT]) } as any);
    };
    const w = new NoH1Watch({ notify: async (t) => { sent.push(t); }, now: () => clock.now() });
    expect((await run(20)).action).toBe('buy_token');
    for (let i = 0; i < 5; i++) {
      const d = await run(); expect(d.action).toBe('skip'); expect(d.reasons.join(' | ')).toMatch(/no 1h price change/);
      clock.advance(7 * H);
    }
    await flush();
    expect(sent).toHaveLength(1);
  });

  it('src/index.ts wires the watcher into decide', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/entryWatch: new NoH1Watch\(\{ notify: \(t\) => notifier\.send\(t\), now: \(\) => clock\.now\(\) \}\)/);
  });

  it('review: decide() passes the pair age — fresh pairs without a 1h change, old ones with it → a message about the fresh half', async () => {
    const intent = { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.7 } as Intent;
    const fast: TrustResult = { score: 7, tier: 'fast', basis: 'author', notes: [] };
    const clock = new VirtualClock(Date.UTC(2026, 10, 16, 8));
    const sent: string[] = [];
    const w = new NoH1Watch({ notify: async (t) => { sent.push(t); }, now: () => clock.now() });
    const run = async (age: number, h1?: number) => {
      const market = { market: async () => ({ chain: 'solana' as const, symbol: 'X', priceUsd: 0.0003, liquidityUsd: 43_000, fdvUsd: 250_000, pairAgeMinutes: age,
        buys24h: 2300, sells24h: 2000, ...(h1 === undefined ? {} : { priceChangeH1Pct: h1 }) }), rug: async () => ({ risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] }) };
      return decide(intent, fast, prefilter(`buy ${MINT}`), { cfg: CFG, risk: new RiskState(CFG, clock), market, clock, blacklist: new Blacklist(), ethUsd: () => 3000, entryWatch: w } as any,
        { mainTextAddresses: new Set([MINT]) } as any);
    };
    for (let i = 0; i < 5; i++) {
      expect((await run(30 * 60, 20)).action).toBe('buy_token'); clock.advance(7 * H);
      expect((await run(5)).reasons.join(' | ')).toMatch(/no 1h price change/); clock.advance(7 * H);
    }
    await flush();
    expect(sent).toHaveLength(1); expect(sent[0]).toMatch(/For fresh pairs/);
  });
});

describe('#128: the invalid memecoinEntry block message — a send failure goes to the service journal', () => {
  it('the notifier refused → console.error with the reason, not silence', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bad = { ...CFG, memecoinEntry: { version: 2 } } as unknown as RiskConfig;
      const clock = new VirtualClock(Date.UTC(2026, 10, 16, 8));
      const paper = new PaperExecutor(bad, new RiskState(bad, clock), new Store(':memory:'), { async send() { throw new Error('telegram down'); } }, clock);
      paper.restore();
      await flush(); await flush();
      expect(err.mock.calls.map(c => String(c[0]))).toContainEqual(expect.stringMatching(/memecoinEntry alert not sent \(version must be 1\): telegram down/));
    } finally { err.mockRestore(); }
  });
});
