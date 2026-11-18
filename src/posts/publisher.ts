// X post queue. The owner's decisions (2026-10-23): for the first 3 days every post goes via a Telegram button
// ("Publish" / "No"), then the agent publishes on its own. A post — only after an action, without sources
// (leak check), without links (expensive), with a card. Without X keys — drafts in Telegram only.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/db.js';
import type { Notifier } from '../notify/telegram.js';
import { esc } from '../notify/telegram.js';
import type { Clock } from '../clock.js';
import { draftPost, needsCa, validCa, shortCaLine, TRADE_KINDS, LOW_CONFIDENCE_BELOW, type PostEvent } from './drafts.js';
import type { Thought } from '../pipeline.js';
import { cardFor, type CardRenderer } from './cards.js';
import { stripLinks, type XPoster } from './x.js';

export type XMode = 'off' | 'approve' | 'auto';
/** Card data beyond the post text. */
export interface CardExtras { entryPrice?: number; exitPrice?: number; holdMinutes?: number; pnlPct?: number; reason?: string; points?: number[]; sizeOutUsd?: number }
export interface PostQueue { queue(e: PostEvent & CardExtras, sourceNames: string[]): Promise<unknown> }

export interface PublisherDeps {
  store: Store; notifier: Notifier; clock: Clock; dataDir: string;
  renderer?: CardRenderer; x?: XPoster;
  /** approve — via a button, auto — at once (autoAfterDays days after the first post approve becomes auto). */
  mode: 'approve' | 'auto'; autoAfterDays: number; dailyMax: number; paper: boolean;
  /** Thoughts (watching/on my list): no more than N a day, the analyst confidence threshold. */
  thoughtsDailyMax?: number; thoughtMinConfidence?: number;
  /**
   * Auto-publish without a reply (the owner 2026-11-11 08:02 UTC): a post waiting for the button longer than N minutes goes out on its own.
   * 0 or unset — off. A post that waited longer than autoApproveMaxAgeMinutes (server downtime) does not go out on its own.
   */
  autoApproveMinutes?: number; autoApproveMaxAgeMinutes?: number;
  /**
   * Times of the last successful Telegram polls (pollWatch). The timer treats silence as consent, so it must know
   * that the channel "No" arrives through worked after the deadline. Unset — a post does not go out on its own.
   */
  controlOkTimes?: () => number[];
  /**
   * T-11. The thought's project keys (domain:…, x:…) at enqueue time: the card number p<id> changes when cards merge, the keys do not.
   * Verdicts of all cards these keys currently belong to. No answer or an error — the thought is published as before.
   */
  projectKeys?: (key: string) => string[] | undefined;
  projectVerdict?: (keys: string[]) => { verdict: string; atIso: string }[] | undefined;
}

/** After a successful poll, give the control loop time to process the arrived presses. */
/**
 * A fetch wrapper for the Telegram control loop: remembers the times of getUpdates polls whose batch was FULLY PROCESSED.
 * A getUpdates response delivers accumulated presses, but a "No" from the batch runs later — after all presses before it
 * (publishing on "Publish" waits tens of seconds for X). So a poll counts only when the loop has come for
 * the next batch and its offset shows it reached the last update of the previous one. A batch of 100 updates
 * (the Telegram limit) does not count: the rest is in the next one.
 */
export function pollWatch(fetchImpl: typeof fetch, now: () => number): { fetch: typeof fetch; okTimes: () => number[] } {
  const done: number[] = [];
  let last: { at: number; maxId: number; full: boolean } | undefined;
  const watched = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const isPoll = String(input).endsWith('/getUpdates');
    if (isPoll && last) {
      let offset = NaN;
      try { offset = Number((JSON.parse(String(init?.body ?? '{}')) as { offset?: unknown }).offset); } catch { /* offset not read — the poll does not count */ }
      if (!last.full && offset > last.maxId) { done.push(last.at); if (done.length > 8) done.shift(); }
      last = undefined;
    }
    const r = await fetchImpl(input, init);
    if (isPoll) {
      try {
        const j = await (typeof r.clone === 'function' ? r.clone() : r).json() as { ok?: boolean; result?: unknown };
        if (j?.ok === true && Array.isArray(j.result)) {
          const ids = (j.result as { update_id?: unknown }[]).map(u => Number(u?.update_id)).filter(Number.isFinite);
          last = { at: now(), maxId: ids.length ? Math.max(...ids) : -Infinity, full: j.result.length >= 100 };
        }
      } catch { /* not JSON — the poll failed, the time is not recorded */ }
    }
    return r;
  }) as typeof fetch;
  return { fetch: watched, okTimes: () => [...done] };
}

