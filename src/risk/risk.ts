// Risk module. Every strategy and every Discord decision gets its size ONLY from here.
// The limits cannot be bypassed: the executor takes the size this module returned and checks it
// once more via assertWithinLimits before sending a transaction (throws an exception).
// State (capital, cash, daily result, hard stop) is saved in the DB and survives a restart.
import type { RiskConfig } from '../config.js';
import type { Chain, Tier } from '../types.js';
import type { Clock } from '../clock.js';
import { riskConfigProblems, haltingRiskProblems } from './riskCheck.js';

export interface Position { id: string; chain: Chain; token: string; costUsd: number; openedAtUtc: string;
  /** S-07: only the moonbag is left of the position — it takes no slot among maxOpenPositions (tail limit — memecoinClasses.maxOpenMoonbags). */
  moonbagOnly?: boolean;
  /** S-07: the position was opened with a moonbag — counts toward the tail limit from the moment of entry. */
  hasMoonbag?: boolean }

/** Share 0 < x ≤ 1. NaN, a string, null — not a share. */
const isShare = (v: unknown): v is number => typeof v === 'number' && v > 0 && v <= 1;

export interface RiskSnapshot { equityUsd: number; cashUsd: number; dayPnl: [string, number][]; hardStopped: boolean; positions: Position[]; operatorHalt?: boolean;
  /** S-06 (#87 item 2): the last floating result — after a restart the daily stop sees it until the monitor's first pass. */
  unrealizedUsd?: number;
  /** S-06 (review, nice-to-have 4): the floating result was not a number (NaN in JSON — null) — after a restart it is "unknown" again, the stop holds. */
  unrealizedUnknown?: boolean;
  /** #139: why the operator stop is on ('/stop' from the owner or the reason for a reconciliation auto-stop). */
  operatorHaltReason?: string }

export class RiskState {
  equityUsd: number;
  cashUsd: number;
  positions: Position[] = [];
  /** Realized bucket result per UTC day. */
  private dayPnl = new Map<string, number>();
  /** Unrealized result of open positions (updated by the price monitor). */
  unrealizedUsd = 0;
  hardStopped = false;
  /** Operator stop (/stop from Telegram, E-08 #43, #58): new entries are forbidden, position exits work; survives a restart. Lifted by /resume. */
  operatorHalt = false;
  /** Why the operator stop is on: '/stop' from the owner or the reason for an automatic stop (wallet reconciliation). No stop — undefined. */
  operatorHaltReason?: string;
  /** Called after every change — for saving to the DB. */
  onChange?: (s: RiskSnapshot) => void;

  constructor(private cfg: RiskConfig, private clock: Clock, equityUsd = cfg.initialCapitalUsd) {
    this.equityUsd = equityUsd;
    this.cashUsd = equityUsd;
  }

  snapshot(): RiskSnapshot { return { equityUsd: this.equityUsd, cashUsd: this.cashUsd, dayPnl: [...this.dayPnl.entries()], hardStopped: this.hardStopped, positions: [...this.positions], operatorHalt: this.operatorHalt, unrealizedUsd: this.unrealizedUsd,
    ...(Number.isFinite(this.unrealizedUsd) ? {} : { unrealizedUnknown: true }), operatorHaltReason: this.operatorHaltReason }; }
  restore(s: RiskSnapshot) {
    this.equityUsd = s.equityUsd; this.cashUsd = s.cashUsd; this.hardStopped = s.hardStopped;
    this.dayPnl = new Map(s.dayPnl); this.positions = [...s.positions];
    this.operatorHalt = !!s.operatorHalt; // an old snapshot without the field — no operator stop
    this.operatorHaltReason = this.operatorHalt && typeof s.operatorHaltReason === 'string' ? s.operatorHaltReason : undefined; // an old snapshot — no reason
    // The last known floating result (#87 item 2); the position monitor replaces it on the first pass. No positions or an old snapshot — 0.
    // Was not a number — NaN again: the daily stop holds until the monitor's first pass, as before the restart (not 0 — that would lift the stop)
    this.unrealizedUsd = !this.positions.length ? 0 : s.unrealizedUnknown ? NaN
      : typeof s.unrealizedUsd === 'number' && Number.isFinite(s.unrealizedUsd) ? s.unrealizedUsd : 0;
  }
  private changed() { this.onChange?.(this.snapshot()); }
  /** reason — why it is on; when turned on again without a reason the previous one is kept; when lifted the reason is cleared. */
  setOperatorHalt(on: boolean, reason?: string) {
    this.operatorHalt = on;
    this.operatorHaltReason = on ? (reason ?? this.operatorHaltReason) : undefined;
    this.changed();
  }

