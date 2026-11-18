// E-06 (#16): a session on a task site WITHOUT money and without the model. Part 1 — the application form; part 2 — connecting a burner wallet and signing a message (siteWallet.ts).
// What it does: opens the task site, fills the application form with the agent's values (X handle, burner wallet address),
// presses "next / submit", saves the confirmation. Anything that requires a wallet, a signature, money or actions on X — a stop with a reason.
//
// Boundaries (the HQ comment in #16 of 2026-11-12 and the owner's decision 2026-11-11 08:02 UTC) are hard-coded, not in the model prompt:
//  • only values from the SessionValues list go into fields — code substitutes them; text from the page or from a message is never typed anywhere;
//  • clicks that look like a wallet, a signature, a deposit or a purchase are not made: the session stops ("that is E-13");
//  • the session lives only on the task domain; outbound links are not opened (links to X are recorded as X tasks);
//  • passwords, seed phrases, e-mail, phone — are never filled;
//  • captcha — a stop: this is one of the three cases when we call a human.
// This file is pure logic (no browser): tests check it with a fake driver. The browser — src/exec/siteBrowser.ts.

import type { WalletEvent, WalletRequest, WalletResponse } from './siteWallet.js';

export type ElementKind = 'input' | 'checkbox' | 'button' | 'link' | 'select' | 'radio' | 'option';
/** A page element something can be done with. The driver issues the id, it is valid until the next observe(). */
export interface SiteElement {
  id: string; kind: ElementKind; label: string; inputType?: string; value?: string; checked?: boolean; href?: string; disabled?: boolean;
  // #148 item 2 — what the real browser driver reports (the fake driver in tests may not have these fields):
  /** Form group: fields and buttons of one form share one value. None — the element is outside forms. */
  form?: string;
  /** The field is required (required, aria-required, an asterisk in the label). */
  required?: boolean;
  /** A form submit button (type=submit). */
  submit?: boolean;
  /** An element in the header, navigation or footer: search, newsletter subscription, social links — not part of the task. */
  chrome?: boolean;
  /** The element is covered by another one (banner, modal): a click would not land on it. */
  covered?: boolean;
  /** A consent button in a cookie banner. */
  cookie?: boolean;
  /** List options (select). */
  options?: string[];
  /** Group name for switches (radio) and options (option). */
  group?: string;
}
/** scoped — the driver marked up forms (form / required / chrome): the planner fills only fields of forms with a submit button. */
export interface Observation { url: string; title?: string; text: string; elements: SiteElement[]; scoped?: boolean }

/** What the agent may type into a field. There are no other values: the planner picks the key, code substitutes the value itself. */
export type ValueKey = 'x_handle' | 'evm_address' | 'sol_address';
export interface SessionValues { xHandle?: string; evmAddress?: string; solAddress?: string }

export type SiteAction =
  | { kind: 'fill'; el: string; value: ValueKey }
  | { kind: 'click'; el: string }
  /** Choosing an option in a list (select): only from the list's own options. */
  | { kind: 'select'; el: string; option: string }
  | { kind: 'done'; note: string }
  /** code — a stop the rules could not handle but the model might (#148 item 3). Without a code — the stop is final. */
  | { kind: 'stop'; reason: string; needsHuman?: 'captcha'; code?: StopCode };

/**
 * Rule stop codes after which the model is called (the fallback, the owner's decision 2026-11-17 18:14 UTC). Only these five.
 * Captcha, money, a wallet refusal, X tasks, secret fields, leaving the site, step and time limits — a stop without a code and without the model.
 */
export type StopCode = 'unknown_field' | 'no_next' | 'no_progress' | 'unsupported_type' | 'wallet_no_step'
  /** The form is already submitted, no confirmation visible (the form is empty again or the same button again): not done and not a second submit. The model is not called. */
  | 'submitted_unconfirmed';
/** Codes after which the model is called. Other codes (submitted_unconfirmed) — for the journal and the result, the stop is final. */
export const MODEL_CALL_CODES: readonly StopCode[] = ['unknown_field', 'no_next', 'no_progress', 'unsupported_type', 'wallet_no_step'];
/** Who chose the action and what it cost (for the journal). */
export interface StepMeta { by?: 'rules' | 'haiku' | 'sonnet'; /** The model's explanation, ≤ 200 characters. */ why?: string; /** Model spend on this step, $. */ usd?: number; /** Hash of the page snapshot shown to the model. */ snapshot?: string; /** Model answers rejected by code before this step. */ rejected?: string[] }

export interface SiteDriver {
  open(url: string): Promise<void>;
  observe(): Promise<Observation>;
  fill(el: string, text: string): Promise<void>;
  click(el: string): Promise<void>;
  /** Choose a list option by its text. A driver without this method does not choose in lists. */
  select?(el: string, option: string): Promise<void>;
  /** A screenshot for the journal; undefined — the driver cannot. */
  screenshot?(): Promise<Uint8Array | undefined>;
  /**
   * Part 2: give the page the session wallet (window.ethereum / window.solana), whose requests SiteWallet decides. Called before open().
   * A driver without this method gives no wallet — the session runs as in part 1 (wallet buttons are not pressed).
   */
  attachWallet?(w: PageWallet): void;
  close(): Promise<void>;
}

/** The session wallet as seen by the driver and the loop (implementation — SiteWallet in siteWallet.ts). */
export interface PageWallet {
  readonly evmAddress?: string; readonly solAddress?: string; readonly solPublicKey?: Uint8Array;
  readonly blocked?: string; readonly isConnected: boolean; readonly signed: WalletEvent[]; readonly events: WalletEvent[];
  request(q: WalletRequest): Promise<WalletResponse>;
}
/** What the planner knows about the wallet: whether there is one and what has been done. No addresses or keys here. */
export interface WalletView { evm: boolean; sol: boolean; connected: boolean; signed: number }

/** Who chooses the next action. The first version — formPlanner (rules, no model); later — the model for games and complex tasks. */
export interface PlannerContext { values: SessionValues; steps: SessionStep[]; xTasks: string[]; wallet?: WalletView; /** The task site's host (for checking actions). */ siteHost?: string;
  /** Session pages by step number (the observation the step was chosen from). For "done": what was on the page before the form was submitted. */
  pages?: ReadonlyMap<number, Observation> }
export type PlannedAction = SiteAction & { meta?: StepMeta };
export interface SessionPlanner { next(o: Observation, ctx: PlannerContext): Promise<PlannedAction> | PlannedAction }

export interface SessionStep extends StepMeta { n: number; url: string; action: SiteAction; label?: string; refused?: string }
export interface SessionResult {
  /** done — the form was submitted and the site confirmed it; stopped — a stop by rule (the reason is in reason); error — a browser or site failure. */
  status: 'done' | 'stopped' | 'error';
  reason?: string;
  /** The rule stop code (if any): e.g. submitted_unconfirmed — the form was submitted, no confirmation visible. */
  code?: StopCode;
  needsHuman?: 'captcha';
  confirmation?: string;
  /** X tasks the site asks to do (follow / repost): the session does not do them, only lists them. */
  xTasks: string[];
  steps: SessionStep[];
  finalUrl?: string;
  screenshot?: Uint8Array;
  /** Part 2: what the site asked the session wallet for — connection, signed messages (with text), refusals. For the journal. */
  wallet?: { connected: boolean; events: WalletEvent[] };
  /** Model spend for the session, $ (the fallback; rules — 0). */
  modelUsd?: number;
  ms: number;
}
export interface SessionLimits { maxSteps: number; maxMs: number }
export const DEFAULT_SESSION_LIMITS: SessionLimits = { maxSteps: 25, maxMs: 3 * 60_000 };

// ── Rules ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Second-level domain (as in src/analyst/browser.ts): app.site.xyz and www.site.xyz are one site. */
/**
 * Shared suffixes under which every holder has their own site (hostings and two-level country zones): "the same site" here is three levels,
 * not two, otherwise any site on vercel.app would count as the task site (acceptance #143). The list is short and built in: we install no packages;
 * a suffix outside the list gives the previous "two levels" rule.
 */