/**
 * T-11: projectKeys / projectVerdict on top of project cards (without importing from src/intel): p<id> → keys at enqueue time;
 * keys → the last real verdict (avoid/ignore/watch/act, not seen) of each card they currently belong to.
 */
export function cardVerdictLookup(cards: { card(id: number): { keys: string[] } | undefined }, store: Pick<Store, 'projectIdsForKeys' | 'projectRealVerdict'>): Pick<PublisherDeps, 'projectKeys' | 'projectVerdict'> {
  return {
    projectKeys: key => { const id = /^p(\d+)$/.exec(key)?.[1]; return id ? cards.card(Number(id))?.keys : undefined; },
    projectVerdict: keys => store.projectIdsForKeys(keys).flatMap(id => { const v = store.projectRealVerdict(id); return v ? [v] : []; }),
  };
}

/** Between re-check posts about one project — at least THOUGHT_UPDATE_GAP_MS; in total about a project — no more than THOUGHT_POSTS_PER_PROJECT_24H posts per day (example values). */
export const THOUGHT_UPDATE_GAP_MS = 4 * 3600_000; // example value — set your own
export const THOUGHT_POSTS_PER_PROJECT_24H = 2; // example value — set your own

/** X's answer "contract addresses are prohibited for the first 7 days after connecting": for a day the address is published shortened, then the full one is tried again. */
const X_CA_BAN = /crypto addresses are prohibited/i;
const X_CA_BAN_KEY = 'x_ca_ban_until';
const X_CA_BAN_RECHECK_MS = 24 * 3600_000;

export class Publisher implements PostQueue {
  constructor(private d: PublisherDeps) { mkdirSync(join(d.dataDir, 'cards'), { recursive: true }); }

  /** The current mode: without X keys — off; approve becomes auto N days after the first published post. */
  mode(): XMode {
    if (!this.d.x) return 'off';
    if (this.d.mode === 'auto') return 'auto';
    const first = this.d.store.kvGet('x_first_post_utc');
    if (this.d.autoAfterDays > 0 && first && this.d.clock.now() - Date.parse(first) >= this.d.autoAfterDays * 86400_000) return 'auto';
    return 'approve';
  }

  /** Returns the created post number; undefined — the post was not created (leak check). */
  async queue(e: PostEvent & CardExtras, sourceNames: string[]): Promise<number | undefined> {
    const { text: raw, problems } = draftPost(e, sourceNames);
    if (problems.length) { await this.d.notifier.send(`🐦 Post not created: ${problems.join('; ')}`); return undefined; }
    const text = stripLinks(`${this.d.paper && TRADE_KINDS.has(e.kind) ? '[paper] ' : ''}${raw}`).slice(0, 280);
    const id = this.d.store.addPost(this.d.clock.iso(), e.kind, text);
    let png: Buffer | undefined;
    if (this.d.renderer) {
      try {
        const c = cardFor({ ...e, paper: this.d.paper, nowIso: this.d.clock.iso() });
        png = await this.d.renderer.render(c.template, c.data);
        const path = join(this.d.dataDir, 'cards', `${id}.png`);
        writeFileSync(path, png);
        this.d.store.updatePost(id, { image: path });
      } catch (err) { console.error('card render', err); }
    }
    // manualOnly: only via the button — in auto mode too, and without a timer
    const mode = e.manualOnly && this.mode() === 'auto' ? 'approve' : this.mode();
    if (mode === 'auto') { await this.publish(id); return id; }
    const wait = mode === 'approve' && !e.manualOnly ? (this.d.autoApproveMinutes ?? 0) : 0;
    const head = mode === 'off' ? `🐦 Post draft (X not connected):\n${esc(text)}` : `🐦 Post to X — publish?\n${esc(text)}`;
    const tail = wait > 0 ? `\n⏳ Without a reply it goes out on its own in ${wait} min. "No" — cancel.` : e.manualOnly && mode === 'approve' ? '\n✋ New note format — goes out only via the button.' : '';
    const buttons = mode === 'approve' ? [[{ text: '✅ Publish', data: `post:${id}:ok` }, { text: '✖️ No', data: `post:${id}:no` }]] : undefined;
    const msgId = png && this.d.notifier.sendPhoto ? await this.d.notifier.sendPhoto(png, head + tail, buttons) : undefined;
    // No buttons — no timer is promised: such a post stays a draft and does not go out on its own
    if (msgId === undefined) await this.d.notifier.send(head + (buttons ? '\n(buttons were not sent — the post will not be published)' : ''));
    const awaiting = mode === 'approve' && msgId !== undefined;
    this.d.store.updatePost(id, { status: awaiting ? 'awaiting' : 'draft', tg_msg: msgId ?? null,
      ...(awaiting && wait > 0 ? { auto_at: new Date(this.d.clock.now() + wait * 60_000).toISOString() } : {}) });
    return id;
  }

