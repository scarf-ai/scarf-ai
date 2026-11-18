import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.js';
import { VirtualClock } from '../src/clock.js';
import { Publisher, pollWatch, THOUGHT_POSTS_PER_PROJECT_24H } from '../src/posts/publisher.js';
import { draftPost, shortCaLine } from '../src/posts/drafts.js';
import { startTelegramControl } from '../src/notify/telegramControl.js';

function setup(opts: { x?: boolean; mode?: 'approve' | 'auto'; dailyMax?: number; autoApproveMinutes?: number; failPost?: boolean; xRule?: (text: string) => string | undefined; slowX?: boolean; photoFails?: boolean; store?: Store; clock?: VirtualClock; pollOk?: () => number[]; projectVerdict?: (key: string) => { verdict: string; atIso: string } | undefined } = {}) {
  const store = opts.store ?? new Store(':memory:');
  const clock = opts.clock ?? new VirtualClock(Date.parse('2026-10-23T16:54:00Z'));
  const sent: string[] = []; const photos: { caption: string; buttons?: any }[] = []; const edits: string[] = [];
  const notifier = {
    async send(t: string) { sent.push(t); },
    async sendPhoto(_png: Buffer, caption: string, buttons?: any) { if (opts.photoFails) return undefined; photos.push({ caption, buttons }); return photos.length; },
    async editCaption(_id: number, c: string) { edits.push(c); },
  };
  const posted: { text: string; img: boolean }[] = []; const release: (() => void)[] = []; const attempts: string[] = [];
  const x = opts.x === false ? undefined : { async post(text: string, image?: Buffer) {
    if (opts.failPost) throw new Error('X is down');
    const refused = opts.xRule?.(text); if (refused) { attempts.push(text); throw new Error(refused); }
    if (opts.slowX) await new Promise<void>(res => release.push(res)); // X does not answer right away
    posted.push({ text, img: !!image }); return { id: `T${posted.length}` };
  } };
  const renderer = { async render() { return Buffer.from([137, 80, 78, 71]); }, async warmup() { return 0; } };
  // By default the Telegram poll is "alive": the batch received just now is processed (buttons reach the agent)
  const pollOk = opts.pollOk ?? (() => [clock.now()]);
  const pub = new Publisher({ store, notifier, clock, dataDir: mkdtempSync(join(tmpdir(), 'agent-pub-')), renderer, x, mode: opts.mode ?? 'approve', autoAfterDays: 3, dailyMax: opts.dailyMax ?? 25, paper: true,
    autoApproveMinutes: opts.autoApproveMinutes, thoughtMinConfidence: 0, controlOkTimes: pollOk,
    // The thought project p<id> is one key; the verdict is looked up by it (real cards — test/publisher-t11-cards.test.ts)
    ...(opts.projectVerdict ? { projectKeys: (k: string) => [k], projectVerdict: (keys: string[]) => keys.flatMap(k => { const v = opts.projectVerdict!(k); return v ? [v] : []; }) } : {}) });
  return { store, clock, sent, photos, edits, posted, release, attempts, pub };
}
const tick = () => new Promise<void>(res => setImmediate(res));
const ev = { kind: 'exit' as const, asset: '$SWARMX', chain: 'robinhood', pnlUsd: -0.54, holding: false };

describe('X posts: Telegram approval for 3 days, then auto (the owner 2026-10-23)', () => {
  it('approve: card + buttons; "ok" posts with the image; "no" rejects; a second press does nothing', async () => {
    const s = setup();
    await s.pub.queue(ev, ['ServerA']);
    expect(s.photos[0].caption).toContain('publish?');
    expect(s.photos[0].buttons[0][0].data).toBe('post:1:ok');
    expect(s.posted.length).toBe(0);
    expect(await s.pub.onCallback('post:1:ok')).toBe('Published');
    expect(s.posted[0]).toEqual({ text: '[paper] Closed $SWARMX: −$0.54. No position now.', img: true });
    expect(await s.pub.onCallback('post:1:ok')).toMatch(/Already handled/);
    await s.pub.queue(ev, []);
    expect(await s.pub.onCallback('post:2:no')).toBe('Not publishing');
    expect(s.posted.length).toBe(1);
  });

  it('after 3 days from the first published post — auto', async () => {
    const s = setup();
    await s.pub.queue(ev, []); await s.pub.onCallback('post:1:ok');
    s.clock.advance(3 * 86400_000 - 60_000);
    expect(s.pub.mode()).toBe('approve');
    s.clock.advance(60_000);
    expect(s.pub.mode()).toBe('auto');
    await s.pub.queue(ev, []);
    expect(s.posted.length).toBe(2);
  });

  it('no X keys → drafts only; leaks of a source name block the post; daily cap holds', async () => {
    const off = setup({ x: false });
    await off.pub.queue(ev, []);
    expect(off.photos[0].caption).toContain('X not connected');
    expect(off.photos[0].buttons).toBeUndefined();
    const s = setup({ mode: 'auto', dailyMax: 1 });
    await s.pub.queue({ ...ev, note: 'thanks ServerA for the call' }, ['ServerA']);
    expect(s.posted[0].text).not.toMatch(/ServerA/);       // the explanation with the leak is dropped entirely
    await s.pub.queue(ev, []);
    expect(s.posted.length).toBe(1);
    expect(s.sent.some(t => t.includes('daily limit'))).toBe(true);
  });
});

describe('PASSED posts: only after the window closed, honest result', () => {
  it('picks one dodged (−40% or worse) and one missed (+50% or better) from two days ago', async () => {
    const { passedPosts } = await import('../src/jobs.js');
    const store = new Store(':memory:');
    const clock = new VirtualClock(Date.parse('2026-10-25T00:05:00Z'));
    const ins = (token: string, p0: number, p1: number, reasons: string[]) => {
      const id = Number(store.db.prepare("INSERT INTO decisions(message_id, ts_utc, server, channel, author, kind, chain, token, action, size_usd, trust_score, tier, price_at_decision, reasons, intent, mode) VALUES ('m','2026-10-23T12:00:00Z','ServerA','degen','a','token_call','solana',?, 'journal_only', 0, 0, 'journal', ?, ?, '{}', 'paper')").run(token, p0, JSON.stringify(reasons)).lastInsertRowid);
      store.db.prepare("INSERT INTO markouts VALUES (?, '24h', ?, '2026-10-24T12:00:00Z')").run(id, p1);
    };
    ins('AAA', 1, 0.3, ['analyst (haiku-5-5, conf 0.9): Fresh domain and a copied ticker. Bundled launch.']);
    ins('BBB', 1, 2.2, ['analyst (haiku-5-5, conf 0.8): Thin liquidity, no socials.']);
    ins('CCC', 1, 0.9, ['analyst (haiku-5-5, conf 0.8): meh']);
    ins('DDD', 1, 0.1, ['scan prefilter (no model): liquidity $900 < $5000']);   // without an analyst review — we do not post
    const market = { async market(a: string) { return { chain: 'solana' as const, symbol: a === 'AAA' ? 'COPY' : 'GEM' }; }, async rug() { return undefined; } };
    const out = await passedPosts(store, market as any, clock);
    expect(out.map(o => o.asset)).toEqual(['$COPY', '$GEM']);
    expect(out[0].note).toBe('Fresh domain and a copied ticker. 24h later: −70%.');
    expect(out[1].note).toMatch(/\+120%\. Missed this one\./);
  });
});

