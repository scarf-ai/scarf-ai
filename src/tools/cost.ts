// Cost baseline (card C-01) — a table for the internal cost document:
//   npm run cost -- 2026-10-28                     (one UTC day, on the server)
//   npm run cost -- 2026-10-27 2026-10-29          (a period)
// On the server it reads server/data/review/<day>.jsonl, server/data/site.sqlite (asks) and server/data/agent.sqlite (llm_spend).
// Without the server — from files sent over:
//   npx tsx src/tools/cost.ts --file review-2026-10-27_2026-10-29.jsonl [--db cost-db.json] [day] [day]
//   cost-db.json — {"spend":[{day,model,usd}],"asks":[{ts,model,cost,reason}]} (an export from the databases; the command is in the internal cost document).
// --today YYYY-MM-DD — which day counts as current (default — today UTC; needed for checks).
// Prints Markdown to the console. Read-only: writes nothing and does not affect the agent.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { baseline, dayTotals, reconcile, splitDays, spendTotal, sumBuckets, mergeShadow, ideaFullDays, type Bucket, type DayCost, type SiteAsk, type SpendRow } from '../cost/baseline.js';
import { PRICES, PRICES_CHECKED } from '../llm/budget.js';
import { X_PRICES } from '../cost/xmeter.js';
import { SHADOW_IDEAS, shadowUsd } from '../cost/shadow.js';

const USAGE = 'Usage: npm run cost -- YYYY-MM-DD [YYYY-MM-DD]\n       npx tsx src/tools/cost.ts --file review.jsonl [--db cost-db.json] [YYYY-MM-DD [YYYY-MM-DD]]';
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
const isDay = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const args = process.argv.slice(2);
const files: string[] = []; let dbJson: string | undefined; const days: string[] = [];
let today = new Date().toISOString().slice(0, 10);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--file' || a === '--db' || a === '--today') {
    const v = args[++i];
    if (!v || v.startsWith('--')) fail(`${a} needs a value.\n${USAGE}`);
    if (a === '--file') files.push(v); else if (a === '--db') dbJson = v; else if (isDay(v)) today = v; else fail(`--today: a YYYY-MM-DD date is required, got «${v}».`);
  } else if (a.startsWith('--')) fail(`Unknown option ${a}.\n${USAGE}`);
  else days.push(a);
}
if (days.length > 2) fail(`There can be one or two dates (from and to), got ${days.length}: ${days.join(' ')}.\n${USAGE}`);
const [from, to = from] = days;
if (!from && !files.length) fail(USAGE);
for (const d of days) if (!isDay(d)) fail(`Invalid date "${d}": YYYY-MM-DD is required.\n${USAGE}`);
if (from && to < from) fail(`The period is reversed: ${from} is after ${to}.`);
const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
const notes: string[] = [];

// ---- reading ----
const dataDir = resolve(process.env.AGENT_ROOT ?? process.cwd(), process.env.AGENT_DATA_DIR ?? 'server/data');
const readText = (f: string) => {
  if (!existsSync(f)) fail(`No file ${f}.`);
  try { return readFileSync(f, 'utf8'); } catch (e) { return fail(`Cannot read ${f}: ${String((e as Error).message ?? e)}`); }
};
const rows: Record<string, unknown>[] = [];
let broken = 0;
const missingDays: string[] = [];
const readJsonl = (f: string) => {
  for (const line of readText(f).split('\n')) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line); if (typeof v === 'object' && v !== null && !Array.isArray(v)) rows.push(v); else broken++; } catch { broken++; }
  }
};
if (files.length) for (const f of files) readJsonl(f);
else for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400_000) {
  const f = join(dataDir, 'review', `${new Date(t).toISOString().slice(0, 10)}.jsonl`);
  if (existsSync(f)) readJsonl(f); else missingDays.push(f.slice(-16, -6));
}
// The log is kept for 30 days and started on 2026-10-28 — missing days in one line, not a list of files
if (missingDays.length) notes.push(`no log file for ${missingDays.length} day(s) (${missingDays.length > 3 ? `${missingDays[0]} … ${missingDays[missingDays.length - 1]}` : missingDays.join(', ')}) in ${join(dataDir, 'review')}`);
if (broken) notes.push(`broken log lines skipped: ${broken}`);