const SHARED_SUFFIXES = new Set(['vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'github.io', 'gitlab.io', 'web.app', 'firebaseapp.com', 'herokuapp.com',
  'onrender.com', 'fly.dev', 'railway.app', 'up.railway.app', 'surge.sh', 'glitch.me', 'replit.app', 'repl.co', 'webflow.io', 'framer.app', 'framer.website', 'carrd.co',
  'notion.site', 'gitbook.io', 'typeform.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'appspot.com', 'run.app', 'ngrok.io', 'ngrok-free.app', 'deno.dev',
  'wixsite.com', 'blogspot.com', 'wordpress.com', 'substack.com', 'co.uk', 'org.uk', 'com.au', 'co.jp', 'co.kr', 'com.br', 'com.cn', 'com.tr', 'co.in', 'com.sg', 'co.nz', 'com.hk']);
/** Site name for the "same site" rule: the last two levels, and under a shared suffix (hosting, country zone) — three. */
export const registrable = (host: string) => {
  const parts = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '').split('.');
  const n = parts.length >= 4 && SHARED_SUFFIXES.has(parts.slice(-3).join('.')) ? 4 : parts.length >= 3 && SHARED_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
};
const hostOf = (url: string): string | undefined => { try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : undefined; } catch { return undefined; } };
/** Does the URL belong to the task site? Only http(s) and the same second-level domain. */
export function sameSite(url: string, siteHost: string): boolean { const h = hostOf(url); return !!h && registrable(h) === registrable(siteHost); }

/** Buttons and links behind which there is a wallet, a signature or money. The first version may not press them — that is E-13. */
export const MONEY_RE = /\b(connect(\s+a|\s+your)?\s+wallet|wallet\s*connect|metamask|phantom|rabby|coinbase wallet|sign\s+in\s+with\s+(ethereum|solana|(a\s+|your\s+)?wallet|metamask|phantom)|sign(?!\s*(up|in|out)\b)|approve|deposit|withdraw|buy|sell|swap|bridge|pay|purchase|checkout|stake|unstake|mint|claim|trade|add funds|top up|fund)\b/i;
/**
 * Part 2 (the owner's decision 2026-11-17): with the session wallet, wallet-connect and message-signing buttons are allowed. What exactly
 * gets signed is decided not by the button but by the wallet (SiteWallet): it will reject a transaction or a token permission and stop the session.
 */
export const WALLET_STEP_RE = /\b(connect(\s+a|\s+your)?\s+wallet|link\s+(a\s+|your\s+)?wallet|scarf wallet|metamask|browser wallet|injected(\s+wallet)?|detected wallet|phantom|sign\s+in\s+with\s+(ethereum|solana|(a\s+|your\s+)?wallet|metamask|phantom)|sign(\s+(a|the))?\s+message|sign\s+to\s+(verify|continue|confirm|prove)|verify\s+(your\s+|my\s+)?(wallet|ownership|address)|^sign$)\b/i;
/** Money in any form: not pressed even with the session wallet — that is E-13. */
export const HARD_MONEY_RE = /\b(wallet\s*connect|rabby|coinbase wallet|ledger|trezor|approve|deposit|withdraw|buy|sell|swap|bridge|pay|purchase|checkout|stake|unstake|mint|claim|trade|add funds|top up|fund)\b/i;
/** A wallet step button that a session with a wallet may press. */
export const walletStep = (label: string) => {
  const n = normLabel(label);
  return (WALLET_STEP_RE.test(n) || WALLET_STEP_I18N_RE.test(n)) && !mixedScript(n) && !checkForms(n).some(t => HARD_MONEY_RE.test(t) || MONEY_I18N_RE.test(t) || MONEY_I18N2_RE.test(t));
};
/** "Connect wallet" and "sign message" in other languages. */
export const WALLET_STEP_I18N_RE = /conectar (la |a |sua |tu )?(billetera|cartera|carteira|wallet)|firmar (el )?mensaje|assinar (a )?mensagem|подключить кошел[её]к|привязать кошел[её]к|подписать сообщение|连接钱包|链接钱包|签名消息|签署消息|지갑 연결|메시지 서명|c[üu]zdan(ı)? ba[ğg]la|mesaj(ı)? imzala/i;
/**
 * The same "money" words in other languages (es / pt / ru / zh / ko / tr) — #148 item 2. Without \b: JS has no word boundaries for Cyrillic
 * and CJK. Words like "onayla" (both "confirm" and "approve") are counted as money: an extra refusal is safer than an extra click.
 */
export const MONEY_I18N_RE = /comprar|vender|depositar|dep[oó]sito|retirar|reclamar|reivindicar|acu[ñn]ar|mintear|aprobar|aprovar|intercambiar|trocar|pagar|купить|продать|депозит|внести|пополнить|вывести|вывод средств|забрать|получить награду|минт|заминтить|одобрить|разрешить списание|обменять|оплатить|стейк|购买|出售|存款|充值|提款|提现|领取|铸造|授权|兑换|支付|质押|구매|판매|입금|출금|청구|민팅|승인|스왑|결제|스테이킹|satın al|yatır|para çek|talep et|onayla|takas|öde\b/i;
/**
 * Review #150 (B1): the same words in de / fr / it / ja / vi / id. Latin-script words — with boundaries by Unicode letters (\b in JS knows only
 * ASCII: "bán", "dépôt"), so that "beli" is not caught in "believe"; Japanese — without boundaries.
 */
export const MONEY_I18N2_RE = new RegExp([
  '(?<!\\p{L})(kaufen|verkaufen|einzahlen|einzahlung|auszahlen|auszahlung|abheben|bezahlen|zahlen|beanspruchen|einl[öo]sen|genehmigen|freigeben|tauschen|pr[äa]gen|staken|einsetzen',
  '|acheter|achat|vendre|d[ée]poser|d[ée]p[ôo]t|retirer|retrait|payer|paiement|r[ée]clamer|approuver|[ée]changer|frapper|miser|staker',
  '|acquista|acquistare|compra|vendi|vendere|deposita|depositare|preleva|prelievo|paga|pagare|riscatta|rivendica|approva|scambia|conia',
  '|mua|b[áa]n|n[ạa]p ti[ềe]n|r[úu]t ti[ềe]n|thanh to[áa]n|nh[ậa]n th[ưu][ởo]ng|[đd][úu]c|ph[êe] duy[ệe]t|ho[áa]n [đd][ổo]i|[đd][ặa]t c[ưu][ợo]c',
  '|beli|jual|setor|tarik dana|bayar|klaim|cetak|setujui|tukar|pembayaran)(?!\\p{L})',
  '|購入|買う|売却|入金|出金|引き出|支払|請求|受け取|ミント|承認|スワップ|ステーク|交換|決済',
].join(''), 'iu');