// T-05. The owner 2026-11-11 08:02 UTC: "if there is no confirmation from me in Telegram to send a post, let it send it
// by itself anyway an hour after it appears". The owner 2026-11-10 13:59 UTC: a thought at low confidence — with a mark.
describe('X posts: no answer in Telegram for an hour → the post goes out by itself (T-05)', () => {
  const MIN = 60_000;
  it('waits the full hour, then posts once and says so in Telegram; the caption warns about the timer', async () => {
    const s = setup({ autoApproveMinutes: 60 });
    await s.pub.queue(ev, []);
    expect(s.photos[0].caption).toContain('goes out on its own in 60 min');
    s.clock.advance(59 * MIN);
    expect(await s.pub.publishOverdue()).toBe(0);
    expect(s.posted.length).toBe(0);
    s.clock.advance(MIN);
    expect(await s.pub.publishOverdue()).toBe(1);                    // the deadline passed, the Telegram batch after it was processed, there was no "No"
    expect(s.posted.length).toBe(1);
    expect(s.edits.at(-1)).toContain('no reply for 60 min');
    expect(await s.pub.publishOverdue()).toBe(0);                    // the second pass sends nothing
    expect(await s.pub.onCallback('post:1:ok')).toMatch(/Already handled/); // and the button after the deadline — too
    expect(s.posted.length).toBe(1);
  });
  it('"No" before the hour cancels the post for good; "ok" before the hour posts it once', async () => {
    const s = setup({ autoApproveMinutes: 60 });
    await s.pub.queue(ev, []); await s.pub.queue(ev, []);
    expect(await s.pub.onCallback('post:1:no')).toBe('Not publishing');
    expect(await s.pub.onCallback('post:2:ok')).toBe('Published');
    s.clock.advance(61 * MIN);
    expect(await s.pub.publishOverdue()).toBe(0);
    expect(s.posted.length).toBe(1);
    expect(s.store.getPost(1)?.status).toBe('rejected');
  });
  it('a post that waited far longer than the timer (server was down) is dropped, not posted late', async () => {
    const s = setup({ autoApproveMinutes: 60 });
    await s.pub.queue(ev, []);
    s.clock.advance(181 * MIN);
    expect(await s.pub.publishOverdue()).toBe(0);
    expect(s.posted.length).toBe(0);
    expect(s.store.getPost(1)?.status).toBe('expired');
    expect(s.edits.at(-1)).toContain('Not published');
  });
  it('timer off (0 / not set), X not connected, daily cap and a failed post — nothing goes out by itself', async () => {
    const off = setup();
    await off.pub.queue(ev, []);
    expect(off.photos[0].caption).not.toContain('goes out on its own');
    off.clock.advance(120 * MIN);
    expect(await off.pub.publishOverdue()).toBe(0);
    expect(off.store.getPost(1)?.status).toBe('awaiting');
    const nox = setup({ x: false, autoApproveMinutes: 60 });
    await nox.pub.queue(ev, []); nox.clock.advance(61 * MIN);
    expect(await nox.pub.publishOverdue()).toBe(0);
    const cap = setup({ autoApproveMinutes: 60, dailyMax: 1 });
    await cap.pub.queue(ev, []); await cap.pub.queue(ev, []);
    cap.clock.advance(61 * MIN);
    expect(await cap.pub.publishOverdue()).toBe(1);                  // the second hit the daily limit
    expect(cap.posted.length).toBe(1);
    expect(cap.store.getPost(2)?.status).toBe('held');
    const bad = setup({ autoApproveMinutes: 60, failPost: true });
    await bad.pub.queue(ev, []); bad.clock.advance(61 * MIN);
    expect(await bad.pub.publishOverdue()).toBe(0);
    expect(bad.store.getPost(1)?.status).toBe('failed');
    expect(bad.sent.at(-1)).toContain('not published');
    expect(await bad.pub.publishOverdue()).toBe(0);                  // does not repeat every minute
  });
  it('a button press and the timer at the same moment post once', async () => {
    const s = setup({ autoApproveMinutes: 60 });
    await s.pub.queue(ev, []);
    s.clock.advance(61 * MIN);
    const [a, b] = await Promise.all([s.pub.onCallback('post:1:ok'), s.pub.publishOverdue()]);
    expect(s.posted.length).toBe(1);
    expect([a, b]).toContain('Published');
  });

  // Remarks of the independent review, round 1 (PR #81)
  it('"No" cannot reach the agent (Telegram polling is failing) → the post does NOT go out by itself', async () => {
    let oks: number[] = [];
    const s = setup({ autoApproveMinutes: 60, pollOk: () => oks });
    await s.pub.queue(ev, []);
    oks = [s.clock.now()];                                           // the last successful poll — before the deadline
    s.clock.advance(90 * MIN);
    expect(await s.pub.publishOverdue()).toBe(0);                    // no polls after the deadline: a "No" could be stuck in the queue
    expect(s.posted.length).toBe(0);
    oks = [...oks, s.clock.now()];                                   // the batch received after the deadline was processed in full
    expect(await s.pub.publishOverdue()).toBe(1);                    // there was no "No" in it — we publish
    const none = setup({ autoApproveMinutes: 60, pollOk: () => [] });
    await none.pub.queue(ev, []); none.clock.advance(61 * MIN);
    expect(await none.pub.publishOverdue()).toBe(0);
  });
  it('pollWatch counts a poll only when its whole batch has been processed (the loop came back for the next one)', async () => {
    let t = 1000;
    const polls: unknown[] = [{ ok: true, result: [] }, { ok: false, error_code: 409, description: 'Conflict' }, { ok: true, result: [{ update_id: 7 }, { update_id: 8 }] },
      { ok: true, result: Array.from({ length: 100 }, (_, i) => ({ update_id: 9 + i })) }, { ok: true, result: [] }];
    const fake = (async (url: string) => { const body = url.endsWith('/getUpdates') ? polls.shift() : { ok: true, result: { message_id: 1 } }; return { ok: true, status: 200, json: async () => body, clone() { return this; } }; }) as unknown as typeof fetch;
    const w = pollWatch(fake, () => t);
    const poll = (offset: number) => w.fetch('https://api.telegram.org/botX/getUpdates', { method: 'POST', body: JSON.stringify({ offset }) });
    await poll(0);                                                    // an empty answer at 1000
    expect(w.okTimes()).toEqual([]);                                  // until the loop comes for the next batch — not counted
    t = 2000; await poll(0);                                          // it came: the previous one is counted; this answer — 409
    expect(w.okTimes()).toEqual([1000]);
    t = 3000; await w.fetch('https://api.telegram.org/botX/sendMessage'); // not a poll
    t = 4000; await poll(0);                                          // 409 not counted; an answer with updates 7 and 8 at 4000
    expect(w.okTimes()).toEqual([1000]);
    t = 5000; await poll(8);                                          // offset 8: the loop did not reach update 8 → the batch is not processed
    expect(w.okTimes()).toEqual([1000]);                              // (this answer — 100 updates at 5000)
    t = 6000; await poll(109);                                        // a full batch of 100 is not counted: the rest is in the next one
    expect(w.okTimes()).toEqual([1000]);
    t = 7000; await w.fetch('https://api.telegram.org/botX/getUpdates', { method: 'POST', body: 'not json' }); // offset not read
    expect(w.okTimes()).toEqual([1000]);
  });
  // Round 2 review: a "No" sits in the same batch behind a slow "Publish" — the poll already answered, but the press is not executed yet
  it('"No" delivered in a batch behind a slow "Publish" still cancels: the timer waits until the batch is processed', async () => {
    const tick = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(res => setImmediate(res)); };
    const store = new Store(':memory:');
    const clock = new VirtualClock(Date.parse('2026-11-11T12:00:00Z'));
    const notifier = { async send() {}, async sendPhoto() { return 1; }, async editCaption() {} };
    const posted: string[] = []; const release: (() => void)[] = [];
    const x = { async post(text: string) { await new Promise<void>(res => release.push(res)); posted.push(text); return { id: `T${posted.length}` }; } };
    const renderer = { async render() { return Buffer.from([137, 80, 78, 71]); }, async warmup() { return 0; } };
    let polls = 0; let stop = false;
    const tgFetch = (async (url: string) => {
      if (String(url).endsWith('/getUpdates')) {
        if (++polls > 1) {                                             // empty after that; every poll yields the queue, after stop — hangs
          await new Promise<void>(res => setImmediate(res));
          if (stop) return new Promise<never>(() => {});
          return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }), clone() { return this; } };
        }
        const body = { ok: true, result: [
          { update_id: 1, callback_query: { id: 'a', data: 'post:2:ok', message: { chat: { id: 42 } } } },   // "Publish" on post 2
          { update_id: 2, callback_query: { id: 'b', data: 'post:1:no', message: { chat: { id: 42 } } } } ] }; // "No" on post 1 (pressed before the deadline)
        return { ok: true, status: 200, json: async () => body, clone() { return this; } };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), clone() { return this; } };
    }) as unknown as typeof fetch;
    const watch = pollWatch(tgFetch, () => clock.now());
    const pub = new Publisher({ store, notifier, clock, dataDir: mkdtempSync(join(tmpdir(), 'agent-pub-')), renderer, x, mode: 'approve', autoAfterDays: 3, dailyMax: 25, paper: true,
      autoApproveMinutes: 60, controlOkTimes: watch.okTimes });
    await pub.queue({ ...ev, asset: '$REJECTED' }, []);                // post 1, deadline 13:00
    clock.advance(30 * MIN);
    await pub.queue({ ...ev, asset: '$APPROVED' }, []);                // post 2
    clock.advance(31 * MIN);                                           // 13:01 — the connection is back, both presses arrived
    const ctl = startTelegramControl('TOKEN', '42', { onCallback: d => pub.onCallback(d) }, { fetchImpl: watch.fetch, now: () => clock.now(), sleep: async () => { await new Promise<void>(res => setImmediate(res)); } });
    await tick();
    expect(store.getPost(2)?.status).toBe('publishing');               // the loop waits for X on the first press
    clock.advance(MIN);
    expect(await pub.publishOverdue()).toBe(0);                        // the batch is not processed yet — the timer does not touch post 1
    expect(store.getPost(1)?.status).toBe('awaiting');
    while (release.length) { release.shift()!(); await tick(); }
    stop = true; ctl.stop(); await tick();
    expect(store.getPost(1)?.status).toBe('rejected');
    expect(posted.some(t => t.includes('$REJECTED'))).toBe(false);
    expect(await pub.publishOverdue()).toBe(0);
  });
  it('X accepted the post but Telegram is down: the post is "posted", counts toward limits, and the project stays quiet for 24h', async () => {
    const store = new Store(':memory:');
    const clock = new VirtualClock(Date.parse('2026-11-11T12:00:00Z'));
    let tgDown = true;
    const notifier = { async send() { if (tgDown) throw new TypeError('fetch failed'); } };
    const posted: string[] = [];
    const x = { async post(text: string) { posted.push(text); return { id: `T${posted.length}` }; } };
    const pub = new Publisher({ store, notifier, clock, dataDir: mkdtempSync(join(tmpdir(), 'agent-pub-')), x, mode: 'auto', autoAfterDays: 3, dailyMax: 25, paper: true, thoughtMinConfidence: 0 });
    const t = { key: 'proj-1', subject: 'Fen Lamp', note: 'Fen Lamp is a Base NFT collection with steady holder growth', verdict: 'watch' as const, holding: false, confidence: 0.8 };
    expect(await pub.thought(t, [])).toBe('queued');
    expect(store.getPost(1)?.status).toBe('posted');
    tgDown = false; clock.advance(10 * MIN);
    expect(await pub.thought({ ...t, note: 'Fen Lamp floor keeps climbing on thin volume' }, [])).toMatch(/already posted/);
    expect(posted.length).toBe(1);
  });
  it('first rollout: a post created before the timer existed (no warning on its card) never goes out by itself', async () => {
    const old = setup({});                                           // before rollout: no timer
    await old.pub.queue(ev, []);
    old.clock.advance(90 * MIN);
    const neu = setup({ autoApproveMinutes: 60, store: old.store, clock: old.clock });
    expect(await neu.pub.publishOverdue()).toBe(0);
    neu.clock.advance(24 * 60 * MIN);
    expect(await neu.pub.publishOverdue()).toBe(0);
    expect(neu.posted.length).toBe(0);
    expect(old.store.getPost(1)?.status).toBe('awaiting');           // via the button — still possible
    expect(await neu.pub.onCallback('post:1:ok')).toBe('Published');
  });
  it('two timer passes overlapping while X is slow do not exceed the daily cap', async () => {
    const s = setup({ autoApproveMinutes: 60, dailyMax: 1, slowX: true });
    await s.pub.queue(ev, []); await s.pub.queue(ev, []);
    s.clock.advance(61 * MIN);
    const pass1 = s.pub.publishOverdue(); await tick();
    const pass2 = s.pub.publishOverdue(); await tick();              // the next minute: the previous pass still waits for X
    const press = s.pub.onCallback('post:2:ok'); await tick();       // and the button at the same time
    while (s.release.length) { s.release.shift()!(); await tick(); }
    await Promise.all([pass1, pass2, press]);
    expect(s.posted.length).toBe(1);
  });
  it('"No" on post 2 while the timer pass is still waiting for X on post 1 — post 2 never goes out', async () => {
    const s = setup({ autoApproveMinutes: 60, slowX: true });
    await s.pub.queue(ev, []); await s.pub.queue(ev, []);
    s.clock.advance(61 * MIN);
    const pass = s.pub.publishOverdue(); await tick();
    expect(await s.pub.onCallback('post:2:no')).toBe('Not publishing');
    for (let i = 0; i < 4; i++) { s.release.shift()?.(); await tick(); }
    await pass;
    expect(s.posted.length).toBe(1);
    expect(s.store.getPost(2)?.status).toBe('rejected');
  });
  it('buttons were not delivered → the message does not promise the timer, and the post stays a draft', async () => {
    const s = setup({ autoApproveMinutes: 60, photoFails: true });
    await s.pub.queue(ev, []);
    expect(s.sent[0]).toContain('the post will not be published');
    expect(s.sent[0]).not.toContain('goes out on its own');
    s.clock.advance(61 * MIN);
    expect(await s.pub.publishOverdue()).toBe(0);
    expect(s.store.getPost(1)?.status).toBe('draft');
  });
  it('a post left in "publishing" by a restart is reported to the owner and never re-sent', async () => {
    const s = setup({ autoApproveMinutes: 60, slowX: true });
    await s.pub.queue(ev, []);
    s.clock.advance(61 * MIN);
    void s.pub.publishOverdue(); await tick();                       // the request to X went out — and the process died
    expect(s.store.getPost(1)?.status).toBe('publishing');
    const r = setup({ autoApproveMinutes: 60, store: s.store, clock: s.clock }); // restart on the same database
    expect(await r.pub.recoverInterrupted()).toBe(1);
    expect(r.store.getPost(1)?.status).toBe('failed');
    expect(r.sent.at(-1)).toMatch(/Post #1.*check on X/);
    r.clock.advance(5 * MIN);
    expect(await r.pub.publishOverdue()).toBe(0);
    expect(await r.pub.onCallback('post:1:ok')).toMatch(/Already handled/);
    expect(r.posted.length).toBe(0);
    expect(await r.pub.recoverInterrupted()).toBe(0);
  });
});

