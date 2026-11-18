import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fillTemplate, fmtPrice, fmtUsd, fmtHeld, clip, downsample, exitReasonLabel, tickerSize, cardFor, cardRenderer } from '../src/posts/cards.js';
import { recordPoint, type OpenPos } from '../src/exec/exits.js';
import { draftPost, shortAddrs } from '../src/posts/drafts.js';
import { Store } from '../src/store/db.js';
import { VirtualClock } from '../src/clock.js';
import { Publisher } from '../src/posts/publisher.js';
import type { Thought } from '../src/pipeline.js';

describe('SCARF cards: fields by README-PIPELINE (brand chat 2026-10-24)', () => {
  it('prices: up to 4 zeros as is, more → subscript; money with a real minus', () => {
    expect(fmtPrice(0.0000642)).toBe('0.0000642');
    expect(fmtPrice(0.00000123)).toBe('0.0₅123');
    expect(fmtPrice(0.0431)).toBe('0.0431');
    expect(fmtPrice(1.234)).toBe('1.23');
    expect(fmtUsd(-0.54, true)).toBe('−$0.54');
    expect(fmtUsd(1.86, true)).toBe('+$1.86');
  });
  it('template: if/else inside style, escaping, comments dropped', () => {
    const t = '<!-- note --><div style="color:{{#if is_win}}#7CF2C9{{else}}#FF7A6B{{/if}};">{{#if paper}}P{{/if}}{{x}}</div>';
    expect(fillTemplate(t, { is_win: false, paper: 'false', x: '<b>&' })).toBe('<div style="color:#FF7A6B;">&lt;b&gt;&amp;</div>');
    expect(fillTemplate(t, { is_win: true, paper: true, x: 'a' })).toBe('<div style="color:#7CF2C9;">Pa</div>');
  });
  it('held, ticker size, exit reason, long Polymarket question cut by word', () => {
    expect([fmtHeld(51), fmtHeld(192), fmtHeld(3000)]).toEqual(['51m', '3h 12m', '2d 2h']);
    expect([tickerSize('$SWARMX'), tickerSize('$SUPERCATX1'), tickerSize('$SUPERCATCOINX')]).toEqual([120, 100, 80]);
    expect(exitReasonLabel('stop-loss at 0.000064')).toBe('Stop hit');
    expect(exitReasonLabel('trailing stop 30% from peak 2')).toBe('Trailing stop');
    const q = 'Will ETH close above $4,000 on October 31, 2026, according to the Binance ETH/USDT daily candle close price as published by Binance?';
    const c = clip(q, 120);
    expect(c.length).toBeLessThanOrEqual(120);
    expect(c.endsWith('…')).toBe(true);
    expect(q.startsWith(c.slice(0, -1))).toBe(true);
  });
  it('price history: monitor keeps ≤ 61 points, card gets ≤ 30 with entry and exit', () => {
    const p = { entryPrice: 1 } as OpenPos;
    for (let i = 1; i <= 500; i++) recordPoint(p, 1 + i / 100);
    expect(p.points!.length).toBeLessThanOrEqual(61);
    expect(p.points![0]).toBe(1);
    expect(p.points![p.points!.length - 1]).toBe(6);
    const d = downsample(p.points!);
    expect(d.length).toBe(30);
    expect([d[0], d[29]]).toEqual([1, 6]);
  });
  it('closed token trade → approved PnL card; thought → WATCHING with the analyst note', () => {
    const now = '2026-10-23T16:54:00.000Z';
    const pnl = cardFor({ kind: 'exit', asset: '$SWARMX', chain: 'robinhood', paper: true, nowIso: now, sizeUsd: 1.25, pnlUsd: -0.54, pnlPct: -43.2, entryPrice: 0.00011, exitPrice: 0.0000642, holdMinutes: 51, reason: 'stop-loss at 0.0000642' });
    expect(pnl.template).toBe('pnl');
    expect(pnl.data).toMatchObject({ ticker: '$SWARMX', ticker_size: 120, pnl_usd: '−$0.54', pnl_pct: '−43.2%', arrow: '▼', result_word: 'LOSS', size_in: '$1.25', size_out: '$0.71',
      held: '51m', exit_reason: 'Stop hit', time_range: '16:03 → 16:54 UTC', chain: 'Robinhood Chain', paper: true });
    expect(String(pnl.data.chart_src)).toMatch(/^data:image\/svg\+xml;base64,/);
    const th = cardFor({ kind: 'thought', verdict: 'watch', asset: '$KEG', chain: 'bsc', paper: true, nowIso: now, note: 'Watching $KEG.' });
    expect(th.template).toBe('thought');
    expect(th.data).toMatchObject({ event_label: 'WATCHING', chip: 'NO POSITION', title: '$KEG', quote: 'Watching $KEG.', chain: 'BNB Chain', mood: 'thinking' });
  });
  const brand = resolve('brand/cards');
  it.skipIf(!existsSync(join(brand, 'fonts/JetBrainsMono-Bold.ttf')))('renders real PNGs from the brand folder in well under a second after warm-up', async () => {
    const r = cardRenderer(brand);
    await r.warmup();
    const now = '2026-10-24T09:00:00.000Z';
    for (const e of [
      { kind: 'exit', asset: '$SUPERCATCOINX', chain: 'solana', paper: true, nowIso: now, sizeUsd: 3, pnlUsd: 1.86, pnlPct: 62, entryPrice: 0.00000123, exitPrice: 0.00000199, holdMinutes: 192, reason: 'take-profit 1', points: [1, 2, 3] },
      { kind: 'thought', verdict: 'watch', asset: 'Lanternfolk', chain: 'ethereum', paper: true, nowIso: now, note: 'Public mint tomorrow; offers already above mint.' },
    ]) {
      const t0 = performance.now();
      const c = cardFor(e);
      const png = await r.render(c.template, c.data);
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(performance.now() - t0).toBeLessThan(3000);
    }
  }, 60_000);
});

