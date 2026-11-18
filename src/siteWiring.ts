// E-06 (#16, #148): wiring of task-site sessions into the agent. index.ts is a top-level script that cannot be tested, so
// the assembly lives here (test/siteWiring.test.ts): no browser, no network and no import side effects.
//
// Three switches in .env (the value is exactly "on"; anything else — off):
//  • AGENT_SITE_SESSIONS=on — task-site sessions: the agent fills in the application form itself (X name, burner wallet address).
//    Wired only after a successful browser check (probeBrowser); no browser — a log line, no sessions.
//  • AGENT_SITE_WALLET=on — sessions also connect a burner wallet and sign a MESSAGE for verification (the owner's decision
//    2026-11-17 16:34 UTC). Only if the key store is open and the wallet holds no coins (burnerHasNoMoney).
//  • AGENT_SITE_MODEL=on — a model (Haiku, Sonnet on failure) as a fallback for the rules (the owner's decision 2026-11-17 18:14 UTC).
// Limits: 10 sessions per UTC day, model spend on sessions — no more than $1 per UTC day (the owner's decision 2026-11-17).
import { SiteSessions } from './exec/siteSessions.js';
import { chromiumSiteDriver } from './exec/siteBrowser.js';
import { evmSigner, solSigner, burnerHasNoMoney } from './exec/siteWallet.js';
import { siteModelPick, SITE_TAG } from './exec/sitePlanner.js';
import type { SiteDriver } from './exec/siteSession.js';
import type { ToolLoop } from './llm/runner.js';

/** How many sessions can be started per day (UTC). */
export const SITE_SESSIONS_PER_DAY = 10;
/** The cap on model spend for sessions per day (UTC), $ — the owner's decision 2026-11-17: "no more than $1 a day". */
export const SITE_SESSIONS_USD_PER_DAY = 1;

export type SiteSwitchName = 'AGENT_SITE_SESSIONS' | 'AGENT_SITE_WALLET' | 'AGENT_SITE_MODEL';

/** A switch: "on" (case- and whitespace-insensitive) — on; empty or "off" — off; anything else — off with a warning. */
export function siteSwitch(env: Record<string, string | undefined>, name: SiteSwitchName): { on: boolean; warn?: string } {
  const v = (env[name] ?? '').trim().toLowerCase();
  if (v === 'on') return { on: true };
  if (v === '' || v === 'off') return { on: false };
  return { on: false, warn: `${name}=${(env[name] ?? '').slice(0, 20)} is not "on" — treated as off` };
}

export interface SiteWiringDeps {
  /** The browser check result (probeBrowser): 'ready' — Chromium launches; { error } — it does not; 'unchecked' — no check was made. */
  browser: 'ready' | 'unchecked' | { error: string };
  dataDir: string;
  /** Brand (src/brand.ts): the X name is entered on sites only if handleRegistered (the account is already registered). */
  brand: { handle: string; handleRegistered: boolean };
  /** The key store (Wallets), if open. None — sessions have neither burner wallet addresses nor a wallet. */
  wallets?: { evmBurners: Parameters<typeof evmSigner>[0][]; solBurners: Parameters<typeof solSigner>[0][] };
  /** Nodes for the "the wallet holds no coins" check: EVM — all chains where the wallet could receive a coin; Solana — one. */
  rpc: { evm: (string | undefined)[]; solana?: string };
  /** Model: present only if there is an Anthropic key. loop — the shared loop, already wrapped by the no-credit pause (modelPause.guard). */
  model?: { loop: ToolLoop; budget: { record(model: string, usd: number): void; spent(model: string): number } };
  /** A line to the service log and the review log. */
  log: (line: string) => void;
  /** Review log: the browser_session event. */
  review?: (kind: string, data: Record<string, unknown>) => void;
  /** Entry stop (risk.halted()): a queued session does not start after /stop or the daily stop. */
  halted: () => boolean;
  /** Tests: own driver and own fetch for the balance check. */
  driver?: () => SiteDriver;
  fetchImpl?: typeof fetch;
}

/**
 * Assembles task-site sessions from the .env switches. undefined — no sessions, agent behaviour unchanged (dapp_session gives
 * only a card). Each decision is one line in d.log; lines contain no keys or secrets (only addresses and counters).
 */
