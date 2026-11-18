// E-06 (#16): running sessions on task sites for the executor — queue, daily limit, screenshot, journal entry.
// The session itself — src/exec/siteSession.ts (rules and loop), the browser — src/exec/siteBrowser.ts.
// There is no money here: no transactions, no keys. From the wallet only the burner wallet's ADDRESS is taken, and in the second part (the owner's decision
// 2026-11-17) — also a "sign a message" function for verification on the site; the key never gets here (see siteWallet.ts).
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runSiteSession, registrable, sessionSummary, escHtml, type SessionResult, type SessionValues, type SiteDriver, type SessionPlanner, type SessionLimits } from './siteSession.js';
import { SiteWallet, type BurnerSigner } from './siteWallet.js';
import { formPlanner } from './siteSession.js';
import { hybridPlanner, type ModelCaps, type ModelPick } from './sitePlanner.js';

export interface SiteSessionsDeps {
  /** A new driver for every session (a clean browser profile). */
  driver: () => SiteDriver;
  /** The agent's X handle (with or without "@"). None — forms that ask for it are not submitted. */
  xHandle?: string;
  /** Burner wallet addresses (addresses only). A site always gets the same one — see burnerFor. */
  evmBurners: string[];
  solBurners: string[];
  /** Data folder: screenshots go to <dataDir>/sessions/. */
  dataDir: string;
  /** How many sessions per day (UTC) may be started. The number is set by whoever wires it (the owner's decision), there is no default. */
  maxPerDay: number;
  /**
   * Session spend cap per day (UTC), $ — the owner's decision 2026-11-17: "no more than $1 a day". Rule-based sessions do not call the model
   * and cost $0; spend appears when the model starts choosing actions on the page (its planner reports the session cost via
   * costOf). Cap exhausted — new sessions do not start until 00:00 UTC.
   */
  maxUsdPerDay: number;
  /** What the session cost, $ (the planner model's spend). Unset — 0: the rule-based planner is free. */
  costOf?: (r: SessionResult) => number;
  /**
   * Part 2: connecting a burner wallet and signing a message for verification. Unset — sessions have no wallet (as in part 1).
   * evm / sol — signing sides of the same burner wallets as in evmBurners / solBurners (matched by address).
   * hasNoMoney — the HQ boundary "only a wallet without money": true — the address is empty. false or a check failure — this session gets no wallet.
   */
  wallet?: {
    evm: NonNullable<BurnerSigner['evm']>[]; sol: NonNullable<BurnerSigner['sol']>[];
    hasNoMoney(kind: 'evm' | 'sol', address: string): Promise<boolean>;
  };
  /**
   * #148 item 3: the model as a fallback for the rules (the owner's decision 2026-11-17 18:14 UTC). Unset — sessions run on rules only.
   * pick — the model call (siteModelPick on top of the project's common loop); caps — per-session limits (default 8 Haiku + 2 Sonnet,
   * $0.05); spentToday — how much the model has already spent on sessions in the UTC day per the daily budget (tag:site): with it the daily
   * cap maxUsdPerDay survives a restart. Cap exhausted — sessions keep running on rules (they are free), without the model.
   */
  model?: { pick: ModelPick; caps?: Partial<Pick<ModelCaps, 'haikuCalls' | 'sonnetCalls' | 'usdPerSession'>>; spentToday?: () => number };
  /** Review journal: the browser_session event. */
  log?: (kind: string, data: Record<string, unknown>) => void;
  /**
   * Entry stop (/stop, daily, hard): risk.halted(). Checked at the start of every session, including one already waiting in the queue:
   * a stop after queueing — the session does not start (HQ review, R1). A check failure — also a stop.
   */
  halted?: () => boolean;
  planner?: SessionPlanner;
  limits?: Partial<SessionLimits>;
  now?: () => number;
}

export interface SiteSessionOutcome { result: SessionResult; summary: string; screenshotPath?: string }

/** Which burner wallet to show the site: by site name, always the same one (also after a restart). Different sites — different ones where possible. */
export function burnerFor(siteHost: string, burners: string[]): string | undefined {
  if (!burners.length) return undefined;
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of registrable(siteHost)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return burners[h % burners.length];
}

/** The first task link suitable for a session: http(s) and not X (a link to X is not a task site). */
export function taskUrl(urls: string[] | undefined): string | undefined {
  for (const raw of urls ?? []) {
    try { const u = new URL(raw); if ((u.protocol === 'https:' || u.protocol === 'http:') && !/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) return u.toString(); } catch { /* not a link */ }
  }
  return undefined;
}

/**
 * The "site → burner wallet" book (acceptance #143, nice-to-have 2): every site gets its own wallet while free ones remain — otherwise
 * one address would link the sites to each other. The record lives in <dataDir>/sessions/burners.json and survives a restart. Free ones
 * ran out — the address by site name (burnerFor), as before. The file cannot be read or written — also burnerFor: the session does not fail.
 */
