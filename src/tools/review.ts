// Export of the review log for a day or a period:
//   npm run review -- 2026-10-28                 (one UTC day)
//   npm run review -- 2026-10-27 2026-10-28      (period)
// Creates in server/data/review/:
//   review-<period>.md     — readable summary: numbers, each analysis (verdict, reasoning, tools, cost), trades and messages to the owner;
//   review-<period>.jsonl  — all records of the period in full (what the model saw, tool responses) — for a detailed review.
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = join(resolve(process.env.AGENT_ROOT ?? process.cwd(), process.env.AGENT_DATA_DIR ?? 'server/data'), 'review');
const [from, to = from] = process.argv.slice(2);
if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  console.error('Usage: npm run review -- YYYY-MM-DD [YYYY-MM-DD]'); process.exit(1);
}

const days: string[] = [];
for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400_000) days.push(new Date(t).toISOString().slice(0, 10));
const rows: any[] = [];
const rawLines: string[] = [];
for (const d of days) {
  const f = join(dir, `${d}.jsonl`);
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; rawLines.push(line); try { rows.push(JSON.parse(line)); } catch { /* broken line */ } }
}
if (!rows.length) { console.error(`No review records for ${from}${to !== from ? `..${to}` : ''} in ${dir}`); process.exit(1); }

const by = (k: string) => rows.filter(r => r.kind === k);
const count = <T,>(xs: T[], key: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const short = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const money = (n: number) => `$${n.toFixed(3)}`;

const msgs = by('message'), an = by('analysis'), tri = by('triage'), hard = by('hard_check'), tg = by('telegram');
const cost = an.reduce((a, r) => a + (r.costUsd ?? 0), 0) + tri.reduce((a, r) => a + (r.costUsd ?? 0), 0);
const period = `${from}${to !== from ? `_${to}` : ''}`;
const out: string[] = [];
out.push(`# Agent review log — ${from}${to !== from ? ` … ${to}` : ''} (UTC)`, '');
out.push('## Numbers', '');
out.push(`- Messages from the mirror: ${msgs.length}; analyzed by the model: ${an.length}; chat batch triages: ${tri.length}; filtered out by code: ${hard.length}.`);
out.push(`- Model spend: ${money(cost)} (analyses ${money(an.reduce((a, r) => a + (r.costUsd ?? 0), 0))}, triage ${money(tri.reduce((a, r) => a + (r.costUsd ?? 0), 0))}).`);
out.push(`- Analyses by model: ${count(an, r => `${String(r.model).replace('claude-', '')}`).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}.`);
out.push(`- Verdicts: ${count(an, r => String(r.verdict?.verdict ?? (r.error ? 'error' : '?'))).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}.`);
const avg = (m: string) => { const xs = an.filter(r => r.model === m); return xs.length ? money(xs.reduce((a, r) => a + (r.costUsd ?? 0), 0) / xs.length) : '—'; };
out.push(`- Average analysis cost: ${[...new Set(an.map(r => r.model))].map(m => `${String(m).replace('claude-', '')} ${avg(m)}`).join(', ') || '—'}.`);
out.push(`- Skips (why a message did not reach the model): ${count(msgs.filter(r => r.skipped), r => String(r.skipped).replace(/\d+(\.\d+)?/g, 'N').slice(0, 70)).slice(0, 12).map(([k, n]) => `${k} — ${n}`).join('; ') || '—'}.`, '');

out.push('## Model analyses', '');
for (const r of an) {
  const v = r.verdict ?? {};
  out.push(`### ${String(r.ts).slice(5, 16).replace('T', ' ')} · ${r.source ?? '?'} · ${String(r.model).replace('claude-', '')} → ${v.verdict ?? 'ERROR'}${v.confidence !== undefined ? ` (${v.confidence})` : ''} · ${money(r.costUsd ?? 0)}`);
  if (r.usage) out.push(`Tokens: rounds ${r.usage.rounds}, input ${r.usage.input}, cache write ${r.usage.cacheWrite}, cache read ${r.usage.cacheRead}, output ${r.usage.output}. Tool limit: ${r.toolBudget ?? '?'}.`);
  if (r.error) out.push(`**Error:** ${short(r.error, 400)}`);
  if (v.thesis) out.push(`**Thesis:** ${short(v.thesis, 1200)}`);
  if (v.risks?.length) out.push(`**Risks:** ${v.risks.map((x: string) => short(x, 200)).join('; ')}`);
  if (v.intents?.length) out.push(`**Actions:** ${v.intents.map((i: any) => `${i.kind} ${i.chain ?? ''} ${i.tokenAddress ?? i.contractAddress ?? i.collection ?? i.marketSlug ?? ''} — ${short(i.summary, 120)}`).join('; ')}`);
  if (v.publicNote) out.push(`**For X:** ${short(v.publicNote, 300)}`);
  for (const [i, t] of (r.trace ?? []).entries()) {
    for (const th of t.thinking ?? []) out.push(`> Reasoning (round ${i + 1}): ${short(th, 1500)}`);
    for (const tool of t.tools ?? []) if (tool.name !== 'emit_verdict') out.push(`- Tool \`${tool.name}\` ${short(JSON.stringify(tool.input), 160)} → ${short(tool.output, 600)}`);
  }
  out.push('');
}

if (hard.length) {
  out.push('## Filtered out by code (no model)', '');
  for (const r of hard) out.push(`- ${String(r.ts).slice(5, 16).replace('T', ' ')} · ${r.source} · ${r.verdict}: ${short(r.thesis, 300)}`);
  out.push('');
}
if (tri.length) {
  out.push('## Chat batch triage (Haiku)', '');
  for (const r of tri) out.push(`- ${String(r.ts).slice(5, 16).replace('T', ' ')} · ${r.channel} · ${r.error ? `error: ${short(r.error, 200)}` : `${r.result?.escalate ? 'to review' : 'nothing'} — ${short(r.result?.reason, 300)}`}`);
  out.push('');
}
out.push('## Telegram messages to the owner (trades, shadow, posts, errors)', '');
for (const r of tg) out.push(`- ${String(r.ts).slice(5, 16).replace('T', ' ')} ${short(String(r.text).replace(/<[^>]+>/g, ''), 500)}`);

const md = join(dir, `review-${period}.md`), js = join(dir, `review-${period}.jsonl`);
writeFileSync(md, out.join('\n'));
writeFileSync(js, rawLines.join('\n') + '\n');
console.log(`Done: ${md}\n        ${js}\n(${rows.length} records, analyses ${an.length}, spend ${money(cost)})`);