describe('Thoughts on X (the owner 2026-10-24): watching, without the source', () => {
  it('draft: the note is the post; a source name kills it; full addresses are shortened', () => {
    // T-09 (the owner 2026-11-11 17:30 UTC): a token thought carries the contract address on a separate line; without an address it is not created
    const ca = '0x5b2e8a47d1c9f03e6b72a5d84c19e0f37ab2c4f9';
    const ok = draftPost({ kind: 'thought', asset: '$KEG', chain: 'bsc', holding: false, ca, note: 'Watching $KEG: real volume, thin liquidity' }, ['ServerA', 'degen-calls', 'alice']);
    expect(ok).toEqual({ text: `Watching $KEG: real volume, thin liquidity. No position.\nCA: ${ca} (bsc)`, problems: [] });
    expect(draftPost({ kind: 'thought', asset: '$KEG', chain: 'bsc', holding: false, note: 'Watching $KEG: real volume' }, [])).toEqual({ text: '', problems: ['token post without a contract address'] });
    expect(draftPost({ kind: 'thought', asset: '$KEG', chain: 'bsc', holding: false, ca, note: 'ServerA folks like $KEG' }, ['ServerA']).problems.length).toBeGreaterThan(0);
    expect(draftPost({ kind: 'thought', asset: '$KEG', chain: 'bsc', holding: false, note: 'Saw it in the alpha chat' }, []).problems.length).toBeGreaterThan(0);
    expect(shortAddrs('CA 0x5b2e8a47d1c9f03e6b72a5d84c19e0f37ab2c4f9 here')).toBe('CA 0x5b2e…c4f9 here');
    expect(shortAddrs('mint 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr ok')).toBe('mint 7GCi…W2hr ok');
  });
  it('one thought per project per 24 h (watch → act may repeat), cap per day, min confidence', async () => {
    const store = new Store(':memory:');
    const clock = new VirtualClock(Date.parse('2026-10-24T10:00:00Z'));
    const photos: string[] = [];
    const notifier = { async send() {}, async sendPhoto(_p: Buffer, c: string) { photos.push(c); return photos.length; }, async editCaption() {} };
    const pub = new Publisher({ store, notifier, clock, dataDir: mkdtempSync(join(tmpdir(), 'agent-th-')), renderer: { async render() { return Buffer.from([137, 80, 78, 71]); }, async warmup() { return 0; } },
      x: { async post() { return { id: 'T' }; } }, mode: 'approve', autoAfterDays: 3, dailyMax: 25, paper: true, thoughtsDailyMax: 2 });
    const t = (key: string, verdict: 'act' | 'watch' = 'watch', confidence = 0.7): Thought => ({ key, subject: `$${key.toUpperCase()}`, note: `Watching $${key.toUpperCase()}`, verdict, holding: false, confidence, ca: '0x5b2e8a47d1c9f03e6b72a5d84c19e0f37ab2c4f9' });
    expect(await pub.thought(t('keg', 'watch', 0.5), [])).toMatch(/confidence/);
    expect(await pub.thought(t('keg'), [])).toBe('queued');
    expect(photos[0]).toContain('Watching $KEG. No position.');
    expect(photos[0]).not.toContain('[paper]');
    expect(await pub.thought(t('keg'), [])).toMatch(/24h/);
    expect(await pub.thought(t('keg', 'act'), [])).toBe('queued');
    expect(await pub.thought(t('kelp'), [])).toMatch(/cap 2/);
    clock.advance(25 * 3600_000);
    expect(await pub.thought(t('kelp'), [])).toBe('queued');
  });
});

import { CLAIMS_DONE } from '../src/posts/drafts.js';
describe('thought notes cannot claim an action that was not done (Chirpochain 2026-10-28)', () => {
  it('blocks first-person done-claims, allows plans and neutral facts', () => {
    expect(CLAIMS_DONE.test('Signed up as a testnet miner on Chirpochain. Costs nothing.')).toBe(true);
    expect(CLAIMS_DONE.test("I've minted two and I hold them.")).toBe(true);
    expect(CLAIMS_DONE.test('Watching $KEG: 2k holders joined this week.')).toBe(false);
    expect(CLAIMS_DONE.test('Planning to sign up as a testnet miner; on my list.')).toBe(false);
    expect(draftPost({ kind: 'thought', asset: 'Chirpochain', chain: '', holding: false, note: 'Signed up as a testnet miner.' }, []).problems).toEqual(['the note claims an action that was not done']);
  });
});
