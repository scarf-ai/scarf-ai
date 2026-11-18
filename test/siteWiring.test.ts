// E-06 (#16, #148): wiring of task-site sessions (src/siteWiring.ts), and that dapp_session does not touch money, the ledger or X posts.
// No browser and no network: the driver is a fake site, the balance check is a fake fetch.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSiteSessions, siteSwitch, wireSiteSessions, siteSessionsNotice, SITE_SESSIONS_PER_DAY, SITE_SESSIONS_USD_PER_DAY, type SiteWiringDeps } from '../src/siteWiring.js';
import { SITE_TAG, SITE_MODELS } from '../src/exec/sitePlanner.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import { NO_POST_ACTIONS, actedForPost } from '../src/pipeline.js';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { FreshPrice, LiveEntryGuard, guardedExecutor } from '../src/liveWiring.js';
import type { Observation, SiteDriver } from '../src/exec/siteSession.js';
import type { ToolLoopArgs } from '../src/llm/runner.js';
import type { Decision, RawMessage } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'scarf-wire-')); dirs.push(d); return d; };
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const NOW = Date.UTC(2026, 10, 17, 22, 0, 0);
const W = new Wallets(newKeyMaterial(2));
const RPCS = ['https://eth.test', 'https://base.test', 'https://arb.test', 'https://bsc.test', 'https://rh.test'];

/** A fake site: an "X username" field, a "Wallet address" field, an "Apply" button → "Thank you — application received". */
function fakeSite(st: { fields: Record<string, string>; opened: string[]; done: boolean }, delayMs = 0): () => SiteDriver {
  return () => {
    let sent = false; let url = '';
    return {
      async open(u) { url = u; st.opened.push(u); if (delayMs) await tick(delayMs); },
      async observe(): Promise<Observation> {
        return sent ? { url, text: 'Thank you — application received', elements: [] }
          : { url, text: 'Apply', elements: [{ id: 'x', kind: 'input', label: 'X username', inputType: 'text', value: st.fields.x ?? '' }, { id: 'w', kind: 'input', label: 'Wallet address', inputType: 'text', value: st.fields.w ?? '' }, { id: 'go', kind: 'button', label: 'Apply' }] };
      },
      async fill(id, t) { st.fields[id] = t; },
      async click() { sent = true; },
      async screenshot() { return undefined; },
      async close() { st.done = true; },
    };
  };
}
const newSite = () => ({ fields: {} as Record<string, string>, opened: [] as string[], done: false });

function deps(over: Partial<SiteWiringDeps> = {}): SiteWiringDeps & { lines: string[] } {
  const lines: string[] = [];
  return { browser: 'ready', dataDir: tmp(), brand: { handle: '@scarf_ai', handleRegistered: false }, wallets: W, rpc: { evm: RPCS, solana: 'https://sol.test' },
    log: (s) => lines.push(s), halted: () => false, driver: fakeSite(newSite()), lines, ...over };
}
/** SiteSessions internal dependencies — what exactly is wired (the field is private, read only in the test). */
const inner = (s: unknown) => (s as { d: any }).d;

