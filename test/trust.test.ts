import { describe, it, expect } from 'vitest';
import { parseTrustCsv, TrustTable, tierFor } from '../src/trust/trust.js';

const CSV = '﻿level,server,channel,author,score,note\n' +
  'server,ServerA,,,5,\n' +
  'channel,ServerA,core-calls,,8,\n' +
  'channel,ServerA,chat,,3,\n' +
  'channel,ServerB,scan-feed,,7,\n' +
  'server,ServerB,,,6,\n' +
  'author,ServerA,,caller1,9,team\n' +
  'author,,,caller2,2,everywhere\n' +
  'channel,ServerC,alpha,,,empty score = template row\n';

describe('trust rules (the owner 2026-10-22)', () => {
  const { rows, errors } = parseTrustCsv(CSV);
  const t = new TrustTable(rows);
  it('parses csv with BOM and skips empty scores', () => { expect(errors).toEqual([]); expect(rows.length).toBe(7); });
  it('scored author keeps own score even in a high channel', () => { expect(t.resolve('ServerA', 'core-calls', 'caller1').score).toBe(9); });
  it('author scored on all servers (empty server)', () => { expect(t.resolve('ServerB', 'scan-feed', 'caller2').score).toBe(2); });
  it('unscored author in channel > 6 inherits channel score', () => {
    const r = t.resolve('ServerA', 'core-calls', 'random_guy'); expect(r.score).toBe(8); expect(r.basis).toBe('channel_inherit');
  });
  it('unscored author in channel <= 6 gets 0', () => { expect(t.resolve('ServerA', 'chat', 'random_guy').score).toBe(0); });
  it('channel without own score uses server score; server 6 → not > 6 → 0', () => { expect(t.resolve('ServerB', 'chat', 'x').score).toBe(0); });
  it('channel exactly 7 inherits', () => { expect(t.resolve('ServerB', '#scan-feed', 'X').score).toBe(7); });
  it('unknown server/channel → 0', () => { expect(t.resolve('Nope', 'x', 'y').score).toBe(0); });
  it('case-insensitive', () => { expect(t.resolve('servera', 'CORE-CALLS', 'CALLER1').score).toBe(9); });
  it('downgrade lowers, cannot raise', () => {
    const t2 = new TrustTable(rows);
    t2.downgrade('servera|caller1', 2);
    expect(t2.resolve('ServerA', 'core-calls', 'caller1').score).toBe(7);
    expect(() => t2.downgrade('servera|caller1', -3)).toThrow();
  });
  it('compromised signs cap score at 1', () => { expect(t.resolve('ServerA', 'core-calls', 'caller1', { compromisedSigns: ['x'] }).score).toBe(1); });
  it('tiers', () => { expect([0, 3, 4, 6, 7, 9, 10].map(tierFor)).toEqual(['journal', 'journal', 'full', 'full', 'fast', 'fast', 'follow']); });
  it('rejects bad score', () => { expect(parseTrustCsv('level,server,channel,author,score\nserver,A,,,11').errors.length).toBe(1); });
});