describe('thought with low analyst confidence carries a note (T-05)', () => {
  const t = { key: 'p1', subject: 'Fen Lamp', note: 'Fen Lamp is a Base NFT collection with steady holder growth', verdict: 'watch' as const, holding: false };
  it('below 0.6 — "Low confidence on this one." before the position line; 0.6 and above — no note', async () => {
    const s = setup({ mode: 'auto' });
    expect(await s.pub.thought({ ...t, confidence: 0.5 }, [])).toBe('queued');
    expect(s.posted[0].text).toBe('Fen Lamp is a Base NFT collection with steady holder growth. Low confidence on this one. No position.');
    expect(await s.pub.thought({ ...t, key: 'p2', confidence: 0.6 }, [])).toBe('queued');
    expect(s.posted[1].text).toBe('Fen Lamp is a Base NFT collection with steady holder growth. No position.');
  });
  it('a long note still fits 280 characters with the note and the position line intact', async () => {
    const s = setup({ mode: 'auto' });
    await s.pub.thought({ ...t, note: 'x'.repeat(400), confidence: 0.2, holding: true }, []);
    expect(s.posted[0].text.length).toBeLessThanOrEqual(280);
    expect(s.posted[0].text.endsWith('Low confidence on this one. I hold this.')).toBe(true);
  });
});