describe('E-06: buildSiteSessions — .env switches', () => {
  it('without AGENT_SITE_SESSIONS=on — no sessions (the previous agent behaviour), no browser needed', () => {
    for (const env of [{}, { AGENT_SITE_SESSIONS: '' }, { AGENT_SITE_SESSIONS: 'off' }, { AGENT_SITE_WALLET: 'on', AGENT_SITE_MODEL: 'on' }]) {
      const d = deps({ browser: 'unchecked' });
      expect(buildSiteSessions(env, d)).toBeUndefined();
      expect(d.lines).toEqual([]);
    }
  });

  it('a value other than "on" — off, with a clear warning; "on" — case- and whitespace-insensitive', () => {
    expect(siteSwitch({ AGENT_SITE_SESSIONS: ' ON ' }, 'AGENT_SITE_SESSIONS')).toEqual({ on: true });
    const d = deps();
    expect(buildSiteSessions({ AGENT_SITE_SESSIONS: 'yes' }, d)).toBeUndefined();
    expect(d.lines).toEqual(['site sessions: AGENT_SITE_SESSIONS=yes is not "on" — treated as off']);
  });

  it('on, but the browser is unavailable (or not checked) — no sessions, one clear log line', () => {
    const d = deps({ browser: { error: "browserType.launch: Executable doesn't exist at /opt/agent/.pw-browsers/chromium" } });
    expect(buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, d)).toBeUndefined();
    expect(d.lines.length).toBe(1);
    expect(d.lines[0]).toMatch(/^site sessions: NOT connected — browser is not available: browserType\.launch: Executable doesn't exist/);
    expect(d.lines[0]).toMatch(/"Browser for sites"/);
    const u = deps({ browser: 'unchecked' });
    expect(buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, u)).toBeUndefined();
    expect(u.lines[0]).toMatch(/NOT connected — the browser check did not run/);
  });

  it('on without AGENT_SITE_WALLET — forms with burner wallet addresses, but sessions have no wallet; limits of 10 per day and $1', () => {
    const d = deps();
    const s = buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, d);
    expect(s).toBeDefined();
    expect(inner(s).wallet).toBeUndefined();
    expect(inner(s).model).toBeUndefined();
    expect(inner(s).evmBurners).toEqual([...W.evmBurners].reverse().map(a => a.address)); // from the end of the list: the NftLive mint takes from the start
    expect(inner(s).solBurners).toEqual(W.solBurners.map(k => k.publicKey.toBase58()));
    expect(inner(s).maxPerDay).toBe(SITE_SESSIONS_PER_DAY); expect(SITE_SESSIONS_PER_DAY).toBe(10);
    expect(inner(s).maxUsdPerDay).toBe(SITE_SESSIONS_USD_PER_DAY); expect(SITE_SESSIONS_USD_PER_DAY).toBe(1);
    expect(d.lines.length).toBe(1);
    expect(d.lines[0]).toMatch(/^site sessions: on — up to 10\/day UTC, model spend up to \$1\/day UTC; wallet off; model off; X handle none; burners EVM 2 \/ Solana 2/);
    expect(JSON.stringify(d.lines)).not.toMatch(/privateKey|secretKey/);
  });

  it('on + AGENT_SITE_WALLET=on, but the keystore is not open — no wallet, no addresses, the reason in the log', () => {
    const d = deps({ wallets: undefined });
    const s = buildSiteSessions({ AGENT_SITE_SESSIONS: 'on', AGENT_SITE_WALLET: 'on' }, d);
    expect(inner(s).wallet).toBeUndefined();
    expect(inner(s).evmBurners).toEqual([]); expect(inner(s).solBurners).toEqual([]);
    expect(d.lines[0]).toMatch(/wallet off/);
    expect(d.lines[0]).toMatch(/keystore is not unlocked — no burner addresses/);
    expect(d.lines[0]).toMatch(/AGENT_SITE_WALLET=on, but the keystore is not unlocked — no session wallet/);
  });

  it('on + AGENT_SITE_WALLET=on + keys open — signers of the same wallets; "no coins" is checked on all five EVM nodes and the Solana node', async () => {
    const asked: string[] = []; let evmBalance = '0x0';
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const b = JSON.parse(init.body); asked.push(`${url} ${b.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: b.method === 'getBalance' ? { value: 0 } : (url === 'https://bsc.test' ? evmBalance : '0x0') }));
    }) as unknown as typeof fetch;
    const d = deps({ fetchImpl });
    const s = buildSiteSessions({ AGENT_SITE_SESSIONS: 'on', AGENT_SITE_WALLET: 'on' }, d);
    const w = inner(s).wallet;
    expect(w.evm.map((x: any) => x.address)).toEqual(W.evmBurners.map(a => a.address));
    expect(w.sol.map((x: any) => x.address)).toEqual(W.solBurners.map(k => k.publicKey.toBase58()));
    expect(await w.hasNoMoney('evm', W.evmBurners[0].address)).toBe(true);
    expect(asked).toEqual(RPCS.map(u => `${u} eth_getBalance`));
    evmBalance = '0x1'; // a coin on BSC — the wallet is not given to the site
    expect(await w.hasNoMoney('evm', W.evmBurners[0].address)).toBe(false);
    asked.length = 0;
    expect(await w.hasNoMoney('sol', W.solBurners[0].publicKey.toBase58())).toBe(true);
    expect(asked).toEqual(['https://sol.test getBalance']);
    expect(d.lines[0]).toMatch(/wallet on \(message signing only, empty burners only\)/);
  });

  it('the model — only with AGENT_SITE_MODEL=on and a key present; a call writes the spend to the daily budget with the tag:site label', async () => {
    const spent = new Map<string, number>();
    const budget = { record: (m: string, usd: number) => spent.set(m, (spent.get(m) ?? 0) + usd), spent: (m: string) => spent.get(m) ?? 0 };
    const calls: ToolLoopArgs[] = [];
    const loop = async (a: ToolLoopArgs) => { calls.push(a); return { final: { action: 'stop', code: 'no_way', why: 'test' }, usage: [{ input_tokens: 1000, output_tokens: 100 }], toolCalls: [], trace: [] }; };
    // no key — no model, the reason in the log
    const noKey = deps();
    expect(inner(buildSiteSessions({ AGENT_SITE_SESSIONS: 'on', AGENT_SITE_MODEL: 'on' }, noKey)).model).toBeUndefined();
    expect(noKey.lines[0]).toMatch(/AGENT_SITE_MODEL=on, but there is no Anthropic key — sessions run on rules only/);
    // a key is present, the switch is off — no model
    expect(inner(buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, deps({ model: { loop, budget } }))).model).toBeUndefined();
    // a key is present and the switch is on
    const d = deps({ model: { loop, budget } });
    const m = inner(buildSiteSessions({ AGENT_SITE_SESSIONS: 'on', AGENT_SITE_MODEL: 'on' }, d)).model;
    expect(d.lines[0]).toMatch(/model on \(fallback of the rules\)/);
    const r = await m.pick('haiku', { system: 's', user: 'u' });
    expect(calls[0].model).toBe(SITE_MODELS.haiku);
    expect(r.usd).toBeGreaterThan(0);
    expect(spent.get(SITE_TAG)).toBeCloseTo(r.usd, 10);
    expect(spent.get(SITE_MODELS.haiku)).toBeCloseTo(r.usd, 10);
    expect(m.spentToday()).toBeCloseTo(r.usd, 10); // the $1 daily cap survives a restart: the count comes from the daily budget
  });

  it('the X name is entered on sites only if the account is registered (brand.json handle_registered: true)', async () => {
    const off = deps();
    expect(inner(buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, off)).xHandle).toBeUndefined();
    expect(off.lines[0]).toMatch(/handle_registered is not true — forms that ask for an X handle are not sent/);
    const st = newSite();
    const on = deps({ brand: { handle: '@scarf_ai', handleRegistered: true }, driver: fakeSite(st) });
    const s = buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, on)!;
    expect(inner(s).xHandle).toBe('@scarf_ai');
    expect(on.lines[0]).toMatch(/X handle @scarf_ai/);
    // the built sessions work: the form gets the X name and the burner wallet address
    const o = await s.run('https://tinmoths.xyz/apply');
    expect(o.result.status).toBe('done');
    expect(st.fields).toEqual({ x: 'scarf_ai', w: W.evmBurners.at(-1)!.address }); // the first site — the last wallet in the list
  });
});

describe('E-06: dapp_session — no money, no position, outside the executor lock, no X post', () => {
  const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-17T22:00:00.000Z', text: 'apply https://tinmoths.xyz/apply' };
  const trust = { score: 9, tier: 'follow' as const, basis: 'author' as const, notes: [] };
  const decision = (urls: string[], chain = 'base'): Decision => ({ action: 'dapp_session', sizeUsd: 12, chain, reasons: ['browser session'], trust, estGasUsd: 0.45,
    intent: { kind: 'dapp_task', chain, urls, summary: 'apply for the whitelist', stance: 'neutral', confidence: 0.8 } } as Decision);

  function setup(mode: 'paper' | 'live', delayMs = 0) {
    const clock = new VirtualClock(NOW);
    const risk = new RiskState(DEFAULT_RISK, clock); const sent: string[] = []; const posts: unknown[] = [];
    const paper = new PaperExecutor(DEFAULT_RISK, risk, new Store(':memory:'), { async send(t) { sent.push(t); } }, clock);
    paper.liveMode = mode;
    paper.poster = { async queue(e) { posts.push(e); } };
    const st = newSite();
    paper.siteSessions = buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, deps({ driver: fakeSite(st, delayMs), brand: { handle: '@scarf_ai', handleRegistered: true } }));
    return { risk, paper, sent, posts, st, clock };
  }

  it('paper: cash, the day result and positions do not change; no X post is queued; an analysis with dapp_session does not mute the thought', async () => {
    const e = setup('paper');
    const cash0 = e.risk.cashUsd; const eq0 = e.risk.equityUsd;
    await e.paper.execute(MSG, decision(['https://tinmoths.xyz/apply']), 1);
    await tick(80);
    expect(e.st.done).toBe(true); expect(e.sent.at(-1)).toMatch(/✅ Application on tinmoths\.xyz submitted/);
    expect(e.risk.cashUsd).toBe(cash0); expect(e.risk.equityUsd).toBe(eq0); expect(e.risk.todayPnl()).toBe(0); expect(e.risk.positions.length).toBe(0);
    expect(e.posts).toEqual([]);
    expect(NO_POST_ACTIONS.has('dapp_session')).toBe(true);
    expect(actedForPost([{ action: 'dapp_session' }])).toBe(false);
    expect(actedForPost([{ action: 'dapp_session' }, { action: 'buy_token' }])).toBe(true);
  });

  it('live with the entry guard: the session runs outside the executor lock — while it is open, the next decision is executed right away; no money and no position', async () => {
    const e = setup('live', 300);
    const price = new FreshPrice(() => e.clock.now()); price.accept(3000);
    const guard = new LiveEntryGuard(price);
    const exec = guardedExecutor(e.paper, guard, () => {});
    // until the startup reconciliation ends — like any entry, it waits (the HQ guard; ENTRY_ACTIONS)
    await expect(exec.execute(MSG, decision(['https://tinmoths.xyz/apply']), 1)).rejects.toThrow(/startup wallet reconciliation not finished/);
    guard.openEntries();
    guard.ethUsd(); // decide reads the price before the entry
    const cash0 = e.risk.cashUsd;
    await exec.execute(MSG, decision(['https://tinmoths.xyz/apply']), 2);
    expect(e.st.opened.length).toBe(1); expect(e.st.done).toBe(false); // the session is still running
    const t0 = Date.now();
    guard.ethUsd();
    await exec.execute(MSG, decision(['https://x.com/tinmoths']), 3); // the executor lock is free
    expect(Date.now() - t0).toBeLessThan(200);
    expect(e.sent.at(-1)).toMatch(/no task url in the message — nothing was done/);
    await tick(400);
    expect(e.st.done).toBe(true);
    expect(e.risk.cashUsd).toBe(cash0); expect(e.risk.positions.length).toBe(0); expect(e.posts).toEqual([]);
  });
});

describe('E-06: wiring in index.ts — wireSiteSessions and the line in the startup message', () => {
  it('sessions are handed over after the browser check; a browser error — no sessions; no check — "unchecked"', async () => {
    let got: unknown = 'not set';
    const ok = deps(); await wireSiteSessions(Promise.resolve(undefined), { AGENT_SITE_SESSIONS: 'on' }, ok, s => { got = s; });
    expect(got).toBeDefined(); expect(ok.lines[0]).toMatch(/^site sessions: on/);
    const bad = deps(); await wireSiteSessions(Promise.resolve('no chromium'), { AGENT_SITE_SESSIONS: 'on' }, bad, s => { got = s; });
    expect(got).toBeUndefined(); expect(bad.lines[0]).toMatch(/browser is not available: no chromium/);
    const none = deps(); await wireSiteSessions(undefined, { AGENT_SITE_SESSIONS: 'on' }, none, s => { got = s; });
    expect(none.lines[0]).toMatch(/the browser check did not run/);
  });

  it('a build failure — not an exception, but a log line (d.log → the service journal and the review log); no sessions', async () => {
    const d = deps({ wallets: { get evmBurners(): never { throw new Error('keystore broken'); }, solBurners: [] } as unknown as SiteWiringDeps['wallets'] });
    let set = false;
    await expect(wireSiteSessions(Promise.resolve(undefined), { AGENT_SITE_SESSIONS: 'on' }, d, () => { set = true; })).resolves.toBeUndefined();
    expect(set).toBe(false);
    expect(d.lines).toEqual(['site sessions: wiring failed — keystore broken; sessions are off']);
  });

  it('the startup message: off — empty; on; the browser check is still running — "will connect later", not "no browser"', () => {
    expect(siteSessionsNotice(false, { done: false, connected: false })).toBe('');
    expect(siteSessionsNotice(true, { done: true, connected: true })).toBe(' Task-site sessions: on.');
    expect(siteSessionsNotice(true, { done: false, connected: false })).toMatch(/the browser check is still running, sessions will connect later/);
    expect(siteSessionsNotice(true, { done: false, connected: false })).not.toMatch(/no browser/);
    expect(siteSessionsNotice(true, { done: true, connected: false })).toMatch(/not connected \(no browser or a failure — details in the log\)/);
  });
});
