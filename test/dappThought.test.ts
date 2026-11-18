// Production bug (review hq/E-06-wire): an analysis with a dapp_session decision lost its X thought. Besides postThought (index.ts), the thought was dropped by
// router.ts (tradedRefs → attachThoughts) with its own NO_POST_ACTIONS set without dapp_session: "trade post covers it", but nobody writes a trade post
// for dapp_session. Now there is one set — src/postActions.ts. Through handleMessage and the scheduled recheck.
import { describe, it, expect } from 'vitest';
import { handleMessage, actedForPost } from '../src/pipeline.js';
import { recheckDue, type AnalysisWithThoughts } from '../src/intel/router.js';
import { setup, msg } from './a08-helpers.js';

const reply = (intents: unknown[]) => () => ({ verdict: 'act', confidence: 0.85, project: { name: 'Tin Moths', category: 'nft' },
  publicNote: 'Tin Moths opened whitelist applications today, I am watching the list fill.', thesis: 'x', intents });
const DAPP = { kind: 'dapp_task', chain: 'base', urls: ['https://tinmoths.xyz/apply'], summary: 'apply for the whitelist', stance: 'neutral', confidence: 0.8 };

describe('E-06 wire: an analysis with dapp_session produces an X thought', () => {
  it('control: the same analysis without an action (watch) — there is a thought', async () => {
    const s = setup();
    s.setAnalyst(() => ({ ...reply([])(), verdict: 'watch' }));
    const r = await handleMessage(msg({ text: 'Tin Moths whitelist apply https://tinmoths.xyz/apply' }), s.deps);
    expect((r.analysis as AnalysisWithThoughts).thought?.subject).toBe('Tin Moths');
  });

  it('act + dapp_task → dapp_session decision, actedForPost=false, and the analysis has a thought', async () => {
    const s = setup();
    s.setAnalyst(reply([DAPP]));
    const r = await handleMessage(msg({ text: 'Tin Moths whitelist apply https://tinmoths.xyz/apply' }), s.deps);
    expect(r.decisions.map(d => d.action)).toEqual(['dapp_session']);
    expect(actedForPost(r.decisions)).toBe(false);
    const a = r.analysis as AnalysisWithThoughts;
    expect(a.thoughtSkips ?? []).not.toContain('Tin Moths: trade post covers it');
    expect(a.thought?.subject).toBe('Tin Moths');
  });

  it('scheduled recheck with dapp_session — there is a thought (update) too', async () => {
    const s = setup();
    s.setAnalyst(() => ({ verdict: 'watch', confidence: 0.6, project: { name: 'Tin Moths', category: 'nft' }, publicNote: 'Watching Tin Moths: the site says applications open soon.', thesis: 'first look', recheckAfterMinutes: 60 }));
    await handleMessage(msg({ text: 'Tin Moths whitelist soon https://tinmoths.xyz/apply' }), s.deps);
    s.clock.set(s.clock.now() + 61 * 60_000);
    s.setAnalyst(() => ({ ...reply([DAPP])(), changeReason: 'the site opened the whitelist form' })); // verdict upgrade — with a stated reason
    const [r] = await recheckDue(s.deps);
    expect(r.decisions.map(d => d.action)).toEqual(['dapp_session']);
    expect(actedForPost(r.decisions)).toBe(false);
    const a = r.analysis as AnalysisWithThoughts;
    expect(a.thoughtSkips ?? []).not.toContain('Tin Moths: trade post covers it');
    expect(a.thought?.subject).toBe('Tin Moths');
  });
});
