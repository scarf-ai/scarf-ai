import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseline, dayTotals, reconcile, xUsd, splitDays, addCall, priceTolerance, sumBuckets, mergeShadow, missedActions } from '../src/cost/baseline.js';
import { verdictOf } from '../src/cost/shadow.js';
import { meterX, xCredits } from '../src/cost/xmeter.js';
import { costUsd, usageSummary, PRICES } from '../src/llm/budget.js';
import type { XProvider } from '../src/analyst/enrich.js';

// vitest 2 does not know node:sqlite as a built-in module — load it via require (as in the production code, read-only)
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// An analysis as runVerdict writes it: costUsd over all rounds and usageSummary
const opus = 'claude-opus-5-5', haiku = 'claude-haiku-5-5';
const rounds = [
  { input_tokens: 1200, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 6000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 4000 } },
  { input_tokens: 300, output_tokens: 1500, cache_read_input_tokens: 6000, cache_creation_input_tokens: 800, cache_creation: { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 0 } },
];
const analysisRow = (ts: string, extra: Record<string, unknown> = {}) => ({
  ts, kind: 'analysis', model: opus, trigger: 'call', costUsd: Number(rounds.reduce((a, u) => a + costUsd(opus, u), 0).toFixed(5)), usage: usageSummary(rounds), ...extra,
});