export class BurnerBook {
  private book: { evm: Record<string, string>; sol: Record<string, string> } = { evm: {}, sol: {} };
  private path: string;
  constructor(private dataDir: string) {
    this.path = join(dataDir, 'sessions', 'burners.json');
    try { const raw = JSON.parse(readFileSync(this.path, 'utf8')); if (raw && typeof raw === 'object') this.book = { evm: { ...(raw.evm ?? {}) }, sol: { ...(raw.sol ?? {}) } }; } catch { /* no file yet */ }
  }
  pick(kind: 'evm' | 'sol', siteHost: string, burners: string[]): string | undefined {
    if (!burners.length) return undefined;
    const site = registrable(siteHost); const map = this.book[kind];
    const known = map[site];
    if (known && burners.includes(known)) return known;
    const used = new Set(Object.values(map));
    const free = burners.find(b => !used.has(b));
    if (!free) return burnerFor(siteHost, burners); // no free ones — a shared address by site name, not written to the book
    map[site] = free;
    try {
      mkdirSync(join(this.dataDir, 'sessions'), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.book, null, 1)); renameSync(`${this.path}.tmp`, this.path);
    } catch (e) { console.error(`[session] burner book not saved: ${String(e).slice(0, 160)}`); }
    return free;
  }
}

export class SiteSessions {
  private chain: Promise<unknown> = Promise.resolve();
  private day = ''; private startedToday = 0; private spentTodayUsd = 0;
  private book: BurnerBook;
  /** The day counter on disk (<dataDir>/sessions/day.json): the daily UTC session limit survives a restart (HQ review, R2). */
  private dayPath: string;
  constructor(private d: SiteSessionsDeps) {
    this.book = new BurnerBook(d.dataDir);
    this.dayPath = join(d.dataDir, 'sessions', 'day.json');
    try {
      const j = JSON.parse(readFileSync(this.dayPath, 'utf8')) as { day?: unknown; started?: unknown; spentUsd?: unknown };
      if (typeof j?.day === 'string' && /^\d{4}-\d\d-\d\d$/.test(j.day) && Number.isFinite(Number(j.started))) {
        this.day = j.day; this.startedToday = Math.max(0, Math.floor(Number(j.started))); this.spentTodayUsd = Math.max(0, Number(j.spentUsd) || 0);
      }
    } catch { /* no file yet or it is corrupted — count from zero */ }
  }
  /** Write the day counter atomically (temp file → rename). A write failure does not crash the session: the count stays in memory. */
  private saveDay() {
    try {
      mkdirSync(join(this.d.dataDir, 'sessions'), { recursive: true });
      writeFileSync(`${this.dayPath}.tmp`, JSON.stringify({ day: this.day, started: this.startedToday, spentUsd: this.spentTodayUsd }));
      renameSync(`${this.dayPath}.tmp`, this.dayPath);
    } catch (e) { console.error(`[session] day counter not saved: ${String(e).slice(0, 160)}`); }
  }

  /** The session wallet is wired (AGENT_SITE_WALLET=on): a site may get a burner wallet for message signing. For the card text. */
  get walletOn(): boolean { return !!this.d.wallet; }

  /** Values the agent is allowed to enter on this site. */
  valuesFor(siteHost: string): SessionValues {
    return { xHandle: this.d.xHandle, evmAddress: this.book.pick('evm', siteHost, this.d.evmBurners), solAddress: this.book.pick('sol', siteHost, this.d.solBurners) };
  }

  /** The session wallet for the site: the same burner addresses as in the form values; empty ones only. Reasons why no wallet was given — in notes. */
  private async walletFor(siteHost: string, values: SessionValues): Promise<{ wallet?: SiteWallet; notes: string[] }> {
    const w = this.d.wallet; const notes: string[] = [];
    if (!w) return { notes };
    const signer: BurnerSigner = {};
    for (const kind of ['evm', 'sol'] as const) {
      const address = kind === 'evm' ? values.evmAddress : values.solAddress;
      if (!address) continue;
      const s = kind === 'evm' ? w.evm.find(x => x.address.toLowerCase() === address.toLowerCase()) : w.sol.find(x => x.address === address);
      if (!s) { notes.push(`${kind}: no signer for ${address}`); continue; }
      let empty = false;
      try { empty = (await w.hasNoMoney(kind, address)) === true; } catch (e) { notes.push(`${kind}: balance check failed (${String((e as Error)?.message ?? e).slice(0, 80)})`); continue; }
      if (!empty) { notes.push(`${kind}: burner ${address} holds funds — not offered to the site`); continue; }
      if (kind === 'evm') signer.evm = s as NonNullable<BurnerSigner['evm']>; else signer.sol = s as NonNullable<BurnerSigner['sol']>;
    }
    return { wallet: signer.evm || signer.sol ? new SiteWallet(siteHost, signer) : undefined, notes };
  }