  get bucketUsd() { return this.equityUsd * this.cfg.huntBucketShare; }
  /** Capital including the unrealized result. */
  get markedEquityUsd() { return this.equityUsd + this.unrealizedUsd; }
  todayPnl() { return this.dayPnl.get(this.clock.utcDay()) ?? 0; }
  recordPnl(usd: number) {
    const d = this.clock.utcDay();
    this.dayPnl.set(d, (this.dayPnl.get(d) ?? 0) + usd);
    this.equityUsd += usd;
    this.checkHardStop();
    this.changed();
  }
  setUnrealized(usd: number) { this.unrealizedUsd = usd; this.checkHardStop(); this.changed(); }
  private checkHardStop() {
    if (this.markedEquityUsd < this.cfg.initialCapitalUsd * this.cfg.hardStopEquityShare) this.hardStopped = true; // only the owner lifts it
  }
  private cfgProblem?: { v: string | undefined };
  /**
   * Invalid risk rule numbers (S-06): found when loading risk.json (cfg.riskProblems — the field is already replaced with the approved
   * value) and the second line — the same full riskConfigProblems check on the config RiskState was created with. Non-empty —
   * "exits only" mode: new entries are closed, exits work. The config does not change — the result is computed once.
   * Invalid memecoinEntry and noPrice blocks do not close entries (haltingRiskProblems): they have their own fallback path.
   */
  stopConfigProblem(): string | undefined {
    if (!this.cfgProblem) {
      const all = haltingRiskProblems([...new Set([...(this.cfg.riskProblems ?? []), ...riskConfigProblems(this.cfg)])]);
      this.cfgProblem = { v: all.length ? all.join('; ') : undefined };
    }
    return this.cfgProblem.v;
  }
  /**
   * Bucket at 00:00 UTC (option C, the owner's decision 2026-11-10 12:21 UTC). Capital changes only via recordPnl (and restore
   * together with dayPnl), so capital at 00:00 = current − the day's closed result: the number is constant within a day,
   * fixed by the UTC day change and survives a restart without a separate field in the snapshot.
   */
  get dayStartBucketUsd() { return (this.equityUsd - this.todayPnl()) * this.cfg.huntBucketShare; }
  /** Daily stop threshold, USD (a positive number): dailyLossStopShareOfDayStart × bucket at 00:00 UTC. */
  dailyStopLimitUsd() { return this.cfg.dailyLossStopShareOfDayStart * this.dayStartBucketUsd; }
  /** The bucket's daily result for the daily stop: closed + floating loss (floating profit does not count). */
  dailyStopPnlUsd() { return this.todayPnl() + Math.min(0, this.unrealizedUsd); }
  /**
   * New entries are forbidden until 00:00 UTC if the bucket's daily result (closed + floating loss) is not better than −threshold.
   * Tolerance 1e-9: for example 0.07 × 10 = 0.7000000000000001, a loss of exactly −0.70 triggers the stop. Threshold or result not a number — the stop is on.
   */
  dailyStopActive() {
    if (!isShare(this.cfg.dailyLossStopShareOfDayStart) || !isShare(this.cfg.huntBucketShare)) return true;
    return !(this.dailyStopPnlUsd() + this.dailyStopLimitUsd() > 1e-9);
  }
  halted() { return this.hardStopped || this.stopConfigProblem() !== undefined || this.operatorHalt || this.dailyStopActive(); }

