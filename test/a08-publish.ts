// A-08, round 3: end-to-end harness from the round 2 review of PR #69 — handleMessage → loop from HQ fix #68 (round 2 version) → real Publisher (auto).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMessage, thoughtCa, type HandleResult } from '../src/pipeline.js';
import { Publisher } from '../src/posts/publisher.js';
import type { AnalysisWithThoughts } from '../src/intel/router.js';
import type { RawMessage } from '../src/types.js';
import { setup, msg } from './a08-helpers.js';

export type S = ReturnType<typeof setup>;
export function withPublisher(s: S) {
  const posted: string[] = []; const log: string[] = [];
  const notifier = { async send() { /* Telegram */ }, async sendPhoto() { return 1; }, async editCaption() { /* */ } };
  const publisher = new Publisher({ store: s.store, notifier, clock: s.clock, dataDir: mkdtempSync(join(tmpdir(), 'a08r3-')), x: { async post(text: string) { posted.push(text); return { id: `T${posted.length}` }; } },
    mode: 'auto', autoAfterDays: 3, dailyMax: 25, paper: true, thoughtsDailyMax: 8, thoughtMinConfidence: 0 } as any);
  /** Publishing loop from HQ fix #68 (round 2 version: no acted check — the router drops a thought about a traded project) + contract address, as in main (T-09). */
  const publish = async (m: RawMessage, r: HandleResult) => {
    if (!r.analysis) return;
    const a = r.analysis as AnalysisWithThoughts;
    const ts = a.thoughts ?? (a.thought ? [a.thought] : []);
    if (!m.backfill && (r.analysis.verdict === 'watch' || r.analysis.verdict === 'act')) {
      if (a.thoughtSkip) log.push(`thought skipped: ${a.thoughtSkip} (${r.analysis.model})`);
      for (const why of (a.thoughtSkips ?? []).filter(x => x !== a.thoughtSkip)) log.push(`thought skipped: ${why}`);
    }
    if (!m.backfill) for (const t0 of ts) {
      // Contract address — as postThought in src/index.ts (main, T-09): from the thought, otherwise the only address on the same project's card
      let t = t0;
      if (!t.ca) {
        const id = /^p(\d+)$/.exec(t.key)?.[1];
        const card = id ? s.deps.intel!.cards.card(Number(id)) : undefined;
        const found = card ? thoughtCa(r, card.keys, () => false) : undefined;
        t = { ...t, token: t.token ?? !!card?.keys.some(k => k.startsWith('ticker:')), ...(found ? { ca: found.ca, chain: found.chain } : {}) };
      }
      const why = await publisher.thought(t, [m.sourceServer, m.channel, m.author, ...s.store.sourceNames()]).catch(e => `error: ${String(e)}`);
      log.push(`thought ${t.subject} (${t.verdict}): ${why}`);
    }
  };
  const one = async (over: Partial<RawMessage>) => { const m = msg(over); const r = await handleMessage(m, s.deps); await publish(m, r); return r; };
  const batch = async (texts: string[]) => {
    let m!: RawMessage; let r!: HandleResult;
    for (const [i, text] of texts.entries()) { m = msg({ sourceServer: 'ServerB', channel: 'chat', author: `user${i}`, text }); r = await handleMessage(m, s.deps); }
    await publish(m, r);
    return r;
  };
  return { posted, log, publish, batch, one, publisher };
}
export const triaged = (names?: string[]) => { const s = setup({ batch: 2, triage: true }); s.setTriage(() => ({ escalate: true, focus: [1, 2], names, reason: 'x' })); return s; };
/** Smart list of two accounts (IDs 1 and 2); the test sets the candidates' followers. */
export const withSmart = (s: S, x: any, followers: Record<string, string[]>) => {
  x.followerIds = async (h: string) => followers[h] ?? ['99'];
  s.deps.intel!.enrich.x = x;
  s.deps.intel!.enrich.smart = { handles: new Map([['alpha_a', 'trader'], ['alpha_b', 'collector']]), ids: async () => new Map([['1', 'alpha_a'], ['2', 'alpha_b']]) };
};
