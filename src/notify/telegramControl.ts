// Control from Telegram: long polling getUpdates, only from the owner's chat (TELEGRAM_CHAT_ID).
// - Buttons: approving X posts ("Publish" / "No").
// - Text commands (O-05, before live): /stop, /resume, /status, /help, /reconcile [accept] (T-08), /release <tx> sold|not-sold (#135 G1) — if onCommand is passed. The reply is text in the chat.
// All other chats and users are ignored: we answer them nothing.

export type CallbackHandler = (data: string) => Promise<string | undefined>;
/** args — the text after the command ("/reconcile accept" → "accept"), lowercased; empty — ''. */
export type CommandHandler = (cmd: string, args?: string) => Promise<string>;
export interface ControlHandlers { onCallback: CallbackHandler; onCommand?: CommandHandler }
export interface ControlOptions {
  fetchImpl?: typeof fetch;
  /** Current time, ms (virtual in tests). */
  now?: () => number;
  /** Pause after a polling failure (no waiting in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Review log: rejected commands and polling failures. */
  log?: (kind: string, data: Record<string, unknown>) => void;
  /** Process start time, ms: a /reconcile accept sent earlier is not executed. Default — the moment startTelegramControl is called. */
  startedAtMs?: number;
}

export const OPERATOR_COMMANDS = ['/stop', '/resume', '/status', '/help', '/reconcile', '/release'] as const;
/**
 * A /resume that sat in the queue longer (the agent was off) is not executed: lifting the stop requires a fresh command.
 * Same for /reconcile accept: the base is taken from balances at execution time, while the owner saw the numbers at sending time.
 */
export const STALE_RESUME_MS = 5 * 60_000;
/** Polling failures (invalid token, a second poller of the same bot, network) — to the log no more than once per 10 minutes. */
export const ERROR_LOG_EVERY_MS = 10 * 60_000;

/** The text after a command: "/reconcile@scarf_bot  Accept" → "accept". */
export function parseArgs(text: string): string {
  return text.trim().split(/\s+/).slice(1).join(' ').toLowerCase();
}

/** "/Stop@scarf_bot now" → "/stop". Not a command — undefined. */
export function parseCommand(text: string): string | undefined {
  const t = text.trim().split(/\s+/)[0] ?? '';
  if (!t.startsWith('/')) return undefined;
  return t.replace(/@\S*$/, '').toLowerCase();
}

