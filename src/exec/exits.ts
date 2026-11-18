// Memecoin position exit rules (a pure function — easy to test).
// Base scheme: stop, first take-profit of a part at ×N, the remainder — trailing from the peak, a time exit if the gain is small.
// S-07 (#102), V2: a position of two parts — the core and a moonbag from the moment of entry. Core: a sell ladder (ladder), after the first sale
// the floor at breakeven, trailing on the remainder, behaviour checks (checks: at check time the price is below the threshold and there were no sales yet — exit),
// emergency floor (stopPrice), deadline. Moonbag: its own stop, trailing after a rise to moonbagArm, a deadline in days; sold last.
// Parameters — the source profile (src/decide/tokenClass.ts, the memecoinClasses block in risk.json). Without the new fields the behaviour is unchanged.
export interface OpenPos {
  id: string; token: string; chain: string;
  entryPrice: number; qty: number; qtyLeft: number; costUsd: number;
  peakPrice: number; tp1Done: boolean; openedAtMs: number;
  stopPrice: number; tp1Price: number; tp1Share: number; trailingPct: number; timeStopAtMs: number; timeStopMinGainPct: number;
  /** The Analyst set a deadline: sell by it whatever the result. */
  hardTimeStop?: boolean;
  /** Ticker for messages and posts. */
  symbol?: string;
  /** S-07: token class at entry (for the journal and posts). */
  tokenClass?: string;
  /** S-07: after the first take-profit the core stop moves to the entry price (breakeven). */
  breakevenAfterTp1?: boolean;
  /** S-07: moonbag — the quantity (out of qty) that lives by its own rules and is sold last. */
  moonbagQty?: number;
  /** Moonbag stop from the entry price (wider than the core one). */
  moonbagStopPrice?: number;
  /** Moonbag trailing from the peak turns on when the peak is ≥ moonbagArmPrice. */
  moonbagArmPrice?: number; moonbagTrailingPct?: number;
  /** Moonbag deadline. */
  moonbagUntilMs?: number;
  /** S-07 V2: sell ladder — absolute price and quantity of each rung; how many rungs are already sold. */
  ladder?: { price: number; qty: number }[]; rungsDone?: number;
  /** S-07 V2: behaviour checks — time and minimum price; how many checks have passed. Active until the first sale. */
  checks?: { atMs: number; minPrice: number }[]; checksDone?: number;
  /** Pair/curve for a live sale. */
  pairAddress?: string; dexId?: string;
  /** Live position: the entry transaction, how many tokens (base units, as a string) this position has left. */
  live?: { tx?: string; raw?: string; decimals?: number };
  /** A sale was sent but not yet confirmed — the monitor does not touch the position until this time. */
  exitingUntilMs?: number;
  /**
   * #135 F3: live sales "in flight" whose outcome is not yet in the ledger — kept in the position state so that the hold survives a restart:
   * after it the position is not sold until the outcome is known (restore → check by hash). soldRaw — as a string (bigint).
   */
  sellsInFlight?: { tx: string; qty: number; proceeds: number; soldRaw?: string; reason: string; price: number; after?: Partial<OpenPos>; sentUtc: string;
    /** EVM: the sender's nonce and address — after a restart the outcome is decided by hash AND nonce (dropped / replaced). */
    nonce?: number; from?: string }[];
  /**
   * #135 R1: sales released with the /release not-sold command are remembered for 24 h (releasedUtc): if such a transaction does land in a block,
   * the late outcome counts it once (no more than the remainder) instead of becoming a ghost without a pair.
   */
  releasedSells?: { tx: string; qty: number; proceeds: number; soldRaw?: string; reason: string; price: number; after?: Partial<OpenPos>; sentUtc: string;
    nonce?: number; from?: string; releasedUtc: string }[];
  /** Price from entry to exit for the mini chart on the card (every monitor check; above 60 points — thinned to every other one). */
  points?: number[];
}

export function recordPoint(p: OpenPos, price: number) {
  if (!(price > 0)) return;
  const pts = p.points ?? (p.points = [p.entryPrice]);
  pts.push(price);
  if (pts.length > 60) p.points = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
}

export type ExitAction = { kind: 'none' } | { kind: 'sell'; qty: number; reason: string };

/** S-07: position fields from the decision's exit plan — from the actual entry price and quantity. Without the new fields — empty. */
export function moonbagFields(plan: { tokenClass?: string; breakevenAfterTp1?: boolean; moonbagShare?: number; moonbagStopPct?: number; moonbagArmX?: number; moonbagTrailingPct?: number; moonbagMaxHours?: number;
  ladder?: [number, number][]; checks?: [number, number][] },
  qty: number, entry: number, nowMs: number): Partial<OpenPos> {
  const out: Partial<OpenPos> = {};
  if (plan.tokenClass) out.tokenClass = plan.tokenClass;
  if (plan.breakevenAfterTp1) out.breakevenAfterTp1 = true;
  if (plan.ladder?.length) out.ladder = plan.ladder.map(([x, share]) => ({ price: entry * x, qty: qty * share }));
  if (plan.checks?.length) out.checks = plan.checks.map(([minutes, x]) => ({ atMs: nowMs + minutes * 60_000, minPrice: entry * x }));
  const share = plan.moonbagShare ?? 0;
  if (share > 0 && share < 1 && plan.moonbagStopPct !== undefined && plan.moonbagArmX !== undefined && plan.moonbagTrailingPct !== undefined && plan.moonbagMaxHours !== undefined) {
    out.moonbagQty = qty * share;
    out.moonbagStopPrice = entry * (1 - plan.moonbagStopPct / 100);
    out.moonbagArmPrice = entry * plan.moonbagArmX;
    out.moonbagTrailingPct = plan.moonbagTrailingPct;
    out.moonbagUntilMs = nowMs + plan.moonbagMaxHours * 3600_000;
  }
  return out;
}

