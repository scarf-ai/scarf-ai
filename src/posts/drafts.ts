// X post drafts. The owner's rules (2026-10-22):
//  - a post only AFTER a completed action (transaction/registration done) or a finished analysis;
//  - never "leak" a call: do not name the server, channel, author, do not quote Discord;
//  - every token/NFT post discloses whether the agent holds a position;
//  - while on paper or without the owner's "yes" to auto-publishing — only a draft in Telegram.
// Voice — per Brand's examples (brand/cards/posts-v2.json): "[paper]" on trades, position disclosure at the end.
// Thoughts (thought, the owner 2026-10-24): the analyst writes the text (publicNote) — with a source leak the post is not created at all.

export interface PostEvent {
  kind: 'entry' | 'nft_mint' | 'nft_buy' | 'exit' | 'raffle' | 'skip_review' | 'prediction' | 'prediction_exit' | 'thought';
  asset: string;          // ticker / collection name / short address
  chain: string;
  sizeUsd?: number;
  pnlUsd?: number;
  note?: string;          // publicNote from the analyst
  holding: boolean;       // position disclosure
  plan?: string;
  /** thought: act | watch. */
  verdict?: string;
  /** thought: the analyst's confidence is below LOW_CONFIDENCE_BELOW — the post carries a mark (the owner 2026-11-10 13:59 UTC). */
  lowConfidence?: boolean;
  /** Publish only via the button: no timer, even in auto mode (a new-format thought until the format is approved, #86). */
  manualOnly?: boolean;
  /**
   * The full contract address of the token the post is about (the owner 2026-11-11 17:30 UTC: "many tickers are the same, the CA is unique").
   * Taken only from the agent's data (the trade intent, the project card), never from model text.
   */
  ca?: string;
}

/** A thought is published at any confidence; below this threshold — with a mark (the owner 2026-11-10 13:59 UTC, T-05). */
export const LOW_CONFIDENCE_BELOW = 0.6;
export const LOW_CONFIDENCE_NOTE = 'Low confidence on this one.';

/** Words that give away a private source. Source names (servers, channels, authors) are supplied by the caller. */
const LEAK_WORDS = /\b(discord|alpha (group|chat|channel)|private (group|chat|server)|caller|call(ed)? (by|from)|our group|server|channel|whitelist chat)\b/i;

export function leaks(text: string, sourceNames: string[]): string[] {
  const out: string[] = [];
  if (LEAK_WORDS.test(text)) out.push('mentions a private source');
  // "Not a letter/digit" boundaries instead of \b: a name like "caller1" is caught too
  for (const n of sourceNames) if (n && n.replace(/\W/g, '').length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text)) out.push(`names "${n}"`);
  return out;
}

/**
 * Contract address: EVM or Solana; any other value counts as missing.
 * If the chain is known, the address kind must match it: 0x… on Solana or base58 on an EVM chain is a data error, such an address is not published.
 */
export const validCa = (a?: string, chain?: string): a is string => {
  if (!a) return false;
  const evm = /^0x[0-9a-fA-F]{40}$/.test(a); const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  if (chain === 'solana') return sol;
  // No chain named — either kind is fine; any named chain other than Solana is EVM (including a new one in the Chain list)
  if (!chain || chain === 'unknown' || chain === 'perps') return evm || sol;
  return evm;
};

/** Text length as X counts it: characters outside Latin and some punctuation ("…", "−", CJK, emoji) count as two. */
const xw = (cp: number) => (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) ? 1 : 2;
export const xLen = (t: string) => { let n = 0; for (const ch of t) n += xw(ch.codePointAt(0)!); return n; };
/** The start of the text no longer than max as X counts it. */
const xCut = (t: string, max: number) => { let n = 0; let out = ''; for (const ch of t) { n += xw(ch.codePointAt(0)!); if (n > max) break; out += ch; } return out; };

