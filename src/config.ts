// Agent configuration. All secrets come only from .env on the server, never from code or chat.
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizeRisk } from './risk/riskCheck.js';

export type Mode = 'paper' | 'live';

export interface RiskConfig {
  /** Starting capital, USD (default example for paper; your own — in server/config/risk.json). */
  initialCapitalUsd: number;
  /** Share of capital in the "Hunt" bucket (Discord, memecoins, mints, tasks). Until the token launch — 1.0. */
  huntBucketShare: number;
  /** Maximum bucket share per action by trust tier. */
  perActionShareByTier: { follow: number; fast: number; full: number };
  /** Minimum action size, USD (smaller makes no sense because of fees). */
  minActionUsd: number;
  /** The action is skipped if gas costs more than this share of capital. */
  maxGasShareOfCapital: number;
  /** The action is skipped if gas costs more than this share of the action size. */
  maxGasShareOfAction: number;
  /** How many simultaneous open positions in the bucket. */
  maxOpenPositions: number;
  /**
   * Daily stop (the owner's decision 2026-11-10 12:21 UTC, option C): the bucket loss over the UTC day (closed + floating) —
   * a share of the bucket at 00:00 UTC (capital at 00:00 × huntBucketShare), after which new entries are blocked until 00:00 UTC.
   */
  dailyLossStopShareOfDayStart: number;
  /**
   * DEPRECATED, old meaning: a share of the bucket AFTER today's loss. Read only from a risk.json without
   * dailyLossStopShareOfDayStart (the old file on the server): loadRisk converts it as s / (1 + s) — the old threshold on closed
   * losses (e.g. 0.2 → 0.1667). After loading the field is not in the config; risk.ts does not read it: the old number cannot silently become
   * "a share of 00:00" (review PR #66, round 1, item 1). It is no longer in server/config/risk.json.
   */
  dailyLossStopShare?: number;
  /**
   * S-06: invalid risk.json numbers found on load (the field is replaced by the approved value from DEFAULT_RISK).
   * Non-empty — new entries are closed (RiskState.halted), exits and reconciliation keep working. Filled by loadRisk.
   */
  riskProblems?: string[];
  /** Capital below this share of the starting capital → full stop and a message to the owner. */
  hardStopEquityShare: number;
  /**
   * NFT mints: the tier cap is computed from the mint price without gas (gas is checked by its own rule).
   * The owner's decision 2026-10-22 10:57 UTC — option A (enabled in server/config/risk.json). Without the file — false (stricter).
   */
  mintCapExcludesGas: boolean;
  /**
   * Team calls in channels rated ≤ 6 (ServerB degen, core-alpha): "maximum caution" (the owner's decision 2026-10-22).
   * A trade only if the analyst is confident, the thesis is strong and the hold is short; size is cut; exits are tighter.
   */
  careful: {
    minConfidence: number; minThesisStrength: number; maxHoldHours: number; sizeFactor: number;
    minLiquidityUsd: number; minBuys24h: number; minSellBuyRatio: number;
    exit: { stopLossPct: number; takeProfit1x: number; takeProfit1Share: number; trailingStopPct: number; timeStopHours: number };
  };
  /**
   * Perps (the owner's decision 2026-10-22: longs/shorts allowed, only with a stop and a take-profit).
   * Loss at the stop ≤ riskPerTradeShare of capital; leverage ≤ maxLeverage and liquidation liqBuffer times further than the stop.
   */
  perp: { maxLeverage: number; defaultLeverage: number; riskPerTradeShare: number; defaultStopPct: number; defaultRewardRisk: number;
    minStopPct: number; maxStopPct: number; feePct: number; liqBuffer: number; venueMinNotionalUsd: number };
  /**
   * NFT mint by numbers (decision 2026-10-23 after Lanternfolk): before public (≤ 60 min) or during public, code itself decides to mint
   * if floor ≥ break-even × minFloorToBreakEven, there were sales and the allowlist is minted out. The model can only forbid (avoid).
   */
  nftAutoMint: { enabled: boolean; minFloorToBreakEven: number; minSales: number; minWlMintedShare: number; windowMinutes: number };
  /** Exit rules for memecoins. */
  memecoinExit: {
    stopLossPct: number;      // hard stop from the entry price, %
    takeProfit1x: number;     // price multiple for the first sale
    takeProfit1Share: number; // share to sell at the first TP
    trailingStopPct: number;  // trailing from the peak for the rest, %
    timeStopHours: number;    // time-based exit if it has not grown
    timeStopMinGainPct: number;
  };
  /** Live execution limits (S-04 #33; the owner's decisions 2026-10-29 21:15 and 2026-11-09 05:39 UTC). */
  live: { slippageBps: number; bridgeMaxShareOfEquity: number; mintMaxShareOfEquity: number; mintMaxWallets: number };
}

