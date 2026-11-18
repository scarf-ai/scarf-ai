// Sample events for previews: real SWARMX paper trade + edge cases.
import { fmtPrice } from "./chart.mjs";

const base = { paper: true, chain: "Robinhood Chain" };

export const PNL_SAMPLES = {
  swarmx: {
    ...base, ticker: "$SWARMX", entry: 0.00011, exit: 0.00011 * 0.73 / 1.25, size_in: "$1.25", size_out: "$0.73",
    pnl_usd: "−$0.54", pnl_pct: "−43.2%", is_win: false, held: "51m", exit_reason: "Stop hit",
    date_utc: "2026-10-23", time_range: "16:03 → 16:54 UTC",
    note: "Quick momentum flip on a fresh Robinhood Chain ponzi-mint narrative",
    points: [100, 104, 112, 118, 109, 96, 88, 79, 71, 66, 61, 58, 57],
  },
  win_long: {
    ...base, chain: "Solana", ticker: "$SUPERCATCOINX", entry: 0.00000123, exit: 0.00000199, size_in: "$3.00", size_out: "$4.86",
    pnl_usd: "+$1.86", pnl_pct: "+62.0%", is_win: true, held: "3h 12m", exit_reason: "Take profit",
    date_utc: "2026-10-24", time_range: "09:41 → 12:53 UTC",
    note: "Volume came back after the dev burned the LP. Took 2× and let the rest ride.",
    points: [100, 98, 103, 110, 108, 121, 134, 129, 142, 151, 158, 162, 161],
  },
  tiny: {
    ...base, chain: "Base", ticker: "$GM", entry: 0.0431, exit: 0.0442, size_in: "$0.50", size_out: "$0.51",
    pnl_usd: "+$0.01", pnl_pct: "+2.6%", is_win: true, held: "6h 05m", exit_reason: "Time exit",
    date_utc: "2026-10-24", time_range: "02:10 → 08:15 UTC",
    note: "Nothing happened, which is also a result.",
    points: [100, 101, 99, 100, 102, 101, 103, 102, 101, 102, 103, 102, 103],
  },
};

export function prep(s) {
  const len = s.ticker.length;
  return {
    ...s,
    entry_price: fmtPrice(s.entry), exit_price: fmtPrice(s.exit),
    // ticker auto-size: code picks font size by length (satori has no auto-fit)
    ticker_size: len <= 8 ? 120 : len <= 11 ? 100 : 80,
    arrow: s.is_win ? "▲" : "▼", result_word: s.is_win ? "PROFIT" : "LOSS",
    position_line: "No position now",
  };
}