// #86 (Analyst, A-08): a thought whose note the model completed with a repeated request goes out only via the button.
describe('thought with origin note_retry is published only by the button (#86)', () => {
  const MIN = 60_000;
  const t = { key: 'p9', subject: 'Fen Lamp', note: 'Fen Lamp is a Base NFT collection with steady holder growth', verdict: 'watch' as const, holding: false, confidence: 0.8, origin: 'note_retry' as const };
  it('approve mode: no timer line, never goes out by itself, the button still works', async () => {
    const s = setup({ autoApproveMinutes: 60 });
    expect(await s.pub.thought(t, [])).toBe('queued');
    expect(s.photos[0].caption).not.toContain('goes out on its own');
    expect(s.photos[0].caption).toContain('only via the button');
    s.clock.advance(120 * MIN);
    expect(await s.pub.publishOverdue()).toBe(0);
    expect(s.posted.length).toBe(0);
    expect(await s.pub.onCallback('post:1:ok')).toBe('Published');
  });
  it('auto mode: still waits for the button; an ordinary thought goes straight out', async () => {
    const s = setup({ mode: 'auto', autoApproveMinutes: 60 });
    await s.pub.thought(t, []);
    expect(s.posted.length).toBe(0);
    expect(s.store.getPost(1)?.status).toBe('awaiting');
    await s.pub.thought({ ...t, key: 'p10', origin: 'publicNote' as const }, []);
    expect(s.posted.length).toBe(1);
  });
  it('a thought that failed the leak check does not silence the project for 24h', async () => {
    const s = setup({ mode: 'auto' });
    expect(await s.pub.thought({ ...t, origin: undefined, note: 'Fen Lamp was called in ServerA today' }, ['ServerA'])).toMatch(/not created/);
    expect(await s.pub.thought({ ...t, origin: undefined }, ['ServerA'])).toBe('queued');
    expect(s.posted.length).toBe(1);
  });
});