describe('C-01 baseline: counting from the review log', () => {
  const rows = [
    { ts: '2026-10-28T10:00:00.000Z', kind: 'message', skipped: 'chatter' },
    { ts: '2026-10-28T10:00:01.000Z', kind: 'message' },
    analysisRow('2026-10-28T10:00:02.000Z'),
    analysisRow('2026-10-28T11:00:00.000Z', { trigger: 'chat_batch' }),
    { ts: '2026-10-28T12:00:00.000Z', kind: 'analysis', model: opus, costUsd: 0, error: 'boom' },
    { ts: '2026-10-28T12:00:01.000Z', kind: 'triage', model: haiku, costUsd: 0.0005 },
    { ts: '2026-10-28T12:00:02.000Z', kind: 'triage', error: 'timeout' },
    { ts: '2026-10-28T12:00:03.000Z', kind: 'hard_check' },
    { ts: '2026-10-28T12:00:04.000Z', kind: 'log', text: 'analyst budget exhausted → Haiku extraction for trusted source' },
    { ts: '2026-10-29T09:00:00.000Z', kind: 'xapi', endpoint: 'search', items: 20 },
    { ts: '2026-10-29T09:00:01.000Z', kind: 'xapi', endpoint: 'profile', items: 0, error: 'HTTP 429' },
    { ts: 'broken', kind: 'analysis', costUsd: 100 },
  ];
  const asks = [{ ts: '2026-10-28T13:00:00.000Z', model: 'claude-sonnet-5-5', cost: 0.01 }, { ts: '2026-10-28T13:01:00.000Z', model: haiku, cost: 0, reason: 'error: x' }];
  const spend = [{ day: '2026-10-28', model: opus, usd: 0 }, { day: '2026-10-28', model: haiku, usd: 0.0005 }, { day: '2026-10-28', model: 'tag:chat', usd: 0.3 }];
  const [d28, d29] = baseline(rows, asks, spend);

  it('day total = sum of costUsd of analyses and triage (as in npm run review)', () => {
    const one = analysisRow('x').costUsd;
    const t = dayTotals(d28);
    expect(t.analysis.n).toBe(3);
    expect(t.analysis.errors).toBe(1);
    expect(t.analysis.usd).toBeCloseTo(2 * one, 9);
    expect(t.triage.usd).toBeCloseTo(0.0005, 9);
    expect(t.triage.errors).toBe(1);
    expect(t.models).toBeCloseTo(2 * one + 0.0005, 9);
    expect(t.site.usd).toBeCloseTo(0.01, 9);
    expect(t.site.errors).toBe(1);
    expect(d28.extract.n).toBe(1);
    expect(t.total).toBeCloseTo(2 * one + 0.0005 + 0.01 + 0.0004, 9);
    expect(d28.messages).toBe(2); expect(d28.skipped).toBe(1); expect(d28.hardChecks).toBe(1);
    expect(t.x).toBeUndefined(); // no xapi events — "no data", not $0
    expect(d28.analysisKind.chat.n).toBe(1); expect(d28.analysisKind.message.n).toBe(2);
  });

  it('shares: input + write + read + output = costUsd; the 1 h write is recovered from the remainder', () => {
    const b = d28.analysis[opus];
    const p = PRICES[opus];
    expect(b.inUsd).toBeCloseTo(2 * 1500 * p.input / 1e6, 9);
    expect(b.readUsd).toBeCloseTo(2 * 6000 * p.cacheRead / 1e6, 9);
    expect(b.outUsd).toBeCloseTo(2 * 2400 * p.output / 1e6, 9);
    expect(b.inUsd + b.writeUsd + b.readUsd + b.outUsd + b.noSplitUsd).toBeCloseTo(b.usd, 9);
    expect(b.cacheWrite).toBe(2 * 6800);
    expect(Math.abs(b.cacheWrite1h - 2 * 4000)).toBeLessThanOrEqual(4); // costUsd rounded to 1e-5
    expect(b.split).toBe(2); expect(b.rounds).toBe(4);
    expect(d28.priceMismatch).toBe(0);
  });

  it('cross-check with llm_spend: the tag:chat label is not compared, the mismatch is visible', () => {
    const r = reconcile(d28);
    expect(r.map(x => x.model)).toEqual([haiku, opus]);
    expect(r.find(x => x.model === haiku)!.diff).toBeCloseTo(0, 9);
    expect(r.find(x => x.model === opus)!.diff).toBeCloseTo(2 * analysisRow('x').costUsd, 9);
  });

  it('different prices at write time — the mismatch is flagged, not hidden', () => {
    const [d] = baseline([{ ts: '2026-10-28T00:00:00Z', kind: 'analysis', model: opus, costUsd: 0.5, usage: { rounds: 1, input: 1000, cacheWrite: 0, cacheRead: 0, output: 1000 } }]);
    expect(d.priceMismatch).toBeGreaterThan(0.4);
  });

  it('twitterapi.io: calls, records and errors by method', () => {
    expect(d29.x!.search).toEqual({ calls: 1, items: 20, errors: 0, usd: xUsd('search', 20), upperBound: false });
    expect(d29.x!.profile).toMatchObject({ errors: 1, usd: 0 }); // a failed call is not billed
    expect(dayTotals(d29).x).toBeCloseTo(20 * 0.15 / 1000, 9);
  });
});

describe('C-01 xmeter: the twitterapi.io counter does not change responses', () => {
  it('writes an event per call and passes the response and the error through as is', async () => {
    const events: [string, Record<string, unknown>][] = [];
    const raw: XProvider = {
      profile: async h => ({ handle: h, followers: 5 }),
      search: async () => [{ text: 'a', createdAt: '', likes: 0, retweets: 0, author: 'x' }, { text: 'b', createdAt: '', likes: 0, retweets: 0, author: 'y' }],
      followers: async () => { throw new Error('twitterapi.io HTTP 429'); },
    };
    const x = meterX(raw, { write: (k, d) => events.push([k, d]) }, () => 0);
    expect(await x.profile('abc')).toEqual({ handle: 'abc', followers: 5 });
    expect((await x.search('q')).length).toBe(2);
    await expect(x.followers!('abc')).rejects.toThrow('HTTP 429');
    expect(x.timeline).toBeUndefined(); // what the provider lacks, the wrapper lacks too
    expect(events).toEqual([
      ['xapi', { endpoint: 'profile', items: 1, ms: 0 }],
      ['xapi', { endpoint: 'search', items: 2, ms: 0 }],
      ['xapi', { endpoint: 'followers', items: 0, ms: 0, error: 'twitterapi.io HTTP 429' }],
    ]);
  });
});