/** Example values — set your own in server/config/risk.json. Not the numbers SCARF trades with. */
export const DEFAULT_RISK: RiskConfig = {
  initialCapitalUsd: 10,
  huntBucketShare: 1.0,
  perActionShareByTier: { follow: 0.45, fast: 0.2, full: 0.08 },
  minActionUsd: 0.3,
  maxGasShareOfCapital: 0.12,
  maxGasShareOfAction: 0.25,
  maxOpenPositions: 6,
  dailyLossStopShareOfDayStart: 0.2,
  hardStopEquityShare: 0.55,
  mintCapExcludesGas: false,
  nftAutoMint: { enabled: true, minFloorToBreakEven: 1.4, minSales: 8, minWlMintedShare: 0.45, windowMinutes: 75 },
  perp: { maxLeverage: 4, defaultLeverage: 2, riskPerTradeShare: 0.015, defaultStopPct: 4, defaultRewardRisk: 2.5,
    minStopPct: 0.8, maxStopPct: 12, feePct: 0.05, liqBuffer: 1.4, venueMinNotionalUsd: 10 },
  careful: {
    minConfidence: 0.8, minThesisStrength: 8, maxHoldHours: 18, sizeFactor: 0.4,
    minLiquidityUsd: 25_000, minBuys24h: 80, minSellBuyRatio: 0.25,
    exit: { stopLossPct: 20, takeProfit1x: 1.5, takeProfit1Share: 0.5, trailingStopPct: 15, timeStopHours: 10 },
  },
  memecoinExit: {
    stopLossPct: 40,
    takeProfit1x: 2,
    takeProfit1Share: 0.5,
    trailingStopPct: 25,
    timeStopHours: 24,
    timeStopMinGainPct: 15,
  },
  live: { slippageBps: 500, bridgeMaxShareOfEquity: 0.5, mintMaxShareOfEquity: 0.25, mintMaxWallets: 8 },
};

export interface AppConfig {
  mode: Mode;
  /** Tests: disables background jobs (markouts, digests). */
  noAutoEvents: boolean;
  /** Tests: virtual time instead of system time. */
  virtualTime: boolean;
  dataDir: string;
  trustCsvPath: string;
  risk: RiskConfig;
  discord: { token?: string; guildId?: string };
  telegram: { botToken?: string; chatId?: string };
  anthropic: { apiKey?: string; extractModel: string; plannerModel: string; dailyBudgetUsd: number };
  /** Analyst layer: limits per UTC day, gatekeeper, own finds, X. */
  /** On startup, check messages already posted in the last N hours (0 — off). */
  backfillHours: number;
  intel: { openseaApiKey?: string; enabled: boolean; opusDailyUsd: number; sonnetDailyUsd: number; gateDailyUsd: number; ownPicks: 'off' | 'paper' | 'on';
    gatePath: string; briefPath: string; twitterApiKey?: string; repeatHours: number; watchRecheckMinutes: number;
    chatBatchSize: number; chatMaxWaitMinutes: number; chatReviewModel: string; chatDailyUsd: number };
  rpc: Record<string, string>;
  /** X posts (official API). Without keys — only drafts in Telegram. */
  x: { keys?: import('./posts/x.js').XKeys; mode: 'approve' | 'auto'; autoAfterDays: number; autoApproveMinutes: number; dailyMax: number; brandDir: string; thoughtsDailyMax: number; thoughtMinConfidence: number };
  /** Wallet reconciliation tolerance (live, E-03 #99): parsed but not checked for "is it needed" — index.ts decides that by mode. */
  reconcileTolerance: ReconcileTolerance;
}

/**
 * Wallet reconciliation tolerance (T-08): AGENT_RECONCILE_TOLERANCE_SHARE — share of cash, 0…0.5; AGENT_RECONCILE_TOLERANCE_USD — minimum in $,
 * 0…100. There is NO default: the owner chooses the number. Without both lines or with an invalid value live does not start (code 78);
 * paper and shadow have no reconciliation and need no settings. Only plain decimal notation is accepted (no 0x, 1e3, inner spaces).
 */
