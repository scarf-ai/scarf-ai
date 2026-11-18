import { describe, it, expect } from 'vitest';
import { polymarketRef, parseGammaMarket, bestOf, feeRateFor, pmFee } from '../src/checks/polymarket.js';

describe('Polymarket parsing (paper, the owner 2026-10-23)', () => {
  it('links → event / market slugs', () => {
    expect(polymarketRef('https://polymarket.com/event/fed-decision-in-december')).toEqual({ event: 'fed-decision-in-december', market: undefined });
    expect(polymarketRef('https://polymarket.com/event/fed-decision-in-december/fed-cuts-25bps?tid=1')).toEqual({ event: 'fed-decision-in-december', market: 'fed-cuts-25bps' });
    expect(polymarketRef('https://polymarket.com/market/will-btc-hit-150k')).toEqual({ market: 'will-btc-hit-150k' });
    expect(polymarketRef('https://example.com/event/x')).toBeUndefined();
  });

  it('Gamma market with JSON-string fields; resolved winner; fee by category', () => {
    const m = parseGammaMarket({ slug: 'will-btc-hit-150k', question: 'Will BTC hit $150k by Dec 31?', outcomes: '["Yes","No"]', outcomePrices: '["0.23","0.77"]',
      clobTokenIds: '["111","222"]', endDate: '2026-12-31T23:59:00Z', closed: false, active: true, liquidityNum: 52000, volumeNum: 1.2e6, description: 'Resolves YES if…' }, 'btc', ['Crypto']);
    expect(m).toMatchObject({ slug: 'will-btc-hit-150k', closed: false, feeRate: 0.07, category: 'crypto', endUtc: '2026-12-31T23:59:00.000Z' });
    expect(m!.outcomes).toEqual([{ name: 'Yes', tokenId: '111', gammaPrice: 0.23 }, { name: 'No', tokenId: '222', gammaPrice: 0.77 }]);
    const r = parseGammaMarket({ slug: 'x', question: 'q', outcomes: ['Yes', 'No'], outcomePrices: ['0', '1'], clobTokenIds: ['1', '2'], closed: true });
    expect(r!.winner).toBe('No');
    expect(parseGammaMarket({ slug: 'x', outcomes: '["Yes","No"]', clobTokenIds: '["1"]' })).toBeUndefined();
    expect(feeRateFor(['Geopolitics']).rate).toBe(0);
    expect(pmFee(100, 0.5, 0.07)).toBeCloseTo(1.75, 6); // example from the docs: 100 shares at 50¢, crypto = $1.75
  });

  it('best ask/bid from the CLOB book regardless of ordering', () => {
    expect(bestOf({ bids: [{ price: '0.20', size: '10' }, { price: '0.22', size: '5' }], asks: [{ price: '0.30', size: '1' }, { price: '0.25', size: '9' }], min_order_size: '5' }))
      .toEqual({ ask: 0.25, bid: 0.22, minOrder: 5 });
  });
});
