// E-06 (#16): running sessions from the executor — without money, outside the executor lock, with a daily limit, a screenshot and a journal record.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { SiteSessions, BurnerBook, burnerFor, taskUrl } from '../src/exec/siteSessions.js';
import type { Observation, SiteDriver } from '../src/exec/siteSession.js';
import type { Decision, RawMessage } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'scarf-sess-')); dirs.push(d); return d; };
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const BURNERS = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];
const SOLB = ['77HqxiSynthAabcdefghijkmnopqrstuvwxyz1Xxpump'];
const NOW = Date.UTC(2026, 10, 17, 9, 30, 0);

/** A fake site: one "X username" field, an "Apply" button, after the press — a confirmation. */
function site(log: { fields: Record<string, string>; opened: string[]; running: number; maxRunning: number }, delayMs = 0): () => SiteDriver {
  return () => {
    let sent = false; let url = '';
    return {
      async open(u) { url = u; log.opened.push(u); log.running++; log.maxRunning = Math.max(log.maxRunning, log.running); if (delayMs) await tick(delayMs); },
      async observe(): Promise<Observation> {
        return sent ? { url, text: 'Thank you — application received', elements: [] }
          : { url, text: 'Apply', elements: [{ id: 'x', kind: 'input', label: 'X username', inputType: 'text', value: log.fields.x ?? '' }, { id: 'w', kind: 'input', label: 'Wallet address', inputType: 'text', value: log.fields.w ?? '' }, { id: 'go', kind: 'button', label: 'Apply' }] };
      },
      async fill(id, t) { log.fields[id] = t; },
      async click() { sent = true; },
      async screenshot() { return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]); },
      async close() { log.running--; },
    };
  };
}
const newLog = () => ({ fields: {} as Record<string, string>, opened: [] as string[], running: 0, maxRunning: 0 });

