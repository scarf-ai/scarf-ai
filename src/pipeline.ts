// Pipeline: message → prefilter → trust → extraction (LLM) → decision → log → execution.
import type { RawMessage, Intent } from './types.js';
import type { Store } from './store/db.js';
import type { TrustTable } from './trust/trust.js';
import { prefilter } from './extract/prefilter.js';
import { extractIntents, type ExtractDeps } from './extract/extract.js';
import { decide, type DecideDeps } from './decide/decide.js';
import type { Executor } from './exec/paper.js';
import type { Mode } from './config.js';
import { verdictCard } from './notify/telegram.js';
import { ModelPausedError, PAUSED_SKIP } from './llm/pause.js';
import { handleIntel, recheckDue, runScheduled, flushDueChatBatches, type IntelDeps } from './intel/router.js';

/** Rough model spend accounting: over the daily budget the LLM is called only for channels scored ≥ 7. */
export class BudgetMeter {
  private spent = new Map<string, number>();
  constructor(private dailyUsd: number, private day: () => string) {}
  add(usd: number) { const d = this.day(); this.spent.set(d, (this.spent.get(d) ?? 0) + usd); }
  today() { return this.spent.get(this.day()) ?? 0; }
  exceeded() { return this.today() >= this.dailyUsd; }
}
export const EST_EXTRACT_COST_USD = 0.0004; // Haiku 5.5: ~700 input tokens + ~200 output

export interface PipelineDeps {
  mode: Mode; store: Store; trust: TrustTable; extract: ExtractDeps; decide: DecideDeps; executor: Executor; budget: BudgetMeter;
  /** The opus/chat channel layer (analyst + gatekeeper). Without it — the old Haiku analysis for all channels. */
  intel?: IntelDeps;
  /** The old analysis (Haiku) — the fallback path when the analyst budget is spent. Filled in automatically. */
  legacy?: (raw: RawMessage) => Promise<HandleResult>;
  /** Messages to the owner outside executor cards (alarms from unverified sources). */
  notifier?: { send(t: string): Promise<void> };
  log?: (s: string) => void;
  /** A scheduled re-check produced an analysis: it can also produce an X thought (the owner 2026-11-11 17:30 UTC). */
  onRecheck?: (r: HandleResult) => Promise<void>;
  /**
   * Live (T-08): are entries open? false — until the startup reconciliation ends. Then tick does nothing: deferred actions, re-checks
   * and chat batches stay in the queue until the next minute instead of turning into a "reconciliation not finished" skip. Unset — always open.
   */
  entriesOpen?: () => boolean;
}

/** A "thought" for X (the owner 2026-10-24): what the agent noted, without the source. key — for repeats (one project — one thought per day). */
export interface Thought {
  key: string; subject: string; note: string; verdict: 'act' | 'watch'; chain?: string; holding: boolean; confidence: number;
  /** Where the note came from: publicNote — from the verdict; note_retry — from a repeat model request (A-08). note_retry is published only via the button (#86). */
  origin?: 'publicNote' | 'note_retry';
  /** The full contract address of the token the thought is about: from the project card or the intent, not from model text. Without it a token thought does not go out. */
  ca?: string;
  /** The project is a token (the project card has a ticker): the address is required even if the note writes the ticker without "$". */
  token?: boolean;
}

/**
 * The token address for a thought when the Analyst did not give one. Only an address from the card of THE SAME project the thought is about, and only if it is the only one there.
 * An address from the blacklist, from a scam warning or from any intent with a skip outcome is not published: the outcome cannot tell
 * "failed the token checks" from "expensive gas", so to be safe a thought about such a token does not go out until the Analyst gives the address.
 * The chain comes from the same address: sol: → solana; for EVM — from the intent with this address, otherwise no chain is written in the post.
 */
export function thoughtCa(r: HandleResult, cardKeys: string[], blacklisted: (a: string) => boolean): { ca: string; chain?: string } | undefined {
  const keys = cardKeys.filter(k => k.startsWith('evm:') || k.startsWith('sol:'));
  if (keys.length !== 1) return undefined;
  const sol = keys[0].startsWith('sol:'); const a = keys[0].slice(4);
  if (blacklisted(a)) return undefined;
  const same = r.decisions.filter(x => (x.intent.tokenAddress ?? x.intent.contractAddress)?.toLowerCase() === a.toLowerCase());
  // Only the intent type and constant decision-code strings — not analyst text ("not a scam" must not hide the address)
  if (same.some(x => x.action === 'skip' || x.intent.kind === 'warning' || x.reasons.some(s => /^(blacklisted |scam warning)/i.test(s)))) return undefined;
  const chain = sol ? 'solana' : same.map(x => x.intent.chain as string | undefined).find(c => !!c && c !== 'unknown' && c !== 'solana');
  return { ca: a, chain };
}

