// Entities in a message found by code (without a model): addresses, tickers, domains, X accounts,
// NFT collections. Keys are normalized — mentions across servers are counted by them.
import type { Prefiltered } from '../types.js';

/** Domains that are not a project by themselves (aggregators, social networks, explorers). */
export const GENERIC_DOMAINS = new Set(['x.com', 'twitter.com', 't.me', 'discord.com', 'discord.gg', 'dexscreener.com', 'etherscan.io', 'basescan.org',
  'arbiscan.io', 'solscan.io', 'pump.fun', 'gmgn.ai', 'birdeye.so', 'jup.ag', 'uniswap.org', 'robinhoodchain.blockscout.com', 'geckoterminal.com',
  'coingecko.com', 'youtube.com', 'youtu.be', 'github.com', 'medium.com', 'mirror.xyz', 'bark.gg', 'klipy.com', 'opensea.io', 'magiceden.io',
  'tenor.com', 'giphy.com', 'imgur.com', 'cdn.discordapp.com', 'media.discordapp.net', 'photon-sol.tinyastro.io', 'axiom.trade', 'bullx.io',
  'google.com', 'docs.google.com', 'notion.so', 'linktr.ee', 'galxe.com', 'zealy.io', 'layer3.xyz',
  // trading terminals, bots and exchanges are tools, not projects (2026-10-23: they ended up in "watching")
  'rick.bot', 'defined.fi', 'padre.gg', 'okx.com', 'binance.com', 'bybit.com', 'coinbase.com', 'kraken.com', 'mexc.com', 'gate.io', 'bitget.com',
  'tradingview.com', 'polymarket.com', 'debank.com', 'arkm.com', 'arkhamintelligence.com', 'phantom.app', 'phantom.com', 'metamask.io', 'rabby.io', 'bonkbot.io',
  'trojan.app', 'maestrobots.com', 'bananagun.io', 'photon-sol.com', 'dextools.io', 'coinmarketcap.com', 'defillama.com', 'hyperliquid.xyz',
  'app.hyperliquid.xyz', 'blur.io', 'tensor.trade', 'x.ai', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'reddit.com', 'tiktok.com', 'instagram.com',
  // links from scanner-bot cards (log 29.10–10.11, A-05): terminals, explorers, launchpads — each gave a "new key"
  'trojan.com', 'raydium.io', 'cielo.finance', 'dexcheck.io', 'codex.io', 'basedbot.app', 'otcdesks.cash', 'blockscan.com', 'bscscan.com',
  'hyperevmscan.io', 'flap.sh']);

export type EntityKind = 'evm' | 'sol' | 'ticker' | 'domain' | 'x' | 'collection' | 'me_collection' | 'polymarket' | 'name';
export interface Entity { kind: EntityKind; key: string; display: string }

/**
 * Scanner bots that sign their Discord cards with their own X (log 2026-10-29: the @RickBurpBot profile was requested
 * in 10 analyses in a row, for a card without a project X the whole X research went to @rick, and in a chat batch the bot mentioned
 * most often took the only X slot in the dossier). It is a tool, not a project (like rick.bot in GENERIC_DOMAINS):
 * not an entity, not a mention key, not X research.
 */
export const SCANNER_BOT_HANDLES = new Set(['rick', 'rickburpbot']);
export const notScannerBot = (h: string) => !SCANNER_BOT_HANDLES.has(h.replace(/^@/, '').toLowerCase());

const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return undefined; } };
/** Registrable domain: app.swapnest.xyz → swapnest.xyz (precise enough for .co.uk and the like). */
export const baseDomain = (h: string) => h.split('.').slice(-2).join('.');

/**
 * Addresses that appear in the text ONLY as service links of a scanner-bot card, not as a token (A-05):
 * holder wallets (solscan.io/account/…, links labelled with a percentage "TH: [3.7](…)"), the developer wallet
 * (creatorAddress=…), the pair address in a DexScreener link when the token itself is in the text. Log 29.10–10.11: because of them
 * a Rick card under a person's call looked like a "new project" — 15 of 16 Opus analyses of such cards were repeats.
 * Only for project keys and the dossier: the trade address check (prefilter) is not affected.
 */
