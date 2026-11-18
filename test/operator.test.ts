import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, startTelegramControl, STALE_RESUME_MS } from '../src/notify/telegramControl.js';
import { operatorCommands, statusText, type OperatorStatus } from '../src/notify/commands.js';
import { runRiskTool, agentActiveFromSystemctl, type RiskToolDeps } from '../src/tools/risk.js';
import { Store } from '../src/store/db.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const OWNER_CHAT = '111';

/** Fake Telegram: returns a batch of updates once, then empty answers; collects sendMessage and answerCallbackQuery. */
function fakeTelegram(updates: any[]) {
  const sent: any[] = [], answered: any[] = [], polls: any[] = [];
  let given = false;
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const m = String(url).split('/').pop();
    if (m === 'getUpdates') {
      polls.push(body);
      const result = given ? [] : updates; given = true;
      if (!result.length) await new Promise(r => setTimeout(r, 5));
      return { json: async () => ({ ok: true, result }) };
    }
    if (m === 'sendMessage') sent.push(body);
    if (m === 'answerCallbackQuery') answered.push(body);
    return { json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, answered, polls };
}
const msg = (id: number, chat: string, text: string, dateMs = NOW) => ({ update_id: id, message: { chat: { id: Number(chat) }, text, date: Math.floor(dateMs / 1000) } });
const settle = () => new Promise(r => setTimeout(r, 40));

