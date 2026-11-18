// Analysis layer (the owner's decisions of 2026-10-22):
//  - opus-mode channels (alpha, core-calls, degen, member-calls, core-alpha, scan-feed): every substantive
//    message gets an analyst analysis (Opus; Sonnet for scan-feed), repeats of the same project are not analysed;
//  - chat-mode channels: the gatekeeper (code triggers + Haiku with context) decides whether to call the analyst;
//  - watch list: a project is re-checked on schedule (30 min before public, etc.) with fresh data.
// The analyst's verdict is a proposal. Code moves money: address checks, decide(), the risk gate.
import type { RawMessage, Prefiltered, TrustResult, Intent, Chain, NftPlan } from '../types.js';
import type { PipelineDeps, HandleResult, Thought } from '../pipeline.js';
import type { ContextWindows, WindowMsg } from '../context/window.js';
import type { ProjectCards } from './projects.js';
import type { GateConfig, TriggerHit } from '../gate/triggers.js';
import type { LlmBudget } from '../llm/budget.js';
import type { GateCaller, TriageOut } from '../gate/chatGate.js';
import { triageSystem, triageUser, validateTriage } from '../gate/chatGate.js';
import type { AnalystRunner, Verdict } from '../analyst/analyst.js';
import type { EnrichDeps, Dossier } from '../analyst/enrich.js';
import type { ChannelMode } from '../trust/trust.js';
import { codeEntities, nameKey, GENERIC_DOMAINS, baseDomain, notScannerBot, isStrong, isScannerBotMessage, type Entity, type EntityKind } from './entities.js';
import { writeShadow, batchDedup, recheckGate, burstMerge, compactBatch, botCardExtraAddresses, ANALYST_RECHECK, DEFAULT_RECHECK, actOutcome, type ActOutcome } from './costShadow.js';
import { computeTriggers, profileFor, topicsOf, NEGATIVE } from '../gate/triggers.js';
import { buildCaseText, buildBatchCaseText, parseVerdict, systemPrompt } from '../analyst/analyst.js';
import { randomBytes } from 'node:crypto';
import { buildDossier, verifyOfficialCa, cachedX, codeRejectsAll, resolveNameX, resolveCollectionsX, xHandlesOfMessage, withLimit } from '../analyst/enrich.js';
import type { ProjectX } from '../analyst/xresearch.js';
import { leaks, shortAddrs, CLAIMS_DONE, LOW_CONFIDENCE_BELOW, LOW_CONFIDENCE_NOTE, xLen } from '../posts/drafts.js';
import { nftRecheckTimes, nftMintRule } from '../analyst/opensea.js';
import { costUsd, CHAT_TAG, usageSummary } from '../llm/budget.js';
import { PAUSED_SKIP, type ModelPause } from '../llm/pause.js';
import { prefilter } from '../extract/prefilter.js';
import { validateIntents } from '../extract/extract.js';
import { decide } from '../decide/decide.js';
import { NO_POST_ACTIONS } from '../postActions.js';
import { haltReason } from '../risk/risk.js';
import { hardRejectReasons } from '../checks/hardcheck.js';
import { review as reviewLog } from '../review/log.js';
import { tierFor } from '../trust/trust.js';
import { utcMs } from '../time.js';

export interface IntelDeps {
  windows: ContextWindows;
  cards: ProjectCards;
  gateCfg: GateConfig;
  budget: LlmBudget;
  brief: string;
  gateCall?: GateCaller;
  /** Haiku: chat batch triage before Opus (decision 2026-10-23). None — the batch goes straight to the analyst. */
  triageCall?: GateCaller;
  runAnalyst?: AnalystRunner;
  enrich: EnrichDeps;
  /** Model per channel: "serverb/scan-feed" → claude-sonnet-5-5. */
  channelModel: Record<string, string>;
  /** The analyst's own finds from sources scored 0–3: off / paper only / everywhere (only with the owner's "yes"). */
  ownPicks: 'off' | 'paper' | 'on';
  /** A repeat of the same project is not analysed for N hours (if there is no new data). */
  repeatHours: number;
  /** A project with a watch verdict is re-checked on new buzz no more than once per N minutes. */
  watchRecheckMinutes: number;
  /** Chat channels: batch size (the owner's decision 2026-10-23: 50; Haiku first, then Opus). */
  chatBatchSize: number;
  /** Batch review after Haiku: the model (default Sonnet) and its own daily limit, USD (option 2, 2026-10-23). */
  chatReviewModel?: string;
  chatDailyUsd?: number;
  /** A batch that did not fill up still goes to the analyst after N minutes (if it has ≥ 5 messages; after 12 h — any). */
  chatMaxWaitMinutes: number;
  /** Model pause without Anthropic credits (C-04): during the pause the model is not called at all, messages go only to the log. */
  pause?: ModelPause;
}

/** The model may be called (no pause, or a probe just lifted it). Without a pause in the deps — always. */
const modelReady = (I: IntelDeps) => (I.pause ? I.pause.ready() : Promise.resolve(true));

const chatKey = (server: string, channel: string) => `${server.toLowerCase()}|${channel.toLowerCase()}`;

export const MIN_VERDICT_CONFIDENCE = 0.6;
/** The agent's own finds (a source without a score) — on paper — from the OWN_PICK_CONFIDENCE threshold (A-13 #105). */
export const OWN_PICK_CONFIDENCE = 0.65; // example value — set your own
/** Outside paper (live etc.) — its own, stricter threshold (acceptance #112, round 1). */
export const OWN_PICK_CONFIDENCE_LIVE = 0.85; // example value — set your own

/** Trivia: no entities or links, ≤ 3 words, no topic words ("gm", "lol", "ser 🔥"). */
export function isTrivial(text: string, pre: Prefiltered, entities: Entity[]): boolean {
  if (entities.length || pre.urls.length || pre.codeBlocks.length) return false;
  const clean = text.replace(/<a?:\w+:\d+>/g, ' ').replace(/[\p{Extended_Pictographic}\p{P}\p{S}]/gu, ' ').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  return words.length <= 3 && topicsOf(text).length === 0;
}

export function entityFromKey(key: string): Entity {
  const i = key.indexOf(':');
  const kind = key.slice(0, i) as EntityKind; const v = key.slice(i + 1);
  const display = kind === 'x' ? `@${v}` : kind === 'ticker' ? `$${v.toUpperCase()}` : v;
  return { kind, key, display };
}

const winToRaw = (w: WindowMsg, cur: RawMessage): RawMessage => ({ id: w.id, sourceServer: cur.sourceServer, channel: cur.channel, author: w.author, tsUtc: w.tsUtc, text: w.text, replyToText: w.replyToText });

/**
 * Where the action address comes from: the current message (or the quote it replies to), or a message above
 * the gatekeeper explicitly pointed to (refersTo). The whole window is not scanned: otherwise the address would be "credited" to whoever
 * wrote it first, even if they wrote "this is a scam".
 */
function findOrigin(intent: Intent, cur: RawMessage, window: WindowMsg[], refersTo: number[]): RawMessage {
  const target = intent.tokenAddress ?? intent.contractAddress;
  if (!target) return cur;
  const has = (t: string) => t.includes(target) || (target.startsWith('0x') && t.toLowerCase().includes(target.toLowerCase()));
  if (has(cur.text) || has(cur.replyToText ?? '')) return cur;
  const w = window.filter(w => refersTo.includes(w.idx)).reverse().find(x => has(x.text));
  return w ? winToRaw(w, cur) : cur;
}

/**
 * The score the action is executed with.
 *  - address in the message itself → the author's score;
 *  - address only in the quoted message being replied to → the replier's score if ≥ 7 (confirmation by a trusted author), otherwise no action;
 *  - address from a message above (via the gatekeeper's reference) → the replier's score if ≥ 7, otherwise the lower of the two.
 * Then the analyst's "own find" (memecoins only, confidence ≥ OWN_PICK_CONFIDENCE in paper mode and ≥ OWN_PICK_CONFIDENCE_LIVE otherwise, mode allowed) raises 0–3 to 4.
 */
function actionTrust(d: PipelineDeps, cur: RawMessage, curTrust: TrustResult, origin: RawMessage, intent: Intent, confidence: number): { trust: TrustResult; quoteEndorsed: boolean } {
  const I = d.intel!;
  const target = (intent.tokenAddress ?? intent.contractAddress ?? '').toLowerCase();
  let eff = curTrust; let quoteEndorsed = false;
  if (origin.id === cur.id) {
    if (target && !cur.text.toLowerCase().includes(target) && curTrust.score >= 7) { quoteEndorsed = true; eff = { ...curTrust, notes: [...curTrust.notes, 'trusted author endorses the quoted call'] }; }
  } else {
    const o = d.trust.resolve(origin.sourceServer, origin.channel, origin.author, { compromisedSigns: prefilter(origin.text).compromisedSigns });
    eff = curTrust.score >= 7 ? { ...curTrust, notes: [...curTrust.notes, `trusted author endorses ${origin.author}'s message`] }
      : (o.score <= curTrust.score ? o : { ...curTrust, notes: [...curTrust.notes, `lower of author ${curTrust.score} and origin ${o.score}`] });
  }
  const ownOk = I.ownPicks === 'on' || (I.ownPicks === 'paper' && d.mode === 'paper');
  if (eff.tier === 'journal' && ownOk && intent.kind === 'token_call' && confidence >= (d.mode === 'paper' ? OWN_PICK_CONFIDENCE : OWN_PICK_CONFIDENCE_LIVE) && !prefilter(origin.text).compromisedSigns.length && !curTrust.notes.some(n => n.includes('compromised')))
    eff = { score: 4, tier: tierFor(4), basis: eff.basis, notes: [...eff.notes, `analyst own pick (source trust ${eff.score}) → treated as 4, full checks`], ownPick: true, sourceScore: eff.score };
  return { trust: eff, quoteEndorsed };
}

// ------------------------------------------------------------------------------------------------
// Message intake: channel mode → gatekeeper → project card → repeat protection → analysis
// ------------------------------------------------------------------------------------------------
export async function handleIntel(raw: RawMessage, mode: ChannelMode, pre: Prefiltered & { compromisedSigns: string[] }, trust: TrustResult, d: PipelineDeps): Promise<HandleResult> {
  const I = d.intel!;
  // Model pause (C-04, the owner's decision 2026-11-08 15:45): no queue — the message goes only to the review log,
  // it does not enter the context window or the chat batch: after the pause the model sees only new messages
  if (!(await modelReady(I))) return { skipped: PAUSED_SKIP, decisions: [] };
  const clock = d.decide.clock;
  const log = d.log ?? (() => {});
  const now = clock.now();
  // A message from history: the window and "buzz" are computed as of the message itself, not as of the check
  const msgNow = raw.backfill && Number.isFinite(Date.parse(raw.tsUtc)) ? Date.parse(raw.tsUtc) : now;
  const window = I.windows.before(raw, msgNow);
  I.windows.add(raw);
  const fullText = `${raw.text}\n${raw.replyToText ?? ''}`;
  const mref = { server: raw.sourceServer, channel: raw.channel, author: raw.author, tsUtc: raw.tsUtc, id: raw.id };
  const mentionKind = /success|wins/i.test(raw.channel) ? 'success' : 'mention';
  const entities = codeEntities(fullText, pre, { parts: [raw.text, raw.replyToText ?? ''], scannerBot: isScannerBotMessage(raw.author, raw.text) });
  const profile = profileFor(I.gateCfg, raw.sourceServer);
  const heldKeys = heldKeysOf(d);
  I.cards.record(entities, mref, mentionKind); // the current message also counts towards "buzz"
  const tr = computeTriggers({ msg: raw, pre, trust, entities, profile, store: d.store, nowMs: msgNow, heldKeys });
  const triggers: TriggerHit[] = [...tr.hits];
  let gateNote: string | undefined;
  let refersTo: number[] = [];

  if (mode === 'opus') {
    if (isTrivial(raw.text, pre, entities)) { I.cards.observe(entities, mref, mentionKind, fullText, false, trust.score); return { skipped: 'trivial', decisions: [] }; }
    triggers.unshift({ name: 'alpha_channel', weight: 0, hard: true });
  } else {
    // Chat: messages accumulate in a batch (default 30), the analyst reviews the whole batch.
    // Immediately — only an alarm about something the agent holds (rug / exploit / dev sold next to our token).
    I.cards.observe(entities, mref, mentionKind, fullText, false, trust.score);
    if (!raw.text.trim()) return { skipped: 'empty', decisions: [] };
    const key = chatKey(raw.sourceServer, raw.channel);
    d.store.chatBufferAdd(key, raw);
    const urgent = tr.hits.some(h => h.name === 'held_position_negative');
    const n = d.store.chatBufferCount(key);
    if (urgent || n >= I.chatBatchSize) return analyzeChatBatch(key, urgent ? 'urgent: warning about a token we hold' : `batch of ${n}`, d, urgent);
    return { skipped: `chat: buffered ${n}/${I.chatBatchSize}`, decisions: [] };
  }

  // Project cards and repeat protection (a repeat scan of the same token is not analysed)
  const projectIds = I.cards.observe(entities, mref, mentionKind, fullText, false, trust.score);
  const urgent = triggers.some(t => t.name.startsWith('held_position_') && t.hard);
  const buzz = triggers.some(t => t.name.startsWith('buzz_'));
  if (projectIds.length && !urgent) {
    /** strongOnly: only strong keys (address, collection) count as new — a tweet's X author, a domain, a ticker do not make the project new. */
    const isFresh = (id: number, strongOnly = false) => {
      const card = I.cards.card(id);
      if (!card?.lastAnalysisUtc) return true;
      // A trusted author (≥ 7) above the one whose message was analysed before — analyse again
      if (trust.score >= 7 && trust.score > (card.lastTrust ?? 0)) return true;
      const ageMin = (now - utcMs(card.lastAnalysisUtc)) / 60_000;
      const newKeys = card.keys.filter(k => entities.some(e => e.key === k && (!strongOnly || isStrong(e))) && !card.analyzedKeys.includes(k) && !k.startsWith('name:'));
      // A factual code cut (honeypot, mint authority) does not change within a day — repeat only after 7 days
      if (card.lastVerdict === 'avoid' && card.lastThesis?.startsWith('Code check') && !newKeys.length && ageMin < 7 * 1440) return false;
      if (ageMin >= I.repeatHours * 60 || newKeys.length) return true;
      return card.lastVerdict === 'watch' && buzz && ageMin >= I.watchRecheckMinutes;
    };
    // The message's address/collection was already analysed and there is nothing new — weak keys (a tweet's X author in a bot card, domain,
    // ticker) do not make the message new, even when merged into the token card (A-05, log 29.10–10.11: a Rick card under a person's
    // call went to Opus a second time). The rule applies with any earlier verdict; exceptions — 24 h, an author scored higher than
    // before (≥ 7), watch with a burst, a new address/collection.
    const strongIds = d.store.projectIdsForKeys(entities.filter(isStrong).map(e => e.key)).filter(id => projectIds.includes(id));
    // Only for scanner-bot messages (the owner's decision 2026-11-10 12:19 UTC was about a bot repost): for a person, new @handles
    // and a project domain are new information, as before (acceptance #64, round 2: narrowed, no need to ask the owner)
    const weakOnly = isScannerBotMessage(raw.author, raw.text) && strongIds.length > 0 && !strongIds.some(id => isFresh(id, true));
    const fresh = weakOnly ? [] : projectIds.filter(id => isFresh(id));
    if (!fresh.length) {
      const c = I.cards.card(strongIds[0] ?? projectIds[0]);
      // "weak keys only" — rule A-05 fired (under the old rule the message would have gone to the model): counted separately in the log
      const byNewRule = weakOnly && projectIds.some(id => isFresh(id));
      return { skipped: `repeat${byNewRule ? ' (weak keys only)' : ''}: ${c?.name ?? 'project'} already analyzed (${c?.lastVerdict ?? '?'})`, decisions: [] };
    }
  }

  // Scanner channel (scan-feed): first a free market check by code, only live tokens go to the model
  if (I.gateCfg.scanChannels.includes(chatKey(raw.sourceServer, raw.channel).replace('|', '/'))) {
    const token = entities.find(e => e.kind === 'sol' || e.kind === 'evm');
    if (!token) return { skipped: 'scan without a token address', decisions: [] };
    const m = await d.decide.market.market(token.display).catch(() => undefined);
    const f = I.gateCfg.scanPrefilter; const why: string[] = [];
    if (!m?.priceUsd) why.push('no tradable pair');
    else {
      if ((m.liquidityUsd ?? 0) < f.minLiquidityUsd) why.push(`liquidity $${Math.round(m.liquidityUsd ?? 0)} < $${f.minLiquidityUsd}`);
      if ((m.buys24h ?? 0) < f.minBuys24h) why.push(`buys ${m.buys24h ?? 0} < ${f.minBuys24h}`);
      if ((m.sells24h ?? 0) < f.minSells24h) why.push('no sells (possible honeypot)');
      if (token.kind === 'sol' && !why.length) { const rug = await d.decide.market.rug('solana', token.display).catch(() => undefined); if (rug?.freezeOrMintAuthority) why.push('freeze/mint authority'); if (rug?.risk === 'high') why.push('rugcheck high'); }
      if (token.kind === 'evm' && !why.length && I.enrich.honeypot) { const hp = await I.enrich.honeypot(m.chain, token.display).catch(() => undefined); if (hp?.isHoneypot) why.push(`honeypot (${hp.reason ?? 'cannot sell'})`); else if ((hp?.sellTax ?? 0) >= 50) why.push(`sell tax ${hp!.sellTax}%`); }
    }
    if (why.length) {
      // To the log with a price: after 24 h it shows whether the filter dropped a "hidden gem"
      const intent: Intent = { kind: 'token_call', chain: m?.chain ?? (token.kind === 'sol' ? 'solana' : 'unknown'), tokenAddress: token.display, urls: [], summary: 'scan', stance: 'buy', confidence: 0 };
      d.store.saveDecision(raw, { action: 'journal_only', sizeUsd: 0, chain: intent.chain, trust, intent, reasons: [`scan prefilter (no model): ${why.join('; ')}`],
        check: m?.priceUsd ? { ok: false, chain: m.chain, address: token.display, priceUsd: m.priceUsd, reasons: why } : undefined }, d.mode, clock.iso());
      return { skipped: `scan prefilter: ${why.join('; ')}`, decisions: [] };
    }
  }

  // A-11 shadow (idea 3, burst-merge): the same project went to the model < 3 min ago — the new path would merge. Counted before the analysis
  const burst = (() => { try { return burstMerge(projectIds.map(id => { const c = I.cards.card(id); return c?.lastAnalysisUtc ? utcMs(c.lastAnalysisUtc) : undefined; }), now); } catch (e) { d.log?.(`cost shadow failed (burst-merge): ${String(e).slice(0, 160)}`); return undefined; } })();
  const res = await analyzeAndAct({ raw, mode, trust, triggers, gateNote, window, refersTo, entities, projectIds }, d);
  if (burst && res.analysis && res.analysis.model !== 'code') writeShadow({ idea: 'burst-merge', wouldSkip: burst.wouldSkip, costUsd: res.analysis.costUsd, verdict: res.analysis.verdict, msgId: raw.id, reason: burst.reason });
  return res;
}

