import { describe, it, expect } from 'vitest';
import { evaluateExit, type OpenPos } from '../src/exec/exits.js';

const mk = (): OpenPos => ({ id: 'p', token: 't', chain: 'solana', entryPrice: 1, qty: 100, qtyLeft: 100, costUsd: 100, peakPrice: 1, tp1Done: false,
  openedAtMs: 0, stopPrice: 0.6, tp1Price: 2, tp1Share: 0.5, trailingPct: 25, timeStopAtMs: 24 * 3600_000, timeStopMinGainPct: 15 }); // example numbers

describe('memecoin exits', () => {
  it('stop-loss sells everything', () => { const p = mk(); expect(evaluateExit(p, 0.55, 1)).toMatchObject({ kind: 'sell', qty: 100 }); });
  it('tp1 sells half once, then trailing from peak', () => {
    const p = mk();
    expect(evaluateExit(p, 2.1, 1)).toMatchObject({ kind: 'sell', qty: 50 });
    p.qtyLeft = 50;
    expect(evaluateExit(p, 3, 2).kind).toBe('none');
    expect(evaluateExit(p, 2.3, 3).kind).toBe('none'); // 2.3 > 3 × 0.75 = 2.25 — hold
    expect(evaluateExit(p, 2.2, 4)).toMatchObject({ kind: 'sell', qty: 50 });
  });
  it('time stop when flat after 24h', () => { const p = mk(); expect(evaluateExit(p, 1.1, 24 * 3600_000 + 1)).toMatchObject({ kind: 'sell', reason: 'time stop' }); });
  it('no time stop when up > 15%', () => { const p = mk(); expect(evaluateExit(p, 1.3, 24 * 3600_000 + 1).kind).toBe('none'); });
});

describe('analyst exit plan for memecoins (the owner 2026-10-23, SWARMX)', () => {
  it('analyst can only tighten the stop; TP, share and sell-by within bounds; no analyst → defaults', async () => {
    const { memecoinPlan } = await import('../src/decide/decide.js');
    const ex = { stopLossPct: 40, takeProfit1x: 2, takeProfit1Share: 0.5, timeStopHours: 24 }; // example numbers
    expect(memecoinPlan(ex, { stopLossPct: 27, takeProfitX: 1.5, takeProfitShare: 1, sellByHours: 4 }, true)).toEqual({ stopPct: 27, tpX: 1.5, share: 1, hours: 4, hard: true });
    expect(memecoinPlan(ex, { stopLossPct: 60 }, true).stopPct).toBe(40);    // cannot be wider
    expect(memecoinPlan(ex, { stopLossPct: 1 }, true).stopPct).toBe(5);      // tighter than 5% is noise
    expect(memecoinPlan(ex, { sellByHours: 100 }, true).hours).toBe(24);
    expect(memecoinPlan(ex, { takeProfitX: 1.01 }, true).tpX).toBe(2);
    expect(memecoinPlan(ex, { stopLossPct: 10, sellByHours: 2 }, false)).toEqual({ stopPct: 40, tpX: 2, share: 0.5, hours: 24, hard: false });
  });

  it('hard sell-by sells at the deadline even in profit', async () => {
    const { evaluateExit } = await import('../src/exec/exits.js');
    const p = { id: 'x', token: 't', chain: 'robinhood', entryPrice: 1, qty: 10, qtyLeft: 10, costUsd: 10, peakPrice: 1, tp1Done: false, openedAtMs: 0,
      stopPrice: 0.73, tp1Price: 1.5, tp1Share: 1, trailingPct: 25, timeStopAtMs: 4 * 3600_000, timeStopMinGainPct: 15, hardTimeStop: true };
    expect(evaluateExit({ ...p }, 1.3, 3 * 3600_000).kind).toBe('none');
    expect(evaluateExit({ ...p }, 1.3, 4 * 3600_000)).toMatchObject({ kind: 'sell', reason: 'sell-by time reached' });
    expect(evaluateExit({ ...p }, 0.72, 1000)).toMatchObject({ kind: 'sell', qty: 10 });
  });
});

import { silenceCheck } from '../src/jobs.js';
describe('mirror silence watchdog (2026-10-27)', () => {
  it('alerts after N hours of silence, at most every 6 h, and says when messages are back', () => {
    const st: { alertedAtMs?: number } = {};
    const t0 = Date.parse('2026-10-24T12:00:00Z');
    expect(silenceCheck('2026-10-24T12:00:00Z', t0 + 2 * 3600_000, st, 3)).toBeUndefined();
    expect(silenceCheck('2026-10-24T12:00:00Z', t0 + 3 * 3600_000, st, 3)).toMatch(/No messages from the mirror server for 3 h/);
    expect(silenceCheck('2026-10-24T12:00:00Z', t0 + 5 * 3600_000, st, 3)).toBeUndefined();
    expect(silenceCheck('2026-10-24T12:00:00Z', t0 + 9 * 3600_000, st, 3)).toMatch(/No messages from the mirror server for 9 h/);
    expect(silenceCheck('2026-10-24T21:30:00Z', t0 + 10 * 3600_000, st, 3)).toMatch(/flowing again/);
    expect(silenceCheck('2026-10-24T21:30:00Z', t0 + 10 * 3600_000, st, 3)).toBeUndefined();
    expect(silenceCheck('2026-10-24T12:00:00Z', t0 + 99 * 3600_000, {}, 0)).toBeUndefined();
  });
});