/**
 * Review #150 (B1): one label normalization for the rules, code checks and the model. NFKC (fullwidth and "mathematical" letters →
 * ordinary ones), invisible and bidi characters are cut out (U+200B–U+200F, U+202A–U+202E, U+2060–U+206F, U+FEFF, U+00AD, tags U+E0000…),
 * spaces are collapsed. Otherwise the model reads "Ap​prove" as "Approve", while the "money" check does not recognize it.
 */
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻]|[\u{E0000}-\u{E007F}]|[\u{1D173}-\u{1D17A}]/gu;
export const normLabel = (s: string | undefined) => (s ?? '').normalize('NFKC').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
/** Basic Cyrillic and Greek homoglyphs → Latin. For checks only: "Approve" spelled with a Cyrillic capital A (U+0410) is "Approve" too. */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  // Review #150 (G1): look-alike spellings of Approve / SELL / Mint — Cyrillic ge U+0433 ≈ r, izhitsa U+0475 ≈ v, palochka U+04C0 ≈ l, pe U+043F ≈ n (lowercase — as in italics and small button fonts)
  г: 'r', ѵ: 'v', Ѵ: 'V', Ӏ: 'l', п: 'n',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  // Review #150 (V1): Armenian, extended Latin (IPA, small capitals) and Cherokee look-alikes of a–z (per UTS #39, common ones only)
  օ: 'o', ս: 'u', ց: 'g', հ: 'h', ո: 'n', զ: 'q', Օ: 'O', Ս: 'U',
  ı: 'i', ȷ: 'j', ɑ: 'a', ɡ: 'g', ɩ: 'i', ɪ: 'i', ʏ: 'y', ɴ: 'n', ʀ: 'r', ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ʜ: 'h', ᴊ: 'j', ᴋ: 'k', ʟ: 'l',
  ᴍ: 'm', ᴏ: 'o', ᴘ: 'p', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ᴢ: 'z', ꞵ: 'b',
  Ꭺ: 'A', Ᏼ: 'B', Ꮯ: 'C', Ꭼ: 'E', Ꮋ: 'H', Ꭻ: 'J', Ꮶ: 'K', Ꮇ: 'M', Ꮲ: 'P', Ꭱ: 'R', Ꮪ: 'S', Ꭲ: 'T', Ꮩ: 'V', Ꮃ: 'W', Ꮓ: 'Z',
};
/** Ordinary letters of European languages that NFKD does not decompose: for checks — their Latin spelling (this is not a forgery). */
const PLAIN_LATIN: Record<string, string> = { ß: 'ss', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th', ħ: 'h', ŋ: 'n', ı: 'i',
  // Review #150 (G4): Azerbaijani ə ("Göndər"), Catalan ŀ ("col·legi" in the old spelling), Greenlandic ĸ, Sami ŧ, African ɛ / ɔ, long ſ
  ə: 'e', Ə: 'E', ŀ: 'l', Ŀ: 'L', ĸ: 'k', ŧ: 't', Ŧ: 'T', ɛ: 'e', Ɛ: 'E', ɔ: 'o', Ɔ: 'O', ſ: 's', ŉ: 'n' };
export const foldHomoglyphs = (s: string) => s.replace(/[^\x00-\x7F]/gu, ch => PLAIN_LATIN[ch] ?? HOMOGLYPHS[ch] ?? ch);
/** For checks: NFKD and without combining marks ("Ap̵prove", "Mi̇nt", "Clai̲m" → "Approve", "Mint", "Claim"). */
const stripMarks = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '');
/** Label variants the code checks run on: as is (normalized), with homoglyphs folded, without marks, and without marks with folding. */
export const checkForms = (label: string): string[] => { const n = normLabel(label); return [...new Set([n, foldHomoglyphs(n), foldHomoglyphs(stripMarks(n))])]; };
/** Letters that look Latin but come from another script (or Latin outside a–z that ordinary languages do not produce). */
const LOOKALIKE_RE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]|(?![\x00-\x7F])\p{Script=Latin}/u;
/**
 * Mixed script in one word: Latin a–z together with look-alike letters of another script ("Connect" with a Cyrillic C, "Apprօve").
 * Such a label imitates an English word: for the "money" checks it is suspicious (the safe side).
 */
export const mixedScript = (label: string) => stripMarks(normLabel(label)).replace(/[^\x00-\x7F]/gu, ch => PLAIN_LATIN[ch] ?? ch)
  .split(/[^\p{L}]+/u).some(w => /[A-Za-z]/.test(w) && LOOKALIKE_RE.test(w));
/**
 * A list option (review #150, V4): normalized, and if normalization changed anything in it besides spaces (invisible characters,
 * fullwidth letters) — marked " (normalized)": "Ethe​reum" does not merge with "Ethereum", select stays unambiguous.
 */
export const normOption = (x: string) => { const n = normLabel(x); return n === x.replace(/\s+/g, ' ').trim() ? n : `${n} (normalized)`; };
/** An observation with normalized labels, options, groups and text (the driver and the session loop call it on every page). */
export function normObservation(o: Observation): Observation {
  return { ...o, text: normLabel(o.text).slice(0, 20_000), ...(o.title !== undefined ? { title: normLabel(o.title) } : {}),
    elements: o.elements.map(e => ({ ...e, label: normLabel(e.label), ...(e.options ? { options: e.options.map(normOption) } : {}), ...(e.group !== undefined ? { group: normLabel(e.group) } : {}),
      // a list's value is the text of the selected option: normalized the same way as the options
      ...(e.kind === 'select' && e.value !== undefined ? { value: normLabel(e.value) } : {}) })) };
}

/** A "money" button or link — in any of the supported languages; the label is normalized, homoglyphs are checked separately. */
export const isMoney = (label: string) =>
  checkForms(label).some(t => MONEY_RE.test(t) || MONEY_I18N_RE.test(t) || MONEY_I18N2_RE.test(t)) || mixedScript(label) // V1: mixed script — suspicious
  || foreignMoneyWord(label);
/** A word made entirely of letters of another script, ≤ 10 letters (longer — a real word of the language, not a fake button). */
const LOOKALIKE_WORD_RE = /^[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]{2,10}$/u;
/**
 * Review #150 (G1): a word entirely in Cyrillic / Greek / Armenian / Cherokee (not mixed script), each letter of which is
 * a Latin homoglyph, and the folding is a "money" word (all-Cyrillic look-alikes folding to "Approve", "SEll", "Mint"). Real Russian
 * labels ("Submit", "Continue", "Next" in Russian) do not fold like this: they contain letters without a Latin twin.
 */
export const foreignMoneyWord = (label: string) => stripMarks(normLabel(label)).split(/[^\p{L}]+/u).some(w => {
  if (!LOOKALIKE_WORD_RE.test(w)) return false;
  const f = w.replace(/./gu, ch => HOMOGLYPHS[ch] ?? ch);
  return /^[A-Za-z]+$/.test(f) && [MONEY_RE, MONEY_I18N_RE, MONEY_I18N2_RE].some(re => re.test(f));
});
/** A short wallet-connect button without the word "wallet". */
export const BARE_CONNECT_RE = /^(connect|connect now|подключить|подключиться|conectar|connecter|verbinden|collega|connetti|连接|연결|ba[ğg]lan|接続)$/i;
/** Fields that are never filled. */
export const SECRET_FIELD_RE = /pass(word|phrase)?|seed|mnemonic|private\s*key|secret|recovery|\bpin\b|\botp\b|2fa|card\s*number|cvv/i;
/** E-mail in other languages (review #150): "Correo electrónico", Russian "e-mail", "邮箱", "이메일", "E-posta", "Adresse e-mail". */
const EMAIL_I18N = 'e-?mail|correo|courriel|e-?posta|почт|邮箱|电子邮件|電子メール|メールアドレス|이메일|surel';
/** Fields the agent has no value for: if such a field is required, the form cannot be submitted. */
export const UNSUPPORTED_FIELD_RE = new RegExp(`${EMAIL_I18N}|phone|telegram|discord|name\\b(?!.*(x|twitter))|country|referr|invite\\s*code|code\\b`, 'i');
export const CAPTCHA_RE = /captcha|recaptcha|hcaptcha|turnstile|verify (that )?you('| a)re (a )?human|i('| a)m not a robot/i;
const X_HOST_RE = /^(www\.|mobile\.)?(x|twitter)\.com$/i;

/** A link to X is an X task (follow / repost / like), not a page for the session. Returns a description or undefined. */
export function xTaskFromLink(href: string | undefined, label: string): string | undefined {
  if (!href) return undefined;
  let u: URL; try { u = new URL(href); } catch { return undefined; }
  if (!X_HOST_RE.test(u.hostname)) return undefined;
  const p = u.pathname.toLowerCase();
  const who = u.searchParams.get('screen_name') ?? u.searchParams.get('user_id');
  if (p.startsWith('/intent/follow') || p.startsWith('/intent/user')) return `follow @${(who ?? '').replace(/^@/, '') || '?'}`;
  if (p.startsWith('/intent/retweet')) return `repost ${u.searchParams.get('tweet_id') ?? '?'}`;
  if (p.startsWith('/intent/like')) return `like ${u.searchParams.get('tweet_id') ?? '?'}`;
  if (p.startsWith('/intent/tweet') || p.startsWith('/intent/post') || p.startsWith('/compose')) return 'post a tweet (not allowed: the session writes no new posts)';
  const m = p.match(/^\/([a-z0-9_]{1,15})(\/status\/(\d+))?\/?$/i);
  if (m?.[3]) return `${/repost|retweet/i.test(label) ? 'repost' : /like/i.test(label) ? 'like' : 'open'} ${m[1]}/status/${m[3]}`;
  if (m) return `follow @${m[1]}`;
  return `x link ${u.pathname}`;
}