describe('E-06: SiteSessions', () => {
  it('the session goes through, a screenshot is saved in <data>/sessions, the browser_session event is recorded without keys and with spend 0', async () => {
    const dir = tmp(); const log = newLog(); const events: any[] = [];
    const s = new SiteSessions({ driver: site(log), xHandle: '@scarf_ai', evmBurners: BURNERS, solBurners: SOLB, dataDir: dir, maxPerDay: 5, maxUsdPerDay: 1, log: (k, d) => events.push({ k, ...d }), now: () => NOW });
    const o = await s.run('https://tinmoths.xyz/apply');
    expect(o.result.status).toBe('done');
    expect(log.fields).toEqual({ x: 'scarf_ai', w: BURNERS[0] }); // the first free burner wallet
    expect(o.screenshotPath).toBe(join(dir, 'sessions', '20261117-093000-tinmoths.xyz.png'));
    expect(readdirSync(join(dir, 'sessions')).filter(n => n.endsWith('.png'))).toEqual(['20261117-093000-tinmoths.xyz.png']);
    expect(readFileSync(o.screenshotPath!).length).toBe(6);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ k: 'browser_session', url: 'https://tinmoths.xyz/apply', status: 'done', model: 'none', costUsd: 0, spentTodayUsd: 0, screenshot: o.screenshotPath });
    expect(events[0].steps.map((x: any) => `${x.action}:${x.value ?? x.label}`)).toEqual(['fill:x_handle', 'fill:evm_address', 'click:Apply', 'done:undefined']);
    expect(JSON.stringify(events[0])).not.toMatch(/screenshot":\{/); // the screenshot itself is not written to the journal — only the path
    expect(o.summary).toMatch(/✅ Application on tinmoths\.xyz submitted/);
  });

  it('one site — always the same burner wallet (also for a subdomain); different sites — by the list; an empty list — no address', () => {
    const a = burnerFor('tinmoths.xyz', BURNERS);
    expect(BURNERS).toContain(a);
    expect(burnerFor('app.tinmoths.xyz', BURNERS)).toBe(a);
    expect(burnerFor('www.TinMoths.xyz', BURNERS)).toBe(a);
    const picks = new Set(['a.xyz', 'b.io', 'c.com', 'd.org', 'e.app', 'f.gg', 'g.fun', 'h.net'].map(h => burnerFor(h, BURNERS)));
    expect(picks.size).toBeGreaterThan(1);
    expect(burnerFor('tinmoths.xyz', [])).toBeUndefined();
  });

  it('the "site → wallet" book: each site gets its own address while free ones remain; the record survives a restart; free ones ran out — an address by the site name', () => {
    const dir = tmp();
    const a = new BurnerBook(dir);
    expect(a.pick('evm', 'tinmoths.xyz', BURNERS)).toBe(BURNERS[0]);
    expect(a.pick('evm', 'app.tinmoths.xyz', BURNERS)).toBe(BURNERS[0]); // the same site — the same wallet
    expect(a.pick('evm', 'nebulix.io', BURNERS)).toBe(BURNERS[1]);
    expect(a.pick('sol', 'nebulix.io', SOLB)).toBe(SOLB[0]);               // chains are counted separately
    const b = new BurnerBook(dir);                                         // "restart"
    expect(b.pick('evm', 'nebulix.io', BURNERS)).toBe(BURNERS[1]);
    expect(b.pick('evm', 'cityprotocol.co', BURNERS)).toBe(BURNERS[2]);
    expect(b.pick('evm', 'fourth.xyz', BURNERS)).toBe(burnerFor('fourth.xyz', BURNERS)); // no free ones
    expect(new BurnerBook(dir).pick('evm', 'tinmoths.xyz', BURNERS.slice(1))).toBe(BURNERS[1]); // the wallet was removed from the list — the site gets another one
    expect(a.pick('evm', 'x.xyz', [])).toBeUndefined();
  });

  it('sessions run one at a time; the daily limit — a refusal with a reason without opening the site; the next day the count restarts', async () => {
    const dir = tmp(); const log = newLog(); let now = NOW;
    const s = new SiteSessions({ driver: site(log, 30), evmBurners: BURNERS, solBurners: [], xHandle: 'scarf_ai', dataDir: dir, maxPerDay: 2, maxUsdPerDay: 1, now: () => now });
    const rs = await Promise.all([s.run('https://a.xyz/'), s.run('https://b.xyz/'), s.run('https://c.xyz/')]);
    expect(log.maxRunning).toBe(1);
    expect(rs.map(r => r.result.status)).toEqual(['done', 'done', 'stopped']);
    expect(rs[2].result.reason).toBe('daily session limit (2) reached — next sessions after 00:00 UTC');
    expect(log.opened).toEqual(['https://a.xyz/', 'https://b.xyz/']);
    now = NOW + 24 * 3600_000;
    expect((await s.run('https://c.xyz/')).result.status).toBe('done');
  });

  it('the $1 per day spend cap: rule-based sessions cost $0 and do not spend it; paid ones — up to the cap, then refused until 00:00 UTC', async () => {
    const dir = tmp(); const log = newLog(); let now = NOW; const events: any[] = [];
    const free = new SiteSessions({ driver: site(log), evmBurners: BURNERS, solBurners: [], xHandle: 'scarf_ai', dataDir: dir, maxPerDay: 50, maxUsdPerDay: 1, now: () => now, log: (k, d) => events.push(d) });
    for (let i = 0; i < 12; i++) expect((await free.run(`https://s${i}.xyz/`)).result.status).toBe('done');
    expect(events.every(e => e.costUsd === 0 && e.model === 'none')).toBe(true);
    const paid = new SiteSessions({ driver: site(log), evmBurners: BURNERS, solBurners: [], xHandle: 'scarf_ai', dataDir: dir, maxPerDay: 50, maxUsdPerDay: 1, costOf: () => 0.4, now: () => now });
    const rs = [await paid.run('https://a.xyz/'), await paid.run('https://b.xyz/'), await paid.run('https://c.xyz/'), await paid.run('https://d.xyz/')];
    expect(rs.map(r => r.result.status)).toEqual(['done', 'done', 'done', 'stopped']); // 0.4 + 0.4 + 0.4 = 1.2 ≥ 1 → the fourth does not start
    expect(rs[3].result.reason).toBe('daily session budget ($1.00) is spent — next sessions after 00:00 UTC');
    now = NOW + 24 * 3600_000;
    expect((await paid.run('https://d.xyz/')).result.status).toBe('done');
    const off = new SiteSessions({ driver: site(log), evmBurners: BURNERS, solBurners: [], dataDir: dir, maxPerDay: 5, maxUsdPerDay: Number('x'), now: () => now });
    expect((await off.run('https://a.xyz/')).result.status).toBe('stopped'); // the cap is not set as a number — no sessions
  });

  it('the task link: the first http(s) and not X; garbage and links to X are skipped', () => {
    expect(taskUrl(['https://x.com/tinmoths', 'not a url', 'https://tinmoths.xyz/apply'])).toBe('https://tinmoths.xyz/apply');
    expect(taskUrl(['javascript:alert(1)', 'ftp://a.b/c'])).toBeUndefined();
    expect(taskUrl(undefined)).toBeUndefined();
  });

  it('a driver failure on creation does not crash the run: an error result', async () => {
    const s = new SiteSessions({ driver: () => { throw new Error('chromium is not installed'); }, evmBurners: BURNERS, solBurners: [], dataDir: tmp(), maxPerDay: 5, maxUsdPerDay: 1 });
    const o = await s.run('https://a.xyz/');
    expect(o.result.status).toBe('error'); expect(o.result.reason).toMatch(/chromium is not installed/);
  });
});