function heldKeysOf(d: PipelineDeps): Set<string> {
  const heldKeys = new Set<string>();
  for (const p of d.decide.risk.positions) {
    const k = p.token.startsWith('nft:') ? `collection:${p.token.slice(4)}` : p.token.startsWith('0x') ? `evm:${p.token.toLowerCase()}` : `sol:${p.token}`;
    heldKeys.add(k);
    for (const id of d.store.projectIdsForKeys([k])) for (const kk of d.store.projectKeys(id)) heldKeys.add(kk);
  }
  return heldKeys;
}

/** kv key: the act outcome of the project's last analysis (survives a restart, like watch records). */
const actOutcomeKey = (projectId: number) => `act_outcome:p${projectId}`;
/**
 * The act outcome is recorded only for a single-project analysis (focus or the only one): in a multi-project analysis decisions
 * cannot be reliably tied to a project — no record, the re-check goes to the model (the safe side). The tie to the analysis is
 * by the card's verdict time: a later analysis without a record invalidates the old record.
 */
function saveActOutcome(d: PipelineDeps, projectIds: number[], focusProjectId: number | undefined, out: HandleResult) {
  const id = focusProjectId ?? (projectIds.length === 1 ? projectIds[0] : undefined);
  const card = id !== undefined ? d.intel!.cards.card(id) : undefined;
  if (!card || card.lastVerdict !== 'act' || !card.lastAnalysisUtc) return;
  try { d.store.kvSet(actOutcomeKey(card.id), JSON.stringify({ iso: card.lastAnalysisUtc, outcome: actOutcome(out.decisions) })); } catch { /* log */ }
}
/** The previous act's action was executed or blocked by a missing executor — a description; otherwise undefined (a re-check is needed). */
function actSettled(d: PipelineDeps, card: { id: number; keys: string[]; lastAnalysisUtc: string | null }): string | undefined {
  let rec: { iso?: string; outcome?: ActOutcome } | null = null;
  try { rec = JSON.parse(d.store.kvGet(actOutcomeKey(card.id)) ?? 'null'); } catch { return undefined; }
  if (!rec || !card.lastAnalysisUtc || rec.iso !== card.lastAnalysisUtc) return undefined;
  if (rec.outcome === 'task') return 'task action done (card issued / session started)';
  if (rec.outcome === 'no_executor') return 'action blocked: no executor';
  // Entry: skip only while the position is open (closed by a stop — the analyst may have set the re-check for a new entry)
  if (rec.outcome === 'position') { const held = heldKeysOf(d); return card.keys.some(k => held.has(k)) ? 'position open (the monitor manages it)' : undefined; }
  return undefined;
}
/** kv key: who set the card's last verdict — the model or code (hard cut). */
const verdictSrcKey = (projectId: number) => `verdict_src:p${projectId}`;
/**
 * The card's last verdict was set by the model (review A-recheck R1): an ignore from a hard code cut (no liquidity yet)
 * does not cancel the analyst's re-checks. No record (old cards) or a verdict of another analysis — "not the model" (the safe side).
 */
function verdictByModel(d: PipelineDeps, card: { id: number; lastAnalysisUtc: string | null }): boolean {
  try {
    const rec = JSON.parse(d.store.kvGet(verdictSrcKey(card.id)) ?? 'null') as { iso?: string; by?: string } | null;
    return !!rec && !!card.lastAnalysisUtc && rec.iso === card.lastAnalysisUtc && rec.by === 'model';
  } catch { return false; }
}

// ------------------------------------------------------------------------------------------------
// Watch-list re-check (without a new message): the original message + a fresh dossier
// ------------------------------------------------------------------------------------------------
export async function recheckDue(d: PipelineDeps): Promise<HandleResult[]> {
  const I = d.intel!;
  const out: HandleResult[] = [];
  if (!(await modelReady(I))) {
    // During a pause scheduled re-checks are dropped, not accumulated: after the pause they would all hit the model at once
    const due = d.store.dueWatch(d.decide.clock.iso());
    for (const w of due) d.store.doneWatch(w.id);
    if (due.length) d.log?.(`${due.length} scheduled recheck(s) dropped: ${PAUSED_SKIP}`);
    return out;
  }
  for (const w of d.store.dueWatch(d.decide.clock.iso())) {
    d.store.doneWatch(w.id);
    const m = d.store.message(w.msg_id);
    const card = I.cards.card(w.project_id);
    if (!m || !card) continue;
    const purged = !m.text;
    const raw: RawMessage = { id: m.id, sourceServer: m.server, channel: m.channel, author: m.author, tsUtc: m.ts_utc, text: m.text || `(original text purged) project ${card.name}` };
    const wpre = prefilter(raw.text);
    const trust = d.trust.resolve(m.server, m.channel, m.author, { compromisedSigns: wpre.compromisedSigns });
    // Entities — only from the original message text (other people's messages may have extended the card).
    // Card keys without addresses/collections (ticker, domain, X) — for context only.
    const own = codeEntities(raw.text, wpre);
    const context = card.keys.map(entityFromKey).filter(e => !own.some(o => o.key === e.key) && !['evm', 'sol', 'collection', 'me_collection'].includes(e.kind));
    // Idea 2 (recheck-gate) is enabled (the owner 2026-11-17 ~22:20 UTC): with an earlier ignore/act verdict, the model does not run a re-check
    // set by the analyst. The record is already marked done (doneWatch above) — it does not accumulate
    const gate = recheckGate(card.lastVerdict, w.reason, { actSettled: card.lastVerdict === 'act' ? actSettled(d, card) : undefined, byModel: verdictByModel(d, card) });
    if (gate.skip) {
      d.log?.(`scheduled recheck skipped (no model): project ${card.name} (#${w.project_id}), last verdict ${card.lastVerdict}, reason «${w.reason}» — ${gate.reason}`);
      reviewLog.write('recheck_skipped', { msgId: m.id, projectId: w.project_id, project: card.name, lastVerdict: card.lastVerdict, watchReason: w.reason, reason: gate.reason });
      out.push({ skipped: `recheck skipped: ${gate.reason}`, decisions: [] });
      continue;
    }
    const res = await analyzeAndAct({ raw, mode: d.trust.channelMode(m.server, m.channel) === 'opus' ? 'opus' : 'chat', trust,
      triggers: [{ name: 'scheduled_recheck', weight: 0, hard: true, detail: w.reason }], window: [], refersTo: [], entities: [...own, ...context], projectIds: [w.project_id], focusProjectId: w.project_id,
      noActions: purged }, d);
    out.push(res);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Analyst analysis and actions on the verdict
// ------------------------------------------------------------------------------------------------
interface CaseCtx {
  raw: RawMessage; mode: ChannelMode; trust: TrustResult; triggers: TriggerHit[]; gateNote?: string;
  window: WindowMsg[]; refersTo: number[]; entities: Entity[]; projectIds: number[]; focusProjectId?: number;
  /** The original message text is erased — the analysis is for the log only, no actions. */
  noActions?: boolean;
}

/**
 * The "trusted caller" threshold for a handle from a message (review A-handles R3): score ≥ 7 — trust tier tierFor 'fast', the same
 * one router already uses to mark a "trusted author" (endorsing someone else's call, Haiku extraction when the budget is spent).
 */
export const DISCORD_HANDLE_MIN_TRUST = 7;
/**
 * "discord" candidates (option 1): @handles and x.com links only from the message's OWN text — without the reply (replyToText),
 * without embed cards (intake appends them after "\n---\n", normalize.ts) and not from scanner bots; the author is a trusted caller
 * (score ≥ DISCORD_HANDLE_MIN_TRUST, not "careful"). Otherwise — empty. Chat batches never come here.
 */
export function discordHandles(raw: RawMessage, trust: TrustResult): string[] {
  if (!(trust.score >= DISCORD_HANDLE_MIN_TRUST) || trust.careful || isScannerBotMessage(raw.author, raw.text)) return [];
  const own = raw.text.split('\n---\n')[0] ?? '';
  return codeEntities(own, prefilter(own), { parts: [own], scannerBot: false }).filter(e => e.kind === 'x').map(e => e.display.replace(/^@/, ''));
}

async function analyzeAndAct(c: CaseCtx, d: PipelineDeps): Promise<HandleResult> {
  const I = d.intel!;
  const clock = d.decide.clock;
  const log = d.log ?? (() => {});
  const now = clock.now();
  const { raw, trust, window, refersTo, entities, projectIds } = c;
  const pre = prefilter(`${raw.text}\n${raw.replyToText ?? ''}`);

  // A pause may have started during processing (a triage or earlier analysis failure) — do not call the model, Haiku included
  if (I.pause?.paused()) return { skipped: PAUSED_SKIP, decisions: [] };
  // Model: by channel (scan-feed → Haiku) and by remaining budget
  const channelPref = I.channelModel[`${raw.sourceServer.toLowerCase()}/${raw.channel.toLowerCase()}`];
  // A scheduled re-check runs on Sonnet instead of Opus (the owner 2026-11-17 ~22:20 UTC); a channel with a cheaper model (Haiku) stays as it was.
  // Sonnet budget spent — the usual pickAnalyst path by channel (Opus, if available), as before the saving (review R2)
  const isRecheck = c.triggers.some(t => t.name === 'scheduled_recheck');
  const preferred = isRecheck && channelPref !== I.budget.caps.gateModel ? I.budget.caps.fallbackModel : channelPref;
  const model = I.budget.pickAnalyst(preferred) ?? (preferred !== channelPref ? I.budget.pickAnalyst(channelPref) : undefined);
  if (!model || !I.runAnalyst) {
    if (!c.focusProjectId && trust.score >= 7 && d.extract.callModel && d.legacy) { log('analyst budget exhausted → Haiku extraction for trusted source'); return d.legacy(raw); }
    return { skipped: 'analyst budget exhausted (journal only)', decisions: [] };
  }

  // Dossier: market, RugCheck, OpenSea, X, domain age, website text
  const refWin = window.filter(w => refersTo.includes(w.idx));
  const allUrls = [...pre.urls, ...refWin.flatMap(w => prefilter(w.text).urls)];
  const projectUrls = allUrls.filter(u => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return !GENERIC_DOMAINS.has(h) && !GENERIC_DOMAINS.has(baseDomain(h)); } catch { return false; } });
  // Hard cut: empty liquidity — only for a source scored ≤ 6. One value for the dossier (A-16) and for the cut below
  const strictLiquidity = trust.score <= 6;
  const dossier: Dossier = await buildDossier({
    tokens: entities.filter(e => e.kind === 'evm' || e.kind === 'sol').map(e => e.display),
    domains: entities.filter(e => e.kind === 'domain').map(e => e.display),
    xHandles: entities.filter(e => e.kind === 'x').map(e => e.display.replace(/^@/, '')),
    urls: projectUrls, tickers: entities.filter(e => e.kind === 'ticker').map(e => e.display.replace(/^\$/, '')),
    collections: entities.filter(e => e.kind === 'collection').map(e => e.display),
    predictions: entities.filter(e => e.kind === 'polymarket').map(e => e.display),
    text: `${raw.text}\n${raw.replyToText ?? ''}`,
    // A-16: the same cut rule as below (strictLiquidity at score ≤ 6) — cut tokens get no follower check
    hardCheck: { strictLiquidity }, discordX: discordHandles(raw, trust),
    log: { msgId: raw.id, source: `${raw.sourceServer}/#${raw.channel}/${raw.author}`, trust: trust.score, trigger: c.triggers.map(t => t.name).join(',') },
  }, I.enrich);
  const allowedUrls = new Set([...allUrls, ...window.flatMap(w => prefilter(w.text).urls), ...dossier.pages.flatMap(p => [p.url, ...(p.links ?? [])]), ...dossier.x.flatMap(x => x.bioUrls ?? []), ...dossier.nft.map(n => `https://opensea.io/collection/${n.slug}`)]);
  // A low-score source (bot card, random member): do not filter out, research it yourself with maximum skepticism
  // (the owner's decision 2026-10-23). For comparison — what is trending now on the token's chain and in our communities.
  const research = trust.score <= LOW_TRUST_RESEARCH && !trust.careful && dossier.tokens.length > 0;
  // Narrative: what is rising on the token's chain and what our communities discuss — for any token (the owner 2026-10-27; 10 min cache, free)
  if (dossier.tokens.length > 0) {
    const chain = dossier.tokens.find(t => t.chain !== 'unknown')?.chain ?? dossier.tokens[0].chain;
    const mt = I.enrich.trends ? await I.enrich.trends.trends(chain).catch(e => { dossier.errors.push(`trends: ${String(e).slice(0, 80)}`); return undefined; }) : undefined;
    dossier.trends = { ...(mt ?? { chain, trendingPools: [], boosted: [] }), communities: d.store.topMentions(new Date(now - 86400_000).toISOString(), 10) };
  }

  // Hard code cuts (option 2, 2026-10-27): all message tokens are honeypot / mint authority / empty liquidity,
  // and the message has nothing else (NFT, prediction markets) → no model, with the reason in the log
  // The condition is the same function the dossier uses to decide "no follower check" (A-16): one rule for both places
  if (codeRejectsAll(dossier, strictLiquidity)) {
    const hard = dossier.tokens.map(t => hardRejectReasons(t, { strictLiquidity }));
    const verdictKind = hard.some(h => h!.verdict === 'avoid') ? 'avoid' : 'ignore';
    const thesis = `Code check (no model): ${dossier.tokens.map((t, i) => `${t.market?.symbol ? `$${t.market.symbol}` : t.address.slice(0, 8)}: ${hard[i]!.reasons.join('; ')}`).join(' | ')}`;
    const v = parseVerdict({ verdict: verdictKind, thesis, confidence: 1 }).verdict!;
    d.store.saveAnalysis({ iso: clock.iso(), msgId: raw.id, projectId: c.focusProjectId ?? projectIds[0], model: 'code', trigger: 'hard_check', verdict: verdictKind, confidence: 1, json: { thesis, hard }, costUsd: 0 });
    applyProjectVerdicts(d, v, projectIds, entities.map(e => e.key), raw.id, trust.score, c.focusProjectId, true, 'code');
    reviewLog.write('hard_check', { msgId: raw.id, source: `${raw.sourceServer}/#${raw.channel}/${raw.author}`, verdict: verdictKind, thesis, tokens: dossier.tokens.map(t => ({ address: t.address, chain: t.chain, market: t.market, rug: t.rug, honeypot: t.honeypot })) });
    return { decisions: [], analysis: { model: 'code', verdict: verdictKind, confidence: 1, thesis, costUsd: 0 } };
  }

  // Code sets watches for mint phases without waiting for the model
  for (const n of dossier.nft) {
    const pid = d.store.projectIdsForKeys([`collection:${n.slug.toLowerCase()}`])[0];
    if (pid) for (const t of nftRecheckTimes(n, now)) d.store.addWatch(pid, raw.id, t.atUtc, t.reason);
  }

  const since24h = new Date(now - 86400_000).toISOString();
  const projects = projectIds.slice(0, 4).filter(id => I.cards.card(id)).map(id => {
    const card = I.cards.card(id)!;
    return { name: `${card.name} [keys: ${card.keys.join(', ')}]`, mentions: d.store.mentionStats(card.keys, since24h), lastVerdict: card.lastVerdict, lastThesis: card.lastThesis, lastAnalysisUtc: card.lastAnalysisUtc, lastNote: lastNoteOf(d, `p${id}`) };
  });
  const risk = d.decide.risk;
  const recheck = c.triggers.some(t => t.name === 'scheduled_recheck');
  const { text: user } = buildCaseText({ recheck,
    msg: raw, trust, channelMode: c.mode === 'opus' ? 'opus' : 'chat', triggers: c.triggers.map(t => t.detail ? `${t.name} (${t.detail})` : t.name), gateNote: c.gateNote,
    window, projects, dossier, nowIso: clock.iso(), research, toolBudget: toolBudget(model, research),
    portfolio: { equityUsd: risk.equityUsd, cashUsd: risk.cashUsd, positions: risk.positions.map(p => ({ token: p.token, chain: p.chain, costUsd: p.costUsd })), halted: haltReason(d.decide.cfg, risk) ?? undefined },
  });

  const opened = new Set<string>();
  const exec = makeExec(d, allowedUrls, now, opened);
  const r = await runVerdict(d, model, user, exec, undefined, toolBudget(model, research), { msgId: raw.id, source: `${raw.sourceServer}/#${raw.channel}/${raw.author}`, trigger: c.triggers.map(t => t.name).join(','), trust: trust.score });
  const verdict = r.verdict; const cost = r.cost;
  if (verdict) stabilizeVerdict(d, verdict, projectIds, c.focusProjectId);
  const trig = c.triggers.map(t => t.name).join(',');
  if (!verdict) {
    d.store.saveAnalysis({ iso: clock.iso(), msgId: raw.id, projectId: projectIds[0], model, trigger: trig, verdict: 'error', confidence: 0, json: { toolCalls: r.toolCalls }, costUsd: cost });
    return { skipped: I.pause?.paused() ? PAUSED_SKIP : 'analyst error', decisions: [] };
  }
  d.store.saveAnalysis({ iso: clock.iso(), msgId: raw.id, projectId: c.focusProjectId ?? projectIds[0], model, trigger: trig, verdict: verdict.verdict, confidence: verdict.confidence, json: { ...verdict, toolCalls: r.toolCalls, usage: r.usage }, costUsd: cost });
  applyProjectVerdicts(d, verdict, projectIds, entities.map(e => e.key), raw.id, trust.score, c.focusProjectId);

  applyNftMintRule(d, verdict, dossier, raw);
  if (verdict.verdict !== 'act') journalPassed(d, verdict, dossier, () => ({ raw, trust }));
  const out: HandleResult = { decisions: [], analysis: { model, verdict: verdict.verdict, confidence: verdict.confidence, thesis: verdict.thesis, costUsd: cost, risks: verdict.risks } };
  await handleExits(d, verdict, () => trust.score, out);
  // No early returns (main): the X thought is set even after an act without an action (A-08)
  if (verdict.verdict === 'act') {
    if (c.noActions) out.skipped = 'original text purged — journal only';
    else if (verdict.confidence < MIN_VERDICT_CONFIDENCE) { out.skipped = `analyst confidence ${verdict.confidence} < ${MIN_VERDICT_CONFIDENCE}`; actSkip(d, out, verdict, `act verdict with confidence ${verdict.confidence} < ${MIN_VERDICT_CONFIDENCE} — no action`); }
    else await actOnIntents(d, verdict, model, dossier, out, (proposed) => {
      const origin = findOrigin(proposed, raw, window, refersTo);
      return { origin, cur: raw, resolveTrust: (intent: Intent) => actionTrust(d, raw, trust, origin, intent, verdict.confidence) };
    });
    saveActOutcome(d, projectIds, c.focusProjectId, out);
  }
  // The X thought goes last: exits and trades wait neither for a repeat note request nor for anything else (blocker 3, round 1 A-08)
  await attachThoughts(d, out, verdict, projectIds, { model, focusProjectId: c.focusProjectId, dossier, backfill: raw.backfill, recheck, sourceNames: [raw.sourceServer, raw.channel, raw.author, ...d.store.sourceNames()],
    collections: [...entities.filter(e => e.kind === 'collection').map(e => e.display), ...opened], msgX: discordHandles(raw, trust) });
  return out;
}