describe('C-01 npm run cost: the command on supplied files', () => {
  it('prints the by-day table, shares and the cross-check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-'));
    const f = join(dir, 'review.jsonl'), db = join(dir, 'db.json');
    writeFileSync(f, [analysisRow('2026-10-28T10:00:00.000Z'), { ts: '2026-10-28T10:00:01.000Z', kind: 'triage', model: haiku, costUsd: 0.0005 }].map(r => JSON.stringify(r)).join('\n') + '\n{broken\n');
    writeFileSync(db, JSON.stringify({ spend: [{ day: '2026-10-28', model: opus, usd: analysisRow('x').costUsd }], asks: [] }));
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/tools/cost.ts', '--file', f, '--db', db, '--today', '2026-10-30'], { encoding: 'utf8' });
    expect(out).toContain('# SCARF costs — 2026-10-28 (UTC)');
    expect(out).toContain('| 2026-10-28 |');
    expect(out).toContain('| opus-5-5 | 1 |');
    expect(out).toContain('matches');
    expect(out).toContain('broken log lines skipped: 1');
    expect(out).toContain('the `src/cost/xmeter.ts` counter is not wired yet');
  });
});

const shadowSection = (out: string) => out.slice(out.indexOf('## Shadow comparison'), out.indexOf('## Cross-check'));
const cli = (args: string[], env: Record<string, string> = {}) => {
  try { return { code: 0, out: execFileSync(process.execPath, ['--import', 'tsx', 'src/tools/cost.ts', ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }) }; }
  catch (e: any) { return { code: e.status as number, out: `${e.stdout}${e.stderr}` }; }
};