describe('E-06: the executor starts a session on a dapp_session decision', () => {
  const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-17T09:30:00.000Z', text: 'apply https://tinmoths.xyz/apply' };
  const trust = { score: 9, tier: 'follow' as const, basis: 'author' as const, notes: [] };
  const decision = (urls: string[]): Decision => ({ action: 'dapp_session', sizeUsd: 0, chain: 'unknown', reasons: ['browser session'], trust, estGasUsd: 0.15,
    intent: { kind: 'dapp_task', chain: 'unknown', urls, summary: 'apply for the whitelist', stance: 'neutral', confidence: 0.8 } } as Decision);
  function setup(mode: 'paper' | 'live') {
    const clock = new VirtualClock(NOW);
    const risk = new RiskState(DEFAULT_RISK, clock); const sent: string[] = [];
    const paper = new PaperExecutor(DEFAULT_RISK, risk, new Store(':memory:'), { async send(t) { sent.push(t); } }, clock);
    paper.liveMode = mode;
    const log = newLog();
    paper.siteSessions = new SiteSessions({ driver: site(log, 20), xHandle: '@scarf_ai', evmBurners: BURNERS, solBurners: SOLB, dataDir: tmp(), maxPerDay: 5, maxUsdPerDay: 1, now: () => NOW });
    return { risk, paper, sent, log };
  }

  for (const mode of ['paper', 'live'] as const) {
    it(`${mode}: the "session started" card, the session runs outside the executor lock, the result — a separate message; cash and the day result do not change`, async () => {
      const e = setup(mode);
      const cash0 = e.risk.cashUsd;
      await e.paper.execute(MSG, decision(['https://tinmoths.xyz/apply']), 1); // returned right away, the session is still running
      expect(e.sent.length).toBe(1);
      expect(e.sent[0]).toMatch(/DAPP SESSION/); expect(e.sent[0]).toMatch(/site session started \(no money, no wallet\): https:\/\/tinmoths\.xyz\/apply/);
      await tick(150);
      expect(e.sent.length).toBe(2); expect(e.sent[1]).toMatch(/✅ Application on tinmoths\.xyz submitted/);
      expect(e.log.fields.x).toBe('scarf_ai');
      expect(e.risk.cashUsd).toBe(cash0); expect(e.risk.todayPnl()).toBe(0); expect(e.risk.positions.length).toBe(0);
    });
  }

  it('the entry stop stops new sessions too; without a task link — a card with a reason, the site is not opened', async () => {
    const e = setup('paper');
    e.risk.setOperatorHalt(true);
    await expect(e.paper.execute(MSG, decision(['https://tinmoths.xyz/apply']), 1)).rejects.toThrow(/trading halted/);
    e.risk.setOperatorHalt(false);
    await e.paper.execute(MSG, decision(['https://x.com/tinmoths']), 2);
    await tick(60);
    expect(e.log.opened).toEqual([]);
    expect(e.sent.at(-1)).toMatch(/no task url in the message — nothing was done/);
  });

  it('sessions are not wired — the previous behaviour: paper — only a card, live — "journal only"', async () => {
    const p = setup('paper'); p.paper.siteSessions = undefined;
    await p.paper.execute(MSG, decision(['https://tinmoths.xyz/apply']), 1);
    expect(p.sent[0]).toMatch(/no browser executor yet \(E-06\)/); expect(p.log.opened).toEqual([]);
    const l = setup('live'); l.paper.siteSessions = undefined;
    await expect(l.paper.execute(MSG, decision(['https://tinmoths.xyz/apply']), 1)).rejects.toThrow(/journal only/);
  });
});

// ── Part 2: the wallet is given to a session only if the burner wallet holds no money ───────────────────────────────────────────
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { evmSigner } from '../src/exec/siteWallet.js';
import type { PageWallet } from '../src/exec/siteSession.js';

