// The owner's Telegram commands (O-05): /stop — stop new entries, /resume — lift it, /status — capital and stops.
// /reconcile — reconcile with the wallet now, /reconcile accept — accept the current balance as the base (live only, T-08).
// The stop flag itself lives in the executor (E-08); here — only texts and the order of actions. HQ wires it in src/index.ts:
//   startTelegramControl(token, chatId, { onCallback, onCommand: operatorCommands({ status, setOperatorHalt, now, log }) })
// The hard stop (capital below the threshold) cannot be lifted from here — only on the server: npm run risk -- unhalt.

export interface OperatorPosition { chain: string; token: string; costUsd: number; openedAtUtc: string }
export interface OperatorStatus {
  mode: string;
  equityUsd: number;
  /** Capital including the unrealized result of open positions. */
  markedEquityUsd: number;
  cashUsd: number;
  positions: OperatorPosition[];
  operatorHalted: boolean;
  /** #139: why the stop on new entries is on ('/stop' or the wallet-reconciliation auto-stop reason). */
  operatorHaltReason?: string;
  dailyStop: boolean;
  /** S-06: the UTC-day result for the daily stop (closed + floating loss) and the threshold, $ (a positive number). */
  dailyStopPnlUsd?: number;
  dailyStopLimitUsd?: number;
  hardStopped: boolean;
  /** #135 G1: pending holds of sales with an unknown outcome and ghost blocks (hash and description) — lifted with /release. */
  holds?: { tx: string; text: string }[];
}
export interface OperatorDeps {
  status(): OperatorStatus;
  /** reason — why it is on (#139): the /stop command passes '/stop'. */
  setOperatorHalt(on: boolean, reason?: string): void;
  now: () => number;
  /** A review-log record: who pressed what and what was answered. */
  log?: (kind: string, data: Record<string, unknown>) => void;
  /** Wallet reconciliation (live only): run — reconcile now and return the result text, accept — Reconciler.acceptCurrent(). Texts are HTML (as in Reconciler). None — the command answers that there is no reconciliation. */
  reconcile?: { run(): Promise<string>; accept(): Promise<string> };
  /** How long to wait for the reconciliation result before answering "will send separately" (Telegram polling must not stall: /stop matters more), ms. */
  replyWaitMs?: number;
  /** Send a result that did not fit in replyWaitMs as a separate message (notifier.send, parse_mode HTML). */
  sendLate?: (text: string) => Promise<void>;
  /** #135 G1: lift a hold / ghost block by hash after checking the wallet (PaperExecutor.release). None — no command (not live). */
  release?: (tx: string, verdict: 'sold' | 'not-sold') => Promise<string>;
}

export const RELEASE_HELP = '/release <tx> sold — the sale went through (count it once) · /release <tx> not-sold — it did not (lift the hold and the address block). Only after checking the wallet; hashes of pending ones are in /status.';

export const RECONCILE_REPLY_WAIT_MS = 15_000;
const RECONCILE_HELP = '/reconcile — reconcile the wallet with the ledger now · /reconcile accept — accept the current balance as the base (when the wallet is intact and the mismatch comes only from the ETH/SOL price; does not lift the stop).';

/** Telegram with parse_mode HTML (notifier.send): &, <, > are escaped exactly once. */
const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A command reply goes as plain text (no parse_mode): HTML escaping is removed, otherwise the owner would see "&lt;". */
export const unescHtml = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The result of a long operation. p returns HTML text (Reconciler texts are already escaped). Done within ms — a plain-text reply (escaping
 * removed); otherwise — "will send separately", and the result goes via sendLate (HTML). The error text is escaped only on the HTML path.
 */
async function within(p: Promise<string>, ms: number, sendLate: ((t: string) => Promise<void>) | undefined, what: string): Promise<string> {
  const safe = p.then(html => ({ html, plain: unescHtml(html) }), e => {
    const plain = `Error (${what}): ${String((e as Error)?.message ?? e).slice(0, 300)}`;
    return { html: escHtml(plain), plain };
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), ms); });
  const r = await Promise.race([safe, late]);
  clearTimeout(timer);
  if (r !== undefined) return r.plain;
  void safe.then(t => sendLate?.(`${what}: ${t.html}`)).catch(e => console.error('operator: late reply failed', String(e)));
  return `${what}: still running (longer than ${Math.round(ms / 1000)} s) — I will send the result in a separate message.`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const short = (t: string) => (t.length > 14 ? `${t.slice(0, 6)}…${t.slice(-4)}` : t);
