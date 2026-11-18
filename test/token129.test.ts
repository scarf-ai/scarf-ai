// #129 (HQ finishing 2026-11-16): a pair date in the future and a non-number — "no data"; the quality check does not take "no number" as 0;
// the 1h change percent — decimal notation only.
import { describe, it, expect } from 'vitest';
import { parseDexScreener, evaluateToken, pairAgeMinutesFrom } from '../src/checks/token.js';

const NOW = Date.UTC(2026, 10, 15, 12);
const MINT = '4CxjZySynthCabcdefghijkmnopqrstuvwxyz18spump';
const RUG = { risk: 'low' as const, freezeOrMintAuthority: false, reasons: [] };
const dex = (o: Record<string, unknown>) => ({ pairs: [{ chainId: 'solana', dexId: 'raydium', pairAddress: 'P1', baseToken: { address: MINT, symbol: 'X' },
  priceUsd: '0.001', liquidity: { usd: 60_000 }, fdv: 600_000, txns: { h24: { buys: 2000, sells: 1800 } }, priceChange: { h1: 10 }, ...o }] });
const parse = (o: Record<string, unknown>) => parseDexScreener(dex(o), MINT, NOW)!;

describe('#129: pair age from pairCreatedAt', () => {
  it('a date later than "now" by more than 2 min → undefined; within 2 min → about 0; the past — as before', () => {
    expect(parse({ pairCreatedAt: NOW + 2 * 3600_000 }).pairAgeMinutes).toBeUndefined();
    expect(parse({ pairCreatedAt: NOW + 2 * 60_000 + 1 }).pairAgeMinutes).toBeUndefined();
    expect(parse({ pairCreatedAt: NOW + 60_000 }).pairAgeMinutes).toBe(0);
    expect(parse({ pairCreatedAt: NOW - 30 * 60_000 }).pairAgeMinutes).toBeCloseTo(30, 9);
  });

  it('a non-number ("soon", an object, NaN) → undefined, not NaN; a string of digits — a number; no field — undefined', () => {
    for (const v of ['soon', '', '0x10', { t: 1 }, NaN, Infinity, -5, null, undefined])
      expect(parse({ pairCreatedAt: v }).pairAgeMinutes, String(v)).toBeUndefined();
    expect(parse({ pairCreatedAt: String(NOW - 60 * 60_000) }).pairAgeMinutes).toBeCloseTo(60, 9);
    expect(pairAgeMinutesFrom(NOW - 120_000, NOW)).toBeCloseTo(2, 9);
  });

  it('review: the date looks like seconds (10 digits, < 1e11) → undefined (the unit is unclear), not a 50+ year old pair', () => {
    const sec = Math.floor((NOW - 30 * 3600_000) / 1000); // 30 h ago, in seconds
    expect(String(sec)).toHaveLength(10);
    expect(pairAgeMinutesFrom(sec, NOW)).toBeUndefined();
    expect(parse({ pairCreatedAt: String(sec) }).pairAgeMinutes).toBeUndefined();
    expect(pairAgeMinutesFrom(99_999_999_999, NOW)).toBeUndefined();
    // the same date in ms — age 30 h; the full check with a date in seconds — refused by age
    expect(pairAgeMinutesFrom(sec * 1000, NOW)).toBeCloseTo(30 * 60, 6);
    expect(evaluateToken(MINT, 'full', parse({ pairCreatedAt: sec }), RUG).reasons).toContain('quality: pair age unknown < 10');
  });

  it('the full quality check: no age (future, "soon") → refused by age; an old pair — passes', () => {
    for (const v of [NOW + 3600_000, 'soon']) {
      const c = evaluateToken(MINT, 'full', parse({ pairCreatedAt: v }), RUG);
      expect(c.ok, String(v)).toBe(false);
      expect(c.reasons).toContain('quality: pair age unknown < 10');
    }
    expect(evaluateToken(MINT, 'full', parse({ pairCreatedAt: NOW - 30 * 3600_000 }), RUG).ok).toBe(true);
    // fast: no minimum age (0) — a missing age does not interfere
    expect(evaluateToken(MINT, 'fast', parse({ pairCreatedAt: 'soon' }), RUG).ok).toBe(true);
  });

  it('the quality check: NaN in liquidity, age and buys does not pass as 0 (where a minimum is set)', () => {
    const m = parse({ pairCreatedAt: NOW - 30 * 3600_000 });
    expect(evaluateToken(MINT, 'full', { ...m, liquidityUsd: NaN }, RUG).reasons).toContain('quality: liquidity unknown < $10000');
    expect(evaluateToken(MINT, 'full', { ...m, pairAgeMinutes: NaN }, RUG).reasons).toContain('quality: pair age unknown < 10');
    expect(evaluateToken(MINT, 'full', { ...m, buys24h: NaN }, RUG).reasons).toContain('quality: buys24h unknown < 50');
    expect(evaluateToken(MINT, 'fast', { ...m, liquidityUsd: NaN }, RUG).ok).toBe(false);
  });
});

describe('#129: the 1h change percent — decimal notation only', () => {
  it('"0x10", "0b1", "1_000", "Infinity" → undefined; "12.5", " -3 ", "1e1" → a number', () => {
    for (const v of ['0x10', '0b1', '0o7', '1_000', 'Infinity', '12.5%', ' '])
      expect(parse({ priceChange: { h1: v } }).priceChangeH1Pct, v).toBeUndefined();
    expect(parse({ priceChange: { h1: '12.5' } }).priceChangeH1Pct).toBe(12.5);
    expect(parse({ priceChange: { h1: ' -3 ' } }).priceChangeH1Pct).toBe(-3);
    expect(parse({ priceChange: { h1: '1e1' } }).priceChangeH1Pct).toBe(10);
    expect(parse({ priceChange: { h1: '.5' } }).priceChangeH1Pct).toBe(0.5);
  });
});
