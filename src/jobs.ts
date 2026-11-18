// Background jobs. Disabled in tests by the AGENT_NO_AUTO_EVENTS=1 flag.
//  - position monitor: every 60 s (stop, take-profit, trailing, time);
//  - markouts: every 5 minutes — the price 5 min / 1 h / 24 h / 7 days after each signal;
//  - once a day (00:05 UTC): report to the owner, auto-downgrade of weak sources' scores, purge of text older than 7 days.
import type { Store } from './store/db.js';
import type { MarketClient } from './checks/token.js';
import type { Notifier } from './notify/telegram.js';
import type { Clock } from './clock.js';
import type { PaperExecutor } from './exec/paper.js';
import type { RiskState } from './risk/risk.js';
import type { TrustTable } from './trust/trust.js';
import type { LlmBudget } from './llm/budget.js';

export const HORIZONS: [string, number][] = [['5m', 5 * 60_000], ['1h', 3600_000], ['24h', 86400_000], ['7d', 7 * 86400_000]];

export async function runMarkouts(store: Store, market: MarketClient, clock: Clock) {
  for (const [h, ms] of HORIZONS) {
    const due = store.pendingMarkouts(h, new Date(clock.now() - ms).toISOString());
    for (const r of due) {
      const info = await market.market(r.token).catch(() => undefined);
      if (info?.priceUsd) store.saveMarkout(r.id, h, info.priceUsd, clock.iso());
    }
  }
}

/**
 * A source with ≥ 5 signals and a negative 24 h median loses 1 point (downgrade only).
 * Only signals after this source's previous downgrade and no older than 7 days count,
 * so the same old signals do not downgrade the source every day.
 */
export function autoDowngrade(store: Store, trust: TrustTable, clock: Clock): string[] {
  const changed: string[] = [];
  const weekAgo = new Date(clock.now() - 7 * 86400_000).toISOString();
  const byKey = new Map<string, { label: string; rows: { ts?: string; ret: number }[] }>();
  for (const r of store.sourceReturns('24h', weekAgo)) {
    const key = trust.authorKeyOf(r.server, r.author);
    (byKey.get(key) ?? byKey.set(key, { label: `${r.server} / ${r.author}`, rows: [] }).get(key)!).rows.push({ ret: r.ret });
  }
  for (const [key, g] of byKey) {
    const since = [weekAgo, store.lastDowngradeIso(key) ?? weekAgo].sort().at(-1)!;
    const fresh = since === weekAgo ? g.rows.map(x => x.ret)
      : store.sourceReturns('24h', since).filter(r => trust.authorKeyOf(r.server, r.author) === key).map(r => r.ret);
    if (fresh.length < 5) continue;
    const med = [...fresh].sort((a, b) => a - b)[Math.floor(fresh.length / 2)];
    if (med >= 0) continue;
    trust.downgrade(key, 1);
    const delta = trust.downgradeEntries().find(([k]) => k === key)?.[1] ?? -1;
    store.saveDowngrade(key, delta, clock.iso());
    changed.push(`${g.label}: 24h median ${(med * 100).toFixed(1)}% over ${fresh.length} signals → −1 (total ${delta})`);
  }
  return changed;
}

/**
 * Candidates for a score upgrade: ≥ 5 calls in 14 days, 24 h median ≥ +20%, ≥ 60% in profit, and the current score < 7.
 * Only the owner upgrades (via the table), the agent only suggests.
 */
export function upgradeCandidates(store: Store, trust: TrustTable, clock: Clock): string[] {
  const since = new Date(clock.now() - 14 * 86400_000).toISOString();
  return store.sourceStats('24h', since)
    .filter(s => s.n >= 5 && s.medianReturn >= 0.2 && s.winRate >= 0.6)
    .map(s => { const [server, channel, author] = s.source.split('|'); return { s, server, channel, author, score: trust.resolve(server, channel, author).score }; })
    .filter(x => x.score < 7)
    .map(x => `• ${x.server} / #${x.channel} / ${x.author}: score ${x.score}, ${x.s.n} calls, 24h median +${(x.s.medianReturn * 100).toFixed(0)}%, in profit ${(x.s.winRate * 100).toFixed(0)}%`);
}

/**
 * Skips for posts (the owner 2026-10-23: "why it filters things out"): analysed by the analyst and skipped the day before yesterday,
 * that have a 24 h price. One "dodged" (−40% or worse) and one honest "missed" (+50% or better) — no more than two a day.
 */