describe('E-06 part 2: SiteSessions and the wallet', () => {
  const accounts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const addrs = accounts.map(a => a.address);
  const MSG = 'Sign to verify your wallet. Nonce: 77';
  /** A site: Connect Wallet → Sign message → "verified"; remembers whether it was given a wallet. */
  function wsite(st: { wallet?: PageWallet; clicks: string[] }): () => SiteDriver {
    return () => {
      let stage = 0; const url = 'https://tinmoths.xyz/apply';
      return { async open() {}, async close() {}, async fill() {}, attachWallet(w) { st.wallet = w; },
        async observe(): Promise<Observation> {
          return stage === 0 ? { url, text: 'Join', elements: [{ id: 'c', kind: 'button', label: 'Connect Wallet' }] }
            : stage === 1 ? { url, text: 'Connected', elements: [{ id: 's', kind: 'button', label: 'Sign message' }] } : { url, text: 'Wallet verified. Thank you!', elements: [] };
        },
        async click(id) {
          st.clicks.push(id);
          if (id === 'c') { await st.wallet!.request({ kind: 'evm', method: 'eth_requestAccounts', params: [], frameUrl: url }); stage = 1; }
          if (id === 's') { await st.wallet!.request({ kind: 'evm', method: 'personal_sign', params: [`0x${Buffer.from(MSG).toString('hex')}`, st.wallet!.evmAddress], frameUrl: url }); stage = 2; }
        } };
    };
  }
  const deps = (st: { wallet?: PageWallet; clicks: string[] }, hasNoMoney: (k: 'evm' | 'sol', a: string) => Promise<boolean>, events: any[]) =>
    ({ driver: wsite(st), evmBurners: addrs, solBurners: [], dataDir: tmp(), maxPerDay: 5, maxUsdPerDay: 1, now: () => NOW, log: (_k: string, d: any) => events.push(d),
      wallet: { evm: accounts.map(a => evmSigner(a)), sol: [], hasNoMoney } });

  it('the wallet is empty → the session connects it and signs a message; the journal has the signature text and the address of this site\'s wallet', async () => {
    const st = { clicks: [] as string[] } as { wallet?: PageWallet; clicks: string[] }; const events: any[] = []; const asked: string[] = [];
    const s = new SiteSessions(deps(st, async (k, a) => { asked.push(`${k}:${a}`); return true; }, events));
    const o = await s.run('https://tinmoths.xyz/apply');
    expect(o.result.status).toBe('done'); expect(st.clicks).toEqual(['c', 's']);
    expect(asked).toEqual([`evm:${addrs[0]}`]);                       // exactly the wallet the site got was checked
    expect(st.wallet!.evmAddress).toBe(addrs[0]);
    expect(events[0].wallet.events.filter((e: any) => e.message).map((e: any) => [e.method, e.allowed, e.message])).toEqual([['personal_sign', true, MSG]]);
    expect(events[0].walletOff).toBeUndefined();
    expect(o.summary).toMatch(/Signed a message \(evm\): .Sign to verify your wallet\. Nonce: 77./);
    expect(JSON.stringify(events[0])).not.toMatch(/privateKey|secretKey/);
  });

  it('the wallet holds money, the check failed or there is no signer → the wallet is not given to the site, the session runs as in part 1; the reason — to the owner and the journal', async () => {
    for (const [hasNoMoney, why] of [
      [async () => false, /evm: burner 0x[0-9a-fA-F]{40} holds funds — not offered to the site/],
      [async () => { throw new Error('rpc timeout'); }, /evm: balance check failed \(rpc timeout\)/],
    ] as const) {
      const st = { clicks: [] as string[] } as { wallet?: PageWallet; clicks: string[] }; const events: any[] = [];
      const o = await new SiteSessions(deps(st, hasNoMoney as any, events)).run('https://tinmoths.xyz/apply');
      expect(st.wallet).toBeUndefined(); expect(st.clicks).toEqual([]);
      expect(o.result.status).toBe('stopped'); expect(o.result.reason).toMatch(/"Connect Wallet" — needs a wallet, a signature or money \(E-13\)/);
      expect(o.summary).toMatch(/Wallet not given to the site: /); expect(o.summary).toMatch(why);
      expect(events[0].walletOff[0]).toMatch(why);
    }
    const st = { clicks: [] as string[] } as { wallet?: PageWallet; clicks: string[] }; const events: any[] = [];
    const d = deps(st, async () => true, events); d.wallet.evm = [];
    const o = await new SiteSessions(d).run('https://tinmoths.xyz/apply');
    expect(st.wallet).toBeUndefined(); expect(o.summary).toMatch(/evm: no signer for 0x/);
  });

  it('the wallet is not wired in the settings (wallet not set) — the part 1 behaviour, no balance checks', async () => {
    const st = { clicks: [] as string[] } as { wallet?: PageWallet; clicks: string[] };
    const s = new SiteSessions({ driver: wsite(st), evmBurners: addrs, solBurners: [], dataDir: tmp(), maxPerDay: 5, maxUsdPerDay: 1, now: () => NOW });
    const o = await s.run('https://tinmoths.xyz/apply');
    expect(st.wallet).toBeUndefined(); expect(o.result.status).toBe('stopped'); expect(o.summary).not.toMatch(/Wallet not given to the site/);
  });
});