export type ReconcileTolerance = { ok: true; share: number; usd: number } | { ok: false; error: string };
export const RECONCILE_SHARE_MAX = 0.5;
export const RECONCILE_USD_MAX = 100;
export function parseReconcileTolerance(env: NodeJS.ProcessEnv): ReconcileTolerance {
  const errs: string[] = [];
  const read = (name: string, max: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') { errs.push(`${name} is not set (there is no default — the owner chooses the number)`); return undefined; }
    const t = raw.trim();
    const n = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
    if (!(Number.isFinite(n) && n >= 0 && n <= max)) { errs.push(`${name}="${t.slice(0, 40)}" — must be a number from 0 to ${max}`); return undefined; }
    return n;
  };
  const share = read('AGENT_RECONCILE_TOLERANCE_SHARE', RECONCILE_SHARE_MAX);
  const usd = read('AGENT_RECONCILE_TOLERANCE_USD', RECONCILE_USD_MAX);
  if (errs.length || share === undefined || usd === undefined) return { ok: false, error: errs.join('; ') };
  return { ok: true, share, usd };
}

export { riskConfigProblems } from './risk/riskCheck.js';

/**
 * risk.json → risk rules (S-06). A JSON syntax error throws, the agent does not start (as before).
 * An invalid number does not crash startup: the field is replaced by the approved value from DEFAULT_RISK, the problem goes to riskProblems —
 * new entries are closed (RiskState.halted), the exit monitor and reconciliation keep working, the owner gets a message (src/index.ts).
 */
export function loadRisk(path: string): RiskConfig {
  const parsed = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const early: string[] = [];
  const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : (early.push('the file is not a JSON object'), {});
  // A block that is not an object ("live": "0,5") is a problem (message to the owner and a stop on new entries), the block numbers are the approved ones
  const block = (o: any, name: string, label = name): Record<string, unknown> => {
    const v = o?.[name];
    if (v === undefined) return {};
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    early.push(`${label}=${typeof v === 'string' ? `"${v.slice(0, 40)}"` : Array.isArray(v) ? '[…]' : String(v)} — must be a block { … }`);
    return {};
  };
  const careful = block(raw, 'careful');
  const carefulExit = block(careful, 'exit', 'careful.exit');
  const cfg: RiskConfig = { ...DEFAULT_RISK, ...raw, memecoinExit: { ...DEFAULT_RISK.memecoinExit, ...block(raw, 'memecoinExit') },
    perActionShareByTier: { ...DEFAULT_RISK.perActionShareByTier, ...block(raw, 'perActionShareByTier') },
    perp: { ...DEFAULT_RISK.perp, ...block(raw, 'perp') },
    live: { ...DEFAULT_RISK.live, ...block(raw, 'live') },
    nftAutoMint: { ...DEFAULT_RISK.nftAutoMint, ...block(raw, 'nftAutoMint') },
    careful: { ...DEFAULT_RISK.careful, ...careful, exit: { ...DEFAULT_RISK.careful.exit, ...carefulExit } } };
  // The old daily-stop field: with the new field present it is neither read nor checked (one log line); without the new one — the old threshold
  // s / (1 + s), not the default and not "s of 00:00"; an invalid old number is a problem, the threshold comes from DEFAULT_RISK
  if ('dailyLossStopShare' in raw) {
    const s = raw.dailyLossStopShare;
    if (raw.dailyLossStopShareOfDayStart !== undefined) console.warn(`${path}: dailyLossStopShare is not read — the daily stop is set by dailyLossStopShareOfDayStart`);
    else if (typeof s === 'number' && Number.isFinite(s) && s > 0 && s <= 1) {
      cfg.dailyLossStopShareOfDayStart = s / (1 + s);
      console.warn(`${path}: no dailyLossStopShareOfDayStart — daily stop from the old dailyLossStopShare=${s} → ${cfg.dailyLossStopShareOfDayStart.toFixed(4)} of the bucket at 00:00 UTC (old threshold)`);
    } else early.push(`dailyLossStopShare=${typeof s === 'string' ? `"${s.slice(0, 40)}"` : String(s)} — must be a share 0 < x ≤ 1 (or the new field dailyLossStopShareOfDayStart)`);
    delete cfg.dailyLossStopShare;
  }
  cfg.riskProblems = [...early, ...sanitizeRisk(cfg, DEFAULT_RISK)];
  return cfg;
}