  /**
   * At startup: a post left in publishing — the process was stopped in the middle of an X request. Retrying is not allowed (a duplicate is possible),
   * staying silent neither: mark it failed and ask the owner to check X by hand.
   */
  async recoverInterrupted(): Promise<number> {
    const stuck = this.d.store.postsByStatus('publishing');
    for (const p of stuck) {
      this.d.store.updatePost(p.id, { status: 'failed', error: 'process restarted during publish' });
      await this.d.notifier.send(`⚠️ Post #${p.id}: the agent restarted during publishing — check on X whether it went out. Not sending it again.\n${esc(p.text)}`)
        .catch(err => console.error('publisher: interrupted-post notice', err));
    }
    return stuck.length;
  }

  /**
   * A thought from an analyst verdict (the owner 2026-10-24: "even if the agent starts watching something").
   * One project — one thought per day (a repeat only if watching became "on my list"), a daily limit, a confidence threshold.
   * A scheduled re-check (update) is project news: it goes out if at least THOUGHT_UPDATE_GAP_MS has passed since the last post about the project,
   * and no more than THOUGHT_POSTS_PER_PROJECT_24H posts about the project per day (the owner 2026-11-11 17:30 UTC).
   * The source is not named: the text is checked for server/channel/author names, addresses from model text are shortened.
   * A thought about a token without a contract address is not created.
   */
  async thought(t: Thought, sourceNames: string[], opts: { update?: boolean } = {}): Promise<string> {
    if (t.confidence < (this.d.thoughtMinConfidence ?? 0.6)) return `confidence ${t.confidence}`;
    if ((t.token || needsCa(t.subject, t.note)) && !validCa(t.ca, t.chain)) return 'not created: token post without a contract address';
    const now = this.d.clock.now();
    const k = `thought:${t.key}`;
    let times: string[] = [];
    try {
      const prev = JSON.parse(this.d.store.kvGet(k) ?? 'null') as { iso: string; verdict: string; times?: string[] } | null;
      times = (prev?.times ?? (prev ? [prev.iso] : [])).filter(x => now - Date.parse(x) < 86400_000);
      if (prev && times.length) {
        // The cap on posts about a project always applies — both for a re-check and for "watching → on my list"
        if (times.length >= THOUGHT_POSTS_PER_PROJECT_24H) return `${THOUGHT_POSTS_PER_PROJECT_24H} posts on this project in 24h already`;
        const upgraded = prev.verdict === 'watch' && t.verdict === 'act';
        const sinceLast = now - Math.max(...times.map(x => Date.parse(x)));
        const updateOk = !!opts.update && sinceLast >= THOUGHT_UPDATE_GAP_MS;
        if (!upgraded && !updateOk) return opts.update ? `recheck: less than ${THOUGHT_UPDATE_GAP_MS / 3600_000}h since the last post on this project` : 'already posted a thought on this project in 24h';
      }
    } catch { /* an old record — does not interfere */ }
    const max = this.d.thoughtsDailyMax ?? 8;
    if (this.d.store.postsOfKind('thought', new Date(now - 86400_000).toISOString()) >= max) return `thoughts cap ${max}/24h`;
    const id = await this.queue({ kind: 'thought', asset: t.subject, chain: t.chain ?? '', note: t.note, holding: t.holding, verdict: t.verdict,
      lowConfidence: t.confidence < LOW_CONFIDENCE_BELOW, manualOnly: t.origin === 'note_retry', ca: t.ca }, sourceNames);
    // The project "stays silent for a day" only if the post was actually created (#86)
    if (id === undefined) return 'not created: leak check';
    // The thought's project — to check before publishing from the queue whether the verdict changed (T-11)
    try {
      const keys = this.d.projectKeys?.(t.key);
      if (keys?.length) this.d.store.updatePost(id, { thought_keys: JSON.stringify(keys) });
    } catch (e) { console.error(`thought #${id}: project keys`, e); }
    this.d.store.kvSet(k, JSON.stringify({ iso: this.d.clock.iso(), verdict: t.verdict, times: [...times, this.d.clock.iso()] }));
    return 'queued';
  }