export interface HandleResult {
  skipped?: string;
  decisions: { action: string; reasons: string[]; intent: Intent }[];
  analysis?: { model: string; verdict: string; confidence: number; thesis: string; costUsd: number; batch?: number; stage?: 'triage'; thought?: Thought; risks?: string[] };
  exits?: string[];
}

/** Actions the executor itself sends nothing about to Telegram: they stay only in the review log and the service log. */
const QUIET_ACTIONS = new Set(['skip', 'journal_only']);

/** Actions without an X trade post — one set for postThought and router.ts (src/postActions.ts). */
export { NO_POST_ACTIONS, actedForPost } from './postActions.js';

/**
 * What to write under the "ACT" card when there is no action (T-06, the owner 2026-11-11: "there was no token buy, not even paper, nothing").
 * There is an action with its own executor card (trade, deferred, task) or the verdict is not act — undefined.
 * minBatchConfidence — the threshold below which a chat batch gets no actions (router.MIN_VERDICT_CONFIDENCE).
 */
export function actOutcome(r: Pick<HandleResult, 'skipped' | 'decisions' | 'analysis' | 'exits'>, minBatchConfidence?: number): string | undefined {
  if (r.analysis?.verdict !== 'act') return undefined;
  if (r.exits?.length) return undefined; // a position was closed by the verdict — the executor sent its own SELL card
  if (r.decisions.some(d => !QUIET_ACTIONS.has(d.action))) return undefined;
  if (!r.decisions.length) {
    if (r.skipped) return r.skipped;
    if (r.analysis.batch && minBatchConfidence !== undefined && r.analysis.confidence < minBatchConfidence) return `confidence ${r.analysis.confidence} is below ${minBatchConfidence} — no actions on a chat batch`;
    return 'the verdict has no action code can execute: the model did not name one, or the address is not in the source message (details in the server log)';
  }
  // The reason is the end of the list: the analyst's thesis is at the start, it is already in the card
  const why = [...new Set(r.decisions.map(d => d.reasons.filter(x => !x.startsWith('analyst (')).slice(-2).join('; ') || d.action))];
  return why.slice(0, 3).join(' · ').slice(0, 400);
}

export async function handleMessage(raw: RawMessage, d: PipelineDeps): Promise<HandleResult> {
  // Each message once (restarts, history + live messages at the seam)
  if (d.store.hasMessage(raw.id)) return { skipped: 'already processed', decisions: [] };
  d.store.saveMessage(raw);
  const mode = d.trust.channelMode(raw.sourceServer, raw.channel);
  if (mode === 'ignore') return { skipped: 'ignored channel', decisions: [] };
  const pre = prefilter(`${raw.text}\n${raw.replyToText ?? ''}`);
  const trust = d.trust.resolve(raw.sourceServer, raw.channel, raw.author, { compromisedSigns: pre.compromisedSigns });
  if (d.intel) {
    // Looks like an injection — not sent to any model
    if (pre.suspicious.length) { (d.log ?? (() => {}))(`suspicious message skipped: ${pre.suspicious.join('; ')}`); return { skipped: 'suspicious', decisions: [] }; }
    const dd: PipelineDeps = { ...d, legacy: (m) => legacyExtract(m, d) };
    return handleIntel(raw, mode, pre, trust, dd);
  }
  return legacyExtract(raw, d);
}