// S-07 (#102): a two-part position — core and moonbag from the moment of entry
describe('memecoin exits: core + moonbag (S-07)', () => {
  const mkm = (): OpenPos => ({ ...mk(), stopPrice: 0.7, tp1Price: 2, tp1Share: 0.5, trailingPct: 30, breakevenAfterTp1: true,
    moonbagQty: 30, moonbagStopPrice: 0.2, moonbagArmPrice: 3, moonbagTrailingPct: 60, moonbagUntilMs: 14 * 86400_000, timeStopAtMs: 72 * 3600_000 });
  it('core stop sells only the core; moonbag survives a deep dip and is sold on its own stop', () => {
    const p = mkm();
    expect(evaluateExit(p, 0.6, 1)).toMatchObject({ kind: 'sell', qty: 70, reason: expect.stringMatching(/moonbag kept/) });
    p.qtyLeft = 30;
    expect(evaluateExit(p, 0.41, 2).kind).toBe('none');            // tobiq: −59 % — moonbag holds
    expect(evaluateExit(p, 0.19, 3)).toMatchObject({ kind: 'sell', qty: 30, reason: expect.stringMatching(/^moonbag stop/) });
  });
  it('take-profit sells a share of the WHOLE position (M3), then breakeven stop; moonbag trails only after arming', () => {
    const p = mkm();
    expect(evaluateExit(p, 2.1, 1)).toMatchObject({ kind: 'sell', qty: 50 }); // 50 % of the whole position (100), as in the table
    expect(p.stopPrice).toBe(1);                                         // breakeven
    p.qtyLeft = 50;
    expect(evaluateExit(p, 2.5, 2).kind).toBe('none');
    expect(evaluateExit(p, 1.7, 3)).toMatchObject({ kind: 'sell', qty: 20, reason: expect.stringMatching(/^trailing/) }); // remainder of the core: 50 − 30
    p.qtyLeft = 30;
    expect(evaluateExit(p, 1.05, 4).kind).toBe('none');               // moonbag: trailing not armed yet (peak 2.5 < 3)
    expect(evaluateExit(p, 10, 5).kind).toBe('none');                 // peak 10 — trailing armed
    expect(evaluateExit(p, 4.1, 6).kind).toBe('none');                // 4.1 > 10 × 0.4
    expect(evaluateExit(p, 3.9, 7)).toMatchObject({ kind: 'sell', qty: 30, reason: expect.stringMatching(/^moonbag trailing/) });
  });
  it('share of the whole position is capped by the core: 75 % + moonbag 30 % sells only the core 70', () => {
    const p = { ...mkm(), tp1Share: 0.75 };
    expect(evaluateExit(p, 2.1, 1)).toMatchObject({ kind: 'sell', qty: 70 });
  });
  it('moonbag time limit; time stop of the core does not touch the moonbag', () => {
    const p = mkm();
    expect(evaluateExit(p, 1.05, 72 * 3600_000 + 1)).toMatchObject({ kind: 'sell', qty: 70, reason: 'time stop' });
    p.qtyLeft = 30;
    expect(evaluateExit(p, 1.05, 72 * 3600_000 + 2).kind).toBe('none');
    expect(evaluateExit(p, 1.05, 14 * 86400_000)).toMatchObject({ kind: 'sell', qty: 30, reason: 'moonbag time limit' });
  });
  it('moonbagFields builds prices from the actual fill; without moonbag only class and breakeven', async () => {
    const { moonbagFields } = await import('../src/exec/exits.js');
    expect(moonbagFields({ tokenClass: 'conviction', breakevenAfterTp1: true, moonbagShare: 0.25, moonbagStopPct: 80, moonbagArmX: 3, moonbagTrailingPct: 60, moonbagMaxHours: 240 }, 100, 2, 1000))
      .toEqual({ tokenClass: 'conviction', breakevenAfterTp1: true, moonbagQty: 25, moonbagStopPrice: expect.closeTo(0.4, 9), moonbagArmPrice: 6, moonbagTrailingPct: 60, moonbagUntilMs: 1000 + 240 * 3600_000 });
    expect(moonbagFields({ tokenClass: 'fresh' }, 100, 2, 0)).toEqual({ tokenClass: 'fresh' });
  });
});