/**
 * NFT mint by numbers: in the public window code itself adds a mint if the OpenSea numbers show a profit.
 * The model can only forbid it (verdict avoid). Limit — 1 piece (the per-wallet public limit), size — the risk gate.
 */
/** Skipped tokens go to the log with a price: after 24 h the report shows what rose while the analyst passed. */
function journalPassed(d: PipelineDeps, verdict: Verdict, dossier: Dossier, rawFor: (address: string) => { raw: RawMessage; trust: TrustResult } | undefined) {
  for (const t of dossier.tokens) {
    if (!t.market?.priceUsd) continue;
    const src = rawFor(t.address);
    if (!src) continue;
    const { raw, trust } = src;
    const intent: Intent = { kind: 'token_call', chain: t.chain, tokenAddress: t.address, urls: [], summary: verdict.project.name ?? 'token', stance: 'buy', confidence: 0 };
    d.store.saveDecision(raw, { action: 'journal_only', sizeUsd: 0, chain: t.chain, trust, intent,
      reasons: [`analyst verdict ${verdict.verdict}: ${verdict.thesis.slice(0, 200)}`],
      check: { ok: false, chain: t.chain, address: t.address, priceUsd: t.market.priceUsd, liquidityUsd: t.market.liquidityUsd, fdvUsd: t.market.fdvUsd, reasons: [] } }, d.mode, d.decide.clock.iso());
  }
}

function applyNftMintRule(d: PipelineDeps, verdict: Verdict, dossier: Dossier, raw: RawMessage) {
  const R = d.decide.cfg.nftAutoMint;
  if (!R.enabled || verdict.verdict === 'avoid') return;
  for (const n of dossier.nft) {
    if (!n.contract) continue;
    const rule = nftMintRule(n, d.decide.clock.now(), R);
    if (!rule.inWindow) continue;
    (d.log ?? (() => {}))(`nft rule ${n.slug}: ${rule.ok ? 'MINT' : 'skip'} — ${rule.facts}${rule.why.length ? ` (${rule.why.join('; ')})` : ''}`);
    if (!rule.ok) continue;
    if ((verdict.intents as Intent[]).some(i => (i.kind === 'mint' || i.kind === 'contract_call') && i.contractAddress?.toLowerCase() === n.contract!.toLowerCase())) continue;
    const pub = n.derived.publicStage!;
    (verdict.intents as Intent[]).push({ kind: 'mint', chain: (n.chain as Chain) ?? 'ethereum', contractAddress: n.contract, urls: [], stance: 'buy', confidence: 0.8,
      summary: `Public mint of ${n.name ?? n.slug} (code rule)`, deadlineUtc: utcMs(pub.startUtc) > d.decide.clock.now() ? pub.startUtc : undefined });
    verdict.verdict = 'act';
    verdict.confidence = Math.max(verdict.confidence, 0.7);
    verdict.thesis = `Code rule: ${rule.facts}. ${verdict.thesis}`.slice(0, 800);
    if (!verdict.nftPlan) verdict.nftPlan = { style: (n.derived.floorToBreakEven ?? 0) >= 3 ? 'hold' : 'flip', targetMultiple: 2 };
    void raw;
  }
}

// ------------------------------------------------------------------------------------------------
// Shared analysis parts: tools, model call, project verdicts, exits, action execution
// ------------------------------------------------------------------------------------------------
/** Collection slug from an OpenSea link (opensea.io/collection/<slug>). */
const openseaSlug = (u: string) => u.match(/^https?:\/\/(?:www\.)?opensea\.io\/collection\/([a-z0-9-]+)/i)?.[1]?.toLowerCase();
/**
 * opened — receives the slugs of collections whose OpenSea pages the analyst opened with a tool (fetch_page / browse_site) during
 * the analysis: their X from the OpenSea page also goes into the post (attachThoughts → resolveCollectionsX).
 */
function makeExec(d: PipelineDeps, allowedUrls: Set<string>, now: number, opened?: Set<string>) {
  const I = d.intel!;
  const noteOpened = (u: string) => { const s = openseaSlug(u); if (s && opened) opened.add(s); };
  return async (name: string, input: any): Promise<string> => {
    switch (name) {
      case 'get_market': return JSON.stringify(await d.decide.market.market(String(input.address)) ?? 'no pair found');
      // A check failure is kept apart from "no": "could not check" is not an argument against the project (OOLONG 2026-10-27)
      case 'x_profile': {
        if (!I.enrich.x) return 'X data not configured';
        if (!notScannerBot(String(input.handle))) return 'scanner bot account (posts token cards automatically), not a project — not looked up';
        const p = await cachedX(I.enrich.x, I.enrich.now ?? Date.now).profile(String(input.handle).replace(/^@/, '')).catch(e => ({ error: String((e as Error).message ?? e).slice(0, 120) }));
        return p && 'notFound' in p && p.notFound ? 'account does not exist (X: user not found)' : p && 'error' in p && p.error ? `LOOKUP FAILED (${p.error}) — unknown, not evidence against the project` : JSON.stringify(p);
      }
      case 'x_search': {
        if (!I.enrich.x) return 'X data not configured';
        const q = String(input.query).slice(0, 120);
        try { return JSON.stringify(await cachedX(I.enrich.x, I.enrich.now ?? Date.now).search(q, input.type === 'Top' ? 'Top' : 'Latest')); }
        catch (e) { return `SEARCH FAILED (${String((e as Error).message ?? e).slice(0, 120)}) — unknown, not evidence`; }
      }
      case 'domain_age': {
        if (!I.enrich.domainAge) return 'not configured';
        try { return JSON.stringify({ ageDays: await I.enrich.domainAge(String(input.domain)) }); }
        catch (e) { return `domain age unknown (${String((e as Error).message ?? e).slice(0, 100)}) — not evidence`; }
      }
      case 'fetch_page': {
        const u = String(input.url);
        if (!allowedUrls.has(u)) return 'refused: only URLs from the messages or the dossier';
        noteOpened(u);
        if (!I.enrich.page) return 'not configured';
        try { return JSON.stringify(await I.enrich.page(u) ?? 'not an html page'); } catch (e) { return `PAGE FETCH FAILED (${String((e as Error).message ?? e).slice(0, 100)}) — unknown, not evidence`; }
      }
      case 'browse_site': {
        if (!I.enrich.render) return 'browser not installed on the server — use fetch_page';
        const u = String(input.url);
        let host = ''; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { return 'bad url'; }
        const reg = (h: string) => h.replace(/^www\./, '').split('.').slice(-2).join('.');
        const allowedHosts = new Set([...allowedUrls].map(x => { try { return reg(new URL(x).hostname); } catch { return ''; } }));
        if (!allowedUrls.has(u) && !allowedHosts.has(reg(host))) return 'refused: only sites from the messages or the dossier';
        noteOpened(u);
        try { return JSON.stringify(await I.enrich.render(u, { tasks: true, timeoutMs: 20_000 }) ?? 'no page'); }
        catch (e) { return `BROWSER FAILED (${String((e as Error).message ?? e).slice(0, 100)}) — unknown, not evidence`; }
      }
      case 'trends': {
        const chain = String(input.chain ?? 'solana').toLowerCase();
        const mt = I.enrich.trends ? await I.enrich.trends.trends(chain).catch(() => undefined) : undefined;
        return JSON.stringify({ ...(mt ?? { note: 'market trends unavailable' }), communities: d.store.topMentions(new Date(now - 86400_000).toISOString(), 10) });
      }
      case 'mentions': return JSON.stringify(d.store.mentionStats([String(input.key)], new Date(now - Math.min(168, Number(input.hours) || 24) * 3600_000).toISOString()));
      default: return 'unknown tool';
    }
  };
}

/** How many tool calls the analyst has: researching a low-score source gets more. */
export const LOW_TRUST_RESEARCH = 3;
// Option 1 (2026-10-27): code collects X, website, docs and trends in advance — the model needs only 2 calls (research — 3)
export function toolBudget(_model: string, research = false): number { return research ? 3 : 2; }

async function runVerdict(d: PipelineDeps, model: string, user: string, exec: (n: string, i: any) => Promise<string>, system?: string, maxToolCalls = toolBudget(model), ctx: Record<string, unknown> = {}): Promise<{ verdict?: Verdict; cost: number; toolCalls: string[]; usage?: ReturnType<typeof usageSummary> }> {
  const I = d.intel!;
  const log = d.log ?? (() => {});
  let verdict: Verdict | undefined; let cost = 0; let toolCalls: string[] = []; let usage: ReturnType<typeof usageSummary> | undefined;
  let trace: import('../analyst/analyst.js').TraceRound[] | undefined; let raw: unknown; let error: string | undefined;
  try {
    const res = await I.runAnalyst!({ model, system: system ?? systemPrompt(I.brief, d.mode), user, exec, maxToolCalls });
    cost = res.usage.reduce((a, u) => a + costUsd(model, u), 0);
    toolCalls = res.toolCalls;
    usage = usageSummary(res.usage);
    trace = res.trace; raw = res.verdict;
    log(`analyst usage ${model.replace('claude-', '')}: ${usage.rounds} round(s), input ${usage.input}, cache write ${usage.cacheWrite}, cache read ${usage.cacheRead}, output ${usage.output} → $${cost.toFixed(4)}`);
    const p = parseVerdict(res.verdict);
    verdict = p.verdict;
    if (!verdict) log(`analyst verdict rejected: ${p.error}`);
  } catch (e) {
    I.pause?.observe(e); // no credits or the key was rejected — model pause (C-04)
    log(`analyst failed: ${String(e)}`);
    error = String((e as Error).message ?? e);
    const u = (e as { usage?: import('../llm/budget.js').Usage[] }).usage; // spend on failure is counted too
    if (u) { cost = u.reduce((a, x) => a + costUsd(model, x), 0); usage = usageSummary(u); }
    trace = (e as { trace?: import('../analyst/analyst.js').TraceRound[] }).trace;
  }
  I.budget.record(model, cost);
  // Review log: what the model saw, how it reasoned, which tools it called, what it decided and what it cost
  reviewLog.write('analysis', { ...ctx, model, costUsd: Number(cost.toFixed(5)), usage, error, verdict: verdict ?? raw, toolBudget: maxToolCalls, trace, case: user });
  return { verdict, cost, toolCalls, usage };
}