export async function passedPosts(store: Store, market: MarketClient, clock: Clock): Promise<(import('./posts/drafts.js').PostEvent & { pnlPct?: number })[]> {
  const rows = (store.db.prepare(`SELECT d.token, d.chain, d.price_at_decision p0, mk.price p1, d.reasons FROM decisions d
    JOIN markouts mk ON mk.decision_id=d.id AND mk.horizon='24h' WHERE d.action IN ('journal_only','skip') AND d.price_at_decision > 0
    AND d.reasons LIKE '%analyst (%' AND substr(d.ts_utc,1,10)=?`).all(clock.utcDay(clock.now() - 2 * 86400_000)) as any[])
    .map(r => ({ ...r, ret: r.p1 / r.p0 - 1 }));
  const dodged = rows.filter(r => r.ret <= -0.4).sort((a, b) => a.ret - b.ret)[0];
  const missed = rows.filter(r => r.ret >= 0.5).sort((a, b) => b.ret - a.ret)[0];
  const out: (import('./posts/drafts.js').PostEvent & { pnlPct?: number })[] = [];
  for (const r of [dodged, missed].filter(Boolean)) {
    const sym = (await market.market(r.token).catch(() => undefined))?.symbol;
    const why = String(JSON.parse(r.reasons ?? '[]')[0] ?? '').replace(/^analyst \([^)]*\):\s*/, '').split(/(?<=\.)\s/)[0].slice(0, 140);
    out.push({ kind: 'skip_review', asset: sym ? `$${sym}` : `${String(r.token).slice(0, 6)}…`, chain: r.chain, holding: false, pnlPct: r.ret * 100, ca: String(r.token),
      note: `${why} 24h later: ${r.ret >= 0 ? '+' : '−'}${Math.abs(r.ret * 100).toFixed(0)}%.${r.ret > 0 ? ' Missed this one.' : ''}` });
  }
  return out;
}

export function dailyReport(store: Store, risk: RiskState, clock: Clock, downgrades: string[], llm?: LlmBudget, upgrades: string[] = []): string {
  const day = clock.utcDay(clock.now() - 86400_000);
  const an = store.analysesOn(day);
  // The analyst's own finds (paper): a separate line so the owner can decide by the numbers whether to enable them in live
  const own = store.db.prepare(`SELECT d.action, d.size_usd, m.price FROM decisions d LEFT JOIN markouts m ON m.decision_id=d.id AND m.horizon='24h'
    WHERE substr(d.ts_utc,1,10)=? AND d.reasons LIKE '%analyst own pick%'`).all(day) as any[];
  const watch = store.db.prepare(`SELECT name, last_thesis FROM projects WHERE last_verdict='watch' AND substr(last_analysis_utc,1,10)=? ORDER BY last_analysis_utc DESC LIMIT 5`).all(day) as any[];
  // Missed: the analyst or the filter skipped it, and 24 h later the price rose ≥ 50%
  const missed = (store.db.prepare(`SELECT d.server, d.channel, d.token, d.price_at_decision p0, mk.price p1, substr(d.reasons,1,90) why FROM decisions d
    JOIN markouts mk ON mk.decision_id=d.id AND mk.horizon='24h' WHERE d.action='journal_only' AND d.price_at_decision > 0 AND substr(d.ts_utc,1,10)=?`).all(clock.utcDay(clock.now() - 2 * 86400_000)) as any[])
    .map(r => ({ ...r, ret: r.p1 / r.p0 - 1 })).filter(r => r.ret >= 0.5).sort((a, b) => b.ret - a.ret).slice(0, 5);
  const counts = store.db.prepare(`SELECT action, COUNT(*) n FROM decisions WHERE substr(ts_utc,1,10)=? GROUP BY action`).all(day) as any[];
  const stats = store.sourceStats('24h').slice(0, 5);
  return [
    `📊 <b>Report for ${day} (UTC)</b>`,
    `Capital: $${risk.equityUsd.toFixed(2)} · cash $${risk.cashUsd.toFixed(2)} · open positions ${risk.positions.length}`,
    `Decisions: ${counts.map(c => `${c.action} ${c.n}`).join(', ') || 'none'}`,
    ...stats.map(s => `• ${s.source}: ${s.n} signals, 24h median ${(s.medianReturn * 100).toFixed(1)}%, in profit ${(s.winRate * 100).toFixed(0)}%`),
    ...(own.length ? [`Analyst's own finds (paper): ${own.length}, bought ${own.filter(o => o.action === 'buy_token').length} of them — their 24 h result is in the markout log`] : []),
    `Analyst analyses: ${an.map(a => `${a.verdict} ${a.n}`).join(', ') || 'none'}${llm ? ` · model spend: ${llm.summary(day)}` : ''}`,
    ...(watch.length ? ['Watching:', ...watch.map(w => `• ${w.name}: ${String(w.last_thesis ?? '').slice(0, 140)}`)] : []),
    ...(missed.length ? ['Missed (skipped, and 24 h later it rose ≥ 50%):', ...missed.map(m => `• ${m.server}/#${m.channel} ${String(m.token).slice(0, 8)}… +${(m.ret * 100).toFixed(0)}% — ${m.why}`)] : []),
    ...(downgrades.length ? ['Downgraded:', ...downgrades] : []),
    ...(upgrades.length ? ['Candidates for a score upgrade (your call):', ...upgrades] : []),
  ].join('\n');
}