// T-09 (the owner 2026-11-11 17:30 UTC): a token post carries the contract address; without the address it does not go out. A re-check also yields a post.
describe('token posts carry the contract address (T-09)', () => {
  const CA = '0x1234567890abcdef1234567890ABCDEF12345678';
  const SOL = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
  const t = { key: 'p1', subject: '$KORVA', note: '$KORVA is a way to play GTA VI through its main character. $436k FDV, $75k liquidity. Watching for fresh flow before launch.', verdict: 'watch' as const, holding: false, confidence: 0.7, chain: 'base' };
  it('a token thought without an address is not created, says why, and does not silence the project', async () => {
    const s = setup({ mode: 'auto' });
    expect(await s.pub.thought(t, [])).toBe('not created: token post without a contract address');
    expect(await s.pub.thought({ ...t, ca: 'not-an-address' }, [])).toMatch(/without a contract address/);
    expect(s.posted.length).toBe(0);
    expect(s.store.postsOfKind('thought', '2000-01-01T00:00:00.000Z')).toBe(0);
    expect(await s.pub.thought({ ...t, ca: CA }, [])).toBe('queued');
  });
  it('with an address: full CA on its own last line with the chain; the position line stays in front of it', async () => {
    const s = setup({ mode: 'auto' });
    await s.pub.thought({ ...t, ca: CA }, []);
    expect(s.posted[0].text).toBe(`${t.note} No position.\nCA: ${CA} (base)`);
    await s.pub.thought({ ...t, key: 'p2', subject: '$BRIXO', note: '$BRIXO keeps its liquidity.', ca: SOL, chain: 'solana' }, []);
    expect(s.posted[1].text).toBe(`$BRIXO keeps its liquidity. No position.\nCA: ${SOL} (solana)`);
  });
  it('a ticker only inside the note also makes it a token post; "$436k" and $ETH do not', async () => {
    const s = setup({ mode: 'auto' });
    expect(await s.pub.thought({ ...t, subject: 'Bars', note: 'Bars lock $BALANCE into numbered NFTs.' }, [])).toMatch(/without a contract address/);
    expect(await s.pub.thought({ ...t, key: 'p3', subject: 'JPEGZ', note: 'JPEGZ: 11,111 free pixel portraits, floor 0.004 $ETH, about $436k traded.' }, [])).toBe('queued');
    expect(s.posted[0].text).not.toContain('CA:');
  });
  it('a long note is cut by whole sentences; the CA and the position line are never cut; an address inside the note stays short', async () => {
    const s = setup({ mode: 'auto' });
    const long = `$KORVA trades at ${CA} today. ${'It has real demand and steady flow. '.repeat(12)}`.trim();
    await s.pub.thought({ ...t, note: long, ca: CA, confidence: 0.3, holding: true }, []);
    const text = s.posted[0].text;
    expect(text.length).toBeLessThanOrEqual(280);
    expect(text.endsWith(`steady flow. Low confidence on this one. I hold this.\nCA: ${CA} (base)`)).toBe(true);
    expect(text).toContain('0x1234…5678 today.');
    expect(text.match(new RegExp(CA, 'g'))?.length).toBe(1);
  });
  it('one endless sentence is cut at a word with "…", the tail is intact', async () => {
    const s = setup({ mode: 'auto' });
    await s.pub.thought({ ...t, note: `$KORVA ${'keeps going up and '.repeat(40)}`.trim(), ca: CA }, []);
    expect(s.posted[0].text.length).toBeLessThanOrEqual(280);
    expect(s.posted[0].text).toMatch(/[a-z]… No position\.\nCA: 0x[0-9a-fA-F]{40} \(base\)$/);
  });
  it('trade posts: the CA is added when the executor passes it and survives the "[paper] " prefix; without it the post is unchanged', async () => {
    const s = setup({ mode: 'auto' });
    await s.pub.queue({ ...ev, ca: CA, note: 'The flow dried up and the stop was hit. '.repeat(8).trim() }, []);
    expect(s.posted[0].text.startsWith('[paper] Closed $SWARMX: −$0.54.')).toBe(true);
    expect(s.posted[0].text.endsWith(`\nCA: ${CA} (robinhood)`)).toBe(true);
    expect(s.posted[0].text.length).toBeLessThanOrEqual(280);
    await s.pub.queue(ev, []);
    expect(s.posted[1].text).toBe('[paper] Closed $SWARMX: −$0.54. No position now.');
    await s.pub.queue({ kind: 'entry', asset: 'BTC long 3x', chain: 'perps', holding: true, ca: CA }, []);
    expect(s.posted[2].text).toBe(`[paper] Entered BTC long 3x on perps. I hold this.\nCA: ${CA}`);
  });
});