/** Well-known coins and our own token: their ticker in the text does not make the post a "token post". */
const MAJOR_TICKERS = new Set(['ETH', 'WETH', 'BTC', 'WBTC', 'SOL', 'BNB', 'USDC', 'USDT', 'USD', 'DAI', 'HYPE', 'SCARF']);
/** Tickers like $ABC in the text, except well-known ones. "$436k" is not a ticker. */
export const cashtags = (t: string): string[] => [...t.matchAll(/(?<![\p{L}\p{N}_$])\$([\p{L}_][\p{L}\p{N}_]*)/gu)].map(m => m[1].toUpperCase()).filter(x => !MAJOR_TICKERS.has(x));
/** A token post: the ticker is in the name or the text. Such a post does not go out without a contract address (the owner 2026-11-11 17:30 UTC). */
export const needsCa = (asset: string, note: string) => cashtags(`${asset} ${note}`).length > 0;

/**
 * X accepts no more than one cashtag ($SYMBOL) per post — otherwise 403 "Posts are limited to a maximum of one cashtag" (the owner 2026-11-12).
 * Keep one: the ticker of the post's subject if it is in the text, otherwise the first. Strip the "$" from the rest and write the ticker in capitals.
 * Amounts like "$436k" are not cashtags.
 */
export function oneCashtag(text: string, prefer?: string): string {
  const re = /(?<![\p{L}\p{N}_$])\$([\p{L}_][\p{L}\p{N}_]*)/gu;
  const all = [...text.matchAll(re)];
  if (all.length <= 1) return text;
  const want = prefer?.replace(/^\$/, '').toLowerCase();
  let keep = want ? all.findIndex(m => m[1].toLowerCase() === want) : 0;
  if (keep < 0) keep = 0;
  let i = -1;
  // Capitals — Latin only: toUpperCase of "ß" and the like makes the text longer
  return text.replace(re, (m, t: string) => (++i === keep ? m : t.replace(/[a-z]/g, c => c.toUpperCase())));
}

/**
 * The address line in shortened form: "CA: 77Hqxi…xipump (solana)". Only while X rejects full addresses
 * (403 "Crypto addresses are prohibited for the first 7 days after authentication"). Without an address line the text does not change.
 */
export const shortCaLine = (text: string) => text.replace(/\nCA: (\S{20,})( \([^()\n]*\))?$/, (_m, a: string, chain?: string) => `\nCA: ${a.slice(0, 6)}…${a.slice(-6)}${chain ?? ''}`);

/** The contract address line under the post; the chain — so an EVM address is not confused between chains. */
export const caLine = (ca: string | undefined, chain: string) => validCa(ca, chain) ? `\nCA: ${ca}${chain && !['unknown', 'perps'].includes(chain) ? ` (${chain})` : ''}` : '';