const onOff = (b: boolean) => (b ? 'on' : 'off');
/** S-06: "−$4.10 of −$12.00" — the UTC-day result against the daily stop threshold. Not a number — "unknown" (the stop is on in that case). */
export function dailyStopFigures(pnlUsd: number, limitUsd: number): string {
  const signed = (n: number) => (Number.isFinite(n) ? `${n < 0 ? '−' : n > 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}` : 'unknown');
  return `${signed(pnlUsd)} of ${Number.isFinite(limitUsd) ? `−$${limitUsd.toFixed(2)}` : 'unknown'}`;
}

function otherStops(s: OperatorStatus): string[] {
  const out: string[] = [];
  if (s.hardStopped) out.push('⚠️ The hard stop is active: capital is below the threshold. There will be no new entries. It is lifted only on the server: npm run risk -- unhalt.');
  if (s.dailyStop) out.push('⚠️ The daily stop is active: new entries — after 00:00 UTC.');
  return out;
}

export function statusText(s: OperatorStatus, nowMs: number): string {
  const lines = [
    `📊 Status at ${new Date(nowMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Mode: ${s.mode}`,
    `Capital: ${usd(s.equityUsd)} (with open positions marked ${usd(s.markedEquityUsd)}), cash ${usd(s.cashUsd)}`,
    `Open positions: ${s.positions.length}`,
    ...s.positions.map(p => `• ${p.chain} ${short(p.token)} — ${usd(p.costUsd)}, since ${p.openedAtUtc.slice(5, 16).replace('T', ' ')} UTC`),
    `Stop on new entries (/stop): ${onOff(s.operatorHalted)}${s.operatorHalted ? ` — reason: ${s.operatorHaltReason ? s.operatorHaltReason.slice(0, 300) : 'not recorded'}` : ''}`,
    `Daily stop: ${onOff(s.dailyStop)}${s.dailyStopLimitUsd !== undefined ? ` — today ${dailyStopFigures(s.dailyStopPnlUsd ?? 0, s.dailyStopLimitUsd)}` : ''}`,
    `Hard stop: ${onOff(s.hardStopped)}`,
    ...(s.holds?.length ? [`Holds (outcome unknown, ${s.holds.length}) — after checking the wallet /release <tx> sold | not-sold:`, ...s.holds.map(h => `• ${h.text}`)] : []),
  ];
  return lines.join('\n');
}

export function operatorCommands(d: OperatorDeps): (cmd: string, args?: string) => Promise<string> {
  return async (cmd, args = '') => {
    const before = d.status();
    let text: string;
    switch (cmd) {
      case '/stop':
        if (before.operatorHalted) text = '⛔ The stop on new entries is already on. The agent keeps managing open positions. To lift — /resume.';
        else {
          d.setOperatorHalt(true, '/stop');
          text = '⛔ The stop on new entries is on. The agent keeps managing open positions: stops and take-profits work. To lift — /resume.';
        }
        break;
      case '/resume':
        if (!before.operatorHalted) text = ['The stop on new entries is not on anyway.', ...otherStops(before)].join('\n');
        else {
          d.setOperatorHalt(false);
          text = ['✅ The stop on new entries is lifted.', ...otherStops(d.status())].join('\n');
        }
        break;
      case '/status':
        text = statusText(before, d.now());
        break;
      case '/reconcile': {
        const a = args.trim().toLowerCase();
        const wait = d.replyWaitMs ?? RECONCILE_REPLY_WAIT_MS;
        if (!d.reconcile) text = `There is no wallet reconciliation in ${before.mode} mode — it works only in live.`;
        else if (a === '') text = await within(d.reconcile.run(), wait, d.sendLate, 'Reconciliation on command');
        else if (a === 'accept') text = await within(d.reconcile.accept(), wait, d.sendLate, 'Accept base');
        else text = `Did not understand «/reconcile ${a.slice(0, 40)}». ${RECONCILE_HELP}`;
        break;
      }
      case '/release': {
        const [tx, verdict, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (!d.release) text = `There are no holds in ${before.mode} mode — /release works only in live.`;
        else if (!tx || (verdict !== 'sold' && verdict !== 'not-sold') || rest.length) text = `Did not understand «/release ${args.trim().slice(0, 120)}». ${RELEASE_HELP}`;
        else text = await d.release(tx, verdict);
        break;
      }
      default:
        text = `Commands: /stop — stop new entries (exits keep working) · /resume — lift it · /status — capital, positions and stops${d.reconcile ? ` · ${RECONCILE_HELP}` : ''}${d.release ? ` · ${RELEASE_HELP}` : d.reconcile ? '' : '.'}`;
    }
    d.log?.('operator', { cmd, ...(args.trim() ? { args: args.trim().slice(0, 60) } : {}), operatorHalted: d.status().operatorHalted, reply: text });
    return text;
  };
}