describe('a scheduled recheck gives a post too (T-09)', () => {
  const H = 3600_000;
  const t = { key: 'p1', subject: 'JPEGZ', note: 'JPEGZ: free pixel portraits, public phase is on my list.', verdict: 'watch' as const, holding: false, confidence: 0.7 };
  const upd = { ...t, note: 'JPEGZ: 2,534 of 11,111 claimed in the first half hour. Still on my list for the public phase.' };
  it('not sooner than THOUGHT_UPDATE_GAP_MS (example: 4 h) after the last post on the project; a plain repeat is still once a day', async () => {
    const s = setup({ mode: 'auto' });
    expect(await s.pub.thought(t, [])).toBe('queued');
    s.clock.advance(3 * H);
    expect(await s.pub.thought(upd, [], { update: true })).toBe('recheck: less than 4h since the last post on this project');
    s.clock.advance(H);
    expect(await s.pub.thought(upd, [])).toBe('already posted a thought on this project in 24h');
    expect(await s.pub.thought(upd, [], { update: true })).toBe('queued');
    expect(s.posted.map(p => p.text)).toEqual([`${t.note} No position.`, `${upd.note} No position.`]);
  });
  it('watch → act upgrades do not get past the cap of THOUGHT_POSTS_PER_PROJECT_24H (example: 2) posts per project', async () => {
    const s = setup({ mode: 'auto' });
    const v = (verdict: 'watch' | 'act') => ({ ...t, note: `JPEGZ update ${verdict}.`, verdict });
    const res: string[] = [await s.pub.thought(v('watch'), [])];
    for (const [wait, verdict] of [[60_000, 'act'], [4 * H, 'watch'], [60_000, 'act'], [4 * H, 'watch'], [60_000, 'act']] as const) { s.clock.advance(wait); res.push(await s.pub.thought(v(verdict), [], { update: true })); }
    expect(s.posted.length).toBe(THOUGHT_POSTS_PER_PROJECT_24H);
    expect(res.slice(THOUGHT_POSTS_PER_PROJECT_24H)).toEqual(Array(6 - THOUGHT_POSTS_PER_PROJECT_24H).fill(`${THOUGHT_POSTS_PER_PROJECT_24H} posts on this project in 24h already`));
  });
  it('at most THOUGHT_POSTS_PER_PROJECT_24H posts on one project in 24 hours; the window slides', async () => {
    const s = setup({ mode: 'auto' });
    await s.pub.thought(t, []);
    for (let i = 0; i < 3; i++) { s.clock.advance(5 * H); await s.pub.thought(upd, [], { update: true }); }
    expect(s.posted.length).toBe(THOUGHT_POSTS_PER_PROJECT_24H);
    expect(await s.pub.thought(upd, [], { update: true })).toBe(`${THOUGHT_POSTS_PER_PROJECT_24H} posts on this project in 24h already`);
    s.clock.advance(10 * H); // the first post left the 24 h window
    expect(await s.pub.thought(upd, [], { update: true })).toBe('queued');
  });
  it('a recheck on a project with no post yet posts at once; the daily cap of thoughts still holds', async () => {
    const s = setup({ mode: 'auto' });
    expect(await s.pub.thought(upd, [], { update: true })).toBe('queued');
    for (let i = 0; i < 7; i++) await s.pub.thought({ ...t, key: `q${i}` }, []);
    expect(await s.pub.thought({ ...t, key: 'q9' }, [], { update: true })).toBe('thoughts cap 8/24h');
  });
  it('a record written before T-09 (no list of times) still counts as one post', async () => {
    const s = setup({ mode: 'auto' });
    s.store.kvSet('thought:p1', JSON.stringify({ iso: s.clock.iso(), verdict: 'watch' }));
    expect(await s.pub.thought(upd, [], { update: true })).toMatch(/less than 4h/);
    s.clock.advance(4 * H);
    expect(await s.pub.thought(upd, [], { update: true })).toBe('queued');
  });
});

// T-09, remarks of the independent review
describe('token posts: review findings (T-09)', () => {
  const CA = '0x1234567890abcdef1234567890ABCDEF12345678';
  const SOL = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
  const xLenOf = (t: string) => [...t].reduce((n, ch) => { const c = ch.codePointAt(0)!; return n + ((c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247)) ? 1 : 2); }, 0);
  it('tickers in other scripts, with "_", very long or one letter are still token posts; amounts are not', () => {
    for (const tk of ['$币安人生', '$PEPE_AI', '$ABCDEFGHIJKLMNOP', '$X', '$pepe'])
      expect(draftPost({ kind: 'thought', asset: tk, chain: 'bsc', holding: false, note: `Watching ${tk} now.` }, []).problems).toEqual(['token post without a contract address']);
    for (const note of ['About $436k traded, floor 0.004 $ETH.', 'Costs $5 to mint.', 'Paid in $USDC.'])
      expect(draftPost({ kind: 'thought', asset: 'JPEGZ', chain: 'ethereum', holding: false, note }, []).problems).toEqual([]);
  });
  it('a project with a ticker in its card needs the address even when the note has no "$"', async () => {
    const s = setup({ mode: 'auto' });
    const t = { key: 'p1', subject: 'KORVA', note: 'KORVA is a way to play GTA VI.', verdict: 'watch' as const, holding: false, confidence: 0.7, chain: 'base' };
    expect(await s.pub.thought({ ...t, token: true }, [])).toMatch(/without a contract address/);
    expect(await s.pub.thought({ ...t, token: true, ca: CA }, [])).toBe('queued');
    expect(s.posted[0].text).toBe(`KORVA is a way to play GTA VI. No position.\nCA: ${CA} (base)`);
  });
  it('the address must fit the chain: 0x… on solana or base58 on an EVM chain is not published', async () => {
    const s = setup({ mode: 'auto' });
    const t = { key: 'p1', subject: '$KORVA', note: '$KORVA keeps its liquidity.', verdict: 'watch' as const, holding: false, confidence: 0.7 };
    expect(await s.pub.thought({ ...t, chain: 'solana', ca: CA }, [])).toMatch(/without a contract address/);
    expect(await s.pub.thought({ ...t, chain: 'base', ca: SOL }, [])).toMatch(/without a contract address/);
    expect(await s.pub.thought({ ...t, chain: 'polygon', ca: SOL }, [])).toMatch(/without a contract address/);
    expect(await s.pub.thought({ ...t, ca: SOL }, [])).toBe('queued'); // the chain is unknown — it is not in the post
    expect(s.posted[0].text).toBe(`$KORVA keeps its liquidity. No position.\nCA: ${SOL}`);
  });
  it('trade post with a CA: a long note is cut, "I hold this." and the CA are not', () => {
    const r = draftPost({ kind: 'exit', asset: '$SWARMX', chain: 'robinhood', pnlUsd: -0.54, holding: true, ca: CA, note: 'The flow dried up and the stop was hit. '.repeat(8).trim() }, []);
    expect(r.text.endsWith(`stop was hit. I hold this.\nCA: ${CA} (robinhood)`)).toBe(true);
    expect(xLenOf(`[paper] ${r.text}`)).toBeLessThanOrEqual(280);
  });
  it('a link right before the CA line: stripping links keeps the line break and the whole address', async () => {
    const s = setup({ mode: 'auto' });
    await s.pub.queue({ ...ev, ca: CA, note: 'The full chart is up on dexscreener.com/rh/abc.' }, []);
    expect(s.posted[0].text).toBe(`[paper] Closed $SWARMX: −$0.54. The full chart is up on No position now.\nCA: ${CA} (robinhood)`);
    await s.pub.queue({ ...ev, ca: CA, plan: 'see https://dexscreener.com/rh/abc' }, []);
    expect(s.posted[1].text.endsWith(`No position now.\nCA: ${CA} (robinhood)`)).toBe(true);
  });
  it('a channel named like a chain ("solana", "base") does not block posts through the CA line; a real leak in the text still does', () => {
    const e = { kind: 'thought' as const, asset: '$BRIXO', chain: 'solana', holding: false, ca: SOL, note: '$BRIXO keeps its liquidity.' };
    expect(draftPost(e, ['solana', 'base']).problems).toEqual([]);
    expect(draftPost({ ...e, note: '$BRIXO was shilled in solana today.' }, ['solana']).problems).toEqual(['names "solana"']);
  });
  it('length is counted the way X counts it: "…" and "−" weigh two', () => {
    const r = draftPost({ kind: 'thought', asset: '$KORVA', chain: 'base', holding: false, ca: CA, note: `$KORVA at ${CA} ${'keeps going up and '.repeat(40)}`.trim() }, []);
    expect(r.text).toContain('… No position.');
    expect(xLenOf(r.text)).toBeLessThanOrEqual(280);
    const x = draftPost({ kind: 'exit', asset: '$SWARMX', chain: 'robinhood', pnlUsd: -0.54, holding: false, ca: CA, note: 'Lost −40% in an hour… '.repeat(20).trim() }, []);
    expect(xLenOf(`[paper] ${x.text}`)).toBeLessThanOrEqual(280);
    expect(x.text.endsWith(`No position now.\nCA: ${CA} (robinhood)`)).toBe(true);
  });
});

