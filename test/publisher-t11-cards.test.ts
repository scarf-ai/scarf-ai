import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.js';
import { VirtualClock } from '../src/clock.js';
import { Publisher, cardVerdictLookup } from '../src/posts/publisher.js';
import { ProjectCards } from '../src/intel/projects.js';

// T-11, a reviewer finding: the card number in a thought (p<id>) does not survive a card merge. The check goes by project keys
// through the real Store + ProjectCards — the same as in src/index.ts.
function setup(clock: VirtualClock) {
  const store = new Store(':memory:');
  const cards = new ProjectCards(store);
  const edits: string[] = []; const posted: string[] = [];
  const pub = new Publisher({ store, clock, dataDir: mkdtempSync(join(tmpdir(), 'pub-t11-')), mode: 'approve', autoAfterDays: 3, dailyMax: 25, paper: true,
    autoApproveMinutes: 60, thoughtMinConfidence: 0, controlOkTimes: () => [clock.now()], ...cardVerdictLookup(cards, store),
    renderer: { async render() { return Buffer.from([1]); }, async warmup() { return 0; } } as any,
    notifier: { async send() {}, async sendPhoto() { return 1; }, async editCaption(_i: number, c: string) { edits.push(c); } } as any,
    x: { async post(t: string) { posted.push(t); return { id: 'T1' }; } } });
  return { store, cards, pub, edits, posted };
}
const thought = (id: number) => ({ key: `p${id}`, subject: 'Tin Moths', note: 'Tin Moths has an application page open', verdict: 'watch' as const, holding: false, confidence: 0.8 });
const X = { kind: 'x' as const, key: 'x:tinmothsnft', display: '@tinmothsnft' };
const D = { kind: 'domain' as const, key: 'domain:tinmoths.fun', display: 'tinmoths.fun' };