/** Text within the limit (as X counts): whole sentences; if even the first does not fit — at a word boundary with "…". */
export function fitText(body: string, max: number): string {
  if (xLen(body) <= max) return body;
  let out = '';
  for (const s of body.split(/(?<=[.!?…])\s+/)) {
    const next = out ? `${out} ${s}` : s;
    if (xLen(next) > max) break;
    out = next;
  }
  if (out.length >= Math.min(60, max)) return out;
  const cut = xCut(body, Math.max(0, max - 2)); const sp = cut.lastIndexOf(' '); // "…" counts as two characters on X
  return `${(sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

/**
 * Full addresses in model text → short ones (0x12ab…cdef): an address from the text is not verified (clones, Brand §4).
 * The agent adds the verified address itself as a separate "CA: …" line (field ca).
 */
export const shortAddrs = (t: string) => t.replace(/\b0x[0-9a-fA-F]{40}\b/g, a => `${a.slice(0, 6)}…${a.slice(-4)}`)
  .replace(/(?<![\w])[1-9A-HJ-NP-Za-km-z]{32,44}(?![\w])/g, a => (/\d/.test(a) && /[a-z]/.test(a) && /[A-Z]/.test(a) ? `${a.slice(0, 4)}…${a.slice(-4)}` : a));

/** First-person claims of a completed action (a thought is published before the action). */
export const CLAIMS_DONE = /\bI(?:'ve| have)?\s+(?:just\s+)?(?:signed up|registered|minted|bought|aped|entered|joined|claimed|staked|deposited|bridged|picked up)\b|\bI\s+(?:hold|own)\b|\bI'm\s+in\b|(?:^|[.!?]\s+)(?:Signed up|Registered|Minted|Bought|Aped into|Entered|Joined|Claimed|Staked|Deposited|Bridged)\b/;

/** Trades are marked "[paper]" while trading is on paper; thoughts and analyses are not (they are not trades). */
export const TRADE_KINDS = new Set(['entry', 'nft_mint', 'nft_buy', 'exit', 'prediction', 'prediction_exit']);

export function draftPost(e: PostEvent, sourceNames: string[]): { text: string; problems: string[] } {
  let note = shortAddrs((e.note ?? '').trim());
  if (e.kind === 'thought') {
    if (!note) return { text: '', problems: ['no public note'] };
    // A thought is published BEFORE the action: the text cannot claim the action is already done (Chirpochain 2026-10-28:
    // "Signed up as a testnet miner…", although there was no registration)
    if (CLAIMS_DONE.test(note)) return { text: '', problems: ['the note claims an action that was not done'] };
    // A token post without a contract address does not go out: a token cannot be identified by its ticker alone (the owner 2026-11-11 17:30 UTC)
    if (needsCa(e.asset, note) && !validCa(e.ca, e.chain)) return { text: '', problems: ['token post without a contract address'] };
    const disclose = e.holding ? 'I hold this.' : 'No position.';
    const tail = e.lowConfidence ? `${LOW_CONFIDENCE_NOTE} ${disclose}` : disclose;
    const ca = caLine(e.ca, e.chain);
    const body = fitText(/[.!?…]$/.test(note) ? note : `${note}.`, 280 - xLen(tail) - 1 - xLen(ca));
    // Look for a source leak in the text without the address line: a channel named "solana" or "base" must not suppress posts about that chain
    // Look for a source leak in the text BEFORE stripping "$": otherwise a source name like "$WAGMI" would stop matching
    const raw = `${body} ${tail}`;
    return { text: `${oneCashtag(raw, e.asset)}${ca}`, problems: leaks(raw, sourceNames) };
  }
  if (note && leaks(note, sourceNames).length) note = ''; // an explanation with a leak is dropped entirely
  const disclose = e.holding ? 'I hold this.' : 'No position now.';
  const lines: string[] = [];
  switch (e.kind) {
    case 'entry': lines.push(`Entered ${e.asset} on ${e.chain}${e.sizeUsd ? ` with $${e.sizeUsd.toFixed(2)}` : ''}.`); break;
    case 'nft_mint': lines.push(`Got 1 ${e.asset} from the public mint on ${e.chain}${e.sizeUsd ? ` for $${e.sizeUsd.toFixed(2)} all-in` : ''}.`); break;
    case 'exit': lines.push(`Closed ${e.asset}${e.pnlUsd !== undefined ? `: ${e.pnlUsd >= 0 ? '+' : '−'}$${Math.abs(e.pnlUsd).toFixed(2)}` : ''}.`); break;
    case 'nft_buy': lines.push(`Bought ${e.asset} on the secondary market${e.sizeUsd ? ` for $${e.sizeUsd.toFixed(2)}` : ''}.`); break;
    case 'raffle': lines.push(`Registered for the ${e.asset} raffle.`); break;
    case 'skip_review': lines.push(`Looked at ${e.asset} and passed.`); break;
    case 'prediction': lines.push(`New prediction bet${e.sizeUsd ? ` ($${e.sizeUsd.toFixed(2)})` : ''}: ${e.asset}`); break;
    case 'prediction_exit': lines.push(`Prediction closed${e.pnlUsd !== undefined ? ` ${e.pnlUsd >= 0 ? '+' : '−'}$${Math.abs(e.pnlUsd).toFixed(2)}` : ''}: ${e.asset}`); break;
  }
  if (note) lines.push(note);
  if (e.plan) lines.push(`Plan: ${e.plan}`);
  // The position line and the contract address are not cut: only the text before them is fitted to the limit. "[paper] " on trades takes 8 chars
  const ca = caLine(e.ca, e.chain);
  const body = fitText(lines.join(' '), 280 - (TRADE_KINDS.has(e.kind) ? 8 : 0) - xLen(disclose) - 1 - xLen(ca));
  const raw = `${body} ${disclose}`;
  return { text: `${oneCashtag(raw, e.asset)}${ca}`, problems: leaks(raw, sourceNames) };
}