  /** A Telegram button press: post:<id>:ok|no. */
  async onCallback(data: string): Promise<string | undefined> {
    const m = data.match(/^post:(\d+):(ok|no)$/);
    if (!m) return undefined;
    const id = Number(m[1]);
    const p = this.d.store.getPost(id);
    if (!p) return 'Post not found';
    if (p.status !== 'awaiting') return `Already handled: ${p.status}`;
    if (m[2] === 'no') {
      this.d.store.updatePost(id, { status: 'rejected' });
      if (p.tg_msg && this.d.notifier.editCaption) await this.d.notifier.editCaption(p.tg_msg, `✖️ Not published\n${esc(p.text)}`);
      return 'Not publishing';
    }
    return this.publish(id);
  }

  /**
   * Posts without a reply (the owner 2026-11-11 08:02 UTC): the auto_at deadline passed — they publish on their own; waiting three times longer — they are dropped.
   * Only a post whose timer was promised in Telegram (auto_at) goes out on its own, and only if after the deadline
   * there was a successful Telegram poll: otherwise a "No" may not have arrived. Called once a minute; passes do not overlap.
   * Returns the number published.
   */
  async publishOverdue(): Promise<number> {
    const wait = this.d.autoApproveMinutes ?? 0;
    if (wait <= 0 || !this.d.x || this.overdueBusy) return 0;
    this.overdueBusy = true;
    try {
      const maxAgeMs = Math.max(this.d.autoApproveMaxAgeMinutes ?? wait * 3, wait) * 60_000;
      let n = 0;
      for (const row of this.d.store.autoPosts()) {
        const now = this.d.clock.now();
        const due = Date.parse(row.auto_at), created = Date.parse(row.ts_utc);
        if (!(now >= due) || !Number.isFinite(created)) continue; // the deadline has not passed (or the time is unreadable — then only via the button)
        const p = this.d.store.getPost(row.id);
        if (!p || p.status !== 'awaiting') continue; // while going through the list, the owner pressed the button
        if (now - created > maxAgeMs) {
          const min = Math.round((now - created) / 60_000);
          this.d.store.updatePost(row.id, { status: 'expired', error: `no answer for ${min} min` });
          // The deadline passed and there was no processed button poll after it — say so directly, otherwise the reason is only in the server log
          const deaf = !(this.d.controlOkTimes?.() ?? []).some(t => t >= due);
          const why = deaf ? ' — Telegram buttons were not reaching the agent, without them a post does not go out on its own' : '';
          if (p.tg_msg && this.d.notifier.editCaption) await this.d.notifier.editCaption(p.tg_msg, `⌛ Not published: waited for a reply ${min} min (more than ${Math.round(maxAgeMs / 60_000)})${why}\n${esc(p.text)}`).catch(e => console.error('auto-publish: caption', e));
          continue;
        }
        // The button channel must have worked after the deadline: a successful poll delivers all accumulated presses
        const oks = this.d.controlOkTimes?.() ?? [];
        if (!oks.some(t => t >= due)) continue;
        if (await this.publish(row.id, `✅ Published on X (no reply for ${wait} min)`) === 'Published') n++;
      }
      return n;
    } finally { this.overdueBusy = false; }
  }
  private overdueBusy = false;