/** Code check of an action — regardless of who chose it (rules or the model). Returns the refusal reason or undefined. */
export function refuseAction(a: SiteAction, o: Observation, siteHost: string, values: SessionValues, wallet = false): string | undefined {
  if (a.kind === 'done' || a.kind === 'stop') return undefined;
  const el = o.elements.find(e => e.id === a.el);
  if (!el) return 'no such element on the page';
  if (el.disabled) return 'element is disabled';
  if (el.covered) return 'element is covered by another element';
  if (a.kind === 'select') {
    if (el.kind !== 'select') return 'select: not a list';
    if (!(el.options ?? []).includes(a.option)) return 'select: no such option in the list';
    if ((el.options ?? []).filter(x => x === a.option).length > 1) return `select: option "${a.option.slice(0, 40)}" is ambiguous — the list has several options with this text`;
    if (isMoney(a.option)) return `select: option "${a.option.slice(0, 40)}" is about money — that is E-13`;
    return undefined;
  }
  if (a.kind === 'fill') {
    if (el.kind !== 'input') return 'fill: not a text field';
    if (el.inputType && !['text', 'search', 'url', ''].includes(el.inputType)) return `fill: field type "${el.inputType}" is never filled`;
    if (checkForms(el.label).some(t => SECRET_FIELD_RE.test(t))) return 'fill: a secret field (password / seed / key) is never filled';
    const v = valueFor(a.value, values);
    if (!v) return `fill: the agent has no value for ${a.value}`;
    return undefined;
  }
  // click
  if (el.kind === 'input') return 'click: a text field';
  if (el.kind === 'select') return 'click: a list is chosen with select, not clicked';
  if (isMoney(el.label) && !(wallet && walletStep(el.label))) return `click: "${normLabel(el.label).slice(0, 60)}" needs ${wallet ? 'a transaction or money' : 'a wallet, a signature or money'} — that is E-13`;
  // Review #150: a bare "Connect" is a wallet connection; without a session wallet nobody presses it (rules — only with a wallet)
  if (!wallet && checkForms(el.label).some(t => BARE_CONNECT_RE.test(t))) return `click: "${normLabel(el.label).slice(0, 60)}" connects a wallet, and this session has none`;
  if (el.kind === 'link') {
    if (!el.href) return undefined; // a link-button without an address (a handler on the page)
    if (xTaskFromLink(el.href, el.label)) return 'click: a link to X is an X task, not a page of this site';
    if (!sameSite(el.href, siteHost)) return `click: link leaves the task site (${hostOf(el.href) ?? 'not http'})`;
  }
  return undefined;
}

/** A value for a field: only from the agent's list. The X handle — without "@" (that is how forms expect it). */
export function valueFor(k: ValueKey, v: SessionValues): string | undefined {
  if (k === 'x_handle') { const h = (v.xHandle ?? '').trim().replace(/^@/, ''); return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : undefined; }
  if (k === 'evm_address') return v.evmAddress && /^0x[0-9a-fA-F]{40}$/.test(v.evmAddress) ? v.evmAddress : undefined;
  return v.solAddress && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.solAddress) ? v.solAddress : undefined;
}

// ── Form planner (rules, no model) ────────────────────────────────────────────────────────────────────────────────