/** X thoughts from an analysis (A-08) and the exact reason if there is none. The main one first; index.ts reads the fields. */
export interface ThoughtPlan { thoughts: Thought[]; skip?: string; skips?: string[] }
/** A thought whose note was written by a repeat request (the model gave no publicNote at first): Brand still confirms the format. */
export type PlannedThought = Thought & { origin?: 'publicNote' | 'note_retry' };
export type AnalysisWithThoughts = NonNullable<HandleResult['analysis']> & { thoughts?: PlannedThought[]; thoughtSkip?: string; thoughtSkips?: string[] };

const squashName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
/** Whole-word occurrence of a name, without RegExp (the name may contain any characters). */
function wordIndex(text: string, word: string): number {
  const t = text.toLowerCase(), w = word.toLowerCase();
  for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) if (!isWordChar(t[i - 1]) && !isWordChar(t[i + w.length])) return i;
  return -1;
}
/** The @handle of the confirmed project X in the note: "Fen Lamp" → "Fen Lamp (@fenlampr)"; no whole-word name — at the end. */
export function withHandle(note: string, subject: string, handle: string): string {
  if (note.toLowerCase().includes(`@${handle.toLowerCase()}`)) return note;
  const i = wordIndex(note, subject);
  if (i >= 0) return `${note.slice(0, i + subject.length)} (@${handle})${note.slice(i + subject.length)}`;
  return `${note.replace(/[.!?…]+$/, '')} (@${handle}).`;
}

/** The project name in the thought and its confirmed X (a thought about several projects: "A / B / C"). */
export interface NameHandle { name: string; handle: string }
/** Project list separators in the thought subject: "Coilmarkers / Runelings / Partitas". */
const LIST_SEP = /(\s*(?:\/|\||;|,|&|\+)\s*)/;
/** Names from a list subject; a plain subject is one element. */
export const subjectParts = (subject: string): string[] => subject.split(LIST_SEP).filter((_, i) => i % 2 === 0).map(s => s.trim()).filter(Boolean);
/** The text already has the @handle (as a whole word). */
const hasTag = (t: string, h: string) => new RegExp(`(?<![\\w@])@${h}(?![A-Za-z0-9_])`, 'i').test(t);

/**
 * Handles into the note: for a list subject each name with a handle is replaced by the @handle; then the first mention of each
 * name whose handle is not yet in the text gets " (@handle)". A main subject not mentioned in the text — "(@h)." at the end (as before).
 */
function tagNames(t: string, subject: string, pairs: NameHandle[]): string {
  if (!pairs.length) return t;
  const parts = subjectParts(subject);
  const forName = (n: string) => pairs.find(p => squashName(p.name) === squashName(n));
  if (parts.length > 1) {
    const i = wordIndex(t, subject);
    if (i >= 0) {
      const seg = t.slice(i, i + subject.length).split(LIST_SEP)
        .map((s, k) => { if (k % 2) return s; const p = forName(s.trim()); return p ? s.replace(s.trim(), `@${p.handle}`) : s; }).join('');
      t = `${t.slice(0, i)}${seg}${t.slice(i + subject.length)}`;
    }
  }
  const bare = subject.replace(/^\$/, '');
  for (const p of pairs) {
    if (hasTag(t, p.handle)) continue;
    if (parts.length < 2 && squashName(p.name) === squashName(subject)) { t = withHandle(t, wordIndex(t, subject) >= 0 ? subject : bare, p.handle); continue; }
    const j = wordIndex(t, p.name);
    if (j >= 0) t = `${t.slice(0, j + p.name.length)} (@${p.handle})${t.slice(j + p.name.length)}`;
  }
  return t;
}

/**
 * The X note (the model's public post) before posting: other @mentions lose the "@" (we tag only the X accounts the matching
 * allows for this thought: handle; X of other dossier projects also lose the "@", review A-handles R1), an unconfirmed "(@h)" is removed with its brackets
 * (otherwise a "bare" name remains: "Quarry (Quarry__app)", prod 2026-11-17/18); long addresses are shortened, the project name goes in the text
 * (otherwise at the start), project handles go next to their names (tagNames), then the publisher's leak and "done" checks.
 * Length: the NOTE_MAX limit (for a token — opts.max) plus inserted handles, but no more than the room in the post (opts.room); if handles
 * would force cutting a word or dropping the thought while without them the note fits in whole sentences — no handles.
 * opts.strict — do not trim by words (a token note: if no sentence fits — undefined).
 * Fails — undefined: no thought, the reason is in the log.
 */
export function cleanNote(note: string, subject: string, handle: string | NameHandle[] | undefined, sourceNames: string[],
  opts: { room?: number; max?: number; strict?: boolean } = {}): string | undefined {
  const pairs: NameHandle[] = typeof handle === 'string' ? [{ name: subject, handle }] : (handle ?? []);
  // plain — the same note without code-inserted handles (confirmed "@" written by the model stay — review A-handles item 7):
  // the length difference shows how much the insertions added
  const keep = new Set(pairs.map(p => p.handle.toLowerCase()));
  const build = (insert: boolean): string | undefined => {
    let t = note.replace(/\s+/g, ' ').trim()
      // A bracket with @mentions (review A-handles R4: "(@a, @b)", "(via @a)", "(h/t @a)"): none confirmed — the whole bracket
      // goes; some confirmed — only they remain. A bracket without @handles (email, "10 @ 0.5") — as is
      .replace(/\s*\(([^()]*@[A-Za-z0-9_][^()]*)\)/g, (m, inner: string) => {
        const hs = [...inner.matchAll(/(?<![\w@])@([A-Za-z0-9_]+)/g)].map(x => x[1]);
        if (!hs.length) return m;
        const ok = hs.filter(h => keep.has(h.toLowerCase()));
        return ok.length ? ` (${ok.map(h => `@${h}`).join(', ')})` : '';
      })
      .replace(/(?<![\w@])@([A-Za-z0-9_]{1,15})\b/g, (m, h: string) => (keep.has(h.toLowerCase()) ? m : h))
      .replace(/\b0x[0-9a-fA-F]{41,}\b/g, a => `${a.slice(0, 6)}…${a.slice(-4)}`).trim();
    t = shortAddrs(t);
    // "Done" claims and leaks — both before the "Name: " prefix and after it (review #69, round 2, item 4: part of CLAIMS_DONE is anchored to the phrase start)
    const bad = (s: string) => !s || CLAIMS_DONE.test(s) || leaks(s, sourceNames).length > 0;
    if (bad(t)) return undefined;
    const bare = subject.replace(/^\$/, '');
    if (wordIndex(t, subject) < 0 && wordIndex(t, bare) < 0) t = `${subject}: ${t}`;
    if (insert) t = tagNames(t, subject, pairs);
    return bad(t) ? undefined : t;
  };
  const t = build(true);
  if (t === undefined) return undefined;
  const plain = pairs.length ? build(false) : t;
  const max = opts.max ?? NOTE_MAX, room = opts.room ?? NOTE_ROOM;
  // Room for handles: as much as they added, but no more than what remains in the post beyond the limit
  const added = Math.max(0, t.length - (plain ?? t).length);
  const limit = max + Math.min(added, Math.max(0, room - max));
  // No cut words (finisher #69, round 3): whole sentences within the limit; if none fits — by words with "…"
  const fit = fitSentences(t, limit);
  if (fit) return fit;
  const plainFit = plain !== undefined && plain !== t ? fitSentences(plain, max) : undefined;
  if (plainFit) return plainFit;
  return opts.strict ? undefined : cutWords(t, limit);
}
const NOTE_MAX = 260;
/** Room for the note in a thought post without a CA line: 280 − space − "No position." (drafts.ts, draftPost). */
const NOTE_ROOM = 280 - 1 - 'No position.'.length;
/** The line "\nCA: <address> (<chain>)" under a token post — no longer than 60 chars (HQ 2026-11-11 17:45 UTC, item 3). */
const CA_ROOM = 60;
/** Trim at a word boundary with "…" within max (including the "…"). */
export function cutWords(t: string, max: number): string {
  if (t.length <= max) return t;
  const head = t.slice(0, max);                                     // max − 1 chars of text + "…"
  const sp = head.lastIndexOf(' ');
  const body = (sp > 0 ? head.slice(0, sp) : head.slice(0, max - 1)).replace(/[\s,;:—–-]+$/, '');
  return `${body}…`;
}

const ADDRESS_LIKE = /^(0x[0-9a-f]{6,}|[1-9A-HJ-NP-Za-km-z]{32,44})/i;

/** A token note — up to 190 chars (the CA line in the post takes up to 60; HQ 2026-11-11 17:45 UTC, item 3). */
export const TOKEN_NOTE_MAX = 190;
/** Shorten to whole sentences within max; a single sentence longer than max — undefined (the thought will not go out). */
export function fitSentences(note: string, max: number): string | undefined {
  if (note.length <= max) return note;
  const head = note.slice(0, max + 1);
  const ends = [...head.matchAll(/[.!?…](?=\s|$)/g)].map(m => (m.index ?? 0) + 1).filter(i => i <= max);
  return ends.length ? note.slice(0, ends.at(-1)).trim() : undefined;
}
/** The last X note about the project (kv note:<thought key>) — for a re-check. */
function lastNoteOf(d: PipelineDeps, key: string): { iso: string; note: string } | null {
  try { const v = JSON.parse(d.store.kvGet(`note:${key}`) ?? 'null') as { iso?: string; note?: string } | null; return v?.iso && v.note ? { iso: v.iso, note: v.note } : null; } catch { return null; }
}
/** A re-check note repeats the previous one: the same words (≥ 80% shared significant words). */
export function repeatsNote(note: string, prev: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().replace(/@\w+/g, ' ').split(/[^a-z0-9$]+/).filter(w => w.length >= 3));
  const a = words(note), b = words(prev);
  if (!a.size || !b.size) return false;
  const common = [...a].filter(w => b.has(w)).length;
  return common / Math.min(a.size, b.size) >= 0.8;
}
type ProjectCard = NonNullable<ReturnType<ProjectCards['card']>>;
/** The analysis project card by the model's reference: address, key, name, ticker, collection slug. */
const cardFinder = (cards: ProjectCard[]) => (ref?: string): ProjectCard | undefined => {
  if (!ref?.trim()) return undefined;
  const r = ref.trim(), sq = squashName(r);
  return cards.find(c => c.keys.includes(r.toLowerCase()) || c.keys.includes(r) || c.keys.includes(nameKey(r)) || c.keys.includes(`ticker:${r.replace(/^\$/, '').toLowerCase()}`)
    || (sq.length >= 3 && (squashName(c.name) === sq || c.keys.some(k => k.startsWith('collection:') && squashName(k.slice(11)) === sq))));
};
interface PlanItem { card?: ProjectCard; name?: string; verdict: 'act' | 'watch'; note?: string; thesis?: string; main: boolean; origin?: PlannedThought['origin'];
  /** The verdict was held by stabilization, the note dropped (F92-2): no repeat note request. */ held?: boolean }

/**
 * What to write on X for a verdict (the owner's decision 2026-11-10 13:59 UTC: every watch/act analysis gives a thought), without network:
 *  - the main one — the verdict's main project (verdict.project / its card); if it has its own avoid/ignore verdict — no main one;
 *  - other watch/act projects from verdict.projects — their own thoughts (up to 4 per analysis; the publisher keeps the daily limit);
 *  - the card is looked up across all analysis projects (address, collection, ticker, name) — the thought key and position disclosure come from it.
 */
function planThoughts(d: PipelineDeps, verdict: Verdict, projectIds: number[], o: { focusProjectId?: number; batch?: boolean }): { items: PlanItem[]; skips: string[] } {
  const I = d.intel!;
  const hotV = (v: string): v is 'act' | 'watch' => v === 'act' || v === 'watch';
  if (!hotV(verdict.verdict)) return { items: [], skips: [] };
  const cards = projectIds.map(id => I.cards.card(id)).filter((c): c is ProjectCard => !!c);
  const cardFor = cardFinder(cards);
  const sameProject = (p: Verdict['projects'][number], name?: string, card?: ProjectCard) =>
    (!!name && (squashName(p.name ?? '') === squashName(name) || squashName(p.ref) === squashName(name))) || (!!card && cardFor(p.ref) === card) || (!!card && !!p.name && cardFor(p.name) === card);
  const hot = verdict.projects.filter(p => hotV(p.verdict)).sort((a, b) => (a.verdict === 'act' ? 0 : 1) - (b.verdict === 'act' ? 0 : 1));
  const focus = o.focusProjectId !== undefined ? cards.find(c => c.id === o.focusProjectId) : undefined;
  const mainName = verdict.project.name?.trim() || undefined;
  let mainCard = focus ?? (!o.batch && cards.length === 1 ? cards[0] : undefined) ?? cardFor(mainName);
  const mainPv = verdict.projects.find(p => sameProject(p, mainName, mainCard));
  if (!mainCard && mainPv) mainCard = cardFor(mainPv.ref) ?? cardFor(mainPv.name);
  const items: PlanItem[] = []; const skips: string[] = [];
  if (mainPv && !hotV(mainPv.verdict)) skips.push(`main project ${mainName ?? mainPv.ref}: own verdict ${mainPv.verdict}`);
  else if (mainName || mainCard) items.push({ card: mainCard, name: mainName ?? mainPv?.name, verdict: mainPv && hotV(mainPv.verdict) ? mainPv.verdict : verdict.verdict as 'act' | 'watch',
    note: verdict.publicNote?.trim() || mainPv?.publicNote?.trim() || undefined, thesis: mainPv?.thesis || verdict.thesis, main: true });
  // No main name — the main one = the most "actionable" in the list (the top verdict and publicNote are about it, the ROLE rule)
  else if (hot.length) items.push({ card: cardFor(hot[0].ref) ?? cardFor(hot[0].name), name: hot[0].name ?? (hot[0].ref.includes(':') ? undefined : hot[0].ref), verdict: hot[0].verdict as 'act' | 'watch',
    note: hot[0].publicNote?.trim() || verdict.publicNote?.trim() || undefined, thesis: hot[0].thesis || verdict.thesis, main: true });
  else skips.push('no project name');
  for (const p of hot) {
    if (items.length >= 4) break;
    const card = cardFor(p.ref) ?? cardFor(p.name);
    const name = p.name ?? (ADDRESS_LIKE.test(p.ref) || p.ref.includes(':') ? undefined : p.ref);
    if (items.some(it => (card && it.card === card) || (name && it.name && squashName(it.name) === squashName(name)) || (it.main && mainPv === p))) continue;
    items.push({ card, name, verdict: p.verdict as 'act' | 'watch', note: p.publicNote?.trim() || undefined, thesis: p.thesis, main: false });
  }
  // Held by stabilization (F92-2, main): no note, no replacement — neither a note from projects[] nor a repeat request
  const held = heldNotesOf.get(verdict);
  if (held) for (const it of items) if ((it.main && held.main) || (!!it.card && held.cardIds.includes(it.card.id))) { it.held = true; it.note = undefined; }
  return { items, skips };
}

/**
 * The model gave no publicNote for a watch/act project — one short repeat request to the same model (option "a" of the round 1 review:
 * the thesis is written for the owner and is not cut into a post). The system prompt is the same (from cache), the request has only the projects and their theses.
 */
