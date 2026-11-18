// Review #150 regression (moved from /tmp/hq/repro-150-a/repro-a-150-caps.test.ts). Review #150 (#148 item 3): model caps of $0.05 per session and the daily remainder — before the call or after? repro-a: red = the defect is present.
import { describe, it, expect } from 'vitest';
import { formPlanner, type Observation, type PlannerContext, type SiteElement } from '../src/exec/siteSession.js';
import { hybridPlanner, parseChoice, type ModelPick } from '../src/exec/sitePlanner.js';

const SITE = 'https://tinmoths.xyz/apply';
const VALUES = { xHandle: 'scarf_ai', evmAddress: '0x' + '1'.repeat(40), solAddress: undefined } as any;
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });
const page = (elements: SiteElement[]): Observation => ({ url: SITE, text: 'Apply', elements, scoped: true } as any);
const ctx = (o: Partial<PlannerContext> = {}): PlannerContext => ({ values: VALUES, steps: [], xTasks: [], siteHost: 'tinmoths.xyz', ...o } as any);
// The rules stop with code no_next on every page; Haiku answers with junk (cheap), Sonnet — with an allowed click for $0.04
// (realistic for Sonnet 5.5: input ~4–5k tokens at $2/M + thinking; the loop does not limit rounds and effort yet)
const pick = (spent: { usd: number }): ModelPick => async (tier) => {
  const usd = tier === 'haiku' ? 0.0005 : 0.04; spent.usd += usd;
  return { input: tier === 'haiku' ? { action: 'oops', why: 'x' } : { action: 'click', id: `b${Math.random()}`, why: 'x' }, usd };
};
describe('#150: model spend must stay within the caps', () => {
  it('session cap $0.05: total model spend of one session ≤ $0.05', async () => {
    const spent = { usd: 0 };
    const planner = hybridPlanner(formPlanner, pick(spent));
    for (let i = 0; i < 5; i++) { const id = `m${i}`; await planner.next(page([el(id, 'button', `Mystery ${i}`)]), ctx()); }
    console.log({ sessionSpent: spent.usd });
    expect(spent.usd).toBeLessThanOrEqual(0.05);
  });
  it('daily cap: $0.001 left today → no call that can cost more than that', async () => {
    const spent = { usd: 0 };
    const planner = hybridPlanner(formPlanner, pick(spent), { dailyLeftUsd: () => 0.001 - spent.usd });
    await planner.next(page([el('m', 'button', 'Mystery')]), ctx());
    console.log({ dailySpentOverLeft: spent.usd });
    expect(spent.usd).toBeLessThanOrEqual(0.001);
  });
});
describe('#150 (nice-to-have): "Connect" without a session wallet', () => {
  it('model click on a bare «Connect» without a session wallet is refused (rules never press it)', () => {
    const o = page([el('c', 'button', 'Connect')]);
    const p = parseChoice({ action: 'click', id: 'c', why: 'x' }, o, ctx());
    console.log(p);
    expect(p.ok).toBe(false);
  });
});
