// Incoming #127 (Strategy, S-02 option B): the 1h price change from DexScreener in MarketInfo.
import { describe, it, expect } from 'vitest';
import { parseDexScreener } from '../src/checks/token.js';

const ADDR = '0xAbC0000000000000000000000000000000000001';
const pair = (extra: Record<string, unknown>) => ({ pairs: [{ chainId: 'base', baseToken: { address: ADDR, symbol: 'TKN' }, priceUsd: '0.01', liquidity: { usd: 50_000 }, ...extra }] });
const h1 = (extra: Record<string, unknown>) => parseDexScreener(pair(extra), ADDR, Date.now())?.priceChangeH1Pct;

describe('parseDexScreener: the 1h price change (priceChange.h1)', () => {
  it('the number from the answer goes into priceChangeH1Pct as is: a rise, a fall, zero', () => {
    expect(h1({ priceChange: { m5: 3, h1: 66, h6: 120, h24: 400 } })).toBe(66);
    expect(h1({ priceChange: { h1: -41.7 } })).toBe(-41.7);
    expect(h1({ priceChange: { h1: 0 } })).toBe(0); // a real zero is data
  });

  it('a numeric string is parsed', () => {
    expect(h1({ priceChange: { h1: '12.5' } })).toBe(12.5);
  });

  it('no data — undefined, not 0 %: no field, null, an empty string, a non-number, infinity', () => {
    expect(h1({})).toBeUndefined();
    expect(h1({ priceChange: {} })).toBeUndefined();
    expect(h1({ priceChange: { h24: 10 } })).toBeUndefined(); // a fresh pair: an hour has not passed yet
    expect(h1({ priceChange: { h1: null } })).toBeUndefined();
    expect(h1({ priceChange: { h1: '' } })).toBeUndefined();
    expect(h1({ priceChange: { h1: 'n/a' } })).toBeUndefined();
    expect(h1({ priceChange: { h1: Infinity } })).toBeUndefined();
    expect(h1({ priceChange: null })).toBeUndefined();
  });

  it('the pair with the highest liquidity is taken — and its price change', () => {
    const json = { pairs: [
      { chainId: 'base', baseToken: { address: ADDR }, priceUsd: '0.01', liquidity: { usd: 1_000 }, priceChange: { h1: 900 } },
      { chainId: 'base', baseToken: { address: ADDR }, priceUsd: '0.01', liquidity: { usd: 80_000 }, priceChange: { h1: 15 } },
    ] };
    expect(parseDexScreener(json, ADDR, Date.now())?.priceChangeH1Pct).toBe(15);
  });
});
