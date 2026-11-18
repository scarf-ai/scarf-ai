// Shadow of saving ideas 1–4 (A-11, #82; the owner's decision 2026-11-11 ~08:00 UTC, Cost request #78). Agent behaviour does NOT
// change (except idea 2 recheck-gate — enabled 2026-11-17, see below): the old path works as is, and the new path's decision is written to the log as a cost_shadow event (counted by
// `npm run cost`). Each idea is enabled later by a separate card: shadow ≥ 2 days, a Cost report, the owner's "yes".
// Everything here is pure functions and log writes; a shadow failure never breaks an analysis.
import { review as reviewLog } from '../review/log.js';
import { prefilter } from '../extract/prefilter.js';

export type ShadowIdea = 'batch-dedup' | 'recheck-gate' | 'burst-merge' | 'batch-compact';
export interface CostShadow {
  idea: ShadowIdea;
  /** The new path would not have called the model. */ wouldSkip: boolean;
  /** What this analysis cost on the old path (it would be saved). */ costUsd: number;
  /** The old path's verdict — shows whether we would have missed an act. */ verdict?: string;
  /** batch-dedup: the coin's earlier verdict — a repeat act after act is not a "missed act" (for the Cost report #80). */ prevVerdict?: string;
  charsBefore?: number; charsAfter?: number; msgId?: string; reason?: string;
}

export function writeShadow(e: CostShadow): void {
  try { reviewLog.write('cost_shadow', { ...e, costUsd: Number((e.costUsd ?? 0).toFixed(5)) }); } catch (err) { console.error('cost shadow failed (journal)', err); }
}

// ---------------- 1. batch-dedup: a chat batch without new data would not go to the model ----------------
export interface CoinState { key: string; lastAnalysisMs?: number; lastTrust?: number; prevFdv?: number; fdv?: number; prevVerdict?: string }
/**
 * "New data" (one rule with A-09 item 1): the batch coin (address, collection) was not analysed in N h, or a more
 * trusted author writes (score ≥ 5 and above the previous one), or the market FDV changed twofold or more. None of these — the batch does not go to the model.
 * No coins in the batch — the rule does not apply (the batch goes to the model, as before).
 */
export function batchDedup(coins: CoinState[], maxTrust: number, nowMs: number, repeatHours: number): { wouldSkip: boolean; reason: string } {
  if (!coins.length) return { wouldSkip: false, reason: 'no coins in the batch' };
  for (const c of coins) {
    if (c.lastAnalysisMs === undefined) return { wouldSkip: false, reason: `new coin ${c.key}` };
    if (nowMs - c.lastAnalysisMs >= repeatHours * 3600_000) return { wouldSkip: false, reason: `${c.key} last analyzed ≥ ${repeatHours} h ago` };
    if (maxTrust >= 5 && maxTrust > (c.lastTrust ?? 0)) return { wouldSkip: false, reason: `new trusted author (${maxTrust} > ${c.lastTrust ?? 0}) on ${c.key}` };
    // FDV unknown (the token has no pair or base) — "unknown → model", the owner's rule. A collection has no FDV — not checked
    const token = c.key.startsWith('evm:') || c.key.startsWith('sol:');
    if (token && (!c.fdv || !c.prevFdv)) return { wouldSkip: false, reason: `FDV unknown on ${c.key}` };
    if (c.prevFdv && c.fdv && (c.fdv >= c.prevFdv * 2 || c.fdv <= c.prevFdv / 2)) return { wouldSkip: false, reason: `FDV ${Math.round(c.prevFdv)} → ${Math.round(c.fdv)} on ${c.key}` };
  }
  return { wouldSkip: true, reason: `all ${coins.length} coin(s) analyzed < ${repeatHours} h, no new trusted author, address or FDV ×2` };
}