// T-10 (the owner 2026-11-12): X rejected posts — two cashtags in one post and a full contract address in the first 7 days after connecting
describe('X posting rules (T-10)', () => {
  const SOL = '77HqxiSynthBabcdefghijkmnopqrstuvwxyz1xipump';
  const EVM = '0x1234567890abcdef1234567890ABCDEF12345678';
  const BAN = 'X post http 403: {"detail":"Crypto addresses are prohibited for the first 7 days after authentication.","status":403}';
  const banFull = (text: string) => (/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text) ? BAN : undefined);
  const t = { key: 'p1', subject: '$zipnu', note: '$zipnu went up about 33x in 9 hours on talk that it pairs with $tobiq, and it has already slipped from that peak.', verdict: 'watch' as const, holding: false, confidence: 0.7, chain: 'solana', ca: SOL };

  it('only one cashtag stays: the ticker of the subject; the others lose "$"; amounts are untouched', async () => {
    const s = setup({ mode: 'auto' });
    await s.pub.thought(t, []);
    expect(s.posted[0].text).toBe(`$zipnu went up about 33x in 9 hours on talk that it pairs with TOBIQ, and it has already slipped from that peak. No position.\nCA: ${SOL} (solana)`);
    expect(draftPost({ kind: 'thought', asset: '$KORVA', chain: 'solana', holding: false, ca: SOL, note: 'Next to $GTA and $VI, $KORVA fell from $440k to $360k FDV. $KORVA again.' }, []).text)
      .toBe(`Next to GTA and VI, $KORVA fell from $440k to $360k FDV. KORVA again. No position.\nCA: ${SOL} (solana)`);
    expect(draftPost({ kind: 'thought', asset: 'Bars', chain: 'ethereum', holding: false, ca: EVM, note: 'Bars lock $BALANCE, priced in $ETH.' }, []).text)
      .toBe(`Bars lock $BALANCE, priced in ETH. No position.\nCA: ${EVM} (ethereum)`);
    expect(draftPost({ kind: 'exit', asset: '$SWARMX', chain: 'robinhood', pnlUsd: -0.54, holding: false, note: 'Rotated into $PONS.' }, []).text).toBe('Closed $SWARMX: −$0.54. Rotated into PONS. No position now.');
  });

  it('review: a source named like a cashtag is still caught by the leak check; only the real last CA line is shortened; non-ASCII is not upper-cased', () => {
    const e = { kind: 'thought' as const, asset: '$ZIPNU', chain: 'solana', holding: false, ca: SOL };
    expect(draftPost({ ...e, note: '$ZIPNU got a shout in $WAGMI today.' }, ['$WAGMI']).problems).toEqual(['names "$WAGMI"']);
    expect(draftPost({ kind: 'entry', asset: '$ZIPNU', chain: 'solana', holding: true, ca: SOL, plan: 'as called in $WAGMI' }, ['$WAGMI']).problems.length).toBe(1);
    const odd = draftPost({ ...e, note: `$ZIPNU moved.\nCA: ${'x'.repeat(30)} was posted elsewhere.` }, []).text;
    expect(shortCaLine(odd).endsWith('\nCA: 77Hqxi…xipump (solana)')).toBe(true);
    expect(shortCaLine(odd)).toContain('x'.repeat(30));
    expect(shortCaLine('No CA line here.')).toBe('No CA line here.');
    expect(draftPost({ ...e, note: '$ZIPNU next to $straße.' }, []).text.startsWith('$ZIPNU next to STRAßE. No position.')).toBe(true);
  });

  it('X refuses the full address → the same post goes out once with a shortened address, and Telegram says so', async () => {
    const s = setup({ mode: 'auto', xRule: banFull });
    expect(await s.pub.thought(t, [])).toBe('queued');
    expect(s.attempts.length).toBe(1); // one rejected attempt with the full address
    expect(s.posted.map(p => p.text)).toEqual([`$zipnu went up about 33x in 9 hours on talk that it pairs with TOBIQ, and it has already slipped from that peak. No position.\nCA: 77Hqxi…xipump (solana)`]);
    expect(s.store.postsOfKind('thought', '2000-01-01T00:00:00.000Z')).toBe(1);
    expect([...s.edits, ...s.sent].join('\n')).toContain('Address shortened');
  });

  it('while X refuses addresses, later posts go short at once; after 24 h the full address is tried again', async () => {
    const s = setup({ mode: 'auto', xRule: banFull });
    await s.pub.thought(t, []);
    await s.pub.thought({ ...t, key: 'p2', subject: '$KORVA', note: '$KORVA rides the GTA VI meme.', ca: EVM, chain: 'base' }, []);
    expect(s.attempts.length).toBe(1);
    expect(s.posted[1].text).toBe('$KORVA rides the GTA VI meme. No position.\nCA: 0x1234…345678 (base)');
    s.clock.advance(25 * 3600_000);
    await s.pub.thought({ ...t, key: 'p3', subject: '$BRIXO', note: '$BRIXO keeps its liquidity.' }, []);
    expect(s.attempts.length).toBe(2); // once a day — one probe of the full address
    expect(s.posted[2].text).toContain('CA: 77Hqxi…xipump (solana)');
  });

  it('when X accepts addresses again the full address is back; a post without a CA line is never touched', async () => {
    let ban = true;
    const s = setup({ mode: 'auto', xRule: text => (ban ? banFull(text) : undefined) });
    await s.pub.thought(t, []);
    ban = false; s.clock.advance(25 * 3600_000);
    await s.pub.thought({ ...t, key: 'p2' }, []);
    expect(s.posted[1].text.endsWith(`\nCA: ${SOL} (solana)`)).toBe(true);
    await s.pub.thought({ key: 'p3', subject: 'JPEGZ', note: 'JPEGZ: free pixel portraits.', verdict: 'watch', holding: false, confidence: 0.7 }, []);
    expect(s.posted[2].text).toBe('JPEGZ: free pixel portraits. No position.');
  });

  it('another X error is not retried and not treated as the address rule; a refusal of the short form fails the post once', async () => {
    const s = setup({ mode: 'auto', xRule: () => 'X post http 403: {"detail":"You are not permitted to perform this action."}' });
    await s.pub.thought(t, []);
    expect(s.attempts.length).toBe(1);
    expect(s.posted.length).toBe(0);
    expect(s.store.kvGet('x_ca_ban_until')).toBeFalsy();
    const s2 = setup({ mode: 'auto', xRule: () => BAN });
    await s2.pub.thought(t, []);
    expect(s2.attempts.length).toBe(2); // full and shortened — and that's it
    expect(s2.posted.length).toBe(0);
    expect(s2.sent.join('\n')).toContain('not published');
  });
});

