// Code triggers for chat channels: cheap rules without a model. They are
//  - hard — the message goes to the analyst in any case;
//  - soft — give points; together with the Haiku score they are compared with the server threshold.
// Server profiles (server/config/gate.json): in ServerA NFT matters more, in ServerB — memecoins, etc.
import { readFileSync, existsSync } from 'node:fs';
import type { Prefiltered, RawMessage, TrustResult } from '../types.js';
import type { Entity } from '../intel/entities.js';
import type { Store } from '../store/db.js';

export type Topic = 'memecoin' | 'nft' | 'defi' | 'points' | 'listing' | 'infra' | 'other' | 'none';

export interface ServerProfile {
  /** Threshold of the soft-point sum for sending to the analyst. */
  escalateScore: number;
  /** The same thing mentioned by ≥ authors different people on this server within minutes minutes. */
  buzzSingleServer: { authors: number; minutes: number };
  /** The same thing mentioned on ≥ servers different servers within minutes minutes. */
  buzzCrossServer: { servers: number; minutes: number };
  /** Points multiplier by topic (e.g. ServerA: nft ×1.3). */
  topicBoost: Partial<Record<Topic, number>>;
  /** Minimum author score at which any substantive message goes to the analyst. */
  trustedAuthorScore: number;
}

export interface GateConfig {
  default: ServerProfile;
  servers: Record<string, Partial<ServerProfile>>;
  /** Analyst model per "server/channel" (the owner's decision: memecoin scans get the cheapest model). */
  channelModels: Record<string, string>;
  /** Scanner channels: code checks the token before the model (free); junk never reaches the model. */
  scanChannels: string[];
  scanPrefilter: { minLiquidityUsd: number; minBuys24h: number; minSells24h: number };
}

/** Example values — set your own in server/config/gate.json (sources, channels and thresholds). */
export const DEFAULT_GATE: GateConfig = {
  default: {
    escalateScore: 4,
    buzzSingleServer: { authors: 4, minutes: 20 },
    buzzCrossServer: { servers: 2, minutes: 45 },
    topicBoost: {},
    trustedAuthorScore: 8,
  },
  servers: {
    servera: { topicBoost: { nft: 1.3 } },
    serverb: { topicBoost: { memecoin: 1.3 } },
  },
  channelModels: { 'serverb/scan-feed': 'claude-haiku-5-5', 'servera/token-chat': 'claude-haiku-5-5' },
  scanChannels: ['serverb/scan-feed', 'servera/token-chat'],
  scanPrefilter: { minLiquidityUsd: 8000, minBuys24h: 15, minSells24h: 1 },
};