export function buildSiteSessions(env: Record<string, string | undefined>, d: SiteWiringDeps): SiteSessions | undefined {
  const sw = { sessions: siteSwitch(env, 'AGENT_SITE_SESSIONS'), wallet: siteSwitch(env, 'AGENT_SITE_WALLET'), model: siteSwitch(env, 'AGENT_SITE_MODEL') };
  for (const s of Object.values(sw)) if (s.warn) d.log(`site sessions: ${s.warn}`);
  if (!sw.sessions.on) return undefined;
  if (d.browser !== 'ready') {
    const why = d.browser === 'unchecked' ? 'the browser check did not run' : `browser is not available: ${d.browser.error.slice(0, 160)}`;
    d.log(`site sessions: NOT connected — ${why}. Install Chromium (server deployment guide, "Browser for sites"), then systemctl restart agent`);
    return undefined;
  }
  const notes: string[] = [];
  const w = d.wallets;
  if (!w) notes.push('keystore is not unlocked — no burner addresses, forms that ask for a wallet address are not sent');

  let wallet: ConstructorParameters<typeof SiteSessions>[0]['wallet'];
  if (sw.wallet.on && w) {
    wallet = { evm: w.evmBurners.map(a => evmSigner(a)), sol: w.solBurners.map(k => solSigner(k)),
      hasNoMoney: burnerHasNoMoney({ evmRpcs: d.rpc.evm.filter((u): u is string => !!u), solRpc: d.rpc.solana || undefined, fetchImpl: d.fetchImpl }) };
  } else if (sw.wallet.on) notes.push('AGENT_SITE_WALLET=on, but the keystore is not unlocked — no session wallet');

  let model: ConstructorParameters<typeof SiteSessions>[0]['model'];
  if (sw.model.on && d.model) {
    const m = d.model;
    model = { pick: siteModelPick({ loop: m.loop, budget: m.budget }), spentToday: () => m.budget.spent(SITE_TAG) };
  } else if (sw.model.on) notes.push('AGENT_SITE_MODEL=on, but there is no Anthropic key — sessions run on rules only');

  const xHandle = d.brand.handleRegistered && d.brand.handle ? d.brand.handle : undefined;
  if (!xHandle) notes.push('X handle is not entered on sites: brand/brand.json handle_registered is not true — forms that ask for an X handle are not sent');

  const sessions = new SiteSessions({
    driver: d.driver ?? (() => chromiumSiteDriver()),
    // EVM wallets are shared with the NftLive mint, which takes free ones from the start of the list: sessions take from the end, so the pools overlap as
    // late as possible (HQ review, R3). BurnerBook hands free ones to sites in list order; the signature is looked up by address, order does not matter to it.
    xHandle, evmBurners: w ? [...w.evmBurners].reverse().map(a => a.address) : [], solBurners: w?.solBurners.map(k => k.publicKey.toBase58()) ?? [],
    dataDir: d.dataDir, maxPerDay: SITE_SESSIONS_PER_DAY, maxUsdPerDay: SITE_SESSIONS_USD_PER_DAY,
    wallet, model, log: d.review, halted: d.halted,
  });
  d.log(`site sessions: on — up to ${SITE_SESSIONS_PER_DAY}/day UTC, model spend up to $${SITE_SESSIONS_USD_PER_DAY}/day UTC; `
    + `wallet ${wallet ? 'on (message signing only, empty burners only)' : 'off'}; model ${model ? 'on (fallback of the rules)' : 'off'}; `
    + `X handle ${xHandle ?? 'none'}; burners EVM ${w?.evmBurners.length ?? 0} / Solana ${w?.solBurners.length ?? 0}${notes.length ? `. Notes: ${notes.join('; ')}` : ''}`);
  return sessions;
}

/**
 * Wiring for index.ts: wait for the browser check (check — the probeBrowser promise: undefined — Chromium launches, a string — an error;
 * no promise — no check was made), assemble sessions and hand them to set. Never throws: a build failure is a line in d.log (service log
 * and review log), no sessions.
 */
export function wireSiteSessions(check: Promise<string | undefined> | undefined, env: Record<string, string | undefined>,
  d: Omit<SiteWiringDeps, 'browser'>, set: (s: SiteSessions | undefined) => void): Promise<void> {
  return (check ?? Promise.resolve(undefined)).then(errMsg => {
    set(buildSiteSessions(env, { ...d, browser: !check ? 'unchecked' : errMsg ? { error: errMsg } : 'ready' }));
  }).catch(e => {
    try { d.log(`site sessions: wiring failed — ${String((e as Error)?.message ?? e).slice(0, 200)}; sessions are off`); } catch { /* the log is unavailable */ }
  });
}

/**
 * The sessions line for the startup message. Switch off — empty. Wiring finished: "on" or "not connected".
 * The browser check is still running (did not fit the wait before Discord) — say so: sessions will connect later, the line goes to the log.
 */
export function siteSessionsNotice(asked: boolean, s: { done: boolean; connected: boolean }): string {
  if (!asked) return '';
  if (s.connected) return ' Task-site sessions: on.';
  if (!s.done) return ' Task-site sessions: the browser check is still running, sessions will connect later (the "site sessions:" line in the log).';
  return ' Task-site sessions: not connected (no browser or a failure — details in the log).';
}