describe('Telegram operator commands (O-05)', () => {
  it('parses commands: case, @bot suffix, arguments; plain text is not a command', () => {
    expect(parseCommand('/Stop@scarf_bot now')).toBe('/stop');
    expect(parseCommand('  /status ')).toBe('/status');
    expect(parseCommand('stop')).toBeUndefined();
  });

  it('only the owner\'s chat is answered; stale /resume is refused, stale /stop still works; buttons keep working', async () => {
    const tg = fakeTelegram([
      msg(1, '999', '/stop'),                                   // another chat — stay silent
      msg(2, OWNER_CHAT, '/stop', NOW - 60 * 60_000),                 // arrived while the agent was off — the stop is executed anyway
      msg(3, OWNER_CHAT, '/resume', NOW - STALE_RESUME_MS - 1000),    // stale /resume — not executed
      msg(4, OWNER_CHAT, 'hello'),                                     // not a command — stay silent
      msg(5, OWNER_CHAT, '/reboot'),                                   // unknown command — a hint
      msg(6, OWNER_CHAT, '/status'),
      { update_id: 7, callback_query: { id: 'cq1', data: 'post:1:yes', message: { chat: { id: Number(OWNER_CHAT) } } } },
      msg(8, OWNER_CHAT, '/resume', NOW - 60_000),                    // fresh /resume — executed
    ]);
    const calls: string[] = [], logged: any[] = [];
    const ctl = startTelegramControl('T', OWNER_CHAT, {
      onCallback: async (d) => { calls.push(`cb ${d}`); return 'Published'; },
      onCommand: async (c) => { calls.push(c); return `ok ${c}`; },
    }, { fetchImpl: tg.fetchImpl, now: () => NOW, log: (k, d) => logged.push({ k, ...d }) });
    await settle(); ctl.stop();
    expect(tg.polls[0].allowed_updates).toEqual(['callback_query', 'message']);
    expect(calls).toEqual(['/stop', '/status', 'cb post:1:yes', '/resume']);
    expect(tg.sent.every(s => s.chat_id === OWNER_CHAT)).toBe(true);
    expect(tg.sent.map(s => s.text)).toEqual([
      'ok /stop',
      expect.stringContaining('/resume from 11:54 UTC was not executed: it sat in the queue for more than 5 minutes — the agent was off or the server clock differs'),
      expect.stringContaining('Unknown command /reboot'),
      'ok /status',
      'ok /resume',
    ]);
    expect(tg.answered).toEqual([{ callback_query_id: 'cq1', text: 'Published' }]);
    expect(logged.map(l => `${l.k} ${l.cmd} ${l.chatId} ${l.reason}`)).toEqual(['operator_rejected /stop 999 not the owner chat', `operator_rejected /resume ${OWNER_CHAT} stale /resume`]);
    expect(tg.polls[1].offset).toBe(9);
  });

  it('Telegram error answers (401/409) pause the poll and are logged at most once per 10 min, without the token', async () => {
    let now = NOW; const polls: number[] = [], logged: any[] = [];
    const errs: string[] = []; const origErr = console.error; console.error = (...a: any[]) => { errs.push(a.join(' ')); };
    const fetchImpl = (async () => { polls.push(now); return { status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized for SECRET123' }) }; }) as unknown as typeof fetch;
    let ctl: { stop(): void } | undefined;
    const sleep = async (ms: number) => { now += ms; if (polls.length >= 200) ctl?.stop(); await Promise.resolve(); };
    ctl = startTelegramControl('SECRET123', OWNER_CHAT, { onCallback: async () => 'OK', onCommand: async () => 'ok' }, { fetchImpl, now: () => now, sleep, log: (k, d) => logged.push({ k, ...d }) });
    await settle(); ctl.stop(); console.error = origErr;
    expect(polls.length).toBe(200);                                   // every failure — a 5 s pause, not a loop without stopping
    expect(now - NOW).toBe(200 * 5_000);
    expect(logged.length).toBe(Math.ceil((200 * 5_000) / (10 * 60_000))); // once every 10 minutes, not 200 times
    expect(logged[0]).toMatchObject({ k: 'telegram_control_error', reason: expect.stringContaining('401 Unauthorized for ***') });
    expect(errs.join('\n')).not.toContain('SECRET123');
  });

  it('without onCommand: old call shape still works and text messages are not requested', async () => {
    const tg = fakeTelegram([msg(1, OWNER_CHAT, '/stop')]);
    const ctl = startTelegramControl('T', OWNER_CHAT, async () => 'OK', tg.fetchImpl);
    await settle(); ctl.stop();
    expect(tg.polls[0].allowed_updates).toEqual(['callback_query']);
    expect(tg.sent).toEqual([]);
  });

  it('/stop, /resume, /status texts; other stops are reported; every command goes to the review journal', async () => {
    let s: OperatorStatus = { mode: 'live', equityUsd: 48, markedEquityUsd: 47.5, cashUsd: 40, operatorHalted: false, dailyStop: false, hardStopped: false,
      positions: [{ chain: 'base', token: '0x1234567890abcdef1234567890abcdef12345678', costUsd: 8, openedAtUtc: '2026-11-09T09:30:00.000Z' }] };
    const logged: any[] = [];
    const run = operatorCommands({ status: () => s, setOperatorHalt: (on) => { s = { ...s, operatorHalted: on }; }, now: () => NOW, log: (k, d) => logged.push({ k, ...d }) });

    expect(await run('/stop')).toContain('The stop on new entries is on');
    expect(s.operatorHalted).toBe(true);
    expect(await run('/stop')).toContain('already on');
    s = { ...s, dailyStop: true };
    const r = await run('/resume');
    expect(r).toContain('✅ The stop on new entries is lifted');
    expect(r).toContain('daily stop');
    expect(s.operatorHalted).toBe(false);
    expect(await run('/resume')).toContain('is not on anyway');
    expect(await run('/help')).toContain('/stop');
    expect(statusText(s, NOW)).toBe([
      '📊 Status at 2026-11-09 12:00 UTC',
      'Mode: live',
      'Capital: $48.00 (with open positions marked $47.50), cash $40.00',
      'Open positions: 1',
      '• base 0x1234…5678 — $8.00, since 11-09 09:30 UTC',
      'Stop on new entries (/stop): off',
      'Daily stop: on',
      'Hard stop: off',
    ].join('\n'));
    expect(logged.map(l => `${l.k} ${l.cmd} ${l.operatorHalted}`)).toEqual(['operator /stop true', 'operator /stop true', 'operator /resume false', 'operator /resume false', 'operator /help false']);
  });
});

describe('npm run risk -- unhalt (O-05: hard stop is lifted only on the server)', () => {
  const setup = (hardStopped: boolean, equityUsd = 30) => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-'));
    const dbPath = join(dir, 'agent.sqlite');
    const st = new Store(dbPath);
    st.saveRiskState({ equityUsd, cashUsd: equityUsd, dayPnl: [], hardStopped, positions: [] }, '2026-11-09T11:00:00.000Z');
    st.db.close();
    const out: string[] = [];
    const deps = (over: Partial<RiskToolDeps> = {}): RiskToolDeps => ({ dbPath, reviewDir: join(dir, 'review'), initialCapitalUsd: 40, hardStopEquityShare: 0.55,
      agentActive: () => false, ask: async () => 'yes', print: (l) => out.push(l), now: () => NOW, ...over });
    const read = () => { const s = new Store(dbPath); const r = s.loadRiskState(); s.db.close(); return r; };
    return { dir, deps, out, read };
  };

  it('refuses while the agent runs; cancels without "yes"; lifts the stop with "yes" and writes the journal', async () => {
    const t = setup(true);
    expect(await runRiskTool('unhalt', t.deps({ agentActive: () => true }))).toBe(1);
    expect(t.out.at(-1)).toContain('Stop it first: systemctl stop agent');
    expect(t.read().hardStopped).toBe(true);

    expect(await runRiskTool('unhalt', t.deps({ ask: async () => 'y' }))).toBe(1);
    expect(t.read().hardStopped).toBe(true);

    t.out.length = 0;
    expect(await runRiskTool('unhalt', t.deps())).toBe(0);
    expect(t.out).toEqual([
      'Capital without open positions: $30.00, cash $30.00, open positions: 0',
      'Hard stop threshold: $22.00 (55 % of the starting $40.00)',
      'Hard stop: ON · state saved 2026-11-09 11:00 UTC',
      'Hard stop lifted. Restore permissions and start the agent: chown -R agent:agent /opt/agent/server/data && systemctl start agent',
    ]);
    expect(t.read()).toMatchObject({ hardStopped: false, equityUsd: 30 });
    const j = JSON.parse(readFileSync(join(t.dir, 'review', readdirSync(join(t.dir, 'review'))[0]), 'utf8').trim());
    expect(j).toMatchObject({ kind: 'operator', cmd: 'risk unhalt', thresholdUsd: 22 });
  });

  it('systemctl failure is "unknown", never "stopped": D-Bus error or empty output → undefined', () => {
    expect(agentActiveFromSystemctl('active\n')).toBe(true);
    expect(agentActiveFromSystemctl('activating\n')).toBe(true);
    expect(agentActiveFromSystemctl('inactive\n')).toBe(false);
    expect(agentActiveFromSystemctl('failed\n')).toBe(false);
    expect(agentActiveFromSystemctl('')).toBeUndefined();                                      // "Failed to connect to bus" goes to stderr, stdout is empty
    expect(agentActiveFromSystemctl('Failed to connect to bus: No such file or directory')).toBeUndefined();
    expect(agentActiveFromSystemctl('unknown\n')).toBeUndefined();
  });

  it('warns when capital is still below the threshold or systemctl is missing; status and "nothing to lift" change nothing', async () => {
    const low = setup(true, 20);
    expect(await runRiskTool('unhalt', low.deps({ agentActive: () => undefined }))).toBe(0);
    expect(low.out.join('\n')).toMatch(/Could not check the agent service[\s\S]*is still below the threshold \$22\.00/);

    const ok = setup(false);
    expect(await runRiskTool('status', ok.deps({ agentActive: () => true }))).toBe(0);
    expect(await runRiskTool('unhalt', ok.deps())).toBe(0);
    expect(ok.out.at(-1)).toBe('No hard stop — nothing to lift.');
    expect(await runRiskTool('bogus', ok.deps())).toBe(1);
    expect(await runRiskTool('status', ok.deps({ dbPath: join(ok.dir, 'none.sqlite') }))).toBe(1);
  });
});
