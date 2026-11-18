// Evaluation of rule A-05 on the review log: how many analyses "a repeat without new information" would cut (#64, HQ acceptance:
// "before—after" must be recomputed, not taken on trust).
//   npx tsx src/intel/repeatSim.ts server/data/review/review-2026-10-29_2026-11-10.jsonl
// Model: analyses in time order; an analysis is cut if all strong message keys (address, collection — as the current
// codeEntities sees them) were analysed < 24 h ago, the author is not higher than before by score (≥ 7) and the message is from a scanner bot. Scheduled re-checks
// are not counted (the rule does not touch them). Approximation: project history from the log, not the database; watch + a burst is not accounted for.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { codeEntities, isStrong, isScannerBotMessage } from './entities.js';
import { prefilter } from '../extract/prefilter.js';

/** A cut analysis: which verdict it actually ended with and whether there was an action (by the message line of the same msgId). */
export interface CutRow { ts: string; model: string; source: string; project: string; verdict: string; actions: string[] | null; costUsd: number }
export interface RepeatSim {
  total: Record<string, number>; cut: Record<string, number>; cutUsd: Record<string, number>;
  /** Cut analyses by final verdict (ignore / avoid / watch / act / error). */
  cutByVerdict: Record<string, number>;
  /** Every cut analysis; actions — decision actions other than skip/journal_only, null — no message line in the log. */
  cutRows: CutRow[];
}

export function simulateRepeats(jsonl: string, repeatHours = 24): RepeatSim {
  const rows = jsonl.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const an = rows.filter((r: any) => r.kind === 'analysis').sort((a: any, b: any) => String(a.ts).localeCompare(String(b.ts)));
  const last = new Map<string, { t: number; trust: number }>();
  const out: RepeatSim = { total: {}, cut: {}, cutUsd: {}, cutByVerdict: {}, cutRows: [] };
  // The analysis result is in the message line of the same msgId: the verdict after code (A-09) and the decisions
  const msgRows = new Map<string, any>(rows.filter((r: any) => r.kind === 'message' && r.msgId).map((r: any) => [String(r.msgId), r]));
  for (const r of an) {
    const model = String(r.model).replace('claude-', '').replace(/-5-5$/, '');
    out.total[model] = (out.total[model] ?? 0) + 1;
    if (String(r.trigger ?? '').startsWith('scheduled_recheck')) continue;
    const msg = String(r.case ?? '').match(/THE MESSAGE:\n<DATA_\w+>\n([\s\S]*?)\n<\/DATA_/)?.[1] ?? '';
    const strong = codeEntities(msg, prefilter(msg)).filter(isStrong).map(e => e.key);
    const t = Date.parse(r.ts); const trust = Number(r.trust ?? 0);
    // The rule is only for scanner-bot messages (acceptance #64, round 2); the author is the last part of source "server/#channel/author"
    const author = String(r.source ?? '').split('/').slice(2).join('/');
    const repeat = isScannerBotMessage(author, msg) && strong.length > 0 && strong.every(k => { const l = last.get(k); return !!l && t - l.t < repeatHours * 3600_000 && !(trust >= 7 && trust > l.trust); });
    if (repeat) {
      out.cut[model] = (out.cut[model] ?? 0) + 1; out.cutUsd[model] = Number(((out.cutUsd[model] ?? 0) + Number(r.costUsd ?? 0)).toFixed(4));
      const m = r.msgId !== undefined ? msgRows.get(String(r.msgId)) : undefined;
      const verdict = String(m?.analysis?.verdict ?? r.verdict?.verdict ?? (r.error ? 'error' : '?'));
      const actions = m ? (m.decisions ?? []).map((x: any) => String(x.action)).filter((a: string) => a !== 'skip' && a !== 'journal_only') : null;
      out.cutByVerdict[verdict] = (out.cutByVerdict[verdict] ?? 0) + 1;
      out.cutRows.push({ ts: String(r.ts), model, source: String(r.source ?? ''), project: String(r.verdict?.project?.name ?? strong[0] ?? '?'), verdict, actions, costUsd: Number(r.costUsd ?? 0) });
    }
    else for (const k of strong) last.set(k, { t, trust });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: npx tsx src/intel/repeatSim.ts <review-*.jsonl>'); process.exit(1); }
  const r = simulateRepeats(readFileSync(file, 'utf8'));
  console.log(`total analyses: ${JSON.stringify(r.total)}\nwould cut: ${JSON.stringify(r.cut)}\ncost of cut ones per log, $: ${JSON.stringify(r.cutUsd)}`);
  console.log(`cut by final verdict: ${JSON.stringify(r.cutByVerdict)}`);
  const noMsg = r.cutRows.filter(x => x.actions === null).length;
  if (noMsg) console.log(`no message line in the log (action unknown): ${noMsg}`);
  // The most expensive things the rule would cut: an act verdict or a real action — line by line
  const hot = r.cutRows.filter(x => x.verdict === 'act' || x.actions?.length);
  console.log(`cut with an act verdict or an action: ${hot.length}`);
  for (const x of hot) console.log(`  ${x.ts} · ${x.source || '?'} · ${x.project} · ${x.model} → ${x.verdict}${x.actions?.length ? ` · actions: ${x.actions.join(', ')}` : ''}`);
}