export function startTelegramControl(botToken: string | undefined, chatId: string | undefined, handlers: CallbackHandler | ControlHandlers,
  opts: ControlOptions | typeof fetch = {}): { stop(): void } {
  if (!botToken || !chatId) return { stop() {} };
  const h: ControlHandlers = typeof handlers === 'function' ? { onCallback: handlers } : handlers;
  const o: ControlOptions = typeof opts === 'function' ? { fetchImpl: opts } : opts;
  const fetchImpl = o.fetchImpl ?? fetch, now = o.now ?? Date.now;
  const startedAtMs = o.startedAtMs ?? now();
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(res => setTimeout(res, ms)));
  let offset = 0; let stopped = false; let lastErrorLog = -Infinity;
  const failed = async (reason: string) => {
    if (now() - lastErrorLog >= ERROR_LOG_EVERY_MS) {
      lastErrorLog = now();
      const safe = reason.split(botToken).join('***').slice(0, 300);
      console.error(`telegram control: polling failed — ${safe} (commands and buttons do not reach the agent)`);
      o.log?.('telegram_control_error', { reason: safe });
    }
    await sleep(5_000);
  };
  const api = (m: string) => `https://api.telegram.org/bot${botToken}/${m}`;
  const post = (m: string, body: unknown, timeoutMs = 15_000) => fetchImpl(api(m), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const reply = (text: string) => post('sendMessage', { chat_id: chatId, text: text.slice(0, 4000) })
    .catch(e => console.error('telegram control: reply failed', String(e)));

  const onMessage = async (m: any) => {
    if (typeof m?.text !== 'string' || !h.onCommand) return;
    const cmd = parseCommand(m.text);
    if (!cmd) return;
    const fromChat = String(m?.chat?.id ?? '');
    if (fromChat !== String(chatId)) { o.log?.('operator_rejected', { cmd, chatId: fromChat, reason: 'not the owner chat' }); return; }
    if (!(OPERATOR_COMMANDS as readonly string[]).includes(cmd)) { await reply(`Unknown command ${cmd}. Available: ${OPERATOR_COMMANDS.join(' ')}`); return; }
    const args = parseArgs(m.text);
    const sentMs = Number(m.date) * 1000;
    if (cmd === '/resume' && Number.isFinite(sentMs) && now() - sentMs > STALE_RESUME_MS) {
      const at = new Date(sentMs).toISOString().slice(11, 16);
      o.log?.('operator_rejected', { cmd, chatId: fromChat, reason: 'stale /resume', sentUtc: new Date(sentMs).toISOString() });
      await reply(`/resume from ${at} UTC was not executed: it sat in the queue for more than 5 minutes — the agent was off or the server clock differs from Telegram. The stop stays. If the stop must be lifted — send /resume again.`);
      return;
    }
    // Accept the base — only with a fresh command sent to this process: the base is taken from balances at execution time,
    // while a command that sat in the queue (or was sent before a restart) referred to other numbers
    if (cmd === '/reconcile' && args === 'accept' && (!Number.isFinite(sentMs) || now() - sentMs > STALE_RESUME_MS || sentMs < startedAtMs)) {
      const at = Number.isFinite(sentMs) ? new Date(sentMs).toISOString().slice(11, 16) : '?';
      const beforeStart = Number.isFinite(sentMs) && sentMs < startedAtMs && now() - sentMs <= STALE_RESUME_MS;
      o.log?.('operator_rejected', { cmd: `${cmd} ${args}`, chatId: fromChat, reason: beforeStart ? 'accept sent before this process started' : 'stale /reconcile accept', sentUtc: Number.isFinite(sentMs) ? new Date(sentMs).toISOString() : undefined });
      await reply(`/reconcile accept from ${at} UTC was not executed: ${beforeStart ? 'it was sent before the agent restarted' : 'it sat in the queue for more than 5 minutes'}, and the base is taken from balances at execution time. Check /reconcile and, if everything is right, send /reconcile accept again.`);
      return;
    }
    // #135 G1: /release changes the ledger (counting a sale or returning a position to the monitor) — only with a fresh command, like /resume
    if (cmd === '/release' && (!Number.isFinite(sentMs) || now() - sentMs > STALE_RESUME_MS)) {
      const at = Number.isFinite(sentMs) ? new Date(sentMs).toISOString().slice(11, 16) : '?';
      o.log?.('operator_rejected', { cmd: `${cmd} ${args}`.slice(0, 160), chatId: fromChat, reason: 'stale /release', sentUtc: Number.isFinite(sentMs) ? new Date(sentMs).toISOString() : undefined });
      await reply(`/release from ${at} UTC was not executed: it sat in the queue for more than 5 minutes. Check /status and, if everything is right, send /release again.`);
      return;
    }
    await reply(await (args ? h.onCommand(cmd, args) : h.onCommand(cmd)).catch(e => `Error: ${String(e).slice(0, 300)}`));
  };

  const loop = async () => {
    while (!stopped) {
      try {
        const r = await post('getUpdates', { offset, timeout: 30, allowed_updates: h.onCommand ? ['callback_query', 'message'] : ['callback_query'] }, 40_000);
        const j: any = await r.json();
        // 401 (invalid token), 409 (the same bot is polled by a second process) — a response without an exception; without a pause the loop would hammer the API
        if (j?.ok === false || !Array.isArray(j?.result)) { await failed(`HTTP ${r.status ?? '?'} ${j?.error_code ?? ''} ${j?.description ?? 'no result'}`); continue; }
        for (const u of j.result) {
          offset = Math.max(offset, Number(u.update_id) + 1);
          if (u.message) { await onMessage(u.message); continue; }
          const cq = u.callback_query;
          if (!cq) continue;
          const fromChat = String(cq.message?.chat?.id ?? '');
          let answer = 'Not accepted';
          if (fromChat === String(chatId)) answer = (await h.onCallback(String(cq.data ?? '')).catch(e => `Error: ${String(e).slice(0, 150)}`)) ?? 'OK';
          await post('answerCallbackQuery', { callback_query_id: cq.id, text: answer.slice(0, 190) }).catch(() => {});
        }
      } catch (e) { await failed(String((e as Error)?.message ?? e)); }
    }
  };
  void loop();
  return { stop() { stopped = true; } };
}