export function loadGateConfig(path: string): GateConfig {
  if (!existsSync(path)) return DEFAULT_GATE;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const lower = (o: Record<string, any> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  return { default: { ...DEFAULT_GATE.default, ...(raw.default ?? {}) }, servers: { ...DEFAULT_GATE.servers, ...lower(raw.servers) },
    channelModels: Object.fromEntries(Object.entries({ ...DEFAULT_GATE.channelModels, ...lower(raw.channelModels) }).filter(([k]) => !k.startsWith('_'))),
    scanChannels: (raw.scanChannels ?? DEFAULT_GATE.scanChannels).map((x: string) => x.toLowerCase()),
    scanPrefilter: { ...DEFAULT_GATE.scanPrefilter, ...(raw.scanPrefilter ?? {}) } };
}

export function profileFor(cfg: GateConfig, server: string): ServerProfile {
  const s = cfg.servers[server.toLowerCase()] ?? {};
  return { ...cfg.default, ...s, topicBoost: { ...cfg.default.topicBoost, ...(s.topicBoost ?? {}) } };
}

// Category words. Case-insensitive, whole words.
export const TOPIC_WORDS: [Topic, RegExp][] = [
  ['nft', /\b(mint(ing|ed)?|wl|whitelist|allow ?list|fcfs|gtd|supply|reveal|floor|collection|pfp|opensea|magic ?eden|free ?mint|public ?sale|phase \d)\b/i],
  ['points', /\b(points?|snapshot|tge|airdrop|season \d|epoch|farm(ing)?|allocation|checker|eligib(le|ility)|claim(ing)? (is )?live)\b/i],
  ['listing', /\b(binance|coinbase|upbit|bybit|okx|bithumb|robinhood (listing|lists)|listing|listed|delist)\b/i],
  ['infra', /\b(mainnet|testnet|launch(ing|ed)?|deployed|went live|is live|beta|v2|v3|bridge (is )?open)\b/i],
  ['memecoin', /\b(ape[ds]?|aping|send(ing)? it|pump(ing)?|moon(ing)?|\d+x|mc|mcap|market ?cap|bonding|migrat(ed|ion)|dev (sold|bought)|ca\b|cto)\b/i],
];
export const NEGATIVE = /\b(rug(ged|pull)?|scam|honeypot|exploit(ed)?|hack(ed)?|drain(ed|er)?|dev (sold|dumped)|dump(ing|ed)|compromised|fake|phish(ing)?|stay away|avoid)\b/i;

export function topicsOf(text: string): Topic[] { return TOPIC_WORDS.filter(([, re]) => re.test(text)).map(([t]) => t); }

export interface TriggerHit { name: string; weight: number; hard?: boolean; detail?: string }

export interface TriggerInput {
  msg: RawMessage; pre: Prefiltered; trust: TrustResult; entities: Entity[]; profile: ServerProfile;
  store: Store; nowMs: number;
  /** Keys of entities the agent holds a position in (addresses + their card keys). */
  heldKeys: Set<string>;
}

export function computeTriggers(x: TriggerInput): { hits: TriggerHit[]; hard: boolean; score: number; topics: Topic[] } {
  const { msg, pre, trust, entities, profile, store, nowMs } = x;
  const hits: TriggerHit[] = [];
  const text = `${msg.text}`;
  const topics = topicsOf(text);
  const boost = Math.max(1, ...topics.map(t => profile.topicBoost[t] ?? 1));

  // 1. Actionable specifics: contract address, function with a selector, code block
  if (pre.evmAddresses.length || pre.solanaMints.length) hits.push({ name: 'contract_address', weight: 3, hard: true });
  if (pre.functionCalls.some(f => f.selector) || pre.codeBlocks.length) hits.push({ name: 'code_or_function', weight: 3, hard: true });

  // 2. A trusted author talks about something specific
  const substantive = !pre.isChatter || topics.length > 0 || text.trim().split(/\s+/).length >= 6;
  if (trust.score >= profile.trustedAuthorScore && substantive) hits.push({ name: 'trusted_author', weight: 3, hard: true, detail: `score ${trust.score}` });

  // 3. Bad news about something the agent holds
  const keys = entities.map(e => e.key);
  const strongHeld = [...x.heldKeys].filter(k => /^(evm|sol|collection):/.test(k));
  const aboutHeld = keys.some(k => x.heldKeys.has(k)) || (msg.replyToText ? strongHeld.some(k => msg.replyToText!.toLowerCase().includes((k.split(':')[1] ?? '\u0000').toLowerCase())) : false);
  if (aboutHeld && NEGATIVE.test(text)) hits.push({ name: 'held_position_negative', weight: 5, hard: true });
  else if (aboutHeld) hits.push({ name: 'held_position_mention', weight: 1 });

  // 4. Buzz on one server (NFT calls in ServerA etc.) and on several servers (memecoins)
  if (keys.length) {
    const s1 = store.mentionStats(keys, new Date(nowMs - profile.buzzSingleServer.minutes * 60_000).toISOString(), msg.sourceServer);
    if (s1.authors >= profile.buzzSingleServer.authors) hits.push({ name: 'buzz_single_server', weight: 2 * boost, detail: `${s1.authors} authors in ${profile.buzzSingleServer.minutes} min` });
    const s2 = store.mentionStats(keys, new Date(nowMs - profile.buzzCrossServer.minutes * 60_000).toISOString());
    if (s2.servers >= profile.buzzCrossServer.servers) hits.push({ name: 'buzz_cross_server', weight: 3, detail: `servers: ${s2.serverList.join(', ')}` });
  }

  // 5. Categories: mint/WL/price, points/snapshot/TGE, listings, protocol launches
  for (const t of topics) if (t !== 'memecoin') hits.push({ name: `topic_${t}`, weight: 1 * (profile.topicBoost[t] ?? 1) });
  if (topics.includes('memecoin') && keys.length) hits.push({ name: 'topic_memecoin', weight: 1 * (profile.topicBoost.memecoin ?? 1) });
  // Mint time and price in the text are a strong sign of an NFT call
  if (topics.includes('nft') && (/\b\d{1,2}(:\d{2})?\s?(utc|est|pst|cet|am|pm)\b/i.test(text) || pre.ethAmounts.length)) hits.push({ name: 'mint_time_or_price', weight: 1.5 * boost });

  // 6. A project link (not an aggregator) + a topic
  if (entities.some(e => e.kind === 'domain' || e.kind === 'collection' || e.kind === 'x') && topics.length) hits.push({ name: 'project_link', weight: 1 });

  // 7. A reply to a message with an address/link — the call discussion continues
  if (msg.replyToText && /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|https?:\/\//.test(msg.replyToText)) hits.push({ name: 'reply_to_call', weight: 1 });

  // 8. A scam warning (may protect from losses) — soft; from trusted authors it is already hard above
  if (NEGATIVE.test(text) && keys.length) hits.push({ name: 'warning_words', weight: 2 });

  const score = hits.reduce((a, h) => a + h.weight, 0);
  return { hits, hard: hits.some(h => h.hard), score, topics };
}
