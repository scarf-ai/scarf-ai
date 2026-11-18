// Incoming #126 item 2 (S-07 V2 tail): the deadline line in the public entry post plan — with a date if the deadline is not today, and with
// the "core" mark if the position has a tail. Option A from the Execution proposal; the wording is approved by the owner.
import { describe, it, expect } from 'vitest';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor, deadlineForPost } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';

const NOW = Date.UTC(2026, 10, 14, 8, 0, 0); // 2026-11-14 08:00 UTC
const TOKEN = '0x4444444444444444444444444444444444444444';
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-14T08:00:00.000Z', text: 'ape' };
const trust = { score: 10, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const buy = (timeStopAtUtc: string, hard: boolean): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'base', reasons: [], trust, estGasUsd: 0.02, publicNote: 'Liquidity is real.',
  intent: { kind: 'token_call', chain: 'base', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: TOKEN, ticker: 'TKN' },
  check: { ok: true, chain: 'base', address: TOKEN, priceUsd: 0.001, reasons: [] },
  exitPlan: { stopPrice: 0.00055, stopPct: 45, tp1Price: 0.0012, tp1Share: 0.2, tpX: 1.2, trailingPct: 35, timeStopAtUtc, hardTimeStop: hard } } as any); // example plan

async function postFor(d: Decision): Promise<string> {
  const clock = new VirtualClock(NOW);
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, new RiskState(DEFAULT_RISK, clock), new Store(':memory:'), { async send(t) { sent.push(t); } }, clock);
  await paper.execute(MSG, d, 1);
  return sent.find(t => t.startsWith('🐦 Post draft ('))!.split('\n').slice(1).join('\n');
}

describe('#126 item 2: deadlineForPost', () => {
  it('deadline today (UTC) — time only; not today — with a date; tail — the core mark', () => {
    expect(deadlineForPost('2026-11-14T12:00:00.000Z', NOW, false)).toBe(', out by 12:00 UTC');
    expect(deadlineForPost('2026-11-14T23:59:00.000Z', NOW, false)).toBe(', out by 23:59 UTC');
    expect(deadlineForPost('2026-11-15T00:00:00.000Z', NOW, false)).toBe(', out by Nov 15 00:00 UTC');
    expect(deadlineForPost('2026-11-17T08:00:00.000Z', NOW, false)).toBe(', out by Nov 17 08:00 UTC');
    expect(deadlineForPost('2026-11-17T08:00:00.000Z', NOW, true)).toBe(', core out by Nov 17 08:00 UTC');
    expect(deadlineForPost('2026-11-14T12:00:00.000Z', NOW, true)).toBe(', core out by 12:00 UTC');
    expect(deadlineForPost('2027-01-02T03:04:00.000Z', Date.UTC(2026, 11, 31, 23), false)).toBe(', out by Jan 2 03:04 UTC'); // across New Year
  });
  it('the deadline did not parse — the line is empty, not "Invalid Date" in a public post', () => {
    expect(deadlineForPost('soon', NOW, true)).toBe('');
    expect(deadlineForPost('', NOW, false)).toBe('');
  });
});

describe('#126 item 2: the entry post', () => {
  it('a deadline several days away — the post has a date, not just a time', async () => {
    const text = await postFor(buy('2026-11-17T08:00:00.000Z', true));
    expect(text).toContain('Plan: stop −45%, 20% off at 1.20x, out by Nov 17 08:00 UTC');
    expect(text.endsWith(`\nCA: ${TOKEN} (base)`)).toBe(true);
  });
  it('deadline today — as before, a time only; a soft deadline (not hard) does not get into the post', async () => {
    expect(await postFor(buy('2026-11-14T12:00:00.000Z', true))).toContain('Plan: stop −45%, 20% off at 1.20x, out by 12:00 UTC');
    expect(await postFor(buy('2026-11-17T08:00:00.000Z', false))).not.toContain('out by');
  });
});