  /** Write-off of expenses without a position (gas, mint fee). This is an immediate loss. */
  spend(usd: number) { this.cashUsd -= usd; this.recordPnl(-usd); }
  openPosition(p: Position) { this.positions.push(p); this.cashUsd -= p.costUsd; this.changed(); }
  /** Partial take-profit: money returned to cash, the position is still open. The result is not recorded (NFT: accounted at close). */
  partialReturn(usd: number) { this.cashUsd += usd; this.changed(); }
  /**
   * Partial sale with the result recorded immediately (S-07, M1): proceeds — to cash, the sold part's result (proceeds − the part's cost) —
   * to the daily result and capital, the position's cost decreases. To close such a position — closePosition(id, proceeds of the last sale, 0).
   */
  realizePartial(id: string, proceedsUsd: number, costPartUsd: number) {
    const p = this.positions.find(x => x.id === id);
    const part = p ? Math.min(Math.max(0, costPartUsd), p.costUsd) : 0;
    if (p) p.costUsd -= part;
    this.cashUsd += proceedsUsd;
    this.recordPnl(proceedsUsd - part);
  }
  /**
   * Closes a position. totalProceedsUsd — all proceeds over the position's life,
   * alreadyReturnedUsd — what has already returned to cash via partial take-profits.
   */
  closePosition(id: string, totalProceedsUsd: number, alreadyReturnedUsd = 0) {
    const i = this.positions.findIndex(p => p.id === id);
    if (i < 0) return;
    const [p] = this.positions.splice(i, 1);
    this.cashUsd += totalProceedsUsd - alreadyReturnedUsd;
    this.recordPnl(totalProceedsUsd - p.costUsd);
  }
  holds(token: string) { return this.positions.some(p => p.token.toLowerCase() === token.toLowerCase()); }
  /** Positions that take trading slots (without moonbag "tails"). */
  activeCount() { return this.positions.filter(p => !p.moonbagOnly).length; }
  moonbagCount() { return this.positions.filter(p => p.moonbagOnly).length; }
  /** Tails for the maxOpenMoonbags limit: already "moonbag only" + open positions with a moonbag (M2, S-07 acceptance). */
  tailCount() { return this.positions.filter(p => p.moonbagOnly || p.hasMoonbag).length; }
  /** S-07: the core part is sold, the moonbag remains. */
  markMoonbagOnly(id: string) { const p = this.positions.find(x => x.id === id); if (p && !p.moonbagOnly) { p.moonbagOnly = true; this.changed(); } }
}

export interface SizeRequest { tier: Tier; chain: Chain; estGasUsd: number;
  /** Bucket share cap on top of the tier share (S-02: a memecoin — no more than memecoinEntry.shareOfCapital at any tier). */
  shareCap?: number }
export interface SizeResult { ok: boolean; sizeUsd: number; reasons: string[] }

export function shareForTier(cfg: RiskConfig, tier: Tier): number {
  if (tier === 'follow') return cfg.perActionShareByTier.follow;
  if (tier === 'fast') return cfg.perActionShareByTier.fast;
  if (tier === 'full') return cfg.perActionShareByTier.full;
  return 0;
}

export function haltReason(cfg: RiskConfig, st: RiskState): string | undefined {
  if (st.hardStopped) return `hard stop: equity $${st.markedEquityUsd.toFixed(2)} < ${cfg.hardStopEquityShare * 100}% of start — waiting for the owner`;
  const badCfg = st.stopConfigProblem();
  if (badCfg) return `risk.json: ${badCfg.slice(0, 400)} — new entries off until the file is fixed (exits keep running)`;
  if (st.operatorHalt) return `halted by operator (${(st.operatorHaltReason ?? 'reason not recorded').slice(0, 200)}) — new entries off until /resume`;
  if (st.dailyStopActive()) return `daily loss stop: ${st.dailyStopPnlUsd().toFixed(2)} USD today (limit −${st.dailyStopLimitUsd().toFixed(2)}) — no new entries until 00:00 UTC`;
  return undefined;
}

