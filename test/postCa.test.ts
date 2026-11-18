// Incoming #110 (T-09, the owner's decision 2026-11-11 17:30 UTC): a post about a token trade ends with the full contract address.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

const EVM = '0x4444444444444444444444444444444444444444';
const SOL = '77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-29T08:00:00.000Z', text: 'ape' };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (chain: string, token: string): Decision => ({ action: 'buy_token', sizeUsd: 2, chain, reasons: [], trust, estGasUsd: 0.02, publicNote: 'Liquidity is real and the team is known.',
  intent: { kind: 'token_call', chain, urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: token, ticker: 'TKN' },
  check: { ok: true, chain, address: token, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-10-30T08:00:00.000Z' } } as any);

function setup() {
  const clock = new VirtualClock(Date.UTC(2026, 9, 29, 8));
  const store = new Store(':memory:');
  const risk = new RiskState(DEFAULT_RISK, clock);
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t) { sent.push(t); } }, clock);
  const market = (priceUsd: number, chain: string): MarketClient => ({ async market() { return { chain: chain as any, priceUsd }; }, async rug() { return undefined; } });
  /** Post draft texts in order of appearance (without a post executor they go to Telegram with a mark). */
  const posts = () => sent.filter(t => t.startsWith('🐦 Post draft (')).map(t => t.split('\n').slice(1).join('\n'));
  return { clock, risk, paper, sent, market, posts };
}

describe('#110: the contract address in token entry and exit posts', () => {
  for (const [chain, token] of [['base', EVM], ['solana', SOL]] as const) {
    it(`${chain}: the entry post and the exit post end with the line "CA: <full address> (${chain})"`, async () => {
      const e = setup();
      await e.paper.execute(MSG, buy(chain, token), 1);
      expect(e.posts().length).toBe(1);
      expect(e.posts()[0]).toMatch(/^Entered \$TKN on /);
      expect(e.posts()[0].endsWith(`\nCA: ${token} (${chain})`)).toBe(true);
      await e.paper.monitor(e.market(0.0002, chain), { tokensOnly: true }); // below the stop — the position is closed in full
      expect(e.paper.open.size).toBe(0);
      expect(e.posts().length).toBe(2);
      expect(e.posts()[1]).toMatch(/^Closed \$TKN/);
      expect(e.posts()[1].endsWith(`\nCA: ${token} (${chain})`)).toBe(true);
    });
  }

  it('perp: the entry post has no address line', async () => {
    const e = setup();
    const perp: Decision = { action: 'open_perp', sizeUsd: 1, chain: 'unknown', reasons: [], trust, intent: { kind: 'perp_trade', chain: 'unknown', urls: [], summary: 's', stance: 'buy', confidence: 0.9 },
      perp: { asset: 'BTC', side: 'long', entry: 100, notionalUsd: 3, leverage: 3, marginUsd: 1, stop: 97, takeProfit: 106, feePct: 0.05 } } as any;
    await e.paper.execute(MSG, perp, 1);
    expect(e.posts().length).toBe(1);
    expect(e.posts()[0]).not.toContain('CA:');
  });
});