// Field recognition (#148 item 1): the site must not receive wrong data on the agent's behalf. Check order — from "definitely not ours" to "ours":
// a foreign platform (Discord, Telegram, e-mail…) and a foreign chain (SUI, TON, BTC…) are cut off before the words handle / username / address
// get a chance to match X or a wallet. A bare "handle", "@username", "address" without a platform or chain name — the field is NOT recognized.
/** The field is clearly about X: the platform is named. The words handle / username alone are not enough — Discord and Telegram are labelled the same way. */
const X_FIELD_RE = /twitter|x\.com|𝕏|(^|[^a-z0-9])x([^a-z0-9]|$).*(user|handle|name|account|profile|@|id\b)|(user|handle|account|profile|@\w*).*(^|[^a-z0-9])x([^a-z0-9]|$)|^\s*x\s*[:(]?\s*$/i;
/** A foreign platform or contact: the agent has no such value. */
const OTHER_ID_RE = new RegExp(`discord|telegram|\\btg\\b|${EMAIL_I18N}|phone|whats\\s*app|instagram|youtube|tiktok|github|linkedin|farcaster|warpcast|\\blens\\b|reddit|facebook|medium|website|\\bsite\\b|\\burl\\b|\\blink\\b`, 'i');
/** Chains the agent has no address for (it has only EVM and Solana). */
const OTHER_CHAIN_RE = /\b(sui|ton|toncoin|btc|bitcoin|ordinals?|taproot|aptos|apt|tron|trx|trc-?20|cosmos|atom|near|cardano|ada|xrp|ripple|doge(coin)?|ltc|litecoin|stark(net|ex)?|polkadot|dot|kusama|kaspa|injective|inj|sei|osmo(sis)?|stellar|xlm|algorand|algo|tezos|xtz|hedera|hbar|flow|icp|monero|xmr|zcash|filecoin|fuel|movement|celestia|tia|bittensor|tao|multiversx|egld|iota|eos|waves|neo)\b/i;
const EVM_FIELD_RE = /\bevm\b|0x|\beth(ereum)?\b|erc-?(20|721)|\b(base|arbitrum|optimism|polygon|matic|bnb|bsc|linea|scroll|zksync|blast|avalanche|avax|monad|berachain|abstract|hyperevm|mainnet)\b|metamask/i;
const SOL_FIELD_RE = /\bsol(ana)?\b|\bspl\b|phantom/i;
/** The word "wallet" is enough; the word "address" alone is not (postal, e-mail, contract). */
const WALLET_WORD_RE = /wallet/i;
const NOT_WALLET_ADDRESS_RE = /street|shipping|home|postal|mailing|billing|delivery|\bip\b|contract|token|referr|city|zip|country|company/i;
const NEXT_RE = /^(continue|next|submit|apply|join|register|sign\s*up|enter|confirm|send|save|proceed|get started|start|done|finish|complete|request access|join (the )?(waitlist|whitelist|allowlist))\b/i;
/** "Next / submit" in other languages (es / pt / ru / zh / ko / tr) — basic words. */
const NEXT_I18N_RE = /^(continuar|siguiente|enviar|unirse|unirme|registrarse|registrarme|pr[oó]ximo|avan[cç]ar|inscrever|cadastrar|participar|продолжить|далее|дальше|отправить|подать заявку|присоединиться|зарегистрироваться|участвовать|готово|继续|下一步|提交|加入|注册|申请|确认|完成|계속|다음|제출|가입|신청|확인|완료|devam|ileri|sonraki|g[öo]nder|kat[ıi]l|kaydol|ba[şs]vur|tamam)/i;
export const isNext = (label: string) => { const l = normLabel(label); return (NEXT_RE.test(l) || NEXT_I18N_RE.test(l)) && !isMoney(l); };
/** Site sign-in buttons: pressed when there is nothing else to do on the page (behind them there is usually a form or a wallet window). */
const ENTRY_RE = /^(log\s*in|login|sign\s*in|launch\s*app|open\s*app|enter\s*app|go\s*to\s*app|join now|start now|войти|вход|открыть приложение|iniciar sesi[oó]n|entrar|登录|登入|进入应用|로그인|giri[şs] yap)$/i;
const AGREE_RE = /agree|accept|terms|i understand|privacy|соглас|принимаю|условия|acepto|aceito|concordo|términos|termos|同意|接受|条款|동의|약관|kabul ediyorum|okudum/i;
export const SUCCESS_RE = /vielen dank|danke f[üu]r|erfolgreich (registriert|angemeldet|eingetragen)|anmeldung (erfolgreich|best[äa]tigt)|merci|inscription (r[ée]ussie|confirm[ée]e|enregistr[ée]e)|vous [êe]tes (inscrit|sur la liste)|grazie|registrazione (completata|riuscita)|sei (in lista|iscritto)|ありがとうございます|登録(が)?完了|受け付けました|cảm ơn|đăng ký thành công|terima kasih|berhasil (mendaftar|terdaftar)|you('| a)re (now )?(registered|on the (wait|white|allow)?list)|(added|signed up) to the (wait|white|allow)list|thank you|thanks for|you('| a)re (in|on the (list|waitlist|whitelist|allowlist))|application (was |has been )?(received|submitted|sent)|successfully (registered|submitted|joined)|registration (is |was )?(complete|successful)|we('| ha)ve received|you have been added|see you (soon|there)|submission (received|complete)|спасибо|заявка (принята|отправлена|получена)|вы в списке|успешно зарегистрирован|gracias|solicitud (recibida|enviada)|obrigad[oa]|inscrição (recebida|concluída)|谢谢|感谢|提交成功|申请已提交|注册成功|감사합니다|신청이 완료|등록되었습니다|teşekkür|başvurunuz alındı/i;
const SEARCH_RE = /search|поиск|buscar|pesquisar|搜索|검색|\bara\b/i;

/**
 * Whether the form was submitted and what was on the page before that (review #150, B3 — for both the rules and the model). submitted — the steps include
 * a click on a submit or "next" button (cookie, checkboxes, switches do not count); before — page texts up to and including that click.
 * Without pages — the submission is recognized by the label of the pressed button, there are no "before" texts.
 */
export function submitHistory(ctx: PlannerContext, pages: ReadonlyMap<number, Observation> | undefined = ctx.pages): { submitted: boolean; before: string[]; form?: string } {
  const elOf = (s: SessionStep) => stepEl(s, pages);
  // Review #150 (V3): "next" counts as a submission only if it is a button of a form in which the session typed or chose something;
  // a carousel "Next" outside a form is not a submission. A submit button is always a submission (except cookie banner buttons). "Working with a form" —
  // typing, choosing in a list and ticking a checkbox / switch of that form (a "consent only + Submit" form is an honest application).
  const worked = new Set(ctx.steps.filter(s => !s.refused && touched(s, elOf(s))).map(s => elOf(s)?.form).filter((f): f is string => !!f));
  for (let i = ctx.steps.length - 1; i >= 0; i--) {
    const s = ctx.steps[i];
    if (s.action.kind !== 'click' || s.refused) continue;
    const el = elOf(s);
    if (isPress(s, el, pages?.get(s.n)?.scoped === true, worked)) return { submitted: true, before: [...(pages ?? [])].filter(([n]) => n <= s.n).map(([, p]) => p.text), ...(el?.form ? { form: el.form } : {}) };
  }
  return { submitted: false, before: [] };
}
/** The element a step worked with — from the page the step was chosen on (ids are valid until the next observation). */
const stepEl = (s: SessionStep, pages: ReadonlyMap<number, Observation> | undefined) =>
  (s.action.kind === 'click' || s.action.kind === 'fill' || s.action.kind === 'select') ? pages?.get(s.n)?.elements.find(e => e.id === (s.action as { el: string }).el) : undefined;
/** A "working with a form" step: typing, choosing in a list, ticking a checkbox / switch. */
const touched = (s: SessionStep, el: SiteElement | undefined) => s.action.kind === 'fill' || s.action.kind === 'select' || (s.action.kind === 'click' && ['checkbox', 'radio', 'option'].includes(el?.kind ?? ''));
/** A click is a form submission: submit (except cookie) or "next" of a form that was worked with. Without form markup (scoped) — any "next", as before. */
const isPress = (s: SessionStep, el: SiteElement | undefined, scoped: boolean, worked: ReadonlySet<string>) =>
  el ? (el.kind === 'button' || el.kind === 'link') && !el.cookie && (!!el.submit || (isNext(el.label) && (!scoped || (!!el.form && worked.has(el.form))))) : isNext(s.label ?? '');
/** The page shows the same form with an empty required field (a narrow check by form key; the model's "done" — openFields). */
export function formStillOpen(o: Observation, form: string | undefined): boolean {
  return !!form && o.elements.some(e => e.form === form && e.required === true && !e.disabled && (e.kind === 'input' || e.kind === 'select') && (e.value ?? '') === '');
}

// ── One "done" model (review #150, round 4) ──────────────────────────────────────────────────────────────────────────
// Element ids change between observations, so a field is recognized by the form key and the normalized label (fieldKey).
//  1) An "open form" — a form in play (it has a submit button, not header / footer, not "money") whose required field is empty
//     and the session did not fill it. While there is such a form — "done" is not counted for either the rules or the model;
//  2) a field the session filled that is empty again after this form was submitted — a reset after success, not an open field;
//  3) the session does not refill or resubmit a submitted form: the form is empty again and there is no new success phrase (or the same button
//     of the same form without new input) — stop submitted_unconfirmed, without the model.

/** A field key across observations: form + normalized label. */
export const fieldKey = (e: Pick<SiteElement, 'form' | 'label'>) => `${e.form ?? ''}\u0001${normLabel(e.label).toLowerCase()}`;
/** A form submission by the session: step, form, button label and the keys of this form's fields filled before the click. */
export interface FormSubmit { n: number; form: string; button: string; keys: ReadonlySet<string> }
/** What the session filled (key → last step) and which forms it submitted — by the session's steps and pages. */
export function formLedger(ctx: PlannerContext, pages: ReadonlyMap<number, Observation> | undefined = ctx.pages): { entered: ReadonlyMap<string, number>; submits: FormSubmit[] } {
  const entered = new Map<string, number>(); const worked = new Set<string>(); const submits: FormSubmit[] = [];
  for (const s of ctx.steps) {
    if (s.refused) continue;
    const el = stepEl(s, pages); if (!el) continue;
    if (touched(s, el)) { entered.set(fieldKey(el), s.n); if (el.form) worked.add(el.form); continue; }
    if (s.action.kind !== 'click' || !isPress(s, el, pages?.get(s.n)?.scoped === true, worked)) continue;
    const form = el.form ?? '';
    submits.push({ n: s.n, form, button: normLabel(el.label).toLowerCase(), keys: new Set([...entered].filter(([k]) => k.startsWith(`${form}\u0001`)).map(([k]) => k)) });
  }
  return { entered, submits };
}
/** Forms "in play": with a submit button (submit or "next"), not in the header / footer, not "money". */
export const formsInPlay = (o: Observation) => new Set(o.elements.filter(e => (e.kind === 'button' || (e.kind === 'link' && !e.href)) && !!e.form && !e.chrome && (e.submit || isNext(e.label)) && !isMoney(e.label)).map(e => e.form!));
/** Item 1: empty required fields of forms in play that the session did not fill (or filled but has not submitted that form yet). Labels. */
export function openFields(o: Observation, ctx: PlannerContext, pages: ReadonlyMap<number, Observation> | undefined = ctx.pages): string[] {
  const sent = new Set(formLedger(ctx, pages).submits.flatMap(s => [...s.keys]));
  const play = formsInPlay(o);
  return o.elements.filter(e => !!e.form && play.has(e.form) && !e.chrome && e.required === true && !e.disabled && (e.kind === 'input' || e.kind === 'select')
    && (e.value ?? '') === '' && e.inputType !== 'search' && !SEARCH_RE.test(e.label) && !sent.has(fieldKey(e))).map(e => e.label);
}
const emptyNow = (e: SiteElement) => (e.kind === 'input' || e.kind === 'select') ? (e.value ?? '') === '' : (e.kind === 'checkbox' || e.kind === 'radio' || e.kind === 'option') ? !e.checked : false;
/** Items 2–3: a submitted form is on the page again and empty — a field filled before the submission is empty now. Returns that submission. */
export function resetAfterSubmit(o: Observation, ctx: PlannerContext, pages: ReadonlyMap<number, Observation> | undefined = ctx.pages): FormSubmit | undefined {
  return lastOf(formLedger(ctx, pages).submits, sub => o.elements.some(e => sub.keys.has(fieldKey(e)) && emptyNow(e)));
}
/** The last element matching the condition (Array.findLast — ES2023, outside the project's lib). */
const lastOf = <T>(xs: readonly T[], f: (x: T) => boolean): T | undefined => { for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i])) return xs[i]; return undefined; };
/**
 * Item 3 for any action (rules, model, session loop): typing into a field of a submitted form and clicking the same button of the same
 * form again without new input in it — refusal. Returns the reason or undefined.
 */
