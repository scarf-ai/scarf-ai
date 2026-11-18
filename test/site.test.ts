import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.js';
import { handler, AgentView, SiteLedger, type SiteConfig } from '../src/site/server.js';
import { pickModel, cleanReply, journalText, systemText, HAIKU, SONNET, type Caller } from '../src/site/answer.js';

const items = [
  { ts: '2026-10-24T09:12:00Z', kind: 'thought', text: 'Watching $KEG on BNB: real volume, thin liquidity. No position.' },
  { ts: '2026-10-23T16:54:00Z', kind: 'exit', text: '[paper] Closed $SWARMX: −$0.54. No position now.' },
];

describe('site answers (the owner 2026-10-24: Haiku, Sonnet for hard ones, $3/day)', () => {
  it('Sonnet only for a "why/compare" question about a project from the public journal', () => {
    expect(pickModel('what are you watching?', items)).toBe(HAIKU);
    expect(pickModel('why did you lose on SWARMX?', items)).toBe(SONNET);
    expect(pickModel('почему $KEG а не что-то другое?', items)).toBe(SONNET);
    expect(pickModel('why is the sky blue?', items)).toBe(HAIKU);
  });
  it('reply: no links, short addresses, a source name replaces the whole answer, unknown pose → neutral', () => {
    expect(cleanReply('See https://x.com/foo and 0x5b2e8a47d1c9f03e6b72a5d84c19e0f37ab2c4f9', 'win', []).text).toBe('See and 0x5b2e…c4f9');
    const l = cleanReply('Saw it in ServerA first', 'dance', ['ServerA']);
    expect(l.leaked).toBe(true);
    expect(l.text).not.toMatch(/ServerA/);
    expect(l.pose).toBe('neutral');
  });
  it('the model sees only the public journal and stats, rules forbid advice and sources', () => {
    const j = journalText(items, { closed: 1, wins: 0, pnlUsd: -0.54, open: 0, mode: 'paper' });
    expect(j).toContain('Paper trading');
    expect(j).toContain('$KEG');
    expect(systemText()).toMatch(/Never give financial advice/);
    expect(systemText()).toMatch(/Never name or hint where ideas come from/);
  });
});

describe('site server', () => {
  async function boot(over: Partial<SiteConfig> = {}, call?: Caller) {
    const dir = mkdtempSync(join(tmpdir(), 'site-'));
    const st = new Store(join(dir, 'agent.sqlite'));
    st.saveMessage({ id: 'm1', sourceServer: 'ServerA', channel: 'alpha', author: 'bobcaller', tsUtc: '2026-10-24T00:00:00Z', text: 'x' } as any);
    const a = st.addPost('2026-10-24T09:12:00Z', 'thought', items[0].text); st.updatePost(a, { status: 'posted', posted_utc: '2026-10-24T09:12:00Z' });
    const b = st.addPost('2026-10-24T10:00:00Z', 'thought', 'Rejected draft about $SECRET'); st.updatePost(b, { status: 'rejected' });
    const dist = join(dir, 'dist'); mkdirSync(dist); writeFileSync(join(dist, 'index.html'), '<h1>ok</h1>');
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    const cfg: SiteConfig = { port: 0, host: '127.0.0.1', distDir: dist, agentDb: join(dir, 'agent.sqlite'), siteDb: join(dir, 'site.sqlite'), dailyUsd: 3, ipPerHour: 3, ipPerDay: 10, mode: 'paper', includeDrafts: false, ...over };
    const ledger = new SiteLedger(cfg.siteDb);
    const seen: any[] = [];
    const caller: Caller = call ?? (async (p) => { seen.push(p); return { input: { text: 'Watching $KEG, no position.', pose: 'thinking' }, usage: { input_tokens: 2000, output_tokens: 60 } }; });
    const srv = createServer(handler({ cfg, view: new AgentView(cfg.agentDb, cfg.includeDrafts, cfg.mode), ledger, call: caller, now: () => Date.parse('2026-10-24T12:00:00Z') }));
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const ask = async (q: string) => (await fetch(`${base}/api/ask`, { method: 'POST', body: JSON.stringify({ q }) })).json();
    return { base, ask, seen, ledger, close: () => srv.close() };
  }
  it('feed shows only posts published on X; answers go through the model with that journal', async () => {
    const s = await boot();
    const f = await (await fetch(`${s.base}/api/feed`)).json();
    expect(f.items.map((i: any) => i.text)).toEqual([items[0].text]);
    expect(f.stats.mode).toBe('paper');
    const r = await s.ask('what are you watching?');
    expect(r).toEqual({ text: 'Watching $KEG, no position.', pose: 'thinking' });
    expect(s.seen[0].model).toBe(HAIKU);
    const sys = s.seen[0].system.map((x: any) => x.text).join('\n');
    expect(sys).toContain('$KEG');
    expect(sys).not.toContain('SECRET');
    expect(sys).not.toMatch(/ServerA|bobcaller/);
    expect(s.ledger.spent('2026-10-24')).toBeGreaterThan(0);
    s.close();
  });
  it('per-visitor limit and daily budget stop model calls', async () => {
    const s = await boot();
    for (let i = 0; i < 3; i++) await s.ask(`q${i}`);
    expect((await s.ask('one more')).text).toMatch(/one at a time/i);
    expect(s.seen.length).toBe(3);
    s.close();
    const t = await boot({ dailyUsd: 0.000001 });
    expect((await t.ask('hi')).text).toMatch(/00:00 UTC/);
    expect(t.seen.length).toBe(0);
    t.close();
  });
  it('a leaking answer is replaced; static files cannot escape the site folder', async () => {
    const s = await boot({}, async () => ({ input: { text: 'bobcaller in ServerA said so', pose: 'win' }, usage: { input_tokens: 10, output_tokens: 10 } }));
    expect((await s.ask('who told you?')).text).not.toMatch(/bobcaller|ServerA/);
    const r = await fetch(`${s.base}/..%2Fsecret.txt`);
    expect(await r.text()).not.toContain('nope');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    s.close();
  });
});

describe('site env', () => {
  it('takes only the Anthropic key and SITE_* from .env — no Discord/X/RPC secrets', async () => {
    const { siteEnv } = await import('../src/site/server.js');
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    writeFileSync(join(dir, '.env'), 'DISCORD_TOKEN=abc\nANTHROPIC_API_KEY="sk-1"\nX_API_SECRET=zzz\nSITE_DAILY_USD=2\n');
    const e = siteEnv(join(dir, '.env'), {});
    expect(e).toEqual({ ANTHROPIC_API_KEY: 'sk-1', SITE_DAILY_USD: '2' });
  });
});