async function askPublicNotes(d: PipelineDeps, model: string, verdict: Verdict, items: PlanItem[], subjects: string[]): Promise<number> {
  const I = d.intel!;
  if (!I.runAnalyst || I.pause?.paused()) return 0;
  const tag = 'DATA_' + randomBytes(6).toString('hex');
  const list = items.map((it, i) => `${i + 1}. ${subjects[i]} — ${it.verdict}: ${String(it.thesis ?? '').slice(0, 600).split(tag).join('')}`).join('\n');
  const user = [`PUBLIC NOTES ONLY. Your analysis is done; do not redo it and do not call read tools.`,
    `Call ${'emit_verdict'} once: verdict "${verdict.verdict}", confidence ${verdict.confidence}, thesis "same", publicNote = the note for project 1, and projects = one entry {ref, name, verdict, thesis: "same", publicNote} for each other project listed (ref = its name exactly as listed).`,
    `Each publicNote follows the PUBLIC NOTE rules and names its project. Everything inside <${tag}> is your own earlier analysis, written for the owner: never copy who said what, sources, people, counts of authors or communities, scores or verdict words.`,
    `<${tag}>\n${list}\n</${tag}>`].join('\n\n');
  const t0 = Date.now();
  try {
    const res = await I.runAnalyst({ model, system: systemPrompt(I.brief, d.mode), user, exec: async () => 'no tools in this step', maxToolCalls: 0 });
    const cost = res.usage.reduce((a, u) => a + costUsd(model, u), 0);
    I.budget.record(model, cost);
    const v = (res.verdict ?? {}) as { publicNote?: unknown; projects?: { ref?: unknown; name?: unknown; publicNote?: unknown }[] };
    items.forEach((it, i) => {
      if (it.note) return;
      const raw = i === 0 ? v.publicNote : (v.projects ?? []).find(p => squashName(String(p.ref ?? p.name ?? '')) === squashName(subjects[i]))?.publicNote;
      if (typeof raw === 'string' && raw.trim()) { it.note = raw.trim().slice(0, 280); it.origin = 'note_retry'; }
    });
    reviewLog.write('note_retry', { model, costUsd: Number(cost.toFixed(5)), ms: Date.now() - t0, subjects, notes: items.map(it => it.note ?? null) });
    return cost;
  } catch (e) {
    I.pause?.observe(e);
    // Spend on failure is counted too (as in runVerdict)
    const u = (e as { usage?: import('../llm/budget.js').Usage[] }).usage;
    const cost = u ? u.reduce((a, x) => a + costUsd(model, x), 0) : 0;
    I.budget.record(model, cost);
    reviewLog.write('note_retry', { model, costUsd: Number(cost.toFixed(5)), error: String((e as Error).message ?? e).slice(0, 200), subjects });
    return cost;
  }
}

/**
 * Limit for the X search by name (HQ 2026-11-18 from the prod log: 5 s was not enough — "project X by name: not checked in 5 s").
 * The search runs after exits and actions, in parallel with the repeat note request, so longer than 5 s is fine; the time is in the project_x log.
 */
export const NAME_X_MS = 12_000;

/** The publisher's daily thought limit (Publisher.thoughtsDailyMax, default 8): above it a repeat note request wastes money. */
const THOUGHTS_DAILY_MAX = 8;
// Actions without a trade post — a set shared with postThought in index.ts (src/postActions.ts): dapp_session does not suppress the thought

/** Keys and names of everything the analysis just traded: address, collection, perp, prediction market. */
function tradedRefs(decisions: HandleResult['decisions']): { keys: Set<string>; names: Set<string>; any: boolean } {
  const keys = new Set<string>(); const names = new Set<string>();
  const done = decisions.filter(x => !NO_POST_ACTIONS.has(x.action));
  for (const x of done) {
    const addr = (x.intent.tokenAddress ?? x.intent.contractAddress ?? '').toLowerCase();
    if (addr) { keys.add(`evm:${addr}`); keys.add(`sol:${addr}`); }
    // Collection: the collection field (secondary buy) or an OpenSea link in the intent (mint)
    const slugs = [x.intent.collection, ...x.intent.urls.map(u => u.match(/opensea\.io\/collection\/([a-z0-9-]+)/i)?.[1])].filter((v): v is string => !!v);
    for (const slug of slugs) { keys.add(`collection:${slug.toLowerCase()}`); names.add(squashName(slug)); }
    const asset = x.intent.kind === 'perp_trade' ? x.intent.asset : undefined;
    if (asset) { keys.add(`ticker:${asset.toLowerCase()}`); keys.add(`perp:${asset.toLowerCase()}`); names.add(squashName(asset)); }
    if (x.intent.marketSlug) { keys.add(`pm:${x.intent.marketSlug.toLowerCase()}`); names.add(squashName(x.intent.marketSlug)); }
  }
  names.delete('');
  return { keys, names, any: done.length > 0 };
}

/** Whether the agent holds a position by the card keys: address — token; collection:<slug> — nft:<slug>; ticker:<t> — perp:<t>. */
function holdsByKeys(d: PipelineDeps, keys: string[]): boolean {
  const risk = d.decide.risk;
  return keys.some(k => {
    const i = k.indexOf(':'); const kind = k.slice(0, i), v = k.slice(i + 1);
    if (!v) return false;
    if (kind === 'evm' || kind === 'sol') return risk.holds(v);
    if (kind === 'collection') return risk.holds(`nft:${v}`);
    if (kind === 'ticker') return risk.holds(`perp:${v}`);
    return false;
  });
}

/**
 * Analysis thoughts — AFTER exits and actions (review #69, rounds 1–2, blockers 2–3):
 *  - a trade in the analysis: the main thought is dropped on any trade; the others — if the trade is on their address, collection, perp, market;
 *  - the project X by name is searched here, with a 5 s limit (in the dossier before the model — only tokens and collections, also with a limit);
 *  - a repeat note request — only if the publisher will accept it (no thought about the project in 24 h, daily limit not reached) and there is budget;
 *    the repeat's cost goes into analysis.costUsd.
 */
async function attachThoughts(d: PipelineDeps, out: HandleResult, verdict: Verdict, projectIds: number[], o: { model: string; focusProjectId?: number; batch?: boolean; dossier: Dossier; sourceNames: string[]; backfill?: boolean; chatReview?: boolean; recheck?: boolean;
  /** Collection slugs of the message (all, not only the two in the dossier) and of OpenSea pages the analyst opened. */ collections?: string[];
  /** "discord" candidates (option 1) — only discordHandles(): the trusted caller's own text. */ msgX?: string[] }): Promise<void> {
  if (!out.analysis) return;
  const I = d.intel!;
  const { items, skips } = planThoughts(d, verdict, projectIds, o);
  const traded = tradedRefs(out.decisions);
  const nameOf = (it: PlanItem) => it.name ?? it.card?.name ?? '';
  const live = items.filter(it => {
    const onTraded = (it.main && traded.any) || (!!it.card && it.card.keys.some(k => traded.keys.has(k.toLowerCase())))
      || [nameOf(it), ...(it.card?.keys.filter(k => k.startsWith('ticker:')).map(k => k.slice(7)) ?? [])].some(n => !!n && traded.names.has(squashName(n)));
    if (onTraded) skips.push(`${nameOf(it) || 'project'}: trade post covers it`);
    return !onTraded;
  });
  const subjectOf = (it: PlanItem) => {
    const ticker = it.card?.keys.find(k => k.startsWith('ticker:'));
    return (ticker ? `$${ticker.slice(7).toUpperCase()}` : nameOf(it)).trim();
  };
  const usable = live.map(it => ({ it, subject: subjectOf(it) })).filter(({ it, subject }) => {
    if (!subject) { skips.push('no project name'); return false; }
    if (ADDRESS_LIKE.test(subject)) { skips.push(`${it.main ? 'main: ' : ''}subject is an address`); return false; }
    return true;
  }).map(u => ({ ...u, key: u.it.card ? `p${u.it.card.id}` : `n:${squashName(u.subject)}` }));

  // Project X: by the card entity; by name — only for name: and collection: entities (a token X does not attach to a name, X5)
  // and only if the thought itself is not about a token (review #69, round 3, item 3: the X of collection "Hood" does not attach to a thought about $HOOD)
  const tokenCard = (c?: ProjectCard) => !!c?.keys.some(k => /^(evm|sol|ticker):/.test(k));
  const aboutToken = (it: PlanItem, subject: string) => subject.startsWith('$') || tokenCard(it.card);
  const cardFor = cardFinder(projectIds.map(id => I.cards.card(id)).filter((c): c is ProjectCard => !!c));
  // Name ↔ project X: the entity name, the name without " by author" (OpenSea: "Coilmarkers by Lumenfold"), the collection slug (runelings-)
  const nameLike = (px: ProjectX, n: string) => {
    const sq = squashName(n);
    if (sq.length < 3) return false;
    const names = [px.name ?? '', (px.name ?? '').replace(/\s+by\s+.*$/i, '')];
    if (px.entity.startsWith('collection:')) { const slug = px.entity.slice(11); names.push(slug, slug.replace(/-by-.*$/, '')); }
    return names.some(x => !!x && squashName(x) === sq);
  };
  const handleFor = (n: string, card: ProjectCard | undefined, token: boolean) => o.dossier.projectX?.find(px => (card && card.keys.includes(px.entity))
    || (!token && (px.entity.startsWith('name:') || px.entity.startsWith('collection:')) && nameLike(px, n)))?.handle;
  const handleOf = (it: PlanItem, subject: string) => { const tok = aboutToken(it, subject);
    return handleFor(subject, it.card, tok) ?? (it.name && it.name !== subject ? handleFor(it.name, undefined, tok) : undefined); };
  /**
   * Thought handles: one project — as before (card / entity / name); a list subject "A / B / C" (one thought about several
   * projects, prod 2026-11-18) — its own handle for each name (its card or name; a collection X does not attach to a token).
   */
  const pairsOf = (it: PlanItem, subject: string): NameHandle[] => {
    const parts = subjectParts(subject);
    const whole = parts.length > 1 ? handleFor(subject, undefined, aboutToken(it, subject)) : handleOf(it, subject);
    if (whole) return [{ name: subject, handle: whole }];
    if (parts.length < 2) return [];
    return parts.flatMap(p => { const c = cardFor(p); const h = handleFor(p, c, p.startsWith('$') || tokenCard(c)); return h ? [{ name: p, handle: h }] : []; });
  };
  const hasOwnX = (c?: ProjectCard) => !!c?.keys.some(k => /^(evm|sol|collection):/.test(k));
  // A thought about a token will not get a handle by name (item 3) — so the paid search by name is not needed for it; for a list — by names
  const namesToSearch = (u: { it: PlanItem; subject: string }): string[] => {
    const parts = subjectParts(u.subject);
    if (parts.length < 2) return !hasOwnX(u.it.card) && !aboutToken(u.it, u.subject) && !handleOf(u.it, u.subject) ? [u.it.name ?? u.subject.replace(/^\$/, '')] : [];
    return parts.filter(p => { const c = cardFor(p); return !p.startsWith('$') && !tokenCard(c) && !hasOwnX(c) && !handleFor(p, c, false); });
  };
  const errs0 = o.dossier.errors.length;
  const msgX = xHandlesOfMessage(o.msgX ?? []);
  // Collections outside the dossier (the message has more than two; the analyst opened the OpenSea page with a tool) — their X from the OpenSea page
  const live0 = !o.backfill && usable.some(u => !u.it.held);
  const collSlugs = live0 ? (o.collections ?? []) : [];
  const collStep = collSlugs.length && I.enrich.opensea
    ? resolveCollectionsX(o.dossier, collSlugs, I.enrich, msgX).catch(e => { o.dossier.errors.push(`collections X: ${String((e as Error).message ?? e).slice(0, 120)}`); })
    : Promise.resolve();
  // Search by name — after actions, in parallel with collections (review A-handles item 5: the queue waits no longer than NAME_X_MS
  // in total; collections fit their own PROJECT_X_MS within the same window). The time goes to the log
  const toSearch = o.backfill || !I.enrich.x ? [] : [...new Set(usable.filter(u => !u.it.held).flatMap(namesToSearch))];
  let searchMs = 0;
  const nameSearch = (async () => {
    if (!toSearch.length) return;
    const t0 = Date.now();
    await withLimit(resolveNameX(o.dossier, toSearch, { ...I.enrich, x: cachedX(I.enrich.x!, I.enrich.now ?? Date.now) },
      { get: k => d.store.kvGet(k) ?? undefined, set: (k, v) => d.store.kvSet(k, v) }, msgX), NAME_X_MS, o.dossier.errors, 'project X by name');
    searchMs = Date.now() - t0;
  })();

  // Repeat note request: only where the publisher will accept the thought, and if the model budget allows (item 6)
  const now = d.decide.clock.now();
  const postedRecently = (key: string, v: 'act' | 'watch') => {
    try {
      const prev = JSON.parse(d.store.kvGet(`thought:${key}`) ?? 'null') as { iso: string; verdict: string } | null;
      return !!prev && now - Date.parse(prev.iso) < 86400_000 && !(prev.verdict === 'watch' && v === 'act');
    } catch { return false; }
  };
  let missing = o.backfill ? [] : usable.filter(u => !u.it.note && !u.it.held);
  missing = missing.filter(u => { const r = postedRecently(u.key, u.it.verdict); if (r) skips.push(`${u.subject}: no public note (retry skipped: thought on it posted in 24h)`); return !r; });
  if (missing.length && d.store.postsOfKind('thought', new Date(now - 86400_000).toISOString()) >= THOUGHTS_DAILY_MAX) {
    skips.push(`no public note (retry skipped: thoughts cap ${THOUGHTS_DAILY_MAX}/24h)`); missing = [];
  }
  const budgetOk = !missing.length || (o.chatReview ? I.budget.pickChatReview(o.model, I.chatDailyUsd ?? 1) === o.model : I.budget.pickAnalyst(o.model) === o.model);
  if (!budgetOk) { skips.push(`no public note (retry skipped: ${o.model} budget exhausted)`); missing = []; }
  const [retryCost] = await Promise.all([
    missing.length ? askPublicNotes(d, o.model, verdict, missing.map(u => u.it), missing.map(u => u.subject)) : Promise.resolve(0),
    nameSearch, collStep]);
  // Log: what was searched by name, who was found and why they were refused (failures, rejected candidates) — this no longer reaches the model
  if (toSearch.length || collSlugs.length) reviewLog.write('project_x', { names: toSearch, ms: searchMs, collections: collSlugs,
    found: (o.dossier.projectX ?? []).filter(p => p.entity.startsWith('name:') || collSlugs.some(s => p.entity === `collection:${s.toLowerCase()}`)), errors: o.dossier.errors.slice(errs0) });
  if (retryCost) { out.analysis.costUsd = Number(((out.analysis.costUsd ?? 0) + retryCost).toFixed(6)); if (o.chatReview) I.budget.record(CHAT_TAG, retryCost); }

  // Position disclosure: card keys; without a card (or without position keys) — cards by ticker, name and slug from the log (D1, D2)
  const holding = (it: PlanItem, subject: string) => {
    if (it.card && holdsByKeys(d, it.card.keys)) return true;
    // The card has its own address or collection — the position is only by them: a same-named token with another address is not "I hold this" (round 3, item 4)
    if (it.card?.keys.some(k => /^(evm|sol|collection):/.test(k))) return false;
    const n = (it.name ?? subject).replace(/^\$/, '').trim(); const sq = squashName(n);
    if (sq.length < 2) return false;
    const ids = d.store.projectIdsForKeys([`ticker:${sq}`, `ticker:${n.toLowerCase()}`, nameKey(n), `collection:${sq}`, `collection:${n.toLowerCase().replace(/\s+/g, '-')}`]);
    return ids.some(id => holdsByKeys(d, I.cards.card(id)?.keys ?? []));
  };
  const thoughts: PlannedThought[] = []; let mainDone = false;
  for (const { it, subject, key } of usable) {
    if (it.held) { skips.push(`${subject}: verdict kept — note dropped, no replacement (F92-2)`); continue; }
    if (!it.note) { if (!skips.some(s => s.startsWith(`${subject}: no public note`))) skips.push(`${subject}: no public note`); continue; }
    const pairs = pairsOf(it, subject);
    // Room for the note in the post (drafts.ts, draftPost): 280 − the low-confidence mark and position disclosure − the token's CA line
    const hold = holding(it, subject);
    const room = 280 - 1 - xLen(`${verdict.confidence < LOW_CONFIDENCE_BELOW ? `${LOW_CONFIDENCE_NOTE} ` : ''}${hold ? 'I hold this.' : 'No position.'}`);
    // "@" is kept only for handles the matching allows for THIS thought (pairsOf): a collection X does not stay in a post
    // about a token (review A-handles, R1); a token gets only its entity's X, confirmed by a back-link to the CA
    const cleaned = cleanNote(it.note, subject, pairs, o.sourceNames, { room });
    if (!cleaned) { skips.push(`${subject}: public note failed the leak check`); continue; }
    // Token: a note up to 190 chars in whole sentences (code-inserted handles do not count towards the limit while there is room in the post)
    const isToken = subject.startsWith('$') || !!it.card?.keys.some(k => k.startsWith('evm:') || k.startsWith('sol:'));
    const note = isToken ? cleanNote(it.note, subject, pairs, o.sourceNames, { room: room - CA_ROOM, max: TOKEN_NOTE_MAX, strict: true }) : cleaned;
    if (!note) { skips.push(`${subject}: public note too long for a token post (${cleaned.length} chars, one sentence)`); continue; }
    // Re-check: a note repeating the previous one does not go out
    const prev = o.recheck ? lastNoteOf(d, key) : null;
    if (prev && repeatsNote(note, prev.note)) { skips.push(`${subject}: re-check note repeats the last one`); continue; }
    const chain = (verdict.intents as Intent[]).map(i => i.chain).find(c => c && c !== 'unknown') ?? (it.card?.keys.some(k => k.startsWith('sol:')) ? 'solana' : undefined);
    const t: PlannedThought = { key, subject: subject.slice(0, 60), note, verdict: it.verdict, chain,
      holding: hold, confidence: verdict.confidence, ...(it.origin ? { origin: it.origin } : {}) };
    if (!thoughts.some(x => x.key === t.key)) {
      thoughts.push(t); if (it.main) mainDone = true;
      d.store.kvSet(`note:${key}`, JSON.stringify({ iso: d.decide.clock.iso(), note }));
    }
  }
  // thoughtSkip — why there is no MAIN thought (even if others exist); thoughtSkips — all reasons of the analysis
  Object.assign(out.analysis, { thought: thoughts[0], thoughts, thoughtSkip: mainDone || (!items.length && !skips.length) ? undefined : skips[0] ?? 'no public note', thoughtSkips: skips } satisfies Partial<AnalysisWithThoughts>);
}