// ---------------- 2. recheck-gate: a re-check goes to code first (ENABLED, no shadow) ----------------
/** Re-check reasons set by the analyst (router.ts, applyProjectVerdicts). Other reasons are set by code (mint phases). */
export const ANALYST_RECHECK = 'analyst re-check';
export const DEFAULT_RECHECK = 'watch without a time — default re-check in 60 min';
export const isAnalystRecheck = (reason?: string) => reason === ANALYST_RECHECK || reason === DEFAULT_RECHECK;
/**
 * The owner's decision 2026-11-17 ~22:20 UTC ("All at once"): enabled, no more shadow (cost_shadow events are not written).
 * (a) earlier verdict ignore — a re-check set by the analyst is not run (idea 2, approved 2026-11-12);
 * (b) earlier verdict act — same: the action is done (the code monitor manages the position) or blocked (no executor),
 *     a repeat model analysis changes nothing. New messages about the project are not a re-check and are analysed as usual.
 * Re-checks set by code (mint phases) and other verdicts go to the model, as before (on Sonnet, see router.ts).
 *
 * HQ clarification (trades must not be lost): act is skipped only if the last analysis's action was executed or
 * blocked by a missing executor (actSettled — a description, router.ts computes it from the analysis result, see actOutcome).
 * An act where decision code refused on market or risk (S-02, price, liquidity, size, limits) — the re-check goes to the model:
 * the analyst set it to enter later.
 */
export function recheckGate(lastVerdict: string | null | undefined, watchReason?: string, o: { actSettled?: string; byModel?: boolean } = {}): { skip: boolean; reason: string } {
  const analyst = isAnalystRecheck(watchReason);
  const { actSettled, byModel } = o;
  // an ignore from a hard code cut (no liquidity yet, etc.) does not cancel the analyst's re-checks (review R1)
  if (lastVerdict === 'ignore' && analyst && byModel) return { skip: true, reason: 'last verdict ignore: analyst re-check is not run' };
  if (lastVerdict === 'ignore' && analyst) return { skip: false, reason: 'ignore set by code (hard check) or source unknown — model as before' };
  if (lastVerdict === 'act' && analyst && actSettled) return { skip: true, reason: `last verdict act, ${actSettled}: analyst re-check is not run` };
  if (lastVerdict === 'act' && analyst) return { skip: false, reason: 'act, but the action was not done (market/risk skip or outcome unknown) — model as before' };
  if (lastVerdict === 'ignore' || lastVerdict === 'act') return { skip: false, reason: `${lastVerdict}, but the recheck was set by code (${watchReason ?? '?'}) — model as before` };
  return { skip: false, reason: `last verdict ${lastVerdict ?? 'none'} — model as before` };
}