/**
 * Silence watchdog (2026-10-27: the message source went down on 24.10, the agent silently received nothing for three days).
 * No messages on the intake server for longer than N hours — a message to the owner, repeated no more than once per 6 h; messages resume — "flowing again".
 */
export function silenceCheck(lastMsgIso: string | undefined, nowMs: number, st: { alertedAtMs?: number }, hours: number): string | undefined {
  if (!lastMsgIso || hours <= 0) return undefined;
  const silentH = (nowMs - Date.parse(lastMsgIso)) / 3600_000;
  if (silentH >= hours) {
    if (st.alertedAtMs !== undefined && nowMs - st.alertedAtMs < 6 * 3600_000) return undefined;
    st.alertedAtMs = nowMs;
    return `⚠️ No messages from the mirror server for ${Math.floor(silentH)} h (last at ${lastMsgIso.slice(0, 16).replace('T', ' ')} UTC). Check the mirror: the agent is running but has nothing to read.`;
  }
  if (st.alertedAtMs !== undefined) { st.alertedAtMs = undefined; return `✅ Messages from the mirror are flowing again (last at ${lastMsgIso.slice(11, 16)} UTC).`; }
  return undefined;
}

/** Open position check (stops). */
export const MONITOR_INTERVAL_MS = 15_000;

export function startJobs(p: { store: Store; market: MarketClient; notifier: Notifier; clock: Clock; paper: PaperExecutor; risk: RiskState; trust: TrustTable; llmBudget?: LlmBudget;
  /** Once a minute: watch-list re-checks and deferred actions (via the shared message queue). */
  everyMinute?: () => Promise<void>;
  /** The queue messages go through: the position monitor changes risk and must run in it too (no races or double sales). */
  exclusive?: <T>(f: () => Promise<T>) => Promise<T>;
  /** X post queue (skips — after the window closes). */
  poster?: import('./posts/publisher.js').PostQueue;
  /** Silence on the intake server longer than N hours → a Telegram message (0 — off). */
  silenceHours?: number }) {
  const timers: NodeJS.Timeout[] = [];
  const silence: { alertedAtMs?: number } = {};
  timers.push(setInterval(() => {
    const msg = silenceCheck(p.store.lastMessageUtc(), p.clock.now(), silence, p.silenceHours ?? 3);
    if (msg) p.notifier.send(msg).catch(() => {});
  }, 10 * 60_000));
  let monitorBusy = false;
  if (p.everyMinute) timers.push(setInterval(() => { p.everyMinute!().catch(e => console.error('watch/scheduled', e)); }, 60_000));
  // Memecoin stops — every 15 s, a full pass (NFT, perps) — every minute. The executor has its own position lock,
  // so the monitor does not wait in the shared message queue (the analyst may think for a minute there).
  let tick = 0;
  timers.push(setInterval(() => {
    if (monitorBusy) return; // the previous pass is still running (slow APIs) — do not overlap
    monitorBusy = true;
    const full = tick++ % 4 === 0;
    p.paper.monitor(p.market, { tokensOnly: !full }).catch(e => console.error('monitor', e)).finally(() => { monitorBusy = false; });
  }, MONITOR_INTERVAL_MS));
  timers.push(setInterval(() => { runMarkouts(p.store, p.market, p.clock).catch(e => console.error('markouts', e)); }, 5 * 60_000));
  let lastReportDay = '';
  timers.push(setInterval(async () => {
    const d = new Date(p.clock.now());
    const day = p.clock.utcDay();
    if (d.getUTCHours() === 0 && d.getUTCMinutes() >= 5 && lastReportDay !== day) {
      lastReportDay = day;
      const down = autoDowngrade(p.store, p.trust, p.clock);
      p.store.purgeOldText(new Date(p.clock.now() - 7 * 86400_000).toISOString());
      await p.notifier.send(dailyReport(p.store, p.risk, p.clock, down, p.llmBudget, upgradeCandidates(p.store, p.trust, p.clock)));
      // "Looked and did not enter": a post only after the window has closed (a day later), with an honest result
      if (p.poster) for (const e of await passedPosts(p.store, p.market, p.clock)) await p.poster.queue(e, p.store.sourceNames()).catch(err => console.error('passed post', err));
    }
  }, 60_000));
  return () => timers.forEach(clearInterval);
}