/** Project verdicts: each project gets its own (if the model gave a list), otherwise the shared one with a mark. */
function applyProjectVerdicts(d: PipelineDeps, verdict: Verdict, projectIds: number[], allKeys: string[], msgId: string, trustScore: number, focusProjectId?: number, defaultRecheck = true, by: 'model' | 'code' = 'model') {
  const I = d.intel!;
  const clock = d.decide.clock; const now = clock.now();
  for (const id of projectIds) {
    const card = I.cards.card(id);
    if (!card) continue;
    const pv = verdict.projects.find(p => card.keys.includes(p.ref.toLowerCase()) || card.keys.includes(p.ref) || card.keys.includes(nameKey(p.ref)) || card.name.toLowerCase() === p.ref.toLowerCase());
    const single = projectIds.length === 1 || id === focusProjectId;
    // In a multi-project message a project without its own verdict is marked "seen" (repeat protection) instead of getting the shared verdict
    const v = pv ?? (single ? { verdict: verdict.verdict, thesis: verdict.thesis, category: verdict.project.category, recheckAtUtc: verdict.recheckAtUtc }
      : { verdict: 'seen', thesis: '', category: undefined, recheckAtUtc: [] as string[] });
    d.store.setProjectVerdict(id, { name: pv?.name ?? (single ? verdict.project.name : undefined), category: v.category, verdict: v.verdict, thesis: v.thesis, scores: pv || !single ? {} : verdict.scores, iso: clock.iso(), analyzedKeys: allKeys, trust: trustScore });
    // Who set the verdict (model / code) — for skipping re-checks on ignore (recheckGate); tied by the card's verdict time
    const iso = I.cards.card(id)?.lastAnalysisUtc;
    if (iso) try { d.store.kvSet(verdictSrcKey(id), JSON.stringify({ iso, by })); } catch { /* log */ }
    // ignore: do not set the analyst's re-check — recheckGate would not run it anyway (the owner 2026-11-17); recheckDue removes old records.
    // act — set it: if code refused on market/risk, a re-check is needed to enter later (recheckGate decides the skip by the action outcome)
    if (v.verdict !== 'ignore') for (const t of v.recheckAtUtc ?? []) { const ms = utcMs(t); if (Number.isFinite(ms) && ms > now && ms < now + 14 * 86400_000) d.store.addWatch(id, msgId, new Date(ms).toISOString(), ANALYST_RECHECK); }
    // Default re-check: only for a single analysis, no more than 3 per project and 15 in total per day (each is a model call)
    if (v.verdict === 'watch' && defaultRecheck && !(v.recheckAtUtc ?? []).length && d.store.watchCount24h(id, new Date(now - 86400_000).toISOString()) < 3
      && d.store.defaultRechecks24h(new Date(now - 86400_000).toISOString()) < 15)
      d.store.addWatch(id, msgId, new Date(now + (verdict.recheckAfterMinutes ?? 60) * 60_000).toISOString(), verdict.recheckAfterMinutes ? ANALYST_RECHECK : DEFAULT_RECHECK);
  }
}

/**
 * Exits from positions on an alarm: missed profit is cheaper than a loss.
 * An alarm from a source scored < 4 (anyone can write "rug") — we do not sell, we notify the owner.
 */
async function handleExits(d: PipelineDeps, verdict: Verdict, trustOf: (e: Verdict['exits'][number]) => number, out: HandleResult) {
  if (verdict.confidence < MIN_VERDICT_CONFIDENCE) return;
  for (const e of verdict.exits) {
    if (!d.decide.risk.holds(e.token) || !d.executor.exitToken) continue;
    const score = trustOf(e);
    if (score < 4) { await d.notifier?.send(`⚠️ Alarm on position ${e.token.slice(0, 10)}… from an unverified source (score ${score}): ${e.reason}. Not touching the position — stops are active.`); continue; }
    if (await d.executor.exitToken(e.token, `analyst: ${e.reason}`, d.decide.market)) out.exits = [...(out.exits ?? []), e.token];
  }
}

type OriginPick = { origin: RawMessage; cur: RawMessage; resolveTrust: (intent: Intent) => { trust: TrustResult; quoteEndorsed: boolean } };

/** Actions from the verdict: address check against the source text, source score, careful mode, decide, execution. */
async function actOnIntents(d: PipelineDeps, verdict: Verdict, model: string, dossier: Dossier, out: HandleResult, pick: (proposed: Intent) => OriginPick | undefined) {
  const clock = d.decide.clock;
  const log = d.log ?? (() => {});
  // An ACT without an action is not silent (A-09): every reason is a skip decision in out.decisions (log and HandleResult; shown in Telegram — T-06)
  if (!verdict.intents.length) { actSkip(d, out, verdict, 'act verdict without an actionable intent (the analyst listed no action)'); return; }
  for (const proposed of verdict.intents as Intent[]) {
    const pk = pick(proposed);
    if (!pk) { log('analyst intent without a source message — dropped'); actSkip(d, out, verdict, 'no source message for the action (address/link not found in the messages)', proposed); continue; }
    const { origin, cur } = pk;
    const oPre = prefilter(`${origin.text}\n${origin.replyToText ?? ''}`);
    const oMain = prefilter(origin.text);
    // An NFT contract from OpenSea (code got it via the collection link in the message) is allowed as "from the text"
    const nft = dossier.nft.find(n => n.contract && proposed.contractAddress?.toLowerCase() === n.contract.toLowerCase());
    let vPre = nft ? { ...oPre, evmAddresses: [...oPre.evmAddresses, nft.contract!] } : oPre;
    // A token address from the project's official X (the owner 2026-10-23): the account comes from the message itself, the address is verified by code
    let official: import('../analyst/enrich.js').OfficialCa | undefined;
    const ta = proposed.tokenAddress;
    if (ta && ![...oPre.evmAddresses, ...oPre.solanaMints].some(a => a.toLowerCase() === ta.toLowerCase())) {
      const handles = codeEntities(`${origin.text}\n${origin.replyToText ?? ''}`, oPre, { parts: [origin.text, origin.replyToText ?? ''], scannerBot: isScannerBotMessage(origin.author, origin.text) }).filter(e => e.kind === 'x').map(e => e.display.replace(/^@/, ''));
      official = dossier.officialCas?.find(c => c.address.toLowerCase() === ta.toLowerCase() && handles.some(h => h.toLowerCase() === c.handle.toLowerCase()))
        ?? (d.intel ? await verifyOfficialCa(ta, { handles, tickers: oPre.tickers, profiles: dossier.x, posts: dossier.xSearch.flatMap(q => q.posts) }, d.intel.enrich).catch(() => undefined) : undefined);
      if (official) {
        const addr = official.address;
        vPre = official.chain === 'solana' || !addr.startsWith('0x') ? { ...vPre, solanaMints: [...vPre.solanaMints, addr] } : { ...vPre, evmAddresses: [...vPre.evmAddresses, addr] };
        log(`official CA ${addr.slice(0, 10)}… accepted: ${official.how}`);
      }
    }
    const v = validateIntents({ intents: [proposed] }, origin, vPre);
    if (v.dropped.length) log(`analyst output dropped: ${v.dropped.join('; ')}`);
    const intent = v.intents[0];
    if (!intent) { actSkip(d, out, verdict, `action dropped by the code check: ${v.dropped.join('; ').slice(0, 300) || 'invalid intent'}`, proposed, origin); continue; }
    if (intent.kind === 'token_call' && !intent.tokenAddress) { const all = [...oMain.solanaMints, ...oMain.evmAddresses]; if (all.length === 1) intent.tokenAddress = all[0]; }
    if ((intent.kind === 'contract_call' || intent.kind === 'mint') && !intent.contractAddress && oMain.evmAddresses.length === 1) intent.contractAddress = oMain.evmAddresses[0];
    // The project is held at its earlier verdict (A-09): buying it is exactly the unexplained upgrade; other projects' actions go ahead.
    // The check is on the validated action, after substituting the address from the source message (acceptance #92, N1, round 2)
    const held = heldOf.get(verdict)?.find(h => [intent.tokenAddress, intent.contractAddress, intent.collection].some(x => !!x && h.ids.includes(x.toLowerCase())));
    if (held) { actSkip(d, out, verdict, `held at ${held.prev}: no named new reason for act on this project — no action`, intent, origin); continue; }

    const { trust: eff, quoteEndorsed } = pk.resolveTrust(intent);
    const mainAddrs = new Set([...oMain.evmAddresses, ...oMain.solanaMints, ...(quoteEndorsed ? [...oPre.evmAddresses, ...oPre.solanaMints] : []), ...(official ? [official.address] : [])]);

    const pub = nft?.derived.publicStage;
    const nftCtx = nft && pub ? { contract: nft.contract!, chain: nft.chain as Chain, priceEth: pub.priceEth } : undefined;
    // Prediction market: only from the dossier (code got it via a link in the message); prices come from the order book, not the model
    let predCtx: import('../decide/decide.js').DecideContext['prediction'];
    let buyCtx: import('../decide/decide.js').DecideContext['nftBuy'];
    if (intent.kind === 'nft_buy') {
      const c = dossier.nft.find(x => x.slug.toLowerCase() === (intent.collection ?? '').toLowerCase()) ?? (dossier.nft.length === 1 ? dossier.nft[0] : undefined);
      const linked = c && oPre.urls.some(u => u.toLowerCase().includes(`opensea.io/collection/${c.slug.toLowerCase()}`));
      if (!c || !linked) { log(`nft_buy: collection ${intent.collection ?? '?'} not linked in the source message — dropped`); actSkip(d, out, verdict, `nft_buy: collection ${intent.collection ?? '?'} not linked in the source message`, intent, origin); continue; }
      buyCtx = { slug: c.slug, contract: c.contract, chain: c.chain as Chain, floorEth: c.floorEth, sellFeesPct: c.sellFeesPct };
    }
    if (intent.kind === 'prediction_bet') {
      const ms = dossier.predictions ?? [];
      const m = ms.find(x => x.slug === intent.marketSlug?.toLowerCase()) ?? (ms.length === 1 ? ms[0] : undefined);
      if (!m) { log(`prediction_bet: market ${intent.marketSlug ?? '?'} not in the dossier — dropped`); actSkip(d, out, verdict, `prediction_bet: market ${intent.marketSlug ?? '?'} not in the dossier`, intent, origin); continue; }
      const linked = [...oPre.urls].some(u => u.toLowerCase().includes(m.slug) || (m.eventSlug && u.toLowerCase().includes(m.eventSlug)));
      if (!linked) { log(`prediction_bet: market ${m.slug} is not linked in the source message — dropped`); actSkip(d, out, verdict, `prediction_bet: market ${m.slug} is not linked in the source message`, intent, origin); continue; }
      predCtx = m;
    }
    // A team call in a channel rated ≤ 6: maximum caution — a weak thesis or a long hold → skip
    if (eff.careful) {
      const c = d.decide.cfg.careful; const why: string[] = [];
      if (verdict.confidence < c.minConfidence) why.push(`confidence ${verdict.confidence} < ${c.minConfidence}`);
      if ((verdict.thesisStrength ?? 0) < c.minThesisStrength) why.push(`thesis ${verdict.thesisStrength ?? 'not rated'} < ${c.minThesisStrength}`);
      if (verdict.expectedHoldHours === undefined || verdict.expectedHoldHours > c.maxHoldHours) why.push(`hold ${verdict.expectedHoldHours ?? 'not stated'} h > ${c.maxHoldHours} h`);
      if (why.length) {
        const skip: import('../types.js').Decision = { action: 'skip', sizeUsd: 0, chain: intent.chain, trust: eff, intent,
          reasons: [`analyst (${model.replace('claude-', '')}): ${verdict.thesis}`, `careful source (team channel ≤ 6) — skipped: ${why.join('; ')}`] };
        d.store.saveDecision(origin, skip, d.mode, clock.iso());
        out.decisions.push({ action: 'skip', reasons: skip.reasons, intent });
        continue;
      }
    }
    const decision = await decide(intent, eff, vPre, d.decide, { mainTextAddresses: mainAddrs, nft: nftCtx, analyst: true, prediction: predCtx, nftBuy: buyCtx });
    if (official) decision.reasons.push(`CA from the project's official X: ${official.how}`);
    if (eff.careful && decision.action === 'buy_token') {
      const f = Math.min(verdict.sizeFactor ?? 1, d.decide.cfg.careful.sizeFactor);
      decision.sizeUsd = Math.round(decision.sizeUsd * f * 100) / 100;
      decision.reasons.push(`careful source: size ×${f}, tighter exits (stop −${d.decide.cfg.careful.exit.stopLossPct}%, time stop ${d.decide.cfg.careful.exit.timeStopHours} h)`);
      if (decision.sizeUsd < d.decide.cfg.minActionUsd) { decision.action = 'skip'; decision.reasons.push('careful size below minimum'); }
    }
    if (decision.action === 'scheduled' && intent.deadlineUtc) {
      // A deferred action: at the deadline the score, price and limits are recomputed. A repeat of the same action is not scheduled.
      const due = new Date(utcMs(intent.deadlineUtc)).toISOString();
      const dedup = `${intent.kind}|${(intent.contractAddress ?? intent.tokenAddress ?? intent.urls[0] ?? intent.summary).toLowerCase()}|${due}`;
      const added = d.store.addScheduled(due, origin, intent, eff, { cur, confidence: verdict.confidence, publicNote: verdict.publicNote, nftPlan: verdict.nftPlan, slug: nft?.slug }, dedup);
      if (!added) { decision.action = 'journal_only'; decision.reasons.push('already scheduled'); }
    }
    if (verdict.sizeFactor && decision.action === 'buy_token' && !eff.careful) {
      decision.sizeUsd = Math.round(decision.sizeUsd * verdict.sizeFactor * 100) / 100;
      if (decision.sizeUsd < d.decide.cfg.minActionUsd) { decision.action = 'skip'; decision.reasons.push(`analyst size ×${verdict.sizeFactor} below minimum`); }
    }
    // Drop: data for the mint (and for the live minter, which is "armed" in advance and fires at the start)
    if (nft && pub && (decision.action === 'contract_call' || decision.action === 'scheduled'))
      decision.nft = { slug: nft.slug, contract: nft.contract!, priceEth: pub.priceEth, sellFeesPct: nft.sellFeesPct, publicEndUtc: pub.endUtc, plan: (verdict.nftPlan as NftPlan | undefined) ?? { style: 'flip' },
        publicStartUtc: pub.startUtc, maxPerWallet: pub.maxPerWallet, exitEstimateEth: nft.derived.exitEstimateEth, leftForPublic: nft.derived.leftForPublicMin };
    if (decision.nftBuy && verdict.nftPlan) decision.nftBuy.plan = verdict.nftPlan as NftPlan;
    decision.publicNote = verdict.publicNote;
    decision.reasons.unshift(`analyst (${model.replace('claude-', '')}, conf ${verdict.confidence}): ${verdict.thesis}`);
    await commit(origin, decision, intent, d);
    out.decisions.push({ action: decision.action, reasons: decision.reasons, intent });
  }
}