describe('C-01 follow-up after HQ acceptance (#35)', () => {
  it('item 1: days with llm_spend only — separately; the average — over full days with a log, without the current and an incomplete first day', () => {
    const spend = [{ day: '2026-10-22', model: opus, usd: 4 }, { day: '2026-10-23', model: opus, usd: 4 }, { day: '2026-10-24', model: opus, usd: 1 }];
    const rows = [
      { ts: '2026-10-24T00:00:05Z', kind: 'analysis', model: opus, costUsd: 1 },
      { ts: '2026-10-25T03:00:00Z', kind: 'analysis', model: opus, costUsd: 2 }, // a late start matters only for the first log day (the 24th)
      { ts: '2026-10-26T00:10:00Z', kind: 'analysis', model: opus, costUsd: 9 }, // the current day
    ];
    const { full, excluded, noJournal } = splitDays(baseline(rows, [], spend), '2026-10-26');
    expect(noJournal.map(d => d.day)).toEqual(['2026-10-22', '2026-10-23']);
    expect(full.map(d => d.day)).toEqual(['2026-10-24', '2026-10-25']);
    expect(excluded.map(e => [e.day.day, e.why])).toEqual([['2026-10-26', 'current UTC day']]);
    const late = splitDays(baseline([{ ts: '2026-10-28T09:41:00Z', kind: 'message' }, { ts: '2026-10-29T00:00:01Z', kind: 'message' }]), '2026-10-30');
    expect(late.excluded[0].why).toBe('log starts at 09:41 UTC — incomplete day');
    expect(late.full.map(d => d.day)).toEqual(['2026-10-29']);
  });

  it('item 1: in the report $4 + $4 before the log do not turn into $0 and do not drag the average down', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-'));
    const f = join(dir, 'r.jsonl'), db = join(dir, 'db.json');
    writeFileSync(f, JSON.stringify({ ts: '2026-10-24T00:00:05Z', kind: 'analysis', model: opus, costUsd: 1 }) + '\n');
    writeFileSync(db, JSON.stringify({ spend: [{ day: '2026-10-22', model: opus, usd: 4 }, { day: '2026-10-23', model: opus, usd: 4 }, { day: '2026-10-24', model: opus, usd: 1 }], asks: [] }));
    const r = cli(['--file', f, '--db', db, '--today', '2026-10-30']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('| **Daily average** (1 full) | **$1.00** |');
    expect(r.out).toContain('## Days without a review log');
    expect(r.out).toContain('| 2026-10-22 | $4.00 | — |');
  });

  it('item 2: null lines, numbers and arrays go to "broken", without a crash', () => {
    expect(() => baseline([null, 1, 'x', [], { ts: '2026-10-28T00:00:00Z', kind: 'message' }])).not.toThrow();
    const dir = mkdtempSync(join(tmpdir(), 'cost-'));
    const f = join(dir, 'r.jsonl');
    writeFileSync(f, ['null', '42', '[]', JSON.stringify({ ts: '2026-10-28T00:00:00Z', kind: 'message' })].join('\n'));
    const r = cli(['--file', f, '--today', '2026-10-30']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('broken log lines skipped: 3');
  });

  it('item 3: the tolerance is relative — a cheap Haiku call without a cache write is flagged, rounding is not', () => {
    const p = PRICES[haiku];
    const fair = (1000 * p.input + 500 * p.output) / 1e6; // $0.00035
    const b = sumBuckets([]);
    expect(addCall(b, haiku, Number(fair.toFixed(5)), { rounds: 1, input: 1000, cacheWrite: 0, cacheRead: 0, output: 500 })).toBe(0);
    expect(addCall(b, haiku, fair + 0.0004, { rounds: 1, input: 1000, cacheWrite: 0, cacheRead: 0, output: 500 })).toBeCloseTo(0.0004, 9);
    expect(b.writeUsd).toBe(0); // without write tokens the remainder does not go to "cache write"
    expect(b.inUsd + b.writeUsd + b.readUsd + b.outUsd + b.unexplainedUsd + b.noSplitUsd).toBeCloseTo(b.usd, 12);
    expect(priceTolerance(1)).toBe(0.01); expect(priceTolerance(0)).toBe(2e-5);
  });

  it('item 4 / C-06: twitterapi.io rates (checked 2026-11-13 against twitterapi.io/pricing) — examples from the page, tiers, minimum; errors — free', () => {
    // Examples from the pricing page verbatim: "If the API returns 4 tweets, you will be charged 60 credits" etc.
    expect(xCredits('search', 4)).toBe(60); expect(xCredits('search', 2)).toBe(30);
    expect(xCredits('search', 1)).toBe(15); expect(xCredits('search', 0)).toBe(15);
    expect(xCredits('followers', 200)).toBe(200);          // "200 followers in one call, you pay 200 credits"
    expect(xCredits('followerIds', 5000)).toBe(2250);      // "5,000 follower IDs in one call, you pay 2,250 credits"
    // Tiers: follower IDs 1–199 → 2, 200–3 999 → 1; followers 1–99 → 3 (minimum 15), 100–199 → 2
    expect(xCredits('followerIds', 150)).toBe(300); expect(xCredits('followerIds', 3000)).toBe(3000); expect(xCredits('followerIds', 3)).toBe(15);
    expect(xCredits('followers', 4)).toBe(15); expect(xCredits('followers', 50)).toBe(150); expect(xCredits('followers', 150)).toBe(300);
    expect(xCredits('followers', 450, 3)).toBe(200 + 200 + 50 * 3); // two full pages and one of 50
    expect(xCredits('profile', 1)).toBe(18); expect(xCredits('profile', 10, 1, 10)).toBe(180);
    expect(xCredits('timeline', 20)).toBe(300);
    expect(xUsd('followerIds', 5000)).toBeCloseTo(0.0225, 12); // $1 = 100 000 credits
    const [d] = baseline([
      { ts: '2026-10-29T00:00:00Z', kind: 'xapi', endpoint: 'followers', items: 450, pages: 3 },
      { ts: '2026-10-29T00:00:01Z', kind: 'xapi', endpoint: 'profile', items: 10, upperBound: true },
      { ts: '2026-10-29T00:00:02Z', kind: 'xapi', endpoint: 'search', items: 0, error: 'HTTP 500' },
    ]);
    expect(d.x!.followers.usd).toBeCloseTo(550 / 1e5, 12);
    expect(d.x!.profile.upperBound).toBe(true);
    expect(d.x!.profile.usd).toBeCloseTo(180 / 1e5, 12);
    expect(d.x!.search).toMatchObject({ errors: 1, usd: 0 });
  });

  it('item 5: xmeter — followers pages and the ids() upper bound', async () => {
    const events: Record<string, unknown>[] = [];
    const raw: XProvider = {
      profile: async h => ({ handle: h }), search: async () => [],
      followers: async () => Array.from({ length: 401 }, (_, i) => ({ handle: `f${i}` })),
      ids: async () => new Map(),
    };
    const x = meterX(raw, { write: (_k, d) => events.push(d) }, () => 0);
    await x.followers!('a', 3); await x.ids!(['a', 'b']);
    expect(events).toEqual([{ endpoint: 'followers', items: 401, pages: 3, ms: 0 }, { endpoint: 'profile', items: 2, upperBound: true, ms: 0 }]);
  });

  it('item 9: clear CLI errors instead of a stack trace', () => {
    const three = cli(['2026-10-27', '2026-10-28', '2026-10-29']);
    expect(three.code).toBe(1); expect(three.out).toContain('There can be one or two dates');
    const missing = cli(['--file', '/nonexistent/r.jsonl']);
    expect(missing.code).toBe(1); expect(missing.out).toContain('No file /nonexistent/r.jsonl'); expect(missing.out).not.toContain('    at ');
    const dir = mkdtempSync(join(tmpdir(), 'cost-'));
    writeFileSync(join(dir, 'r.jsonl'), ''); writeFileSync(join(dir, 'db.json'), '{oops');
    const bad = cli(['--file', join(dir, 'r.jsonl'), '--db', join(dir, 'db.json')]);
    expect(bad.code).toBe(1); expect(bad.out).toContain('not JSON'); expect(bad.out).not.toContain('    at ');
    expect(cli(['28.10.2026']).out).toContain('Invalid date');
  });

  it('item 10: server mode — the log by day and node:sqlite databases (read-only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-srv-'));
    mkdirSync(join(dir, 'review'));
    const one = analysisRow('x').costUsd;
    writeFileSync(join(dir, 'review', '2026-10-28.jsonl'), [analysisRow('2026-10-28T00:00:03.000Z'), { ts: '2026-10-28T05:00:00.000Z', kind: 'triage', model: haiku, costUsd: 0.0005 }].map(r => JSON.stringify(r)).join('\n') + '\n');
    const a = new DatabaseSync(join(dir, 'agent.sqlite'));
    a.exec('CREATE TABLE llm_spend(day TEXT, model TEXT, usd REAL, PRIMARY KEY(day, model))');
    for (const [day, model, usd] of [['2026-10-27', opus, 3], ['2026-10-28', opus, one], ['2026-10-28', haiku, 0.0005], ['2026-10-28', 'tag:chat', 0.1]] as const) a.prepare('INSERT INTO llm_spend VALUES (?,?,?)').run(day, model, usd);
    a.close();
    const s = new DatabaseSync(join(dir, 'site.sqlite'));
    s.exec('CREATE TABLE asks(ts TEXT, model TEXT, cost REAL, q_len INTEGER, reason TEXT)');
    s.prepare('INSERT INTO asks VALUES (?,?,?,?,?)').run('2026-10-28T12:00:00.000Z', haiku, 0.0003, 10, null);
    s.close();
    const r = cli(['2026-10-27', '2026-10-28', '--today', '2026-10-30'], { AGENT_DATA_DIR: dir });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`| 2026-10-28 | $${(one + 0.0005 + 0.0003).toFixed(2)} | $${(one + 0.0005).toFixed(2)} | 1 · $${one.toFixed(2)} | 1 · $0.0005 | 1 · $0.0003 |`);
    expect(r.out).toContain('| 2026-10-27 | $3.00 | — |'); // llm_spend without a log — separately
    expect(r.out).toMatch(/\| 2026-10-28 \| opus-5-5 \| .* \| matches \|/);
    expect(r.out).toMatch(/\| 2026-10-28 \| haiku-5-5 \| .* \| matches \|/);
    expect(r.out).toContain('no log file');
  });
});