/** How much of the remainder is the moonbag (it is sold last). */
export function moonbagLeft(p: OpenPos): number { return Math.min(p.qtyLeft, Math.max(0, p.moonbagQty ?? 0)); }

export function evaluateExit(p: OpenPos, price: number, nowMs: number): ExitAction {
  if (!(price > 0)) return { kind: 'none' };
  recordPoint(p, price);
  if (price > p.peakPrice) p.peakPrice = price;
  const eps = p.qty * 1e-9;
  const moon = moonbagLeft(p);
  const core = p.qtyLeft - moon;

  // Moonbag: its own wide stop, trailing after a rise, and a deadline. Sold last, so its exit closes everything that is left.
  if (moon > eps) {
    if (p.moonbagStopPrice !== undefined && price <= p.moonbagStopPrice) return { kind: 'sell', qty: p.qtyLeft, reason: `moonbag stop at ${price}` };
    if (p.moonbagTrailingPct !== undefined && p.moonbagArmPrice !== undefined && p.peakPrice >= p.moonbagArmPrice && price <= p.peakPrice * (1 - p.moonbagTrailingPct / 100))
      return { kind: 'sell', qty: p.qtyLeft, reason: `moonbag trailing ${p.moonbagTrailingPct}% from peak ${p.peakPrice}` };
    if (p.moonbagUntilMs !== undefined && nowMs >= p.moonbagUntilMs) return { kind: 'sell', qty: p.qtyLeft, reason: 'moonbag time limit' };
  }
  if (core <= eps) return { kind: 'none' };

  // Core part
  if (price <= p.stopPrice) return { kind: 'sell', qty: core, reason: `stop-loss at ${price}${moon > eps ? ' (moonbag kept)' : ''}` };
  if (p.ladder?.length) {
    // Ladder: all rungs passed are sold in one sale; the first sale moves the floor to breakeven
    const done = p.rungsDone ?? 0; let n = done, q = 0;
    while (n < p.ladder.length && price >= p.ladder[n].price) { q += p.ladder[n].qty; n++; }
    if (n > done) {
      p.rungsDone = n; p.tp1Done = true;
      if (p.breakevenAfterTp1 && p.stopPrice < p.entryPrice) p.stopPrice = p.entryPrice;
      return { kind: 'sell', qty: Math.min(core, q), reason: `ladder ${done + 1}${n - done > 1 ? `–${n}` : ''}/${p.ladder.length} at ${price}` };
    }
  } else if (!p.tp1Done && price >= p.tp1Price) {
    p.tp1Done = true;
    if (p.breakevenAfterTp1 && p.stopPrice < p.entryPrice) p.stopPrice = p.entryPrice;
    // The take-profit share is of the whole position (as in the risk.json table), but no more than the core part (M3, S-07 acceptance)
    return { kind: 'sell', qty: Math.min(core, p.qty * p.tp1Share), reason: `take-profit 1 at ${price}` };
  }
  // Behaviour checks: while there were no sales — at check time the price is below the threshold → the token "is not alive", exit the core part
  // The monitor was late (no price) — only the latest due check is applied to the current price, earlier ones count as passed (V3)
  if (!p.tp1Done && p.checks?.length) {
    const from = p.checksDone ?? 0; let k = from;
    while (k < p.checks.length && nowMs >= p.checks[k].atMs) k++;
    if (k > from) {
      p.checksDone = k; const c = p.checks[k - 1];
      if (price < c.minPrice) return { kind: 'sell', qty: core, reason: `behavior check ${Math.round((c.atMs - p.openedAtMs) / 60_000)} min: ${(price / p.entryPrice).toFixed(2)}x < ${(c.minPrice / p.entryPrice).toFixed(2)}x` };
    }
  }
  if (p.tp1Done && p.trailingPct > 0 && price <= p.peakPrice * (1 - p.trailingPct / 100)) return { kind: 'sell', qty: core, reason: `trailing stop ${p.trailingPct}% from peak ${p.peakPrice}` };
  if (p.hardTimeStop && nowMs >= p.timeStopAtMs) return { kind: 'sell', qty: core, reason: 'sell-by time reached' };
  if (!p.tp1Done && nowMs >= p.timeStopAtMs && price < p.entryPrice * (1 + p.timeStopMinGainPct / 100)) return { kind: 'sell', qty: core, reason: 'time stop' };
  return { kind: 'none' };
}