export function resubmitRefusal(a: SiteAction, o: Observation, ctx: PlannerContext, pages: ReadonlyMap<number, Observation> | undefined = ctx.pages): string | undefined {
  if (a.kind !== 'fill' && a.kind !== 'select' && a.kind !== 'click') return undefined;
  const el = o.elements.find(e => e.id === a.el); if (!el) return undefined;
  const { entered, submits } = formLedger(ctx, pages);
  const key = fieldKey(el);
  const sentField = submits.find(sub => sub.keys.has(key));
  if (sentField && (a.kind !== 'click' || ['checkbox', 'radio', 'option'].includes(el.kind))) return `the form was already sent (with "${sentField.button.slice(0, 40)}") — the session does not fill it again`;
  if (a.kind !== 'click') return undefined;
  const again = lastOf(submits, sub => sub.form === (el.form ?? '') && sub.button === normLabel(el.label).toLowerCase() && sub.keys.size > 0
    && o.elements.some(e => sub.keys.has(fieldKey(e)))
    && ![...entered].some(([k, n]) => k.startsWith(`${sub.form}\u0001`) && n > sub.n));
  return again ? `the form was already sent with "${again.button.slice(0, 40)}" and nothing new was entered — the session does not send it twice` : undefined;
}
/** A success phrase (SUCCESS_RE) in the text that was not in any "before" text; undefined — no new one. */
export function freshSuccess(text: string, before: string[]): string | undefined {
  const was = before.map(t => normLabel(t).toLowerCase());
  for (const m of normLabel(text).matchAll(new RegExp(SUCCESS_RE.source, 'gi'))) if (!was.some(t => t.includes(m[0].toLowerCase()))) return m[0];
  return undefined;
}
/** A list or switch group "which chain is the wallet on": the only choice the rules make by themselves. */
const CHAIN_CHOICE_RE = /network|chain|blockchain|wallet type|сеть|блокчейн|red\b|rede\b|网络|链|네트워크|체인|a[ğg]/i;
const EVM_OPTION_RE = /^(evm|ethereum|eth|erc-?20|base|ethereum \(evm\)|evm \(ethereum\))\b/i;
const SOL_OPTION_RE = /^(solana|sol)\b/i;

/** Which value the field asks for; 'unsupported' — the agent has none; undefined — the field is not recognized. */
export function fieldWants(el: SiteElement): ValueKey | 'unsupported' | undefined {
  if (el.kind !== 'input') return undefined;
  const l = normLabel(el.label); // review #150 (B1): "pass​word" is a password too
  if (checkForms(l).some(t => SECRET_FIELD_RE.test(t)) || (el.inputType && !['text', 'search', 'url', ''].includes(el.inputType))) return 'unsupported';
  const x = X_FIELD_RE.test(l); const other = OTHER_ID_RE.test(l);
  // "Twitter or Telegram handle" — what exactly to type cannot be decided from the label: the field is not recognized (no guessing)
  if (x && other) return undefined;
  if (other) return 'unsupported';                     // Discord handle, Telegram @username, Email address
  if (x) return 'x_handle';
  const evm = EVM_FIELD_RE.test(l); const sol = SOL_FIELD_RE.test(l); const alien = OTHER_CHAIN_RE.test(l);
  const walletish = WALLET_WORD_RE.test(l) || /address/i.test(l) || evm || sol || alien;
  if (walletish && !NOT_WALLET_ADDRESS_RE.test(l)) {
    if (alien && !evm && !sol) return 'unsupported';   // SUI / TON / BTC address — the agent has no address on such a chain
    if (alien) return undefined;                       // "EVM or SUI address" — cannot decide from the label
    if (evm && sol) return undefined;                  // "ETH or SOL wallet" — same
    if (sol) return 'sol_address';
    if (evm || WALLET_WORD_RE.test(l)) return 'evm_address'; // "Wallet address" without a chain — EVM, as is usual in application forms
    return undefined;                                  // a bare "Address" — could be anything
  }
  if (/^\s*@\s*\w+\s*$/.test(l) || /^\s*handle\s*$/i.test(l)) return undefined; // "@username", "handle" without a platform — not recognized
  if (UNSUPPORTED_FIELD_RE.test(l) || NOT_WALLET_ADDRESS_RE.test(l)) return 'unsupported';
  return undefined;
}

/**
 * A planner for application forms (whitelist, registration): fill the recognized fields, tick the consent, press "next".
 * When it does not know what to do — it stops with a reason; it does not guess.
 *
 * #148 item 2 — when the driver has marked up the page (o.scoped):
 *  • only fields of a form that has a submit button are filled; search in the header and a subscription in the footer do not stop the session;
 *  • an unknown or unsupported field not marked required is skipped; a required one — a stop, as before;
 *  • a cookie banner is closed with the consent button; covered elements are not touched;
 *  • a list and switches "which chain is the wallet on" are chosen by the address the agent has; other lists and
 *    switches are not chosen by the rules (a required list — a stop);
 *  • links to X in the header and footer ("we are on X") are not tasks;
 *  • when there is nothing else to do — sign-in buttons "Log in / Launch App", and with a wallet — "Connect".
 */