describe('C-03 shadow comparison of saving ideas (scarf-cost-gate)', () => {
  const ev = (ts: string, o: Record<string, unknown>) => ({ ts, kind: 'cost_shadow', ...o });
  const rows = [
    ev('2026-11-10T00:00:30Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.125, verdict: 'watch' }),
    ev('2026-11-10T03:00:00Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.09, verdict: 'ignore' }),
    ev('2026-11-10T05:00:00Z', { idea: 'recheck-gate', wouldSkip: false, costUsd: 0.12, verdict: 'act' }),
    ev('2026-11-10T06:00:00Z', { idea: 'batch-compact', wouldSkip: false, costUsd: 0.02, charsBefore: 12000, charsAfter: 8400 }),
    ev('2026-11-11T01:00:00Z', { idea: 'batch-dedup', wouldSkip: true, costUsd: 0.02, verdict: 'act' }),
  ];

  it('by idea: skipped calls, $ and verdicts of what was skipped; act/watch — separately', () => {
    const s = mergeShadow(baseline(rows));
    expect(s['recheck-gate']).toMatchObject({ events: 3, wouldSkip: 2, skippedVerdicts: { watch: 1, ignore: 1 } });
    expect(s['recheck-gate'].usdSaved).toBeCloseTo(0.215, 9);
    expect(missedActions(s['recheck-gate'])).toBe(1);
    expect(missedActions(s['batch-dedup'])).toBe(1);
    expect(s['batch-compact']).toMatchObject({ wouldSkip: 0, charsBefore: 12000, charsAfter: 8400 });
  });

  it('report: $ per day over the idea\'s full days, all verdicts of what was skipped, a warning; compaction without inputUsd — "—", not $0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-'));
    const f = join(dir, 'r.jsonl');
    writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const r = cli(['--file', f, '--today', '2026-11-12']);
    expect(r.code).toBe(0);
    const sec = shadowSection(r.out);
    // recheck-gate started 10.11 at 00:00 — full days 10.11 and 11.11; all savings on 10.11 → $0.215 / 2
    expect(sec).toContain('| 2 · recheck-gate | 3 | 2 | $0.21 | 2 | $0.11 | **1** | watch 1, ignore 1 | — |');
    // batch-dedup started 11.11 at 01:00 — the first day is incomplete, no full days
    expect(sec).toContain('| 1 · batch-dedup | 1 | 1 | $0.0200 | 0 | — | **1** | act 1 | — |');
    expect(sec).toContain('| 4 · batch-compact | 1 | 0 | — | 1 | — | 0 | — | 12000 → 8400 (−30%) |'); // started at 06:00 — only 11.11 is full
    expect(sec).toContain('⚠ batch-dedup: the new path would miss 1 action(s)');
    expect(sec).toContain('batch-compact: compaction without inputUsd — the $ saving cannot be estimated');
  });
});