let asks: SiteAsk[] = []; let spend: SpendRow[] | undefined;
if (dbJson) {
  let j: any;
  try { j = JSON.parse(readText(dbJson)); } catch (e) { fail(`${dbJson}: not JSON (${String((e as Error).message ?? e)}).`); }
  if (typeof j !== 'object' || j === null || (j.asks !== undefined && !Array.isArray(j.asks)) || (j.spend !== undefined && !Array.isArray(j.spend))) fail(`${dbJson}: expected {"spend":[…],"asks":[…]}.`);
  asks = j.asks ?? []; spend = j.spend;
} else if (!files.length) {
  const { DatabaseSync } = await import('node:sqlite');
  const q = (file: string, sql: string) => {
    const p = join(dataDir, file);
    if (!existsSync(p)) { notes.push(`no database ${p}`); return undefined; }
    try { const db = new DatabaseSync(p, { readOnly: true }); try { return db.prepare(sql).all() as any[]; } finally { db.close(); } }
    catch (e) { notes.push(`${file}: ${String((e as Error).message ?? e)}`); return undefined; }
  };
  asks = (q('site.sqlite', 'SELECT ts, model, cost, reason FROM asks') ?? []) as SiteAsk[];
  spend = q('agent.sqlite', 'SELECT day, model, usd FROM llm_spend') as SpendRow[] | undefined;
}

const list = baseline(rows, asks, spend).filter(d => inRange(d.day));
if (!list.length) fail(`No data for ${from ?? 'all days'}${to && to !== from ? `…${to}` : ''}.${notes.length ? `\n${notes.join('\n')}` : ''}`);
const { full, excluded, noJournal } = splitDays(list, today);
const journalDays = list.filter(d => d.journalRows);

// ---- output ----
const $ = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.1 ? 4 : 2)}`;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
const short = (m: string) => m.replace('claude-', '');
const cell = (b: Bucket) => (b.n ? `${b.n} · ${$(b.usd)}` : '—');
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
const merge = (ds: DayCost[], pick: (d: DayCost) => Record<string, Bucket>) => {
  const m: Record<string, Bucket[]> = {};
  for (const d of ds) for (const [model, b] of Object.entries(pick(d))) (m[model] ??= []).push(b);
  return Object.entries(m).map(([model, bs]) => [model, sumBuckets(bs)] as const).sort((a, b) => b[1].usd - a[1].usd);
};
const out: string[] = [];
const period = `${list[0].day}${list.length > 1 ? ` … ${list[list.length - 1].day}` : ''}`;
out.push(`# SCARF costs — ${period} (UTC)`, '');
out.push(`Anthropic prices — \`src/llm/budget.ts\`, checked against platform.claude.com ${PRICES_CHECKED}: ${Object.entries(PRICES).map(([m, p]) => `${short(m)} input $${p.input} / 5-min write $${p.cacheWrite} / 1-h write $${p.cacheWrite1h} / read $${p.cacheRead} / output $${p.output}`).join('; ')} (per 1M tokens). twitterapi.io — ${X_PRICES.checked}.`, '');