/** Task actions: the executor issued a task card / started a session — a repeat analysis changes nothing. */
const TASK_ACTIONS = new Set(['dapp_session', 'social_session', 'notify_human']);
/** Entries with a position: the re-check is skipped only while the position is open (the code monitor manages it). */
const POSITION_ACTIONS = new Set(['buy_token', 'contract_call', 'nft_buy', 'open_perp', 'prediction_buy']);
/** An executor refusal "no executor" (live without an executor, no browser session, money on a site — E-13). */
const NO_EXECUTOR = /no live executor|no browser executor|\bE-13\b/i;
/** Reasons written by the model (thesis "analyst (…): …" / "analyst: …") are not code reasons: "no executor" is not searched in them (review R3). */
const MODEL_REASON = /^analyst\s*(\(|:)/i;
const noExecutor = (reasons: string[]) => reasons.some(r => !MODEL_REASON.test(r) && NO_EXECUTOR.test(r));
export type ActOutcome = 'task' | 'position' | 'no_executor' | 'open';
/**
 * The act outcome from the analysis decisions. If any decision was not executed for another reason (market, risk, scheduled, no decisions) —
 * 'open': a re-check is needed. Otherwise — a position (if there is an entry), a task or "no executor".
 */
export function actOutcome(decisions: { action: string; reasons: string[] }[]): ActOutcome {
  if (!decisions.length) return 'open';
  const kinds = decisions.map((d): ActOutcome => TASK_ACTIONS.has(d.action) ? 'task' : POSITION_ACTIONS.has(d.action) ? 'position'
    : (d.action === 'skip' || d.action === 'journal_only') && noExecutor(d.reasons) ? 'no_executor' : 'open');
  for (const k of ['open', 'position', 'task'] as const) if (kinds.includes(k)) return k;
  return 'no_executor';
}

// ---------------- 3. burst-merge: messages about one project within 2–3 minutes — one analysis ----------------
export const BURST_WINDOW_MS = 3 * 60_000;
/** The same project (address, collection, domain) already went to the model < 3 min ago — the new path would merge this message into that analysis. */
export function burstMerge(lastAnalysisMs: (number | undefined)[], nowMs: number, windowMs = BURST_WINDOW_MS): { wouldSkip: boolean; reason: string } {
  const recent = lastAnalysisMs.filter((t): t is number => t !== undefined && nowMs - t < windowMs && nowMs >= t);
  return recent.length
    ? { wouldSkip: true, reason: `same project analyzed ${Math.round((nowMs - Math.max(...recent)) / 1000)} s ago (window ${windowMs / 1000} s)` }
    : { wouldSkip: false, reason: 'no analysis of the same project in the window' };
}

// ---------------- 4. batch-compact: a compacted batch for Sonnet ----------------
/** Scanner bots by message author (people also write "MC 40k" and a DexScreener link — a text-based sign confused them, review #89 D4). */
export const SCANNER_BOT_AUTHORS = new Set(['rick', 'rickburpbot', 'serverb', 'bark', 'bark tools', 'phanes', 'maestro']);
/** A scanner-bot card: the author is a bot, the text has FDV/MC figures and DexScreener / pump.fun / t.me/rick links. */
export function isBotCard(text: string, author?: string): boolean {
  // The author is a bot, or a forwarded Rick card (signature t.me/rick?start=…): people do not write like that
  const bot = (!!author && SCANNER_BOT_AUTHORS.has(author.trim().toLowerCase())) || /t\.me\/rick\?start=/i.test(text);
  return bot && /\b(FDV|MC)\b\s*:?/.test(text) && /(dexscreener\.com|pump\.fun|t\.me\/rick|flap\.sh|birdeye\.so|gmgn\.ai)/i.test(text);
}
/** The coin address of a bot card is the first in the text; the others (holder wallets, pair, developer) are not coins. */
export function botCardExtraAddresses(messages: { msg: { text: string; author?: string } }[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) if (isBotCard(m.msg.text, m.msg.author)) {
    const p = prefilter(m.msg.text); const all = [...p.solanaMints, ...p.evmAddresses];
    const first = p.solanaMints[0] ?? p.evmAddresses[0];
    for (const a of all) if (a !== first) out.add(a.startsWith('0x') ? `evm:${a.toLowerCase()}` : `sol:${a}`);
  }
  return out;
}
/** Bot card → one data line: name/ticker, address (in full — the action is checked against it), FDV, liquidity, age, 1h. */
export function compactCard(text: string): string {
  const pick = (re: RegExp) => text.match(re)?.[1]?.trim();
  const name = pick(/\*\*\[([^\]]{1,60})\]/) ?? pick(/\$([A-Za-z][A-Za-z0-9]{1,15})\b/);
  const pre = prefilter(text);
  const addr = pre.solanaMints[0] ?? pre.evmAddresses[0];
  const fdv = pick(/FDV:\s*`?([^`\s⋅]+)`?/), liq = pick(/Liq:\s*`?([^`\s⋅]+)`?/), age = pick(/Age:\s*`?([^`\s⋅]+)`?/), h1 = pick(/1H:\s*`?[^`\s⋅]+`?\s*⋅\s*`?([^`\s]+)`?/);
  return ['bot card:', name, addr, fdv && `FDV ${fdv}`, liq && `Liq ${liq}`, age && `Age ${age}`, h1 && `1H ${h1}`].filter(Boolean).join(' ');
}
/** Batch → compacted: bot cards as one line each, repeated cards for the same address — only the last one. */
export function compactBatch<T extends { msg: { text: string; author?: string } }>(messages: T[]): T[] {
  const lastCardIdx = new Map<string, number>();
  messages.forEach((m, i) => { if (isBotCard(m.msg.text, m.msg.author)) { const p = prefilter(m.msg.text); const a = p.solanaMints[0] ?? p.evmAddresses[0]; if (a) lastCardIdx.set(a.toLowerCase(), i); } });
  return messages.flatMap((m, i) => {
    if (!isBotCard(m.msg.text, m.msg.author)) return [m];
    const p = prefilter(m.msg.text); const a = (p.solanaMints[0] ?? p.evmAddresses[0])?.toLowerCase();
    if (a && lastCardIdx.get(a) !== i) return [];
    return [{ ...m, msg: { ...m.msg, text: compactCard(m.msg.text) } }];
  });
}