/** The old path: Haiku extracts intents from one message → decide. */
export async function legacyExtract(raw: RawMessage, d: PipelineDeps): Promise<HandleResult> {
  const log = d.log ?? (() => {});
  const pre = prefilter(`${raw.text}\n${raw.replyToText ?? ''}`);
  const preMain = prefilter(raw.text);
  const mainTextAddresses = new Set([...preMain.evmAddresses, ...preMain.solanaMints]);
  const trust = d.trust.resolve(raw.sourceServer, raw.channel, raw.author, { compromisedSigns: pre.compromisedSigns });
  if (preMain.isChatter && !raw.replyToText) return { skipped: 'chatter', decisions: [] };
  if (pre.isChatter) return { skipped: 'chatter', decisions: [] };
  // Looks like an injection — not sent to the model, log only
  if (pre.suspicious.length) { log(`suspicious message skipped: ${pre.suspicious.join('; ')}`); return { skipped: 'suspicious', decisions: [] }; }
  if (d.budget.exceeded() && trust.score < 7) return { skipped: `llm budget exceeded, trust ${trust.score} < 7`, decisions: [] };

  let ex;
  try { ex = await extractIntents(raw, pre, d.extract); }
  catch (e) {
    if (e instanceof ModelPausedError) return { skipped: PAUSED_SKIP, decisions: [] }; // no-credit pause (C-04): there was no call
    log(`extract failed: ${String(e)}`); return { skipped: 'extract failed', decisions: [] };
  }
  if (!ex.skippedLlm) d.budget.add(EST_EXTRACT_COST_USD);
  if (ex.dropped.length) log(`dropped from model output: ${ex.dropped.join('; ')}`);

  const out: HandleResult = { decisions: [] };
  for (const intent of ex.intents) {
    // If the model gave no address and the text has exactly one — take it (only a literal address from the text)
    if (intent.kind === 'token_call' && !intent.tokenAddress) {
      const all = [...preMain.solanaMints, ...preMain.evmAddresses];
      if (all.length === 1) intent.tokenAddress = all[0];
    }
    if ((intent.kind === 'contract_call' || intent.kind === 'mint') && !intent.contractAddress && preMain.evmAddresses.length === 1) intent.contractAddress = preMain.evmAddresses[0];
    const decision = await decide(intent, trust, pre, d.decide, { mainTextAddresses });
    const id = d.store.saveDecision(raw, decision, d.mode, d.decide.clock.iso());
    if (intent.kind === 'warning') for (const b of d.decide.blacklist.entries()) d.store.addBlacklist(b, d.decide.clock.iso());
    try { await d.executor.execute(raw, decision, id); }
    catch (e) {
      log(`execute failed: ${String(e)}`);
      decision.reasons.push(`execution blocked: ${String((e as Error).message ?? e)}`);
      decision.action = 'skip';
      d.store.updateDecision(id, decision.action, decision.reasons);
    }
    out.decisions.push({ action: decision.action, reasons: decision.reasons, intent });
  }
  return out;
}

/**
 * Sequential processing: messages are handled strictly one at a time, so two calls
 * of one token arriving at once do not open two positions or bypass limits.
 */
export function serialHandler(d: PipelineDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T,>(f: () => Promise<T>): Promise<T> => { const next = chain.then(f); chain = next.catch(() => undefined); return next; };
  const handle = (raw: RawMessage): Promise<HandleResult> => run(() => handleMessage(raw, d));
  /** Any other work that changes risk (the position monitor) goes into the same queue. */
  handle.exclusive = run;
  /** Re-checks and deferred actions go into the same queue as messages: no races over limits. */
  handle.tick = (): Promise<void> => run(async () => {
    if (!d.intel) return;
    if (d.entriesOpen && !d.entriesOpen()) { d.log?.('tick postponed: startup wallet reconciliation not finished'); return; }
    const dd: PipelineDeps = { ...d, legacy: (m) => legacyExtract(m, d) };
    const card = async (r: HandleResult, source: string) => {
      const t = r.analysis ? verdictCard({ ...r.analysis, source }) : undefined;
      if (t) await d.notifier?.send(t).catch(() => {});
    };
    for (const r of await recheckDue(dd)) if (r.analysis) { d.log?.(`recheck → ${r.analysis.verdict}: ${r.analysis.thesis.slice(0, 120)}`); await card(r, 'scheduled re-check'); await d.onRecheck?.(r).catch(e => d.log?.(`recheck thought: ${String(e)}`)); }
    for (const r of await runScheduled(dd)) d.log?.(`scheduled → ${r.action}`);
    for (const r of await flushDueChatBatches(dd)) if (r.analysis) { d.log?.(`chat batch (timer) → ${r.analysis.verdict} $${r.analysis.costUsd.toFixed(3)}`); await card(r, `chat batch (${r.analysis.batch} messages, by timer)`); }
  });
  return handle;
}