export const formPlanner: SessionPlanner = {
  next(o, ctx) {
    if (CAPTCHA_RE.test(o.text) || o.elements.some(e => CAPTCHA_RE.test(e.label))) return { kind: 'stop', reason: 'captcha on the page', needsHuman: 'captcha' };
    // The rules' "done" (review #150, as for the model): after a submit or "next" button was pressed, and the success phrase appeared after it —
    // "Thank you for visiting" that was on the page before clicking cookie or a checkbox is not an application confirmation
    // One "done" model (round 4): while the page has an open form (an empty required field the session did not fill) — not done
    const open = openFields(o, ctx);
    if (SUCCESS_RE.test(o.text) && !open.length) {
      const h = submitHistory(ctx); const fresh = h.submitted ? freshSuccess(o.text, h.before) : undefined;
      if (fresh) {
        const t = normLabel(o.text); const at = t.toLowerCase().indexOf(fresh.toLowerCase());
        return { kind: 'done', note: t.slice(Math.max(0, at - 80), at + fresh.length + 160).trim() };
      }
    }
    // A submitted form is empty again and there is no new confirmation (or there is an open form) — do not fill or submit it a second time
    const reset = resetAfterSubmit(o, ctx);
    if (reset) return { kind: 'stop', code: 'submitted_unconfirmed',
      reason: `the form was sent, but no confirmation is visible (the form is empty again after "${reset.button.slice(0, 40)}"${open.length ? `; the page still has an empty required field "${open[0].slice(0, 40)}"` : ''}) — not sending it twice` };
    /** How many times this same action has already been done on this same page. */
    const repeats = (kind: 'fill' | 'click' | 'select', label: string) => ctx.steps.filter(st => !st.refused && st.action.kind === kind && st.label === label.slice(0, 80) && st.url === o.url).length;
    const scoped = o.scoped === true;
    const live = (e: SiteElement) => !e.disabled && !e.covered;
    const buttons = o.elements.filter(e => (e.kind === 'button' || (e.kind === 'link' && !e.href)) && live(e));
    // 0) a cookie banner covers the page — close it with consent (this is neither "money" nor a task)
    const cookie = buttons.find(e => e.cookie && !isMoney(e.label) && repeats('click', e.label) < 2);
    if (cookie) return { kind: 'click', el: cookie.id };
    // Forms "in play": with a submit button and not in the header / footer. Without driver markup — all fields, as in part 1
    const submitForms = new Set(buttons.filter(e => e.form && !e.chrome && (e.submit || isNext(e.label)) && !isMoney(e.label)).map(e => e.form!));
    const inPlay = (e: SiteElement) => !scoped || (!!e.form && submitForms.has(e.form) && !e.chrome && !(e.inputType === 'search' || SEARCH_RE.test(e.label)));
    /** An optional field can be skipped. Without driver markup whether it is required is unknown — we treat it as required, as before. */
    const optional = (e: SiteElement) => scoped && e.required !== true;
    // 1) empty fields the agent can fill
    for (const el of o.elements) {
      if (el.kind !== 'input' || !live(el) || (el.value ?? '') !== '' || !inPlay(el)) continue;
      const want = fieldWants(el);
      if (want === 'unsupported') { if (optional(el)) continue; return { kind: 'stop', reason: `the form asks for "${el.label.slice(0, 60)}" — the agent has no such value` }; }
      if (want === undefined) { if (optional(el)) continue; return { kind: 'stop', reason: `unknown field "${el.label.slice(0, 60)}" — not guessing`, code: 'unknown_field' }; }
      if (!valueFor(want, ctx.values)) { if (optional(el)) continue; return { kind: 'stop', reason: `the form asks for ${want}, but the agent has no value for it` }; }
      // the field stayed empty after two attempts — the site does not accept input: do not repeat until the step limit
      if (repeats('fill', el.label) >= 2) return { kind: 'stop', reason: `the field "${el.label.slice(0, 60)}" stays empty after two attempts`, code: 'no_progress' };
      return { kind: 'fill', el: el.id, value: want };
    }
    // 2) lists: the rules choose only the wallet chain; any other required list — a stop
    /** The "wallet chain" option by the agent's address: EVM if there is an EVM address; Solana — only if there is no EVM option. */
    const chainOption = (labels: string[]) => (valueFor('evm_address', ctx.values) ? labels.find(x => EVM_OPTION_RE.test(x.trim())) : undefined)
      ?? (valueFor('sol_address', ctx.values) && !labels.some(x => EVM_OPTION_RE.test(x.trim())) ? labels.find(x => SOL_OPTION_RE.test(x.trim())) : undefined);
    for (const el of o.elements) {
      if (el.kind !== 'select' || !live(el) || (el.value ?? '') !== '' || !inPlay(el)) continue;
      const pick = CHAIN_CHOICE_RE.test(el.label) ? chainOption(el.options ?? []) : undefined;
      if (pick && repeats('select', el.label) < 2) return { kind: 'select', el: el.id, option: pick };
      if (optional(el)) continue;
      return { kind: 'stop', reason: `the form asks to choose "${el.label.slice(0, 60)}" — the rules do not choose in such a list`, code: 'unsupported_type' };
    }
    // 3) switches: a "wallet chain" group with nothing selected
    const choices = o.elements.filter(e => (e.kind === 'radio' || e.kind === 'option') && live(e) && inPlay(e));
    for (const group of new Set(choices.map(e => e.group ?? ''))) {
      const items = choices.filter(e => (e.group ?? '') === group);
      if (items.some(e => e.checked) || !CHAIN_CHOICE_RE.test(group)) continue;
      const label = chainOption(items.map(e => e.label));
      const pick = label ? items.find(e => e.label === label) : undefined;
      if (pick && repeats('click', pick.label) < 2) return { kind: 'click', el: pick.id };
    }
    // 4) consent to the terms
    const agree = o.elements.find(e => e.kind === 'checkbox' && live(e) && !e.checked && !e.chrome && AGREE_RE.test(e.label) && !isMoney(e.label));
    if (agree) {
      if (repeats('click', agree.label) >= 2) return { kind: 'stop', reason: `the checkbox "${agree.label.slice(0, 60)}" does not tick after two attempts`, code: 'no_progress' };
      return { kind: 'click', el: agree.id };
    }
    // 5) X tasks at this step: the session does not do them — it lists them and stops
    if (ctx.xTasks.length) return { kind: 'stop', reason: `the site asks for X actions first: ${ctx.xTasks.join('; ')}` };
    // 6) the wallet step (part 2): choose the wallet in the picker → connect → sign the message. What to sign is decided by the wallet
    const w = ctx.wallet;
    if (w) {
      const fresh = (e: SiteElement) => walletStep(e.label) && repeats('click', e.label) < 2;
      const pick = buttons.find(e => fresh(e) && (w.evm && /^(scarf wallet|metamask|browser wallet|injected(\s+wallet)?|detected wallet)\b/i.test(e.label.trim()) || w.sol && /^(scarf wallet|phantom)\b/i.test(e.label.trim())));
      if (pick && !w.connected) return { kind: 'click', el: pick.id };
      const connect = buttons.find(e => fresh(e) && (/connect(\s+a|\s+your)?\s+wallet|link\s+(a\s+|your\s+)?wallet|sign\s+in\s+with/i.test(e.label) || WALLET_STEP_I18N_RE.test(e.label) && !/firmar|assinar|подписать|签|서명|imzala/i.test(e.label)));
      if (connect && (!w.connected || /sign\s+in\s+with/i.test(connect.label) && w.signed === 0)) return { kind: 'click', el: connect.id };
      // a short "Connect" button (without the word wallet) — also a connection, when the session has a wallet
      const bare = buttons.find(e => /^(connect|подключить|conectar|连接|연결|ba[ğg]lan)$/i.test(e.label.trim()) && repeats('click', e.label) < 2);
      if (bare && !w.connected) return { kind: 'click', el: bare.id };
      const sign = buttons.find(e => fresh(e) && (/sign|verify/i.test(e.label) || /firmar|assinar|подписать|签|서명|imzala/i.test(e.label)) && !/connect/i.test(e.label));
      if (sign && w.connected && w.signed === 0) return { kind: 'click', el: sign.id };
    }
    // 7) the "next" button: first a button of a form "in play", then any
    const nexts = buttons.filter(e => (isNext(e.label) || (e.submit && !!e.form && submitForms.has(e.form) && !isMoney(e.label))) && !e.chrome);
    const next = nexts.find(e => !!e.form && submitForms.has(e.form)) ?? nexts[0];
    if (next) {
      // the same button already submitted this form, no new input, no confirmation — do not submit a second time (round 4, item 3)
      if (resubmitRefusal({ kind: 'click', el: next.id }, o, ctx))
        return { kind: 'stop', code: 'submitted_unconfirmed', reason: `the form was sent with "${next.label.slice(0, 40)}", but no confirmation is visible — not sending it twice` };
      // the same step twice without changes on the page — the site did not accept the input
      const last = ctx.steps.at(-1);
      if (last?.action.kind === 'click' && last.label === next.label.slice(0, 80) && last.url === o.url && repeats('click', next.label) >= 2)
        return { kind: 'stop', reason: `no progress after pressing "${next.label.slice(0, 40)}" twice`, code: 'no_progress' };
      return { kind: 'click', el: next.id };
    }
    // 8) a sign-in button: behind it there is usually a form or a wallet window
    const entry = buttons.find(e => ENTRY_RE.test(e.label.trim()) && !isMoney(e.label) && repeats('click', e.label) < 2);
    if (entry) return { kind: 'click', el: entry.id };
    const money = buttons.find(e => isMoney(e.label) && !(w && walletStep(e.label)));
    if (money) return { kind: 'stop', reason: `next step is "${money.label.slice(0, 60)}" — needs ${w ? 'a transaction or money' : 'a wallet, a signature or money'} (E-13)` };
    // the wallet signed a message and there is nothing else to do on the page — verification passed, even if the site did not say "thank you"
    if (w && w.signed > 0 && !open.length) return { kind: 'done', note: `wallet verified: the site received a signed message; nothing else to press (${o.text.replace(/\s+/g, ' ').trim().slice(0, 120)})` };
    if (w && w.connected) return { kind: 'stop', reason: 'wallet connected, but the page shows no further step the agent understands', code: 'wallet_no_step' };
    return { kind: 'stop', reason: 'no field to fill and no button to continue — the page is not a form the agent understands', code: 'no_next' };
  },
};

// ── Session loop ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One session on a task site. Every planner action goes through refuseAction; a refusal is a stop, not "I'll try something else".
 * After every action the page must stay on the task site.
 */