  /**
   * T-11: the thought waited in the queue, and meanwhile the project was analysed again and marked to avoid (avoid/ignore) — do not publish.
   * A new watch/act does not block. A quality check, not a safeguard: a failed verdict lookup — publish as before.
   */
  private cancelStaleThought(p: { id: number; ts_utc: string; text: string; tg_msg?: number; thought_keys?: string | null }): Promise<void> | undefined {
    if (!p.thought_keys || !this.d.projectVerdict) return undefined;
    let v: { verdict: string; atIso: string } | undefined;
    try {
      // There may be several cards (keys split or merged): any newer avoid/ignore cancels
      v = (this.d.projectVerdict(JSON.parse(p.thought_keys) as string[]) ?? [])
        .find(x => (x.verdict === 'avoid' || x.verdict === 'ignore') && Date.parse(x.atIso) > Date.parse(p.ts_utc));
    } catch (e) { console.error(`post #${p.id}: verdict lookup`, e); return undefined; }
    if (!v) return undefined;
    const line = `🐦 Post #${p.id} cancelled: after it the project verdict became ${v.verdict.toUpperCase()}`;
    this.d.store.updatePost(p.id, { status: 'rejected', error: `verdict ${v.verdict} at ${v.atIso}` });
    console.log(`post #${p.id} (${p.thought_keys}): cancelled, verdict ${v.verdict} at ${v.atIso} after queued ${p.ts_utc}`);
    const notice = p.tg_msg && this.d.notifier.editCaption ? this.d.notifier.editCaption(p.tg_msg, `${line}\n${esc(p.text)}`) : this.d.notifier.send(line);
    return Promise.resolve(notice).then(() => undefined, e => console.error(`post #${p.id}: cancel notice`, e));
  }

  private async publish(id: number, okCaption = '✅ Published on X'): Promise<string> {
    const p = this.d.store.getPost(id)!;
    // One post — one publication: publish only from "awaiting" / "pending"; the button and the timer may arrive at once
    if (p.status !== 'awaiting' && p.status !== 'pending') return `Already handled: ${p.status}`;
    // The check is synchronous: there is no await between checking the status and changing it (the button and the timer may arrive at once)
    const cancelled = this.cancelStaleThought(p);
    if (cancelled) { await cancelled; return 'Cancelled: the project verdict changed'; }
    const day = this.d.clock.utcDay();
    // The limit also counts posts whose X request has not returned yet (two publications at once)
    if (this.d.store.postsOn(day) + this.d.store.postsByStatus('publishing').length >= this.d.dailyMax) {
      this.d.store.updatePost(id, { status: 'held', error: `daily cap ${this.d.dailyMax}` });
      await this.d.notifier.send(`🐦 Post #${id} not published: daily limit of ${this.d.dailyMax} posts`);
      return 'Daily post limit';
    }
    this.d.store.updatePost(id, { status: 'publishing' });
    let xId: string;
    // While X rejects full contract addresses, the "CA:" line goes out shortened; once a day the full address is tried again
    const short = shortCaLine(p.text);
    const banUntil = Date.parse(this.d.store.kvGet(X_CA_BAN_KEY) ?? '');
    let text = short !== p.text && banUntil > this.d.clock.now() ? short : p.text;
    try {
      const img = p.image && existsSync(p.image) ? readFileSync(p.image) : undefined;
      try { xId = (await this.d.x!.post(text, img)).id; }
      catch (err) {
        if (text === short || !X_CA_BAN.test(String((err as Error).message ?? err))) throw err;
        this.d.store.kvSet(X_CA_BAN_KEY, new Date(this.d.clock.now() + X_CA_BAN_RECHECK_MS).toISOString());
        text = short;
        xId = (await this.d.x!.post(text, img)).id;
      }
    } catch (err) {
      const msg = String((err as Error).message ?? err).slice(0, 300);
      this.d.store.updatePost(id, { status: 'failed', error: msg });
      await this.d.notifier.send(`⚠️ Post #${id} not published: ${esc(msg)}`).catch(e => console.error('post: failure notice', e));
      return 'Publishing error';
    }
    const caNote = text !== p.text ? '\nℹ️ Address shortened: X does not accept contract addresses for the first 7 days after connecting' : '';
    this.d.store.updatePost(id, { status: 'posted', x_id: xId, posted_utc: this.d.clock.iso() });
    if (!this.d.store.kvGet('x_first_post_utc')) this.d.store.kvSet('x_first_post_utc', this.d.clock.iso());
    // The post is already on X: a Telegram notification failure does not make it "unpublished" (otherwise it would drop out of the daily limit and the "one thought per day" rule)
    try {
      if (p.tg_msg && this.d.notifier.editCaption) await this.d.notifier.editCaption(p.tg_msg, `${okCaption}\n${esc(text)}${caNote}`);
      else await this.d.notifier.send(`✅ Published on X: ${esc(text.slice(0, 120))}${caNote}`);
    } catch (e) { console.error(`post #${id}: published, Telegram notice failed`, e); }
    return 'Published';
  }
}