// Repros from HQ review #80, round 1 (R1–R6) and item 9 — expected behaviour after the follow-up
describe('C-03 shadow: follow-up after HQ review (#80, round 1)', () => {
  const ev = (ts: string, o: Record<string, unknown>) => ({ ts, kind: 'cost_shadow', ...o });
  const report = (rows: unknown[], today = '2026-11-12') => {
    const f = join(mkdtempSync(join(tmpdir(), 'repro-')), 'r.jsonl');
    writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return shadowSection(cli(['--file', f, '--today', today]).out);
  };

  it('R1: verdict as an object, as in the analysis event — a skipped act is visible', () => {
    const rows = [ev('2026-11-10T00:00:30Z', { idea: 'batch-dedup', wouldSkip: true, costUsd: 0.02, msgId: 'm1', verdict: { verdict: 'act', confidence: 0.8, thesis: 'x' } })];
    expect(missedActions(mergeShadow(baseline(rows))['batch-dedup'])).toBe(1);
    expect(report(rows)).toContain('⚠ batch-dedup');
    expect(verdictOf(' ACT ')).toBe('act'); expect(verdictOf({ verdict: 'Watch' })).toBe('watch'); expect(verdictOf('maybe')).toBeUndefined();
  });

  it('R2: off-format fields — "unrecognized", not a silent zero; no verdict — a skip that needs review', () => {
    const rows = [
      ev('2026-11-10T00:00:30Z', { idea: 'recheck-gate', wouldSkip: 'true', costUsd: 0.125, verdict: 'act' }),
      ev('2026-11-10T01:00:00Z', { idea: 'recheck-gate', would_skip: true, cost_usd: 0.125, verdict: 'act' }),
      ev('2026-11-10T02:00:00Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: '0.125', verdict: 'ACT' }),
      ev('2026-11-10T03:00:00Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.125 }),
    ];
    const b = mergeShadow(baseline(rows))['recheck-gate'];
    expect(b).toMatchObject({ unrecognized: 3, events: 1, wouldSkip: 1, missed: 1, skippedVerdicts: { 'not recognized': 1 } });
    const sec = report(rows);
    expect(sec).toContain('⚠ recheck-gate: unrecognized events: 3');
    expect(sec).toContain('⚠ recheck-gate: the new path would miss 1 action(s)');
  });

  it('R3: $ per day — over the idea\'s own full days; a day whose first event is after 01:00 is incomplete', () => {
    const base = [{ ts: '2026-11-08T00:00:10Z', kind: 'message' }, { ts: '2026-11-09T00:00:10Z', kind: 'message' }, { ts: '2026-11-10T00:00:10Z', kind: 'message' }];
    // Enabled 10.11 at 00:00:30 — 10.11 is a full day of the idea: $0.24 per day, not $0.08 (dividing by the period's 3 days is a bug)
    expect(report([...base, ev('2026-11-10T00:00:30Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.12, verdict: 'ignore', msgId: 'a' }),
      ev('2026-11-10T14:00:00Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.12, verdict: 'ignore', msgId: 'b' })]))
      .toContain('| 2 · recheck-gate | 2 | 2 | $0.24 | 1 | $0.24 |');
    // Enabled 10.11 at 02:00 (the review example) — the day is incomplete: $ per day is not computed, 0 full days
    expect(report([...base, ev('2026-11-10T02:00:00Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.12, verdict: 'ignore', msgId: 'a' }),
      ev('2026-11-10T14:00:00Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.12, verdict: 'ignore', msgId: 'b' })]))
      .toContain('| 2 · recheck-gate | 2 | 2 | $0.24 | 0 | — |');
  });

  it('R4: compaction — "—" without inputUsd and an estimate from inputUsd if present', () => {
    expect(report([ev('2026-11-10T00:00:30Z', { idea: 'batch-compact', wouldSkip: false, costUsd: 0.02, charsBefore: 12000, charsAfter: 8400 })]))
      .not.toContain('| 4 · batch-compact | 1 | 0 | $0.00 |');
    const sec = report([ev('2026-11-10T00:00:30Z', { idea: 'batch-compact', wouldSkip: false, costUsd: 0.02, inputUsd: 0.015, charsBefore: 12000, charsAfter: 8400 })]);
    expect(sec).toContain('| 4 · batch-compact | 1 | 0 | ≈$0.0045 | 1 | $0.0045 |'); // 0.015 × 30 %; one day in the log
  });

  it('R5: the same event twice (idea, msgId, time) — counted once', () => {
    const e = ev('2026-11-10T00:00:30Z', { idea: 'burst-merge', wouldSkip: true, costUsd: 0.065, verdict: 'ignore', msgId: 'm-1' });
    const s = mergeShadow(baseline([e, { ...e }]))['burst-merge'];
    expect(s.usdSaved).toBeCloseTo(0.065, 9);
    expect(s.duplicates).toBe(1);
  });

  it('R6 and item 7: no charsAfter — no "−100 %"; the text grew — "+17 %", not "−-17 %"', () => {
    const noAfter = report([ev('2026-11-10T00:00:30Z', { idea: 'batch-compact', wouldSkip: false, costUsd: 0.02, charsBefore: 12000 })]);
    expect(noAfter).not.toContain('(−100%)');
    expect(noAfter).toContain('12000 → ?');
    expect(noAfter).toContain('⚠ batch-compact: 1 compaction events have no charsAfter');
    expect(report([ev('2026-11-10T00:00:30Z', { idea: 'batch-compact', wouldSkip: false, costUsd: 0.02, charsBefore: 6000, charsAfter: 7000 })])).toContain('6000 → 7000 (+17%)');
  });

  it('item 9: a recheck dropped with the previous watch — not a miss; act or a verdict change — a miss', () => {
    const s = mergeShadow(baseline([
      ev('2026-11-10T00:00:30Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.1, verdict: 'watch', prevVerdict: 'watch', msgId: 'a' }),
      ev('2026-11-10T01:00:30Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.1, verdict: 'act', prevVerdict: 'watch', msgId: 'b' }),
      ev('2026-11-10T02:00:30Z', { idea: 'recheck-gate', wouldSkip: true, costUsd: 0.1, verdict: 'watch', prevVerdict: 'ignore', msgId: 'c' }),
    ]))['recheck-gate'];
    expect(s.missed).toBe(2);
  });

  it('item 5: an unknown idea is flagged', () => {
    expect(report([ev('2026-11-10T00:00:30Z', { idea: 'msg-merge', wouldSkip: true, costUsd: 0.05, verdict: 'ignore' })])).toContain('msg-merge (unknown idea)');
  });
});

describe('C-05: cache keep-alive pings in npm run cost', () => {
  it('are included in the agent models and the llm_spend cross-check, a separate table', () => {
    const rows = [
      { ts: '2026-11-12T00:00:30Z', kind: 'analysis', model: opus, costUsd: 0.05, usage: { rounds: 1, input: 5000, cacheWrite: 0, cacheRead: 8813, output: 1000 } },
      { ts: '2026-11-12T01:00:00Z', kind: 'cache_keepalive', model: opus, costUsd: 0.00177, usage: { rounds: 1, input: 1, cacheWrite: 0, cacheRead: 8813, output: 0 } },
    ];
    const [d] = baseline(rows, [], [{ day: '2026-11-12', model: opus, usd: 0.05177 }]);
    expect(dayTotals(d).models).toBeCloseTo(0.05177, 9);
    expect(reconcile(d)[0].diff).toBeCloseTo(0, 9);
    const f = join(mkdtempSync(join(tmpdir(), 'ka-')), 'r.jsonl');
    writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const out = cli(['--file', f, '--today', '2026-11-13']).out;
    expect(out).toContain('## System-prompt cache keep-alive (C-05)');
    expect(out).toContain('| opus-5-5 | 1 | $0.0018 | 8813 |');
  });
});