export async function runSiteSession(p: { url: string; driver: SiteDriver; planner?: SessionPlanner; values: SessionValues; limits?: Partial<SessionLimits>; now?: () => number;
  /** Part 2: the session wallet. Effective only if the driver can give it to the page (attachWallet). */
  wallet?: PageWallet }): Promise<SessionResult> {
  const now = p.now ?? Date.now; const t0 = now();
  const limits = { ...DEFAULT_SESSION_LIMITS, ...p.limits };
  const planner = p.planner ?? formPlanner;
  const steps: SessionStep[] = []; const xTasks: string[] = [];
  /** Pages by step number — for the rules' and the model's "done" (what was there before the form was submitted). */
  const pages = new Map<number, Observation>();
  const siteHost = hostOf(p.url);
  const wallet = p.wallet && p.driver.attachWallet ? p.wallet : undefined;
  const modelUsd = () => { const u = steps.reduce((a, st) => a + (st.usd ?? 0), 0); return u > 0 ? { modelUsd: Number(u.toFixed(6)) } : {}; };
  const out = (r: Partial<SessionResult> & { status: SessionResult['status'] }): SessionResult => ({ xTasks, steps, ms: now() - t0, ...modelUsd(),
    ...(wallet ? { wallet: { connected: wallet.isConnected, events: [...wallet.events] } } : {}), ...r });
  if (!siteHost) return out({ status: 'stopped', reason: 'task url is not http(s)' });
  let last: Observation | undefined; let shot: Uint8Array | undefined;
  const snap = async () => { try { shot = (await p.driver.screenshot?.()) ?? shot; } catch { /* the screenshot is not a mandatory part */ } };
  try {
    if (wallet) p.driver.attachWallet!(wallet);
    await p.driver.open(p.url);
    for (let n = 1; ; n++) {
      if (n > limits.maxSteps) { await snap(); return out({ status: 'stopped', reason: `step limit (${limits.maxSteps}) reached`, finalUrl: last?.url, screenshot: shot }); }
      if (now() - t0 > limits.maxMs) { await snap(); return out({ status: 'stopped', reason: `time limit (${Math.round(limits.maxMs / 1000)} s) reached`, finalUrl: last?.url, screenshot: shot }); }
      // Review #150 (B1): the rules, code checks and the model see the same normalized text (also with the fake driver)
      const o = normObservation(await p.driver.observe()); last = o;
      if (!sameSite(o.url, siteHost)) { await snap(); return out({ status: 'stopped', reason: `the page left the task site (${hostOf(o.url) ?? o.url.slice(0, 40)})`, finalUrl: o.url, screenshot: shot }); }
      // X tasks — links to X in the page body. "We are on X" in the header and footer is not a task (an intent link /intent/… is always a task)
      for (const e of o.elements) {
        const t = e.kind === 'link' && !(e.chrome && !/\/intent\//i.test(e.href ?? '')) ? xTaskFromLink(e.href, e.label) : undefined;
        if (t && !xTasks.includes(t)) xTasks.push(t);
      }
      // The wallet rejected a transaction or a permission signature — there is nothing more to do on this site
      if (wallet?.blocked) { await snap(); return out({ status: 'stopped', reason: wallet.blocked, finalUrl: o.url, screenshot: shot }); }
      const view: WalletView | undefined = wallet ? { evm: !!wallet.evmAddress, sol: !!wallet.solAddress, connected: wallet.isConnected, signed: wallet.signed.length } : undefined;
      pages.set(n, o);
      const planned = await planner.next(o, { values: p.values, steps, xTasks, wallet: view, siteHost, pages });
      const { meta, ...rest } = planned; const a = rest as SiteAction;
      const el = a.kind === 'fill' || a.kind === 'click' || a.kind === 'select' ? o.elements.find(e => e.id === a.el) : undefined;
      // Do not fill or submit a submitted form a second time — whoever chose the action (round 4, item 3)
      const refused = refuseAction(a, o, siteHost, p.values, !!wallet) ?? resubmitRefusal(a, o, { values: p.values, steps, xTasks, siteHost, pages });
      steps.push({ n, url: o.url, action: a, label: el?.label.slice(0, 80), ...(refused ? { refused } : {}), ...(meta ?? {}) });
      if (refused) { await snap(); return out({ status: 'stopped', reason: `refused: ${refused}`, finalUrl: o.url, screenshot: shot }); }
      if (a.kind === 'done') { await snap(); return out({ status: 'done', confirmation: a.note.slice(0, 400), finalUrl: o.url, screenshot: shot }); }
      if (a.kind === 'stop') { await snap(); return out({ status: 'stopped', reason: a.reason, ...(a.code ? { code: a.code } : {}), needsHuman: a.needsHuman, finalUrl: o.url, screenshot: shot }); }
      if (a.kind === 'fill') await p.driver.fill(a.el, valueFor(a.value, p.values)!);
      else if (a.kind === 'select') { if (!p.driver.select) throw new Error('driver cannot choose in a list'); await p.driver.select(a.el, a.option); }
      else await p.driver.click(a.el);
    }
  } catch (e) {
    await snap();
    return out({ status: 'error', reason: String((e as Error)?.message ?? e).slice(0, 200), finalUrl: last?.url, screenshot: shot });
  } finally {
    await p.driver.close().catch(() => undefined);
  }
}

/** Escaping for Telegram (parse_mode HTML): text from the site page must not become markup or a link in the owner's chat. */
export const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * Session summary for Telegram (rule reasons — as is). Returned ALREADY escaped for parse_mode HTML:
 * the confirmation, button and field labels, reasons and addresses come from the site page (acceptance #143, H1). The summary has no markup of its own,
 * so the whole text is escaped; the length is capped — the Telegram message limit is 4096 characters.
 */
export function sessionSummary(r: SessionResult, url: string): string {
  return escHtml(sessionSummaryPlain(r, url).slice(0, 3000));
}
/** Summary lines about the wallet: connection, signed messages (with the start of the text), wallet refusals. */
function walletLines(r: SessionResult): string[] {
  const w = r.wallet; if (!w) return [];
  const signed = w.events.filter(e => e.allowed && e.message !== undefined);
  const refused = w.events.filter(e => !e.allowed);
  return [
    w.connected ? 'Wallet: a burner wallet is connected to the site.' : undefined,
    ...signed.map(e => `Signed a message (${e.chain}): «${e.message!.replace(/\s+/g, ' ').slice(0, 300)}»`),
    ...refused.slice(0, 5).map(e => `Wallet refused the site: ${e.method} — ${e.reason}${e.message ? ` («${e.message.replace(/\s+/g, ' ').slice(0, 160)}»)` : ''}`),
  ].filter((x): x is string => !!x);
}
/** Summary line about the model (the fallback): how many steps the model chose and what it cost. */
function modelLines(r: SessionResult): string[] {
  const by = r.steps.filter(s => s.by === 'haiku' || s.by === 'sonnet');
  if (!by.length && !r.modelUsd) return [];
  const names = [...new Set(by.map(s => s.by))].join(' + ');
  return [`Model (fallback${names ? `, ${names}` : ''}): steps ${by.length}, spend $${(r.modelUsd ?? 0).toFixed(4)}.`];
}
function sessionSummaryPlain(r: SessionResult, url: string): string {
  const head = r.status === 'done' ? `✅ Application on ${hostOf(url) ?? url} submitted: ${r.confirmation ?? 'the site confirmed'}`
    : r.status === 'stopped' ? `⏸ Session on ${hostOf(url) ?? url} stopped: ${r.reason}`
      : `⚠️ Session on ${hostOf(url) ?? url}: failure — ${r.reason}`;
  const did = r.steps.filter(s => !s.refused && (s.action.kind === 'fill' || s.action.kind === 'click' || s.action.kind === 'select'))
    .map(s => (s.action.kind === 'fill' ? `entered ${s.action.value} into «${s.label}»` : s.action.kind === 'select' ? `chose «${s.action.option}» in «${s.label}»` : `clicked «${s.label}»`));
  return [head, did.length ? `Done (${did.length}): ${did.join('; ')}` : 'Nothing was entered or clicked.',
    r.xTasks.length ? `X tasks on the site: ${r.xTasks.join('; ')}` : undefined,
    ...walletLines(r),
    ...modelLines(r),
    r.needsHuman === 'captcha' ? 'Need your help: captcha.' : undefined].filter(Boolean).join('\n');
}
