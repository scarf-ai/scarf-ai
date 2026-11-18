// Cheap regex parsing before the LLM: addresses, links, code, functions, chain hints,
// suspicious content and signs of a hacked account.
import type { Chain, Prefiltered } from '../types.js';

const EVM_ADDR = /\b0x[a-fA-F0-9]{40}\b/g;
const EVM_HASH = /\b0x[a-fA-F0-9]{64}\b/g;
const SELECTOR = /(?:([A-Za-z_][A-Za-z0-9_]{1,63})\s*\(\s*)?\b(0x[a-fA-F0-9]{8})\b(?![a-fA-F0-9])/g;
const SOL_MINT = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const URL = /https?:\/\/[^\s<>()"'`\]]+/g;
const CODE_BLOCK = /```[a-z]*\n?([\s\S]*?)```|`([^`\n]+)`/g;
const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,11})\b/g;
const GAS_RANGE = /(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*(?:eth|ETH)\b/;
const GAS_SINGLE = /(\d+(?:[.,]\d+)?)\s*(?:eth|ETH)\s*(?:per\s*tx|gas)/;

const EXPLORER_HINTS: [RegExp, Chain][] = [
  [/etherscan\.io/i, 'ethereum'],
  [/basescan\.org|base\.blockscout|\bbase\b.*\bchain\b/i, 'base'],
  [/arbiscan\.io/i, 'arbitrum'],
  [/bscscan\.com|dexscreener\.com\/bsc|four\.meme|pancakeswap\.finance|gmgn\.ai\/bsc|\bBSC\b|\bBNB\s*chain\b/i, 'bsc'],
  [/robinhoodchain\.blockscout|robinhood\s*chain|\bRH\b/i, 'robinhood'],
  [/solscan\.io|pump\.fun|dexscreener\.com\/solana|photon-sol|bullx|axiom\.trade|gmgn\.ai\/sol|jup\.ag|\bSOL\b|bark\.gg/i, 'solana'],
  [/dexscreener\.com\/ethereum/i, 'ethereum'],
  [/dexscreener\.com\/base/i, 'base'],
  [/dexscreener\.com\/robinhood/i, 'robinhood'],
];

// Phrases addressed to a bot/model are a sign of prompt injection.
const INJECTION = [
  /ignore (all )?(previous|prior) (instructions|rules)/i,
  /\b(system|developer) prompt\b/i,
  /\byou are (an? )?(ai|assistant|agent|bot)\b/i,
  /\b(send|transfer|withdraw) (all|everything|your (funds|balance|tokens))\b/i,
  /\bnew instructions?\b/i,
];
const MORSE = /(?:[.\-]{1,6}\s+){12,}/;
const MORSE_G = /(?:[.\-]{1,6}\s+){12,}/g;
const BASE64_BLOB = /\b[A-Za-z0-9+/]{120,}={0,2}/;
const BASE64_BLOB_G = /\b[A-Za-z0-9+/]{120,}={0,2}/g;

// Signs that the author's account may have been hacked (classic Discord drainer patterns).
const URGENCY = /\b(hurry|asap|last chance|only \d+ (min|minutes|spots)|ending soon|right now|quick(ly)?|fcfs ends)\b/i;
const WALLET_BAIT = /\b(connect (your )?wallet|verify (your )?wallet|claim (your )?(airdrop|allocation|rewards?)|sync wallet|validate wallet|revoke now)\b/i;
const SIGN_BAIT = /\b(permit2?|setapprovalforall|approve all|sign (this|the) message to claim|eip-?7702|delegate your wallet)\b/i;

const uniq = <T,>(a: T[]) => [...new Set(a)];

export function prefilter(text: string): Prefiltered & { compromisedSigns: string[] } {
  const hashes = new Set((text.match(EVM_HASH) ?? []).map(h => h.toLowerCase()));
  const evm = uniq((text.match(EVM_ADDR) ?? []).filter(a => !hashes.has(a.toLowerCase())));

  const urls = uniq((text.match(URL) ?? []).map(u => u.replace(/[.,;:!?]+$/, '')));
  // Solana: base58 32–44, drop what is part of an EVM address/hash and pure digits
  const textNoEvm = text.replace(EVM_HASH, ' ').replace(EVM_ADDR, ' ');
  const sol = uniq((textNoEvm.match(SOL_MINT) ?? []).filter(s => /[A-Za-z]/.test(s) && /\d/.test(s) || s.endsWith('pump')));

  const codeBlocks: string[] = [];
  for (const m of text.matchAll(CODE_BLOCK)) { const c = (m[1] ?? m[2] ?? '').trim(); if (c) codeBlocks.push(c); }

  const functionCalls: Prefiltered['functionCalls'] = [];
  for (const m of textNoEvmHashOnly(text).matchAll(SELECTOR)) functionCalls.push({ name: m[1], selector: m[2].toLowerCase() });

  const chainHints: Chain[] = [];
  for (const [re, ch] of EXPLORER_HINTS) if (re.test(text)) chainHints.push(ch);
  if (sol.some(s => s.endsWith('pump'))) chainHints.push('solana');

  let gasHintEth: Prefiltered['gasHintEth'];
  const g = text.match(GAS_RANGE);
  if (g) gasHintEth = { min: Number(g[1].replace(',', '.')), max: Number(g[2].replace(',', '.')) };
  else { const g1 = text.match(GAS_SINGLE); if (g1) { const v = Number(g1[1].replace(',', '.')); gasHintEth = { min: v, max: v }; } }

  const suspicious: string[] = [];
  for (const re of INJECTION) if (re.test(text)) suspicious.push(`injection-like phrase: ${re.source}`);
  if (MORSE.test(text)) suspicious.push('morse-like sequence');
  if (BASE64_BLOB.test(text)) suspicious.push('long base64-like blob');

  const compromisedSigns: string[] = [];
  if (WALLET_BAIT.test(text) && URGENCY.test(text) && urls.length) compromisedSigns.push('wallet-connect/claim bait + urgency + link');
  if (SIGN_BAIT.test(text)) compromisedSigns.push('asks to sign permit/approve-all/7702');
  if (/discord\.(gg|com\/invite)\//i.test(text) && WALLET_BAIT.test(text)) compromisedSigns.push('discord invite + wallet bait');

  const ethAmounts = uniq([...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:eth|ETH)\b/g)].map(m => Number(m[1].replace(',', '.'))).filter(Number.isFinite));
  const tickers = uniq([...text.matchAll(TICKER)].map(m => m[1].toUpperCase()));
  const isChatter = !evm.length && !sol.length && !urls.length && !codeBlocks.length && !functionCalls.length && !tickers.length;

  return { evmAddresses: evm, solanaMints: sol, urls, codeBlocks, functionCalls, chainHints: uniq(chainHints),
    gasHintEth, suspicious, isChatter, tickers, ethAmounts, compromisedSigns };
}

function textNoEvmHashOnly(t: string) { return t.replace(EVM_HASH, ' ').replace(EVM_ADDR, ' '); }

/** Text sent to the LLM: trim length and cut out suspicious blocks. */
export function sanitizeForLlm(text: string, maxLen = 4000): string {
  return text.replace(BASE64_BLOB_G, '[removed: base64-like blob]').replace(MORSE_G, '[removed: morse-like sequence]').slice(0, maxLen);
}