/** ACT without an action (A-09): a skip decision with a reason — into HandleResult and the decision log (if there is a source message). */
function actSkip(d: PipelineDeps, out: HandleResult, verdict: Verdict, why: string, proposed?: Intent, origin?: RawMessage) {
  const intent: Intent = proposed ?? { kind: 'chatter', chain: 'unknown', urls: [], summary: verdict.thesis.slice(0, 200), stance: 'neutral', confidence: verdict.confidence };
  const reasons = [`analyst: ${verdict.thesis.slice(0, 300)}`, why];
  if (origin) try { d.store.saveDecision(origin, { action: 'skip', sizeUsd: 0, chain: intent.chain, trust: { score: 0, tier: 'journal' } as TrustResult, intent, reasons }, d.mode, d.decide.clock.iso()); } catch { /* log */ }
  out.decisions.push({ action: 'skip', reasons, intent });
  (d.log ?? (() => {}))(`act without action: ${why}`);
}

const VERDICT_RANK: Record<string, number> = { avoid: 0, ignore: 1, watch: 2, act: 3 };
/** Analysis projects held by stabilization (per verdict object): the general path and the batch path read them in actOnIntents. */
const heldOf = new WeakMap<Verdict, { ids: string[]; prev: string }[]>();
/** Notes dropped by a hold (F92-2): the main one and the held projects' cards — no replacement (repeat note request) is invented. */
const heldNotesOf = new WeakMap<Verdict, { main: boolean; cardIds: number[] }>();
/**
 * A verdict does not jump up without a named new reason (A-09, the owner 2026-11-11: $BRIXO 12 analyses overnight, avoid → act → watch →
 * act). An earlier project verdict (card, < repeatHours) and a new higher one without changeReason → the earlier one stays; the thesis
 * says why. Down (more careful) is fine without a reason: code never raises a verdict to act by itself.
 */
export function stabilizeVerdict(d: PipelineDeps, verdict: Verdict, projectIds: number[], focusProjectId?: number): string[] {
  const I = d.intel!;
  const now = d.decide.clock.now();
  const cards = projectIds.map(id => I.cards.card(id)).filter((c): c is NonNullable<typeof c> => !!c);
  const sq = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cardFor = (ref?: string) => {
    if (!ref?.trim()) return undefined;
    const r = ref.trim();
    return cards.find(c => c.keys.includes(r.toLowerCase()) || c.keys.includes(r) || c.keys.includes(nameKey(r)) || c.keys.includes(`ticker:${r.replace(/^\$/, '').toLowerCase()}`)
      || (sq(r).length >= 3 && sq(c.name) === sq(r)));
  };
  const prevOf = (c?: (typeof cards)[number]) => (c?.lastVerdict && c.lastVerdict in VERDICT_RANK && c.lastAnalysisUtc && now - utcMs(c.lastAnalysisUtc) < I.repeatHours * 3600_000 ? c : undefined);
  const named = (s?: string) => !!s && s.trim().length >= 12;
  const notes: string[] = [];
  // Names of held projects: if the publicNote is about one of them — the note is dropped (acceptance #92, F92-2)
  const heldTags: string[] = [];
  const heldNotes = { main: false, cardIds: [] as number[] };
  for (const p of verdict.projects) {
    const c = prevOf(cardFor(p.ref) ?? cardFor(p.name));
    if (c && VERDICT_RANK[p.verdict] > VERDICT_RANK[c.lastVerdict!] && !named(p.changeReason) && !named(verdict.changeReason)) {
      notes.push(`${p.name ?? p.ref}: kept ${c.lastVerdict} (was ${c.lastVerdict} at ${c.lastAnalysisUtc!.slice(11, 16)} UTC; ${p.verdict} without a named new reason)`);
      p.verdict = c.lastVerdict as typeof p.verdict;
      // The project note was written for the higher verdict — it is dropped together with it (F92-2, also for projects[].publicNote A-08)
      p.publicNote = undefined;
      heldNotes.cardIds.push(c.id);
      heldTags.push(p.ref, p.name ?? '', c.name, ...c.keys.filter(k => /^(ticker|sol|evm):/.test(k)).map(k => k.slice(k.indexOf(':') + 1)));
      // Addresses and collections of a held project — its actions in this analysis are not executed (actOnIntents, acceptance #92, N1)
      const ids = c.keys.filter(k => /^(sol|evm|collection|me):/.test(k)).map(k => k.slice(k.indexOf(':') + 1).toLowerCase());
      heldOf.set(verdict, [...(heldOf.get(verdict) ?? []), { ids, prev: c.lastVerdict! }]);
    }
  }
  const focus = focusProjectId !== undefined ? cards.find(c => c.id === focusProjectId) : undefined;
  const topCard = focus ?? cardFor(verdict.project.name) ?? (cards.length === 1 ? cards[0] : undefined);
  const main = prevOf(topCard);
  let top = verdict.verdict;
  if (main && VERDICT_RANK[top] > VERDICT_RANK[main.lastVerdict!] && !named(verdict.changeReason)) {
    notes.push(`kept ${main.lastVerdict} for ${verdict.project.name ?? main.name} (was ${main.lastVerdict} at ${main.lastAnalysisUtc!.slice(11, 16)} UTC; ${top} without a named new reason)`);
    top = main.lastVerdict as Verdict['verdict'];
  } else if (!topCard && notes.length && verdict.projects.length) {
    // The main project is undefined and projects were lowered — the top verdict is no higher than the "hottest" of the rest.
    // The main project is found but has no earlier verdict (a new token) — its verdict is left alone: holding another project
    // does not cancel a trade on the new one (acceptance #92, F92-1)
    const best = Math.max(...verdict.projects.map(p => VERDICT_RANK[p.verdict]));
    if (VERDICT_RANK[top] > best) top = (Object.keys(VERDICT_RANK).find(k => VERDICT_RANK[k] === best) ?? top) as Verdict['verdict'];
  }
  // The public note was written for the earlier (higher) verdict: its project was held — no note, no replacement (F92-2)
  const note = verdict.publicNote?.toLowerCase();
  if (note && (top !== verdict.verdict || heldTags.some(t => t.trim().length >= 3 && note.includes(t.trim().toLowerCase())))) verdict.publicNote = undefined;
  if (top !== verdict.verdict || (note && !verdict.publicNote)) heldNotes.main = true;
  if (heldNotes.main || heldNotes.cardIds.length) heldNotesOf.set(verdict, heldNotes);
  if (top !== verdict.verdict) verdict.verdict = top;
  if (notes.length) {
    verdict.thesis = `${notes.join(' ')} — ${verdict.thesis}`.slice(0, 2000);
    reviewLog.write('verdict_kept', { notes });
    (d.log ?? (() => {}))(`verdict kept: ${notes.join(' | ')}`);
  }
  return notes;
}

async function commit(origin: RawMessage, decision: import('../types.js').Decision, intent: Intent, d: PipelineDeps) {
  const clock = d.decide.clock;
  const id = d.store.saveDecision(origin, decision, d.mode, clock.iso());
  if (intent.kind === 'warning') for (const b of d.decide.blacklist.entries()) d.store.addBlacklist(b, clock.iso());
  try { await d.executor.execute(origin, decision, id); }
  catch (e) {
    decision.reasons.push(`execution blocked: ${String((e as Error).message ?? e)}`);
    decision.action = 'skip';
    d.store.updateDecision(id, decision.action, decision.reasons);
  }
}