/** AGENT_X_AUTO_APPROVE_MIN: unset — 90 (example); a number ≥ 0 — that number; anything else — 0 (timer off) with a warning. */
function autoApproveMinutes(raw: string | undefined): number {
  if (raw === undefined) return 90; // example value — set AGENT_X_AUTO_APPROVE_MIN yourself
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) { console.warn(`AGENT_X_AUTO_APPROVE_MIN="${raw}" — not a number ≥ 0: auto-publishing posts without a reply is off`); return 0; }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const root = resolve(env.AGENT_ROOT ?? process.cwd());
  const mode = (env.AGENT_MODE ?? 'paper') as Mode;
  if (mode !== 'paper' && mode !== 'live') throw new Error(`AGENT_MODE must be paper|live, got ${mode}`);
  return {
    mode,
    noAutoEvents: env.AGENT_NO_AUTO_EVENTS === '1',
    virtualTime: env.AGENT_VIRTUAL_TIME === '1',
    dataDir: resolve(root, env.AGENT_DATA_DIR ?? 'server/data'),
    trustCsvPath: resolve(root, env.AGENT_TRUST_CSV ?? 'server/config/trust-sources.csv'),
    risk: loadRisk(resolve(root, env.AGENT_RISK_JSON ?? 'server/config/risk.json')),
    discord: { token: env.DISCORD_BOT_TOKEN, guildId: env.DISCORD_GUILD_ID },
    telegram: { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY,
      extractModel: env.AGENT_EXTRACT_MODEL ?? 'claude-haiku-5-5',
      plannerModel: env.AGENT_PLANNER_MODEL ?? 'claude-opus-5-5',
      dailyBudgetUsd: Number(env.AGENT_LLM_DAILY_BUDGET_USD ?? 10),
    },
    backfillHours: Math.max(0, Math.min(168, Number(env.AGENT_BACKFILL_HOURS ?? 24))),
    intel: {
      enabled: env.AGENT_INTEL !== '0',
      opusDailyUsd: Number(env.AGENT_OPUS_DAILY_USD ?? 4),
      sonnetDailyUsd: Number(env.AGENT_SONNET_DAILY_USD ?? 2),
      gateDailyUsd: Number(env.AGENT_GATE_DAILY_USD ?? 0.5),
      ownPicks: ((): 'off' | 'paper' | 'on' => { const v = env.AGENT_OWN_PICKS ?? 'paper'; if (!['off', 'paper', 'on'].includes(v)) throw new Error('AGENT_OWN_PICKS must be off|paper|on'); return v as any; })(),
      gatePath: resolve(root, env.AGENT_GATE_JSON ?? 'server/config/gate.json'),
      briefPath: resolve(root, env.AGENT_BRIEF ?? 'server/config/agent-brief.md'),
      twitterApiKey: env.TWITTERAPI_IO_KEY || undefined,
      openseaApiKey: env.OPENSEA_API_KEY || undefined,
      repeatHours: Number(env.AGENT_REPEAT_HOURS ?? 24),
      watchRecheckMinutes: Number(env.AGENT_WATCH_RECHECK_MIN ?? 60),
      chatBatchSize: Math.max(5, Number(env.AGENT_CHAT_BATCH ?? 50)),
      chatMaxWaitMinutes: Math.max(10, Number(env.AGENT_CHAT_MAX_WAIT_MIN ?? 180)),
      // Chat batch review after Haiku (option 2, the owner 2026-10-23): Sonnet, only flagged messages, its own daily limit
      chatReviewModel: env.AGENT_CHAT_REVIEW_MODEL ?? 'claude-sonnet-5-5',
      chatDailyUsd: Number(env.AGENT_CHAT_DAILY_USD ?? 0.5),
    },
    x: {
      keys: env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET
        ? { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET } : undefined,
      // The owner's decision 2026-10-23: 3 days via a Telegram button, then on its own
      mode: env.AGENT_X_POST_MODE === 'auto' ? 'auto' : 'approve',
      autoAfterDays: Number(env.AGENT_X_AUTO_AFTER_DAYS ?? 7),
      // The owner 2026-11-11: no reply in Telegram within an hour — the post goes out on its own. 0 — off
      autoApproveMinutes: autoApproveMinutes(env.AGENT_X_AUTO_APPROVE_MIN),
      dailyMax: Number(env.AGENT_X_DAILY_MAX ?? 20),
      brandDir: resolve(root, env.AGENT_BRAND_CARDS ?? 'brand/cards'),
      // Thoughts (the owner 2026-10-24): watching/on my list. The daily limit and confidence threshold are examples, set in .env
      thoughtsDailyMax: Number(env.AGENT_X_THOUGHTS_DAILY ?? 6),
      thoughtMinConfidence: Number(env.AGENT_X_THOUGHT_MIN_CONF ?? 0), // The owner 2026-11-10: a thought at any confidence, marked when low
    },
    rpc: {
      robinhood: env.RPC_ROBINHOOD ?? 'https://rpc.mainnet.chain.robinhood.com',
      ethereum: env.RPC_ETHEREUM ?? 'https://ethereum-rpc.publicnode.com',
      base: env.RPC_BASE ?? 'https://mainnet.base.org',
      arbitrum: env.RPC_ARBITRUM ?? 'https://arb1.arbitrum.io/rpc',
      bsc: env.RPC_BSC ?? 'https://bsc-dataseed.bnbchain.org',
      solana: env.RPC_SOLANA ?? 'https://api.mainnet-beta.solana.com',
    },
    reconcileTolerance: parseReconcileTolerance(env),
  };
}
