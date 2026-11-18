// A production bug (the owner): a dapp_session decision counted as an "action" — the thought post (and the re-check update) was muted, while nobody
// writes a trade post for dapp_session: nothing went to X. actedForPost (src/pipeline.ts) — the same logic as postThought in index.ts.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_POST_ACTIONS, actedForPost } from '../src/pipeline.js';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { SiteSessions } from '../src/exec/siteSessions.js';
import type { Observation, SiteDriver } from '../src/exec/siteSession.js';
import type { Decision, RawMessage } from '../src/types.js';

const NOW = Date.UTC(2026, 10, 17, 22, 0, 0);
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-17T22:00:00.000Z', text: 'apply https://tinmoths.xyz/apply' };
const trust = { score: 9, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const dapp: Decision = { action: 'dapp_session', sizeUsd: 2, chain: 'base', reasons: ['browser session'], trust, estGasUsd: 0.45,
  intent: { kind: 'dapp_task', chain: 'base', urls: ['https://tinmoths.xyz/apply'], summary: 'apply for the whitelist', stance: 'neutral', confidence: 0.8 } } as Decision;
const site = (): SiteDriver => {
  let sent = false;
  return { async open() {}, async close() {}, async fill() {}, async click() { sent = true; }, async screenshot() { return undefined; },
    async observe(): Promise<Observation> { return sent ? { url: 'https://tinmoths.xyz/apply', text: 'Thank you — application received', elements: [] }
      : { url: 'https://tinmoths.xyz/apply', text: 'Apply', elements: [{ id: 'go', kind: 'button', label: 'Apply' }] }; } };
};

describe('a thought in X and dapp_session (NO_POST_ACTIONS)', () => {
  it('only dapp_session (with other "quiet" decisions) — not counted as an action for the post: the thought is published', () => {
    expect(NO_POST_ACTIONS.has('dapp_session')).toBe(true);
    expect(actedForPost([{ action: 'dapp_session' }])).toBe(false);
    expect(actedForPost([{ action: 'dapp_session' }, { action: 'journal_only' }, { action: 'skip' }])).toBe(false);
    expect(actedForPost([{ action: 'social_session' }, { action: 'notify_human' }])).toBe(false);
    expect(actedForPost([])).toBe(false);
  });

  it('a trade (buy_token, open_perp, nft_buy …) — the thought is muted, as before: the trade post covers it', () => {
    for (const a of ['buy_token', 'open_perp', 'nft_buy', 'prediction_buy', 'contract_call']) {
      expect(actedForPost([{ action: a }])).toBe(true);
      expect(actedForPost([{ action: 'dapp_session' }, { action: a }])).toBe(true);
    }
  });

  for (const wired of [false, true]) {
    it(`the executor writes no trade post for dapp_session (sessions ${wired ? 'wired' : 'not wired'}) — so the thought must not be muted`, async () => {
      const clock = new VirtualClock(NOW); const posts: unknown[] = []; const sent: string[] = [];
      const paper = new PaperExecutor(DEFAULT_RISK, new RiskState(DEFAULT_RISK, clock), new Store(':memory:'), { async send(t) { sent.push(t); } }, clock);
      paper.poster = { async queue(e) { posts.push(e); } };
      if (wired) paper.siteSessions = new SiteSessions({ driver: site, evmBurners: [], solBurners: [], dataDir: mkdtempSync(join(tmpdir(), 'scarf-np-')), maxPerDay: 5, maxUsdPerDay: 1, now: () => NOW });
      await paper.execute(MSG, dapp, 1);
      await new Promise(r => setTimeout(r, 60));
      expect(sent[0]).toMatch(/DAPP SESSION/);
      expect(posts).toEqual([]);                         // no trade post is queued
      expect(actedForPost([dapp])).toBe(false);          // and postThought does not mute the thought
    });
  }
});