/** Deferred actions: at the deadline the decision is made again (risk, prices, limits — as of now). */
export async function runScheduled(d: PipelineDeps): Promise<{ action: string; reasons: string[] }[]> {
  const out: { action: string; reasons: string[] }[] = [];
  // Live during a model pause: no new entries are opened (C-04, item 5) — deferred actions are dropped with a reason.
  // Exits by code stop rules do not run here (the position monitor) and work as usual.
  const pausedLive = d.mode === 'live' && !!d.intel?.pause?.paused();
  for (const row of d.store.dueScheduled(d.decide.clock.iso())) {
    d.store.doneScheduled(row.id);
    const origin = JSON.parse(row.msg_json) as RawMessage;
    const intent = JSON.parse(row.intent_json) as Intent;
    if (pausedLive) {
      const reasons = [`scheduled action due ${row.due_utc}`, `no new entries: ${PAUSED_SKIP}`];
      d.store.saveDecision(origin, { action: 'skip', sizeUsd: 0, chain: intent.chain ?? 'unknown', reasons, trust: d.trust.resolve(origin.sourceServer, origin.channel, origin.author), intent }, d.mode, d.decide.clock.iso());
      out.push({ action: 'skip', reasons });
      continue;
    }
    const ctx = JSON.parse(row.ctx_json ?? '{}');
    const cur: RawMessage = ctx.cur ?? origin;
    const pre = prefilter(`${origin.text}\n${origin.replyToText ?? ''}`);
    const main = prefilter(origin.text);
    delete intent.deadlineUtc; // the deadline has come
    // The score is recomputed (downgrades in the meantime count; "own find" — per the current setting)
    const curTrust = d.trust.resolve(cur.sourceServer, cur.channel, cur.author, { compromisedSigns: prefilter(cur.text).compromisedSigns });
    const { trust, quoteEndorsed } = d.intel ? actionTrust(d, cur, curTrust, origin, intent, ctx.confidence ?? 0) : { trust: curTrust, quoteEndorsed: false };
    // NFT — fresh OpenSea data: price, whether the mint is live, whether it is sold out
    let nftCtx: { contract: string; chain: Chain; priceEth: number } | undefined;
    let nftInfo: import('../analyst/opensea.js').NftInfo | undefined;
    if (ctx.slug) {
      nftInfo = await d.intel?.enrich.opensea?.nft(ctx.slug).catch(() => undefined);
      const pub = nftInfo?.derived.publicStage;
      const soldOut = nftInfo?.maxSupply !== undefined && nftInfo?.minted !== undefined && nftInfo.minted >= nftInfo.maxSupply;
      if (!nftInfo || !pub || !nftInfo.contract || soldOut || (pub.endUtc && utcMs(pub.endUtc) <= d.decide.clock.now())) {
        const reason = !nftInfo ? 'OpenSea unavailable at due time' : soldOut ? 'sold out' : 'public stage not available';
        d.store.saveDecision(origin, { action: 'skip', sizeUsd: 0, chain: (nftInfo?.chain as Chain) ?? 'unknown', reasons: [`scheduled action due ${row.due_utc}`, reason], trust, intent }, d.mode, d.decide.clock.iso());
        out.push({ action: 'skip', reasons: [reason] });
        continue;
      }
      nftCtx = { contract: nftInfo.contract, chain: nftInfo.chain as Chain, priceEth: pub.priceEth };
    }
    const mainAddrs = new Set([...main.evmAddresses, ...main.solanaMints, ...(quoteEndorsed ? [...pre.evmAddresses, ...pre.solanaMints] : [])]);
    const decision = await decide(intent, trust, pre, d.decide, { mainTextAddresses: mainAddrs, nft: nftCtx, analyst: true });
    if (nftCtx && nftInfo && decision.action === 'contract_call') decision.nft = { slug: ctx.slug, contract: nftCtx.contract, priceEth: nftCtx.priceEth, sellFeesPct: nftInfo.sellFeesPct, publicEndUtc: nftInfo.derived.publicStage?.endUtc, plan: ctx.nftPlan ?? { style: 'flip' },
      publicStartUtc: nftInfo.derived.publicStage?.startUtc, maxPerWallet: nftInfo.derived.publicStage?.maxPerWallet, exitEstimateEth: nftInfo.derived.exitEstimateEth, leftForPublic: nftInfo.derived.leftForPublicMin };
    decision.publicNote = ctx.publicNote;
    decision.reasons.unshift(`scheduled action due ${row.due_utc}`);
    await commit(origin, decision, intent, d);
    out.push({ action: decision.action, reasons: decision.reasons });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Chat-channel batches
// ------------------------------------------------------------------------------------------------
/** Batches waiting too long (slow chats): ≥ 5 messages and older than the deadline, or any older than 12 h. */
export async function flushDueChatBatches(d: PipelineDeps): Promise<HandleResult[]> {
  const I = d.intel!;
  const now = d.decide.clock.now();
  const out: HandleResult[] = [];
  for (const b of d.store.chatBufferStats()) {
    // The channel is no longer a chat (e.g. it became a scanner) — the accumulated batch is not analysed
    const [srv, ch] = b.key.split('|');
    if (d.trust.channelMode(srv, ch) !== 'chat') { d.store.chatBufferTake(b.key); continue; }
    const ageMin = (now - utcMs(b.oldest)) / 60_000;
    if ((b.n >= 5 && ageMin >= I.chatMaxWaitMinutes) || ageMin >= 12 * 60) out.push(await analyzeChatBatch(b.key, `waited ${Math.round(ageMin)} min, ${b.n} messages`, d));
  }
  return out;
}

/** Batch review after Haiku: fewer tools — every call re-reads the whole batch and dossier (that is what was expensive). */
export const CHAT_REVIEW_TOOLS = 2;

/**
 * Which batch messages the reviewer sees: those flagged by Haiku + up to `context` context messages
 * (2 before each flagged one, the rest before the first). Original numbering. No flags — the last 15.
 */
export function focusWindow(n: number, focus: number[], context = 10): number[] {
  const f = [...new Set(focus)].filter(i => i >= 1 && i <= n).sort((a, b) => a - b);
  if (!f.length) return Array.from({ length: Math.min(15, n) }, (_, i) => n - Math.min(15, n) + 1 + i);
  const keep = new Set(f); let extra = 0;
  for (const i of f) for (let j = i - 1; j >= Math.max(1, i - 2) && extra < context; j--) if (!keep.has(j)) { keep.add(j); extra++; }
  for (let j = f[0] - 3; j >= 1 && extra < context; j--) if (!keep.has(j)) { keep.add(j); extra++; }
  return [...keep].sort((a, b) => a - b);
}

async function analyzeChatBatch(key: string, reason: string, d: PipelineDeps, urgent = false): Promise<HandleResult> {
  const I = d.intel!;
  const clock = d.decide.clock; const now = clock.now();
  const log = d.log ?? (() => {});
  const batch = d.store.chatBufferTake(key);
  if (!batch.length) return { skipped: 'empty batch', decisions: [] };
  // A batch collected before the pause is neither analysed nor deferred during the pause: no queue (C-04)
  if (!(await modelReady(I))) { log(`chat batch ${key} (${batch.length} messages) dropped: ${PAUSED_SKIP}`); return { skipped: PAUSED_SKIP, decisions: [] }; }
  const last = batch[batch.length - 1];
  const items = batch.map((msg, i) => {
    const pre = prefilter(`${msg.text}\n${msg.replyToText ?? ''}`);
    return { idx: i + 1, msg, pre, trust: d.trust.resolve(msg.sourceServer, msg.channel, msg.author, { compromisedSigns: pre.compromisedSigns }) };
  });

  // Step 1 — Haiku reads the batch without a dossier or tools; further only if there is something interesting.
  // An alarm about our position goes to the analyst immediately.
  let triageCost = 0;
  let review = items; // what the reviewer model will see (after Haiku — only the flagged messages and context)
  let triaged = false; let triNames: string[] = [];
  if (I.triageCall && !urgent) {
    const gm = I.budget.caps.gateModel;
    if (!I.budget.gateAvailable()) { log(`chat batch ${key}: Haiku budget exhausted — journal only`); return { skipped: 'triage budget exhausted (chat batch journaled)', decisions: [] }; }
    let tri: TriageOut | undefined;
    try {
      const res = await I.triageCall(triageSystem(I.brief), triageUser(last.sourceServer, last.channel, items));
      triageCost = res.usage ? costUsd(gm, res.usage) : 0;
      tri = validateTriage(res.output, items.length, batch.map(m => `${m.text}\n${m.replyToText ?? ''}`).join('\n'));
      if (!tri) log(`chat triage ${key}: invalid answer`);
      reviewLog.write('triage', { channel: key, messages: items.length, model: gm, costUsd: Number(triageCost.toFixed(5)), result: tri ?? res.output });
    } catch (e) { I.pause?.observe(e); log(`chat triage ${key} failed: ${String(e)}`); reviewLog.write('triage', { channel: key, messages: items.length, error: String(e).slice(0, 300) }); }
    I.budget.record(gm, triageCost);
    d.store.saveAnalysis({ iso: clock.iso(), msgId: last.id, model: gm, trigger: `chat_triage(${batch.length})`, verdict: tri ? (tri.escalate ? 'escalate' : 'ignore') : 'error', confidence: tri ? 1 : 0, json: { ...(tri ?? {}), batch: batch.length }, costUsd: triageCost });
    if (!tri) return { skipped: I.pause?.paused() ? PAUSED_SKIP : 'triage error (chat batch journaled)', decisions: [] };
    if (!tri.escalate) return { decisions: [], analysis: { model: gm, verdict: 'ignore', confidence: 1, thesis: tri.reason, costUsd: triageCost, batch: batch.length, stage: 'triage' } };
    reason = `${reason}; cheap triage flagged it: ${tri.reason}${tri.focus.length ? ` — look first at messages ${tri.focus.map(i => `[${i}]`).join(', ')}` : ''}`;
    // Option 2: the reviewer gets only the flagged messages and up to 10 context messages before them
    let focus = tri.focus;
    if (!focus.length && tri.names.length) focus = items.filter(it => tri!.names.some(n => it.msg.text.toLowerCase().includes(n.toLowerCase()))).map(it => it.idx).slice(-10);
    const keep = new Set(focusWindow(items.length, focus));
    review = items.filter(it => keep.has(it.idx));
    triaged = true; triNames = tri.names;
    log(`chat triage ${key}: escalate → ${tri.reason} (${review.length} of ${items.length} messages to review)`);
  }

  const preferred = I.channelModel[`${last.sourceServer.toLowerCase()}/${last.channel.toLowerCase()}`];
  const model = triaged ? I.budget.pickChatReview(I.chatReviewModel ?? I.budget.caps.fallbackModel, I.chatDailyUsd ?? 1) : I.budget.pickAnalyst(preferred);
  if (!model || !I.runAnalyst) {
    const why = triaged ? 'chat review budget exhausted' : 'analyst budget exhausted';
    log(`chat batch ${key}: ${why} — journal only`);
    return { skipped: `${why} (chat batch journaled)`, decisions: [] };
  }

  // Batch entities: the most mentioned go into the dossier (up to 3 tokens, 2 collections, 2 domains, 2 X)
  const count = new Map<string, { e: Entity; n: number }>();
  for (const it of review) for (const e of codeEntities(`${it.msg.text}\n${it.msg.replyToText ?? ''}`, it.pre, { parts: [it.msg.text, it.msg.replyToText ?? ''], scannerBot: isScannerBotMessage(it.msg.author, it.msg.text) })) { const c = count.get(e.key) ?? { e, n: 0 }; c.n++; count.set(e.key, c); }
  const ranked = [...count.values()].sort((a, b) => b.n - a.n).map(x => x.e);
  const top = (k: Entity['kind'], n: number) => ranked.filter(e => e.kind === k).slice(0, n);
  const allUrls = review.flatMap(it => it.pre.urls);
  const projectUrls = allUrls.filter(u => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return !GENERIC_DOMAINS.has(h) && !GENERIC_DOMAINS.has(baseDomain(h)); } catch { return false; } });
  const dossier = await buildDossier({
    // After Haiku — a narrower dossier (every tool call re-reads it in full)
    tokens: [...top('evm', 3), ...top('sol', 3)].slice(0, triaged ? 2 : 3).map(e => e.display),
    domains: top('domain', 2).map(e => e.display), xHandles: top('x', triaged ? 1 : 2).map(e => e.display.replace(/^@/, '')),
    urls: projectUrls.slice(0, triaged ? 1 : 2), tickers: top('ticker', 1).map(e => e.display.replace(/^\$/, '')), collections: top('collection', 2).map(e => e.display),
    predictions: top('polymarket', 2).map(e => e.display),
    text: review.map(it => it.msg.text).join('\n'),
    log: { msgId: last.id, source: `${last.sourceServer}/#${last.channel} (batch of ${batch.length})`, trigger: 'chat_batch' },
  }, I.enrich);
  const allowedUrls = new Set([...allUrls, ...dossier.pages.flatMap(p => [p.url, ...(p.links ?? [])]), ...dossier.x.flatMap(x => x.bioUrls ?? []), ...dossier.nft.map(n => `https://opensea.io/collection/${n.slug}`)]);
  for (const n of dossier.nft) {
    const pid = d.store.projectIdsForKeys([`collection:${n.slug.toLowerCase()}`])[0];
    if (pid) for (const t of nftRecheckTimes(n, now)) d.store.addWatch(pid, last.id, t.atUtc, t.reason);
  }

  const projectIds = d.store.projectIdsForKeys(ranked.map(e => e.key)).slice(0, 6);
  const since24h = new Date(now - 86400_000).toISOString();
  const projects = projectIds.filter(id => I.cards.card(id)).slice(0, 4).map(id => {
    const card = I.cards.card(id)!;
    return { name: `${card.name} [keys: ${card.keys.join(', ')}]`, mentions: d.store.mentionStats(card.keys, since24h), lastVerdict: card.lastVerdict, lastThesis: card.lastThesis, lastAnalysisUtc: card.lastAnalysisUtc };
  });
  const buzz = ranked.slice(0, 5).map(e => ({ e, s: d.store.mentionStats([e.key], new Date(now - 3600_000).toISOString()) }))
    .filter(x => x.s.servers >= 2 || x.s.authors >= 3).map(x => `${x.e.display}: ${x.s.authors} authors on ${x.s.servers} servers in the last hour`);
  const risk = d.decide.risk;
  const batchCase: Parameters<typeof buildBatchCaseText>[0] = { server: last.sourceServer, channel: last.channel, reason, messages: review.map(({ idx, msg, trust }) => ({ idx, msg, trust })), total: items.length, projects, buzz, dossier, nowIso: clock.iso(),
    portfolio: { equityUsd: risk.equityUsd, cashUsd: risk.cashUsd, positions: risk.positions.map(p => ({ token: p.token, chain: p.chain, costUsd: p.costUsd })), halted: haltReason(d.decide.cfg, risk) ?? undefined } };
  const user = buildBatchCaseText(batchCase);
  // A-11 shadow (ideas 1 and 4): computed BEFORE the analysis — card state is unchanged; written after, with the old path's cost and verdict
  const shadowPre = (() => {
    try {
      const extra = botCardExtraAddresses(review.map(it => ({ msg: { text: it.msg.text, author: it.msg.author } })));
      const coins = ranked.filter(e => isStrong(e) && !extra.has(e.key)).map(e => {
        const c = I.cards.card(d.store.projectIdsForKeys([e.key])[0] ?? -1);
        const tok = dossier.tokens.find(t => (t.address.startsWith('0x') ? `evm:${t.address.toLowerCase()}` : `sol:${t.address}`) === e.key);
        const prev = Number(d.store.kvGet(`shadow_fdv:${e.key}`) ?? NaN);
        // A batch marks as analysed only the projects the model named — hence also a shadow memory "the model saw the coin in a batch"
        const seen = JSON.parse(d.store.kvGet(`shadow_seen:${e.key}`) ?? 'null') as { at: number; trust: number } | null;
        const lastMs = Math.max(c?.lastAnalysisUtc ? utcMs(c.lastAnalysisUtc) : -Infinity, seen?.at ?? -Infinity);
        return { key: e.key, lastAnalysisMs: Number.isFinite(lastMs) ? lastMs : undefined, lastTrust: Math.max(c?.lastTrust ?? 0, seen?.trust ?? 0) || undefined,
          prevFdv: Number.isFinite(prev) ? prev : undefined, fdv: tok?.market?.fdvUsd, prevVerdict: c?.lastVerdict ?? undefined };
      });
      return { coins, dedup: batchDedup(coins, Math.max(...review.map(it => it.trust.score)), now, I.repeatHours),
        charsBefore: user.length, charsAfter: buildBatchCaseText({ ...batchCase, messages: compactBatch(batchCase.messages) }).length };
    } catch (e) { d.log?.(`cost shadow failed (batch): ${String(e).slice(0, 160)}`); return undefined; }
  })();

  const opened = new Set<string>();
  const r = await runVerdict(d, model, user, makeExec(d, allowedUrls, now, opened), undefined, triaged ? CHAT_REVIEW_TOOLS : undefined, { msgId: last.id, source: `${last.sourceServer}/#${last.channel} (batch of ${batch.length})`, trigger: 'chat_batch' });
  if (triaged) I.budget.record(CHAT_TAG, r.cost);
  /** The shadow event is written with the old path's final verdict (after the code mint rule — review #89 item 2). */
  const writeBatchShadow = (v: string) => {
    if (!shadowPre) return;
    try {
      const prevVerdict = shadowPre.coins.map(c => c.prevVerdict).find(Boolean);
      writeShadow({ idea: 'batch-dedup', wouldSkip: shadowPre.dedup.wouldSkip, costUsd: r.cost, verdict: v, ...(prevVerdict ? { prevVerdict } : {}), msgId: last.id, reason: shadowPre.dedup.reason });
      writeShadow({ idea: 'batch-compact', wouldSkip: false, costUsd: r.cost, verdict: v, msgId: last.id, charsBefore: shadowPre.charsBefore, charsAfter: shadowPre.charsAfter, reason: `${model}${triaged ? ' after triage' : ''}` });
      // The base for the next batch — only if the new path itself would have gone to the model (review #89 item 1: otherwise the "24 h" window and FDV base
      // would shift because of analyses the new path would not have had)
      if (!shadowPre.dedup.wouldSkip) {
        const seenTrust = Math.max(...review.map(it => it.trust.score));
        for (const c of shadowPre.coins) {
          if (c.fdv) d.store.kvSet(`shadow_fdv:${c.key}`, String(c.fdv));
          d.store.kvSet(`shadow_seen:${c.key}`, JSON.stringify({ at: now, trust: Math.max(seenTrust, c.lastTrust ?? 0) }));
        }
      }
    } catch (e) { d.log?.(`cost shadow failed (write): ${String(e).slice(0, 160)}`); }
  };
  const verdict = r.verdict;
  if (verdict) stabilizeVerdict(d, verdict, projectIds);
  if (!verdict) writeBatchShadow('error');
  if (!verdict) {
    d.store.saveAnalysis({ iso: clock.iso(), msgId: last.id, model, trigger: 'chat_batch', verdict: 'error', confidence: 0, json: { toolCalls: r.toolCalls, batch: batch.length }, costUsd: r.cost });
    return { skipped: I.pause?.paused() ? PAUSED_SKIP : 'analyst error', decisions: [] };
  }
  d.store.saveAnalysis({ iso: clock.iso(), msgId: last.id, projectId: projectIds[0], model, trigger: `chat_batch(${batch.length})`, verdict: verdict.verdict, confidence: verdict.confidence, json: { ...verdict, toolCalls: r.toolCalls, usage: r.usage, batch: batch.length }, costUsd: r.cost });
  applyNftMintRule(d, verdict, dossier, last);
  writeBatchShadow(verdict.verdict);
  // Batch: the call is credited to the author of the message that had the address
  if (verdict.verdict !== 'act') journalPassed(d, verdict, dossier, (a) => { const it = items.find(x => x.msg.text.toLowerCase().includes(a.toLowerCase())); return it ? { raw: it.msg, trust: it.trust } : undefined; });
  const maxTrust = Math.max(...items.map(i => i.trust.score));
  // Verdicts — only for projects the analyst named (a batch has many random mentions)
  const named = projectIds.filter(id => { const c = I.cards.card(id); return c && verdict.projects.some(p => c.keys.includes(p.ref.toLowerCase()) || c.keys.includes(p.ref) || c.keys.includes(nameKey(p.ref))); });
  applyProjectVerdicts(d, verdict, named, ranked.map(e => e.key), last.id, maxTrust, undefined, false);

  const out: HandleResult = { decisions: [], analysis: { model, verdict: verdict.verdict, confidence: verdict.confidence, thesis: verdict.thesis, costUsd: r.cost + triageCost, batch: batch.length, risks: verdict.risks } };
  const byIdx = (i?: number) => (i && i >= 1 && i <= items.length ? items[i - 1] : undefined);
  await handleExits(d, verdict, (e) => byIdx(e.sourceIdx)?.trust.score ?? 0, out);
  if (verdict.verdict === 'act' && verdict.confidence < MIN_VERDICT_CONFIDENCE) actSkip(d, out, verdict, `act verdict with confidence ${verdict.confidence} < ${MIN_VERDICT_CONFIDENCE} — no action`);
  else if (verdict.verdict === 'act') await actOnIntents(d, verdict, model, dossier, out, (proposed) => {
    // The action source is message [sourceIdx]; the address must be in it literally (validateIntents checks)
    const target = (proposed.tokenAddress ?? proposed.contractAddress ?? '').toLowerCase();
    // An NFT contract from OpenSea: the source is the message with the link to this collection
    const nftSrc = dossier.nft.find(n => n.contract?.toLowerCase() === target);
    const it = byIdx(proposed.sourceIdx) ?? (target ? [...items].reverse().find(x => x.msg.text.toLowerCase().includes(target)) : undefined)
      ?? (nftSrc ? [...items].reverse().find(x => x.msg.text.toLowerCase().includes(`opensea.io/collection/${nftSrc.slug.toLowerCase()}`)) : undefined);
    if (!it) return undefined;
    // A warning message ("rug", "scam", "avoid") cannot be a buy source — even from a trusted author
    if (NEGATIVE.test(it.msg.text) && proposed.stance !== 'sell') { log(`chat batch: source [${it.idx}] is a warning — not a buy source`); return undefined; }
    return { origin: it.msg, cur: it.msg, resolveTrust: (intent: Intent) => actionTrust(d, it.msg, it.trust, it.msg, intent, verdict.confidence) };
  });
  // Thoughts — after exits and actions; cards — all batch projects (position disclosure and thought key), not only the named ones
  await attachThoughts(d, out, verdict, projectIds, { model, batch: true, chatReview: triaged, dossier, sourceNames: [last.sourceServer, last.channel, ...items.map(it => it.msg.author), ...d.store.sourceNames()],
    // Chat batch: participants' handles are not "discord" candidates (review A-handles R3), only the old thresholds (site, search, smart followers)
    collections: [...ranked.filter(e => e.kind === 'collection').map(e => e.display), ...opened] });
  return out;
}