  /** One session; sessions run strictly one at a time. Does not throw: any failure — a result with status 'error'. */
  run(url: string): Promise<SiteSessionOutcome> {
    const next = this.chain.then(() => this.runOne(url), () => this.runOne(url));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runOne(url: string): Promise<SiteSessionOutcome> {
    const now = this.d.now ?? Date.now;
    const iso = new Date(now()).toISOString();
    let host: string;
    try { host = new URL(url).hostname; } catch { return this.finish(url, { status: 'stopped', reason: 'task url is not a url', xTasks: [], steps: [], ms: 0 }, iso); }
    // Entry stop — before the day counter: a session queued before /stop does not start and does not use the daily limit
    let halted = false; try { halted = !!this.d.halted?.(); } catch { halted = true; }
    if (halted) return this.finish(url, { status: 'stopped', reason: 'new entries are halted (/stop, daily or hard stop) — the session was not started', xTasks: [], steps: [], ms: 0 }, iso);
    if (iso.slice(0, 10) !== this.day) { this.day = iso.slice(0, 10); this.startedToday = 0; this.spentTodayUsd = 0; }
    // A paid planner without the model fallback (costOf): cap exhausted — no sessions. With the model fallback sessions keep going
    // on rules: the cap only closes model calls (dailyLeftUsd below)
    if (!this.d.model && (!(this.d.maxUsdPerDay > 0) || this.spentTodayUsd >= this.d.maxUsdPerDay)) return this.finish(url, { status: 'stopped', reason: `daily session budget ($${Number(this.d.maxUsdPerDay).toFixed(2)}) is spent — next sessions after 00:00 UTC`, xTasks: [], steps: [], ms: 0 }, iso);
    if (this.startedToday >= this.d.maxPerDay) return this.finish(url, { status: 'stopped', reason: `daily session limit (${this.d.maxPerDay}) reached — next sessions after 00:00 UTC`, xTasks: [], steps: [], ms: 0 }, iso);
    this.startedToday++;
    this.saveDay(); // before opening the site: a restart mid-session will not "return" it to the limit
    let result: SessionResult; let walletNotes: string[] = [];
    try {
      const values = this.valuesFor(host);
      const w = await this.walletFor(host, values); walletNotes = w.notes;
      const m = this.d.model;
      const spent = () => Math.max(this.spentTodayUsd, Number(m?.spentToday?.()) || 0);
      // A planner with the model — a new one for every session: it holds this session's call and spend counters
      const planner = this.d.planner ?? (m ? hybridPlanner(formPlanner, m.pick, { ...m.caps, dailyLeftUsd: () => this.d.maxUsdPerDay - spent() }) : undefined);
      result = await runSiteSession({ url, driver: this.d.driver(), planner, values, limits: this.d.limits, now, wallet: w.wallet });
    }
    catch (e) { result = { status: 'error', reason: String((e as Error)?.message ?? e).slice(0, 200), xTasks: [], steps: [], ms: 0 }; }
    let cost = 0; try { cost = Math.max(0, Number(this.d.costOf ? this.d.costOf(result) : result.modelUsd ?? 0)) || 0; } catch { cost = 0; }
    this.spentTodayUsd += cost;
    if (cost > 0) this.saveDay();
    return this.finish(url, result, iso, cost, walletNotes);
  }

  private finish(url: string, result: SessionResult, iso: string, costUsd = 0, walletNotes: string[] = []): SiteSessionOutcome {
    let screenshotPath: string | undefined;
    if (result.screenshot?.length) {
      try {
        const dir = join(this.d.dataDir, 'sessions'); mkdirSync(dir, { recursive: true });
        let host = 'site'; try { host = registrable(new URL(url).hostname).replace(/[^a-z0-9.-]/gi, '_'); } catch { /* default file name */ }
        screenshotPath = join(dir, `${iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${host}.png`);
        writeFileSync(screenshotPath, result.screenshot);
      } catch (e) { console.error(`[session] screenshot not saved: ${String(e).slice(0, 160)}`); screenshotPath = undefined; }
    }
    // To the journal — what was done and how it ended, and what it cost (rule-based planner — 0)
    try {
      this.d.log?.('browser_session', { url, status: result.status, reason: result.reason, needsHuman: result.needsHuman, confirmation: result.confirmation, xTasks: result.xTasks,
        steps: result.steps.map(s => ({ n: s.n, url: s.url, action: s.action.kind, value: s.action.kind === 'fill' ? s.action.value : s.action.kind === 'select' ? s.action.option : undefined, label: s.label, refused: s.refused,
          by: s.by, why: s.why, usd: s.usd, snapshot: s.snapshot, rejected: s.rejected })),
        // the text of every signed message goes to the journal (an HQ requirement); wallet refusals too
        wallet: result.wallet ? { connected: result.wallet.connected, events: result.wallet.events } : undefined, walletOff: walletNotes.length ? walletNotes : undefined,
        finalUrl: result.finalUrl, ms: result.ms, screenshot: screenshotPath, model: this.d.costOf ? 'planner' : ([...new Set(result.steps.map(s => s.by).filter(b => b && b !== 'rules'))].join('+') || 'none'), costUsd, spentTodayUsd: this.spentTodayUsd });
    } catch (e) { console.error(`[session] log failed: ${String(e).slice(0, 160)}`); }
    const off = walletNotes.length ? `\n${escHtml(`Wallet not given to the site: ${walletNotes.join('; ')}`)}` : '';
    return { result, summary: sessionSummary(result, url) + off, screenshotPath };
  }
}