// T-11. Journal 2026-11-12: a thought about a project was queued with watch, 37 min later the project was re-analysed — avoid,
// but the thought still went to X on its own an hour later. Now before publishing from the queue we check the latest verdict.
describe('queued thought vs a newer project verdict (T-11)', () => {
  const MIN = 60_000;
  const t = { key: 'p7', subject: 'Tin Moths', note: 'Tin Moths has an application page open, on my list to check again', verdict: 'watch' as const, holding: false, confidence: 0.8 };
  type V = { verdict: string; atIso: string } | undefined;
  /** A queued thought with a 60 min timer; the project verdict changes after queuing. */
  async function queued(look: (clock: VirtualClock, queuedAt: number) => (key: string) => V) {
    let lookup: (key: string) => V = () => undefined;
    const s = setup({ autoApproveMinutes: 60, projectVerdict: key => lookup(key) });
    const queuedAt = s.clock.now();
    expect(await s.pub.thought(t, [])).toBe('queued');
    lookup = look(s.clock, queuedAt);
    return s;
  }
  const after = (verdict: string, min = 37) => (_c: VirtualClock, q: number) => (key: string): V =>
    key === 'p7' ? { verdict, atIso: new Date(q + min * MIN).toISOString() } : undefined;

  for (const verdict of ['avoid', 'ignore']) {
    it(`newer ${verdict} → no auto-publish, post cancelled, Telegram told, nothing sent to X`, async () => {
      const s = await queued(after(verdict));
      s.clock.advance(60 * MIN);
      expect(await s.pub.publishOverdue()).toBe(0);
      expect(s.posted.length).toBe(0);
      expect(s.store.getPost(1)?.status).toBe('rejected');
      expect(s.edits.at(-1)).toContain(`🐦 Post #1 cancelled: after it the project verdict became ${verdict.toUpperCase()}`);
      s.clock.advance(MIN);
      expect(await s.pub.publishOverdue()).toBe(0);
      expect(await s.pub.onCallback('post:1:ok')).toMatch(/Already handled/);
      expect(s.posted.length).toBe(0);
    });
  }

  it('the publish button after a newer avoid does not publish either', async () => {
    const s = await queued(after('avoid', 5));
    s.clock.advance(10 * MIN);
    expect(await s.pub.onCallback('post:1:ok')).toMatch(/Cancelled/);
    expect(s.posted.length).toBe(0);
    expect(s.store.getPost(1)?.status).toBe('rejected');
    expect(s.edits.at(-1)).toContain('became AVOID');
  });

  it('a newer watch or act does not cancel', async () => {
    for (const verdict of ['watch', 'act']) {
      const s = await queued(after(verdict));
      s.clock.advance(60 * MIN);
      expect(await s.pub.publishOverdue()).toBe(1);
      expect(s.posted.length).toBe(1);
    }
  });

  it('an avoid older than the thought does not cancel', async () => {
    const s = await queued((_c, q) => () => ({ verdict: 'avoid', atIso: new Date(q - MIN).toISOString() }));
    s.clock.advance(60 * MIN);
    expect(await s.pub.publishOverdue()).toBe(1);
    expect(s.posted.length).toBe(1);
  });

  it('lookup throws or finds nothing → published as before (fail open)', async () => {
    const a = await queued(() => () => { throw new Error('no intel yet'); });
    a.clock.advance(60 * MIN);
    expect(await a.pub.publishOverdue()).toBe(1);
    const b = await queued(() => () => undefined);
    expect(await b.pub.onCallback('post:1:ok')).toBe('Published');
    expect(a.posted.length + b.posted.length).toBe(2);
  });

  it('a trade post in the queue is untouched by an avoid verdict', async () => {
    const s = setup({ autoApproveMinutes: 60, projectVerdict: () => ({ verdict: 'avoid', atIso: '2030-01-01T00:00:00Z' }) });
    await s.pub.queue(ev, []);
    s.clock.advance(60 * MIN);
    expect(await s.pub.publishOverdue()).toBe(1);
    expect(s.posted.length).toBe(1);
  });

  it('a thought queued before this change (no stored key) is published as before', async () => {
    const s = await queued(after('avoid'));
    s.store.db.prepare('UPDATE post_drafts SET thought_keys=NULL WHERE id=1').run();
    s.clock.advance(60 * MIN);
    expect(await s.pub.publishOverdue()).toBe(1);
    expect(s.posted.length).toBe(1);
  });

  it('after a restart (new Publisher on the same database) the queued thought is still checked', async () => {
    const s = await queued(() => () => undefined);
    const r = setup({ autoApproveMinutes: 60, store: s.store, clock: s.clock,
      projectVerdict: () => ({ verdict: 'avoid', atIso: new Date(s.clock.now() + 30 * MIN).toISOString() }) });
    s.clock.advance(60 * MIN);
    expect(await r.pub.publishOverdue()).toBe(0);
    expect(r.posted.length).toBe(0);
    expect(s.store.getPost(1)?.status).toBe('rejected');
  });

  it('an old database without the new column opens and keeps working', async () => {
    const store = new Store(':memory:');
    store.db.exec('DROP TABLE post_drafts');
    store.db.exec("CREATE TABLE post_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_utc TEXT, kind TEXT, text TEXT, status TEXT)");
    const s = setup({ autoApproveMinutes: 60, store, projectVerdict: () => undefined });
    expect(await s.pub.thought(t, [])).toBe('queued');
    expect(s.store.getPost(1)?.thought_keys).toBe('["p7"]');
  });
});