// S-07 V2: a ladder of N rungs, behavior checks, trailing 0 = off. Numbers are examples (as in test/fixtures/risk.example.json)
describe('memecoin exits V2: ladder and behavior checks', async () => {
  const { moonbagFields } = await import('../src/exec/exits.js');
  const mkv = (plan: any): OpenPos => ({ id: 'v', token: 't', chain: 'solana', entryPrice: 1, qty: 100, qtyLeft: 100, costUsd: 100, peakPrice: 1, tp1Done: false, openedAtMs: 0,
    stopPrice: 1 - plan.floor / 100, tp1Price: plan.ladder[0][0], tp1Share: plan.ladder[0][1], trailingPct: plan.trail, timeStopAtMs: 48 * 3600_000, timeStopMinGainPct: 0, hardTimeStop: true,
    ...moonbagFields({ breakevenAfterTp1: true, ladder: plan.ladder, checks: plan.checks, moonbagShare: plan.moon, moonbagStopPct: 80, moonbagArmX: 5, moonbagTrailingPct: 50, moonbagMaxHours: 336 }, 100, 1, 0) });
  const call = { floor: 45, trail: 35, moon: 0.2, ladder: [[1.2, 0.2], [1.8, 0.2], [2.7, 0.2], [4.05, 0.2]], checks: [[20, 0.75], [45, 0.7], [90, 0.65], [300, 0.85]] };
  const scan = { floor: 70, trail: 0, moon: 0.2, ladder: [[1.2, 0.4], [1.44, 0.4]], checks: [[20, 0.75], [45, 0.7], [90, 0.65]] };
  const M = 60_000;
  it('a jump through several rungs sells them in one sale; first sale moves the floor to breakeven', () => {
    const p = mkv(call);
    expect(evaluateExit(p, 2.0, M)).toMatchObject({ kind: 'sell', qty: expect.closeTo(40, 6), reason: expect.stringMatching(/^ladder 1–2\/4/) });
    expect(p.stopPrice).toBe(1);
    p.qtyLeft -= 40;
    expect(evaluateExit(p, 2.5, 2 * M).kind).toBe('none');
    expect(evaluateExit(p, 3.0, 3 * M)).toMatchObject({ kind: 'sell', qty: expect.closeTo(20, 6), reason: expect.stringMatching(/^ladder 3\/4/) });
    p.qtyLeft -= 20;
    // trailing 35 % from the 3.0 peak → 1.95: the rest of the core (20) is sold, the moonbag (20) stays
    expect(evaluateExit(p, 1.94, 4 * M)).toMatchObject({ kind: 'sell', qty: expect.closeTo(20, 6), reason: expect.stringMatching(/^trailing/) });
  });
  it('behavior checks fire only before the first sale and only when the price is below the threshold at the check time', () => {
    const p = mkv(call);
    expect(evaluateExit(p, 0.75, 10 * M).kind).toBe('none');               // before the first check, above the −45 % floor
    expect(evaluateExit(p, 0.77, 20 * M).kind).toBe('none');               // 20 min: 0.77 ≥ 0.75
    expect(evaluateExit(p, 0.67, 46 * M)).toMatchObject({ kind: 'sell', qty: 80, reason: expect.stringMatching(/behavior check 45 min/) });
    const q = mkv(call);
    expect(evaluateExit(q, 1.25, 5 * M)).toMatchObject({ kind: 'sell', reason: expect.stringMatching(/^ladder 1\/4/) });
    q.qtyLeft -= 20;
    expect(evaluateExit(q, 1.05, 91 * M).kind).toBe('none');               // no checks after a sale (1.05 > breakeven)
  });
  it('after the first sale the breakeven floor sells the core; moonbag stays', () => {
    const q = mkv(call);
    evaluateExit(q, 1.25, 5 * M); q.qtyLeft -= 20;
    expect(evaluateExit(q, 0.99, 6 * M)).toMatchObject({ kind: 'sell', qty: expect.closeTo(60, 6), reason: expect.stringMatching(/stop-loss.*moonbag kept/) });
  });
  it('scan: trailing 0 is off; both rungs leave only the moonbag; floor −70 %', () => {
    const p = mkv(scan);
    expect(evaluateExit(p, 1.21, M)).toMatchObject({ kind: 'sell', qty: 40 }); p.qtyLeft -= 40;
    expect(evaluateExit(p, 1.21 * 0.5, 2 * M)).toMatchObject({ kind: 'sell', qty: 40, reason: expect.stringMatching(/stop-loss/) }); // below breakeven
    const r = mkv(scan);
    expect(evaluateExit(r, 0.75, 5 * M).kind).toBe('none');                 // −25 % — not a stop: floor −70 %
    expect(evaluateExit(r, 0.74, 21 * M)).toMatchObject({ kind: 'sell', qty: 80, reason: expect.stringMatching(/behavior check 20 min/) });
    const s = mkv(scan);
    expect(evaluateExit(s, 0.29, M)).toMatchObject({ kind: 'sell', qty: 80, reason: expect.stringMatching(/stop-loss/) }); // emergency floor
  });
});