out.push('## By day (with a review log)', '');
if (journalDays.length) {
  out.push('| Day | Total | Agent models | Analyses (n · $) | Haiku triage | Site | Haiku extraction (≤) | twitterapi.io | Messages / did not reach the model | In average |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  const why = new Map(excluded.map(e => [e.day.day, e.why]));
  for (const d of journalDays) {
    const t = dayTotals(d);
    out.push(`| ${d.day} | ${$(t.total)} | ${$(t.models)} | ${cell(t.analysis)} | ${cell(t.triage)} | ${cell(t.site)} | ${d.extract.n ? `${d.extract.n} · ≤${$(d.extract.usdMax)}` : '—'} | ${t.x === undefined ? 'no data' : $(t.x)} | ${d.messages} / ${d.skipped} | ${why.has(d.day) ? `no: ${why.get(d.day)}` : 'yes'} |`);
  }
  if (full.length) {
    const ts = full.map(dayTotals);
    const avg = (f: (t: ReturnType<typeof dayTotals>) => number) => $(ts.reduce((a, t) => a + f(t), 0) / full.length);
    const xd = ts.filter(t => t.x !== undefined);
    out.push(`| **Daily average** (${full.length} full) | **${avg(t => t.total)}** | ${avg(t => t.models)} | ${avg(t => t.analysis.usd)} | ${avg(t => t.triage.usd)} | ${avg(t => t.site.usd)} | | ${xd.length ? $(xd.reduce((a, t) => a + t.x!, 0) / xd.length) : 'no data'} | | |`);
  } else out.push('', 'No full days with a log — the daily average is not computed.');
} else out.push('There is no review log for these days.');
out.push('');

if (noJournal.length) {
  out.push('## Days without a review log', '', 'No log — what the model did is not visible; spend exists only in budget accounting and the site database. Not included in totals and the average.', '');
  out.push('| Day | llm_spend (agent models) | Site |', '|---|---|---|');
  for (const d of noJournal) out.push(`| ${d.day} | ${d.spendDb ? $(spendTotal(d)) : '—'} | ${cell(sumBuckets(Object.values(d.site)))} |`);
  out.push('');
}

out.push('## $ per analysis by model', '', `All days with a log (${journalDays.length}).`, '');
out.push('| Model | Analyses | Errors | Total | $ per successful analysis | $ per analysis incl. errors | Rounds per analysis |', '|---|---|---|---|---|---|---|');
const byModel = merge(journalDays, d => d.analysis);
const ok = (b: Bucket) => (b.n - b.errors ? $((b.usd - b.errorUsd) / (b.n - b.errors)) : '—');
for (const [m, b] of byModel) out.push(`| ${short(m)} | ${b.n} | ${b.errors} | ${$(b.usd)} | ${ok(b)} | ${$(b.usd / b.n)} | ${b.split ? (b.rounds / b.split).toFixed(1) : '—'} |`);
const msg = sumBuckets(journalDays.map(d => d.analysisKind.message)), chat = sumBuckets(journalDays.map(d => d.analysisKind.chat));
out.push('', `Single message: ${cell(msg)}${msg.n ? ` (${ok(msg)} per successful analysis)` : ''}. Chat batch: ${cell(chat)}${chat.n ? ` (${ok(chat)} per successful analysis)` : ''}.`, '');

out.push('## Analysis cost shares', '');
out.push('| Model | Input | Cache write | Cache read | Output | Does not match prices | No tokens | Tokens: input / write (of which 1 h) / read / output |', '|---|---|---|---|---|---|---|---|');
const shareRow = (name: string, b: Bucket) => out.push(`| ${name} | ${$(b.inUsd)} (${pct(b.inUsd, b.usd)}) | ${$(b.writeUsd)} (${pct(b.writeUsd, b.usd)}) | ${$(b.readUsd)} (${pct(b.readUsd, b.usd)}) | ${$(b.outUsd)} (${pct(b.outUsd, b.usd)}) | ${$(b.unexplainedUsd)} | ${$(b.noSplitUsd)} | ${k(b.input)} / ${k(b.cacheWrite)} (${k(b.cacheWrite1h)}) / ${k(b.cacheRead)} / ${k(b.output)} |`);
for (const [m, b] of byModel) shareRow(short(m), b);
if (byModel.length > 1) shareRow('**all**', sumBuckets(byModel.map(([, b]) => b)));
out.push('', 'Output includes the model\'s thinking. Cache write is the remainder after input, read and output, within the 5-min and 1-h write price bounds; "of which 1 h" — how many tokens were written for 1 hour (2× input instead of 1.25×). "Does not match prices" — what did not fit these bounds: prices were different at write time.', '');

const xs: Record<string, { calls: number; items: number; errors: number; usd: number; upperBound: boolean }> = {};
for (const d of journalDays) for (const [e, b] of Object.entries(d.x ?? {})) {
  const a = (xs[e] ??= { calls: 0, items: 0, errors: 0, usd: 0, upperBound: false });
  a.calls += b.calls; a.items += b.items; a.errors += b.errors; a.usd += b.usd; a.upperBound ||= b.upperBound;
}
out.push('## twitterapi.io', '');
if (Object.keys(xs).length) {
  out.push(`Days with the counter: ${journalDays.filter(d => d.x).length} of ${journalDays.length}. Failed calls are not priced — it is unknown whether twitterapi.io charges for them.`, '', '| Method | Calls | Records | Errors | $ (estimate) |', '|---|---|---|---|---|');
  for (const [e, b] of Object.entries(xs).sort((a, b) => b[1].usd - a[1].usd)) out.push(`| ${e} | ${b.calls} | ${b.upperBound ? `≤${b.items}` : b.items} | ${b.errors} | ${b.upperBound ? '≤' : ''}${$(b.usd)} |`);
} else out.push('No xapi events in the log: the `src/cost/xmeter.ts` counter is not wired yet. Spend for these days — only from the twitterapi.io dashboard.');
out.push('');

const shadow = Object.entries(mergeShadow(journalDays));
if (shadow.length) {
  // scarf-cost-gate: savings over the days the idea's shadow ran; not a single missed action without review
  out.push('## Shadow comparison of saving ideas', '', 'The old path worked as is; the new one only recorded what it would have done. "$ per day" — over full days since the idea\'s first event. Do not add up ideas: one analysis may fall under several ideas. The event format — section 2 of the internal cost document.', '');
  out.push('| Idea | Events | Would not call the model | Would save | Full days | $ per day | Missed act/watch | Verdicts of skipped | Text compaction |', '|---|---|---|---|---|---|---|---|---|');
  const warn: string[] = [];
  for (const [idea, b] of shadow.sort((a, c) => shadowUsd(c[1]) - shadowUsd(a[1]))) {
    const n = SHADOW_IDEAS[idea];
    const days = ideaFullDays(full, b);
    const perDay = days.reduce((a, d) => a + (d.shadow?.[idea] ? shadowUsd(d.shadow[idea]) : 0), 0);
    // Compaction does not skip the model: without inputUsd the saving cannot be estimated — "—", not $0
    const usdKnown = b.wouldSkip > 0 || b.compactUsd > 0;
    const usd = !usdKnown ? '—' : `${b.compactUsd ? '≈' : ''}${$(shadowUsd(b))}`;
    const verdicts = Object.entries(b.skippedVerdicts).sort((x, y) => y[1] - x[1]).map(([v, k]) => `${v} ${k}`).join(', ') || '—';
    const pct = b.charsBefore && b.charsAfter ? Math.round((b.charsAfter / b.charsBefore - 1) * 100) : undefined;
    const compact = !b.compactEvents ? '—' : `${b.charsBefore} → ${b.compactNoAfter === b.compactEvents ? '?' : b.charsAfter}${pct === undefined ? '' : ` (${pct > 0 ? '+' : '−'}${Math.abs(pct)}%)`}`;
    out.push(`| ${n ? `${n} · ${idea}` : `${idea} (unknown idea)`} | ${b.events} | ${b.wouldSkip} | ${usd} | ${days.length} | ${usdKnown && days.length ? $(perDay / days.length) : '—'} | ${b.missed ? `**${b.missed}**` : '0'} | ${verdicts} | ${compact} |`);
    if (b.missed) warn.push(`⚠ ${idea}: the new path would miss ${b.missed} action(s) (act/watch unlike the earlier verdict, or an unrecognized verdict) — per scarf-cost-gate the idea is not enabled until every case is reviewed.`);
    if (b.unrecognized) warn.push(`⚠ ${idea}: unrecognized events: ${b.unrecognized} — fields off-format (section 2 of the internal cost document), not included in the sums.`);
    if (b.duplicates) warn.push(`${idea}: repeats of the same event (idea, msgId, time) not counted: ${b.duplicates}.`);
    if (b.compactNoAfter) warn.push(`⚠ ${idea}: ${b.compactNoAfter} compaction events have no charsAfter — compaction is not computed for them.`);
    if (b.compactEvents && !b.compactUsd) warn.push(`${idea}: compaction without inputUsd — the $ saving cannot be estimated. Compaction quality is not checked by a shadow event: the same cases need a repeat analysis.`);
    if (!n) warn.push(`⚠ ${idea}: there is no such idea in section 7 of the internal cost document — check the name.`);
  }
  if (warn.length) out.push('', ...warn.map(w => `- ${w}`));
  out.push('');
}

const ka = merge(journalDays, d => d.keepalive);
if (ka.length) {
  out.push('## System-prompt cache keep-alive (C-05)', '', '`max_tokens: 0` pings when idle: extend the brief cache by 1 hour at the price of a read. Already included in "Agent models".', '');
  out.push('| Model | Pings | $ | Cache read, tokens |', '|---|---|---|---|');
  for (const [m, b] of ka) out.push(`| ${short(m)} | ${b.n} | ${$(b.usd)} | ${k(b.cacheRead)} |`);
  out.push('');
}

out.push('## Cross-check with budget accounting (llm_spend)', '');
const rec = journalDays.flatMap(d => reconcile(d).map(r => ({ day: d.day, ...r })));
if (rec.length) {
  out.push('| Day | Model | Review log | llm_spend | Difference |', '|---|---|---|---|---|');
  for (const r of rec) out.push(`| ${r.day} | ${short(r.model)} | ${$(r.journal)} | ${$(r.db)} | ${Math.abs(r.diff) < 0.001 ? 'matches' : $(r.diff)} |`);
} else out.push('No llm_spend data for the days with a log.');
out.push('');

const mismatch = journalDays.reduce((a, d) => a + d.priceMismatch, 0);
out.push('## What the log does not show', '');
out.push('- Haiku triage and the site: the log has only $, no tokens — shares are not computed for them.');
out.push('- Haiku extraction via the old path: the price is not written. The table shows an upper estimate: lines "budget spent → extraction" × $0.0004; after such a line the model may not be called at all.');
for (const e of excluded) out.push(`- ${e.day.day} is not in the average: ${e.why}.`);
if (mismatch > 0) out.push(`- Does not match prices by ${$(mismatch)}: prices at log time differed from those now in \`budget.ts\`.`);
for (const n of notes) out.push(`- ${n}`);
console.log(out.join('\n'));
