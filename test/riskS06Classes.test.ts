// The owner's decision 2026-11-18 ~00:00 UTC ("Don't buy new ones"): an invalid memecoinClasses block — new memecoins are not bought,
// other entries work, open positions follow the exit plan saved at entry; the owner gets a message.
import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig, type RiskConfig } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { RiskState, sizeAction } from '../src/risk/risk.js';
import { Store } from '../src/store/db.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { evaluateExit, type OpenPos } from '../src/exec/exits.js';
import { legacyExit } from '../src/decide/tokenClass.js';
import { Blacklist, decide } from '../src/decide/decide.js';
import { prefilter } from '../src/extract/prefilter.js';
import type { Intent, TrustResult } from '../src/types.js';

const ROOT = resolve(__dirname, '..');
const CFG: RiskConfig = loadConfig({ AGENT_ROOT: ROOT, AGENT_RISK_JSON: 'test/fixtures/risk.example.json' } as NodeJS.ProcessEnv).risk;
const BAD = { ...CFG, memecoinClasses: { ...(CFG as any).memecoinClasses, version: '2' } } as RiskConfig;
const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
const clock = new VirtualClock(Date.UTC(2026, 10, 18, 12));
function deps(cfg: RiskConfig) {
  const market = {
    market: async () => ({ chain: 'solana' as const, symbol: 'X', priceUsd: 0.0003, liquidityUsd: 43_000, fdvUsd: 250_000, pairAgeMinutes: 5, buys24h: 2300, sells24h: 2000, priceChangeH1Pct: 20 }),
    rug: async () => ({ risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] }),
  };
  return { cfg, risk: new RiskState(cfg, clock), market, clock, blacklist: new Blacklist(), ethUsd: () => 3000 };
}
const intent: Intent = { kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.7 } as Intent;
const tr: TrustResult = { score: 7, tier: 'fast', basis: 'author', notes: [] };
const run = (cfg: RiskConfig) => decide(intent, tr, prefilter(`buy ${MINT}`), deps(cfg), { mainTextAddresses: new Set([MINT]), analyst: true });

describe('invalid memecoinClasses: "Don\'t buy new ones"', () => {
  it('a memecoin buy is refused with a clear reason; with a valid block the same buy goes through', async () => {
    const bad = await run(BAD);
    expect(bad.action).toBe('skip');
    expect(bad.reasons.join(' ')).toMatch(/exit classes invalid \(risk\.json memecoinClasses: version must be 2\) — new memecoins are not bought until fixed/);
    expect((await run(CFG)).action).toBe('buy_token');
  });
  it('other entries work: no general stop, a trade size is given', () => {
    const st = new RiskState(BAD, clock);
    expect(st.halted()).toBe(false);
    expect(sizeAction(BAD, st, { tier: 'fast', chain: 'base', estGasUsd: 0.05 }).ok).toBe(true);
  });
  it('exits of an open position: by the saved plan — for a position of the previous scheme it is memecoinExit (stop −40 %, example); the monitor does not read the block', () => {
    const e = legacyExit(BAD);
    expect(e.stopLossPct).toBe(40);
    const p: OpenPos = { id: 'p', token: MINT, chain: 'solana', entryPrice: 1, qty: 100, qtyLeft: 100, costUsd: 100, peakPrice: 1, tp1Done: false, openedAtMs: 0,
      stopPrice: 1 - e.stopLossPct / 100, tp1Price: e.takeProfit1x, tp1Share: e.takeProfit1Share, trailingPct: e.trailingStopPct, timeStopAtMs: e.timeStopHours * 3600_000, timeStopMinGainPct: e.timeStopMinGainPct };
    expect(evaluateExit(p, 0.61, 1)).toMatchObject({ kind: 'none' });
    expect(evaluateExit(p, 0.59, 1)).toMatchObject({ kind: 'sell', qty: 100 });
    expect(readFileSync(join(ROOT, 'src/exec/exits.ts'), 'utf8')).not.toMatch(/classesFrom|memecoinClasses\s*[:\]]/);
  });
  it('a message to the owner at startup', () => {
    const sent: string[] = [];
    new PaperExecutor(BAD, new RiskState(BAD, clock), new Store(':memory:'), { async send(t: string) { sent.push(t); } }, clock).restore();
    expect(sent.join('\n')).toMatch(/the memecoinClasses block was rejected: version must be 2\. New memecoins are not bought until fixed; open positions follow the exit plan saved at entry/);
  });
});