/** Scanner bots by message author (Rick, ServerB, Bark…). */
export const SCANNER_BOT_AUTHORS = new Set(['rick', 'rickburpbot', 'serverb', 'bark', 'bark tools', 'phanes', 'maestro']);
/** A recognized bot card: Rick's signature (t.me/rick?start=…) or a holders line "TH: [3.7](…)". */
export const looksLikeBotCard = (text: string) => /t\.me\/rick\?start=/i.test(text) || /\bTH:\s*\[[\d.,%]+\]\(/.test(text);
/** A scanner-bot message: an author from the bot list or a forwarded bot card (acceptance #64, round 2: rule A-05 applies only to them). */
export const isScannerBotMessage = (author: string, text: string) => SCANNER_BOT_AUTHORS.has(author.trim().toLowerCase()) || looksLikeBotCard(text);

export function auxiliaryAddresses(text: string, addrs: string[], parts: string[] = [text]): Set<string> {
  const lc = text.toLowerCase();
  const count = (re: RegExp, s = lc) => (s.match(re) ?? []).length;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates: string[] = [];
  // An address from a DexScreener link is a "pair" only in a recognized bot card. For a person a DexScreener link is the usual way
  // to share a token ("rotating into https://dexscreener.com/solana/<new>"): when in doubt the address stays a key (acceptance #64, round 2).
  // The card is searched in message parts (own text, reply quote), not the whole text: a person's links in a reply to a Rick
  // card are theirs, not service links (acceptance #64, round 3, X1). A link with a numeric label "[1](…)" is a service link only inside a card too (X6)
  const segs = parts.map(p => ({ lc: p.toLowerCase(), card: looksLikeBotCard(p) }));
  for (const a of addrs) {
    const x = esc(a.toLowerCase());
    const all = count(new RegExp(x, 'g'));
    const walletRe = (card: boolean) => new RegExp(`solscan\\.io/account/${x}${card ? `|\\[[\\d.,%]+\\]\\(https?://[^)\\s]*${x}` : ''}|creatoraddress=${x}`, 'g');
    const wallet = segs.reduce((n, p) => n + count(walletRe(p.card), p.lc), 0);
    const pair = segs.reduce((n, p) => n + (p.card ? count(new RegExp(`dexscreener\\.com/[a-z0-9-]+/${x}`, 'g'), p.lc) : 0), 0);
    if (all && wallet + pair === all) candidates.push(a);
  }
  // Service addresses are struck out only if another, non-service address (the token itself) remains in the text. Otherwise the service link is
  // the only trace of the token ("check https://solscan.io/account/<mint>", "[1](https://pump.fun/<mint>)"): it must not be lost
  // (acceptance #64, round 1: without a key there is no card, no repeat protection and no analysis in scan-feed)
  return addrs.some(a => !candidates.includes(a)) ? new Set(candidates) : new Set<string>();
}

/**
 * ctx.parts — message parts (own text, reply quote) that text is joined from; ctx.scannerBot — a scanner-bot message
 * (default — a bot card in the text itself).
 */
export function codeEntities(text: string, pre: Prefiltered, ctx: { parts?: string[]; scannerBot?: boolean } = {}): Entity[] {
  const out = new Map<string, Entity>();
  const add = (e: Entity) => { if (!out.has(e.key)) out.set(e.key, e); };
  const aux = auxiliaryAddresses(text, [...pre.evmAddresses, ...pre.solanaMints], ctx.parts);
  const scannerBot = ctx.scannerBot ?? looksLikeBotCard(text);
  for (const a of pre.evmAddresses) if (!aux.has(a)) add({ kind: 'evm', key: `evm:${a.toLowerCase()}`, display: a });
  for (const a of pre.solanaMints) if (!aux.has(a)) add({ kind: 'sol', key: `sol:${a}`, display: a });
  for (const t of pre.tickers) add({ kind: 'ticker', key: `ticker:${t.toLowerCase()}`, display: `$${t}` });
  for (const u of pre.urls) {
    const h = host(u); if (!h) continue;
    const x = u.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
    // A tweet link (…/status/<id>) in a scanner-bot message — the tweet author is not a project key: that is how bot cards quote other people's
    // posts (acceptance #64). For a person a tweet is the usual way to share a new project or an official X (acceptance #64, round 3, X2/X3)
    const tweet = scannerBot && /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\//i.test(u);
    if (x && !tweet && !['i', 'home', 'search', 'intent', 'share', 'hashtag'].includes(x[1].toLowerCase()) && notScannerBot(x[1])) add({ kind: 'x', key: `x:${x[1].toLowerCase()}`, display: `@${x[1]}` });
    // OpenSea: code later requests the drop by slug. Magic Eden is a separate kind: OpenSea is not queried for it
    // (otherwise a same-named collection on OpenSea would substitute its own contract).
    const os = u.match(/opensea\.io\/collection\/([a-z0-9-]+)/i);
    if (os) add({ kind: 'collection', key: `collection:${os[1].toLowerCase()}`, display: os[1] });
    const me = u.match(/magiceden\.io\/(?:[a-z-]+\/)*(?:collections|marketplace|launchpad)\/(?:[a-z]+\/)?([a-z0-9_-]+)/i);
    if (me) add({ kind: 'me_collection', key: `me:${me[1].toLowerCase()}`, display: me[1] });
    // Polymarket: the key is the specific market if it is in the link, otherwise the event; display — "event/market" for the data request
    const pm = u.match(/polymarket\.com\/(event|market)\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?/i);
    if (pm) { const ev = pm[1].toLowerCase() === 'event' ? pm[2].toLowerCase() : ''; const mk = (pm[1].toLowerCase() === 'market' ? pm[2] : pm[3] ?? '').toLowerCase();
      add({ kind: 'polymarket', key: `pm:${mk || ev}`, display: `${ev}/${mk}` }); }
    const bd = baseDomain(h);
    if (!GENERIC_DOMAINS.has(h) && !GENERIC_DOMAINS.has(bd)) add({ kind: 'domain', key: `domain:${bd}`, display: bd });
  }
  // @handle is an X account; @role/@user/@everyone are Discord mention placeholders, not accounts
  for (const m of text.matchAll(/(?<![\w@.])@([A-Za-z0-9_]{2,15})\b/g)) {
    if (['role', 'user', 'everyone', 'here', 'channel'].includes(m[1].toLowerCase()) || !notScannerBot(m[1])) continue;
    add({ kind: 'x', key: `x:${m[1].toLowerCase()}`, display: `@${m[1]}` });
  }
  return [...out.values()];
}

/** Key for a project name from the model (checked that the name is in the text). */
export const nameKey = (name: string) => `name:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;

/** Strong identifiers: address, collection. Project cards are merged by them. */
export const isStrong = (e: Entity) => e.kind === 'evm' || e.kind === 'sol' || e.kind === 'collection' || e.kind === 'me_collection' || e.kind === 'polymarket';

/** Splits a message into blocks: blank lines, "=====", "-----", "***" lines. */
export function splitBlocks(text: string): string[] {
  return text.split(/\n\s*(?:[=\-*_~]{3,}\s*)?\n|\n\s*[=\-*_~]{3,}\s*(?:\n|$)/).map(b => b.trim()).filter(Boolean);
}
