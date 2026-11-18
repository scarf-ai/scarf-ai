// Review of hq/E-06-wire, the "money / ledger" part (reviewer reproductions, moved from /tmp/hq/repro-wire-b/wireb.test.ts):
// R1 — /stop after queuing: the next session does not start; R2 — the per-UTC-day session limit survives a restart.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSiteSessions } from '../src/siteWiring.js';
import { SiteSessions } from '../src/exec/siteSessions.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Observation, SiteDriver } from '../src/exec/siteSession.js';
import type { Decision, RawMessage } from '../src/types.js';

const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));
const W = new Wallets(newKeyMaterial(3));
const tmp = () => mkdtempSync(join(tmpdir(), 'rwb-'));
function site(opened: string[], delayMs = 0): () => SiteDriver {
  return () => { let sent = false; let url = ''; let wv = '';
    return { async open(u) { url = u; opened.push(u); if (delayMs) await tick(delayMs); }, async close() {}, async screenshot() { return undefined; },
      async fill(_id: string, t: string) { wv = t; }, async click() { sent = true; },
      async observe(): Promise<Observation> { return sent ? { url, text: 'Thank you — application received', elements: [] }
        : { url, text: 'Apply', elements: [{ id: 'w', kind: 'input', label: 'Wallet address', inputType: 'text', value: wv }, { id: 'go', kind: 'button', label: 'Apply' }] }; } }; };
}
const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-18T10:00:00.000Z', text: 'apply' };
const trust = { score: 9, tier: 'follow' as const, basis: 'author' as const, notes: [] };
const dapp = (u: string): Decision => ({ action: 'dapp_session', sizeUsd: 0, chain: 'unknown', reasons: ['r'], trust, estGasUsd: 0,
  intent: { kind: 'dapp_task', chain: 'unknown', urls: [u], summary: 's', stance: 'neutral', confidence: 0.8 } } as Decision);