describe('queued thought vs a newer verdict on real project cards (T-11)', () => {
  it('incident: the thought card is merged into an older card, avoid lands there → not published', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-12T12:00:00Z'));
    const s = setup(clock);
    const m = (id: string) => ({ server: 's', channel: 'c', author: 'a', tsUtc: clock.iso(), id });
    // earlier: only the X account → the card with the lower number
    const [xId] = s.cards.observe([X], m('m0'), 'mention', '@tinmothsnft', true, 10);
    // 13:10: only the domain → its own card, watch, a thought in the queue
    clock.set(Date.parse('2026-11-12T13:10:50Z'));
    const [dId] = s.cards.observe([D], m('m1'), 'mention', 'tinmoths.fun', true, 10);
    expect(dId).toBeGreaterThan(xId);
    s.store.setProjectVerdict(dId, { verdict: 'watch', thesis: '', scores: {}, iso: clock.iso(), analyzedKeys: [D.key], trust: 10 });
    expect(await s.pub.thought(thought(dId), [])).toBe('queued');
    // 13:47: both keys in one message → the cards are merged into the lower number, avoid is recorded there
    clock.set(Date.parse('2026-11-12T13:47:46Z'));
    const ids = s.cards.observe([X, D], m('m2'), 'mention', '@tinmothsnft tinmoths.fun', true, 10);
    expect(ids).toEqual([xId]);
    expect(s.cards.card(dId)).toBeUndefined();
    for (const id of ids) s.store.setProjectVerdict(id, { verdict: 'avoid', thesis: 'team warning', scores: {}, iso: clock.iso(), analyzedKeys: [X.key, D.key], trust: 10 });
    clock.set(Date.parse('2026-11-12T14:11:00Z'));
    expect(await s.pub.publishOverdue()).toBe(0);
    expect(s.posted.length).toBe(0);
    expect(s.store.getPost(1)?.status).toBe('rejected');
    expect(s.edits.at(-1)).toContain('🐦 Post #1 cancelled: after it the project verdict became AVOID');
  });

  it('the same merge with a newer watch on the surviving card → published', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-12T12:00:00Z'));
    const s = setup(clock);
    const m = (id: string) => ({ server: 's', channel: 'c', author: 'a', tsUtc: clock.iso(), id });
    s.cards.observe([X], m('m0'), 'mention', '@tinmothsnft', true, 10);
    clock.set(Date.parse('2026-11-12T13:10:50Z'));
    const [dId] = s.cards.observe([D], m('m1'), 'mention', 'tinmoths.fun', true, 10);
    expect(await s.pub.thought(thought(dId), [])).toBe('queued');
    clock.set(Date.parse('2026-11-12T13:47:46Z'));
    for (const id of s.cards.observe([X, D], m('m2'), 'mention', '@tinmothsnft tinmoths.fun', true, 10))
      s.store.setProjectVerdict(id, { verdict: 'watch', thesis: '', scores: {}, iso: clock.iso(), analyzedKeys: [X.key, D.key], trust: 10 });
    clock.set(Date.parse('2026-11-12T14:11:00Z'));
    expect(await s.pub.publishOverdue()).toBe(1);
    expect(s.posted.length).toBe(1);
  });

  // Repeats src/intel/router.ts applyProjectVerdicts: setProjectVerdict writes the verdict to the card
  const verdict = (s: { store: Store }, id: number, v: string, iso: string) =>
    s.store.setProjectVerdict(id, { verdict: v, thesis: '', scores: {}, iso, analyzedKeys: [], trust: 10 });
  /** A card with a domain key, a thought queued at 13:10:50. */
  async function queued() {
    const clock = new VirtualClock(Date.parse('2026-11-12T13:10:50Z'));
    const s = setup(clock);
    const [id] = s.cards.observe([D], { server: 's', channel: 'c', author: 'a', tsUtc: clock.iso(), id: 'm1' }, 'mention', 'tinmoths.fun', true, 10);
    expect(await s.pub.thought(thought(id), [])).toBe('queued');
    return { ...s, clock, id };
  }

  it('avoid, then a later "seen" mark from a multi-project message → still not published (reviewer repro)', async () => {
    const s = await queued();
    verdict(s, s.id, 'avoid', '2026-11-12T13:47:46Z');
    verdict(s, s.id, 'seen', '2026-11-12T13:55:00Z');
    expect(s.cards.card(s.id)?.lastVerdict).toBe('seen');            // the card did not change for other readers
    s.clock.set(Date.parse('2026-11-12T14:11:00Z'));
    expect(await s.pub.publishOverdue()).toBe(0);
    expect(s.posted.length).toBe(0);
    expect(s.store.getPost(1)?.status).toBe('rejected');
  });

  it('avoid, then a newer watch → published', async () => {
    const s = await queued();
    verdict(s, s.id, 'avoid', '2026-11-12T13:47:46Z');
    verdict(s, s.id, 'watch', '2026-11-12T14:00:00Z');
    s.clock.set(Date.parse('2026-11-12T14:11:00Z'));
    expect(await s.pub.publishOverdue()).toBe(1);
  });

  it('merge where the dropped card holds the newer avoid → the survivor keeps it, still cancelled', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-12T12:00:00Z'));
    const s = setup(clock);
    const m = (id: string) => ({ server: 's', channel: 'c', author: 'a', tsUtc: clock.iso(), id });
    const [xId] = s.cards.observe([X], m('m0'), 'mention', '@tinmothsnft', true, 10);
    verdict(s, xId, 'watch', '2026-11-12T12:00:00Z');
    clock.set(Date.parse('2026-11-12T13:10:50Z'));
    const [dId] = s.cards.observe([D], m('m1'), 'mention', 'tinmoths.fun', true, 10);
    expect(await s.pub.thought(thought(dId), [])).toBe('queued');
    verdict(s, dId, 'avoid', '2026-11-12T13:47:46Z');
    clock.set(Date.parse('2026-11-12T13:50:00Z'));
    expect(s.cards.observe([X, D], m('m2'), 'mention', '@tinmothsnft tinmoths.fun', true, 10)).toEqual([xId]);
    expect(s.store.projectRealVerdict(xId)).toEqual({ verdict: 'avoid', atIso: '2026-11-12T13:47:46Z' });
    clock.set(Date.parse('2026-11-12T14:11:00Z'));
    expect(await s.pub.publishOverdue()).toBe(0);
    expect(s.posted.length).toBe(0);
  });

  it('legacy card rows (no real-verdict columns filled): avoid in last_verdict cancels, seen does not', async () => {
    for (const [legacy, published] of [['avoid', 0], ['seen', 1]] as const) {
      const s = await queued();
      s.store.db.prepare('UPDATE projects SET last_verdict=?, last_analysis_utc=?, last_real_verdict=NULL, last_real_verdict_utc=NULL WHERE id=?')
        .run(legacy, '2026-11-12T13:47:46Z', s.id);
      s.clock.set(Date.parse('2026-11-12T14:11:00Z'));
      expect(await s.pub.publishOverdue()).toBe(published);
      expect(s.posted.length).toBe(published);
    }
  });

  it('an old database without the real-verdict columns opens and gets them as NULL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-t11-')); const path = join(dir, 'a.db');
    const old = new Store(path);
    old.db.exec('CREATE TABLE p2 AS SELECT id, name, first_seen, last_seen, category, last_verdict, last_analysis_utc, last_thesis, scores, analyzed_keys, last_trust FROM projects');
    old.db.exec('DROP TABLE projects'); old.db.exec('ALTER TABLE p2 RENAME TO projects');
    old.db.exec("INSERT INTO projects(id, name, first_seen, last_seen, last_verdict, last_analysis_utc) VALUES (1, 'x', 't', 't', 'watch', '2026-11-12T10:00:00Z')");
    old.db.close();
    const s = new Store(path);
    expect(s.project(1).last_real_verdict).toBeNull();
    expect(s.projectRealVerdict(1)).toEqual({ verdict: 'watch', atIso: '2026-11-12T10:00:00Z' });
  });
});