export function sizeAction(cfg: RiskConfig, st: RiskState, req: SizeRequest): SizeResult {
  const reasons: string[] = [];
  const halt = haltReason(cfg, st);
  if (halt) return { ok: false, sizeUsd: 0, reasons: [halt] };
  if (st.activeCount() >= cfg.maxOpenPositions) return { ok: false, sizeUsd: 0, reasons: [`max open positions ${cfg.maxOpenPositions}`] };
  const share = Math.min(shareForTier(cfg, req.tier), req.shareCap ?? Infinity);
  if (share <= 0) return { ok: false, sizeUsd: 0, reasons: [`tier ${req.tier}: journal only`] };
  let size = Math.min(st.bucketUsd * share, st.cashUsd - req.estGasUsd);
  size = Math.floor(size * 100) / 100;
  if (req.estGasUsd > st.equityUsd * cfg.maxGasShareOfCapital) reasons.push(`gas $${req.estGasUsd.toFixed(2)} > ${cfg.maxGasShareOfCapital * 100}% of capital $${st.equityUsd.toFixed(2)}`);
  if (size > 0 && req.estGasUsd > size * cfg.maxGasShareOfAction) reasons.push(`gas $${req.estGasUsd.toFixed(2)} > ${cfg.maxGasShareOfAction * 100}% of action $${size.toFixed(2)}`);
  if (size < cfg.minActionUsd) reasons.push(`size $${size.toFixed(2)} < min $${cfg.minActionUsd}`);
  return { ok: reasons.length === 0, sizeUsd: reasons.length ? 0 : size, reasons };
}

/** The last line of defence before sending a transaction. Throws an exception rather than returning false. */
export function assertWithinLimits(cfg: RiskConfig, st: RiskState, tier: Tier, sizeUsd: number, estGasUsd: number, opts: { token?: string; opensPosition?: boolean; /** free mint: the position costs only gas */ allowFree?: boolean } = {}) {
  if (st.halted()) throw new Error('risk: trading halted');
  const cap = st.bucketUsd * shareForTier(cfg, tier);
  if (sizeUsd < 0 || sizeUsd > cap + 1e-9) throw new Error(`risk: size ${sizeUsd} exceeds tier cap ${cap}`);
  if (opts.opensPosition && !(sizeUsd > 0) && !opts.allowFree) throw new Error('risk: empty position');
  if (sizeUsd + estGasUsd > st.cashUsd + 1e-9) throw new Error('risk: not enough cash');
  if (estGasUsd > st.equityUsd * cfg.maxGasShareOfCapital) throw new Error('risk: gas exceeds capital share');
  if (opts.opensPosition && st.activeCount() >= cfg.maxOpenPositions) throw new Error('risk: max open positions');
  if (opts.token && st.holds(opts.token)) throw new Error('risk: token already in position');
}

/** Gas estimate for one action, USD. For Ethereum the hint is taken only from the message text. */
/** Live gas price (gwei) per chain, refreshed from RPC (eth_gasPrice) every 2 minutes. */
export const liveGasGwei = new Map<Chain, { gwei: number; atMs: number }>();
/** Gas of a typical Ethereum action (SeaDrop mint ~120–160k, swap ~150k) with a margin. */
export const ETH_ACTION_GAS = 180_000;
const LIVE_GAS_MAX_AGE_MS = 10 * 60_000;

export function estimateGasUsd(chain: Chain, ethUsd: number, gasHintEth?: { min: number; max: number }, nowMs = Date.now()): number {
  switch (chain) {
    case 'solana': return 0.01;      // base fee + priority
    case 'robinhood': return 0.015;  // swap ≈ 236k gas × 0.02 gwei
    case 'base': return 0.02;
    case 'arbitrum': return 0.03;
    case 'polygon': return 0;       // Polymarket: CLOB orders cost no gas for the trader
    case 'bsc': return 0.03;       // PancakeSwap swap ≈ 150k gas × 0.1 gwei × BNB, with a margin
    case 'ethereum': {
      // Take the LARGER of the hint in the text and the live gas price × 1.3: an understated hint must not let expensive gas through.
      // Without a live price — conservatively no less than 0.0015 ETH.
      const g = liveGasGwei.get('ethereum');
      const live = g && nowMs - g.atMs < LIVE_GAS_MAX_AGE_MS ? g.gwei * 1e-9 * ETH_ACTION_GAS * 1.3 : 0.0015;
      return Math.max(gasHintEth?.max ?? 0, live) * ethUsd;
    }
    default: return 0.05;
  }
}