describe('E-06 wire — money/ledger (review)', () => {
  it('R1: /stop after queuing — the next session does not start, the result "stopped" with a reason', async () => {
    const clock = new VirtualClock(NOW); const risk = new RiskState(DEFAULT_RISK, clock); const sent: string[] = [];
    const paper = new PaperExecutor(DEFAULT_RISK, risk, new Store(':memory:'), { async send(t) { sent.push(t); } }, clock);
    const opened: string[] = [];
    paper.siteSessions = buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, { browser: 'ready', dataDir: tmp(), brand: { handle: '@scarf_ai', handleRegistered: false },
      wallets: W, rpc: { evm: [] }, log: () => {}, halted: () => risk.halted(), driver: site(opened, 200) });
    await paper.execute(MSG, dapp('https://a-site.xyz/apply'), 1);
    await paper.execute(MSG, dapp('https://b-site.xyz/apply'), 2);   // accepted before the stop, waits in the queue
    risk.setOperatorHalt(true);                                       // the owner: /stop
    await tick(700);
    expect(opened).toEqual(['https://a-site.xyz/apply']);
    expect(sent.some(t => /⏸ Session on b-site\.xyz stopped: new entries are halted \(\/stop, daily or hard stop\) — the session was not started/.test(t))).toBe(true);
  });

  it('R1: a stop check failure — a stop too', async () => {
    const opened: string[] = [];
    const s = new SiteSessions({ driver: site(opened), evmBurners: [], solBurners: [], dataDir: tmp(), maxPerDay: 5, maxUsdPerDay: 1, now: () => NOW, halted: () => { throw new Error('db'); } });
    expect((await s.run('https://a-site.xyz/apply')).result.status).toBe('stopped');
    expect(opened).toEqual([]);
  });

  it('R2: the limit of 10 sessions per UTC day survives a restart; a new UTC day — the count from zero', async () => {
    const dir = tmp(); const opened: string[] = []; let now = NOW;
    const mk = () => new SiteSessions({ driver: site(opened), evmBurners: W.evmBurners.map(a => a.address), solBurners: [], dataDir: dir, maxPerDay: 10, maxUsdPerDay: 1, now: () => now });
    const a = mk(); for (let i = 0; i < 10; i++) { const r = (await a.run(`https://s${i}.xyz/apply`)).result; expect(r.status, r.reason).toBe('done'); }
    expect((await a.run('https://s99.xyz/apply')).result.reason).toMatch(/daily session limit/); opened.length = 0;
    expect(JSON.parse(readFileSync(join(dir, 'sessions', 'day.json'), 'utf8'))).toMatchObject({ day: '2026-11-18', started: 10 });
    const b = mk();                                                   // systemctl restart agent on the same day
    const o = await b.run('https://s10.xyz/apply');
    expect(opened).toEqual([]);
    expect(o.result.reason).toMatch(/daily session limit \(10\) reached/);
    now = Date.UTC(2026, 10, 19, 0, 0, 5);                            // the next UTC day
    const c = mk();
    expect((await c.run('https://s11.xyz/apply')).result.status).toBe('done');
    expect(JSON.parse(readFileSync(join(dir, 'sessions', 'day.json'), 'utf8'))).toMatchObject({ day: '2026-11-19', started: 1 });
  });

  it('R2: a corrupted day.json — the count from zero, the session does not fail', async () => {
    const dir = tmp(); const opened: string[] = [];
    const s0 = new SiteSessions({ driver: site(opened), evmBurners: [], solBurners: [], dataDir: dir, maxPerDay: 1, maxUsdPerDay: 1, now: () => NOW });
    await s0.run('https://s0.xyz/apply');
    writeFileSync(join(dir, 'sessions', 'day.json'), '{oops');
    const s = new SiteSessions({ driver: site(opened), evmBurners: [], solBurners: [], dataDir: dir, maxPerDay: 1, maxUsdPerDay: 1, now: () => NOW });
    expect((await s.run('https://s1.xyz/apply')).result.status).not.toBe('error');
    expect(opened.length).toBe(2);
  });

  it('R3 (address linkage): sites get wallets from the end of the list, the NftLive mint takes from the start (pool.slice(0, n)) — the pools meet later', () => {
    const s = buildSiteSessions({ AGENT_SITE_SESSIONS: 'on' }, { browser: 'ready', dataDir: tmp(), brand: { handle: '@scarf_ai', handleRegistered: false },
      wallets: W, rpc: { evm: [] }, log: () => {}, halted: () => false, driver: site([]) })!;
    const nftLiveFirst = W.evmBurners.filter(() => true)[0].address;  // nftLive.ts:77-79 — free ones in order
    expect(s.valuesFor('a-site.xyz').evmAddress).not.toBe(nftLiveFirst);
    expect(s.valuesFor('a-site.xyz').evmAddress).toBe(W.evmBurners[2].address);
    expect(s.valuesFor('b-site.xyz').evmAddress).toBe(W.evmBurners[1].address);
  });

  it('item 6: the DAPP SESSION card tells the truth about the wallet — with AGENT_SITE_WALLET=on "burner wallet: message signing only"', async () => {
    for (const [env, text] of [
      [{ AGENT_SITE_SESSIONS: 'on' }, /site session started \(no money, no wallet\): https:\/\/a-site\.xyz\/apply/],
      [{ AGENT_SITE_SESSIONS: 'on', AGENT_SITE_WALLET: 'on' }, /site session started \(no money; burner wallet: message signing only\): https:\/\/a-site\.xyz\/apply/],
    ] as const) {
      const clock = new VirtualClock(NOW); const risk = new RiskState(DEFAULT_RISK, clock); const sent: string[] = [];
      const paper = new PaperExecutor(DEFAULT_RISK, risk, new Store(':memory:'), { async send(t) { sent.push(t); } }, clock);
      paper.siteSessions = buildSiteSessions(env, { browser: 'ready', dataDir: tmp(), brand: { handle: '@scarf_ai', handleRegistered: false },
        wallets: W, rpc: { evm: [] }, log: () => {}, halted: () => false, driver: site([]) });
      await paper.execute(MSG, dapp('https://a-site.xyz/apply'), 1);
      expect(sent[0]).toMatch(text);
      await tick(50);
    }
  });
});
