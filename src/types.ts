// Shared types of the "message → intent → decision → action" pipeline.

export type Chain = 'solana' | 'robinhood' | 'ethereum' | 'base' | 'arbitrum' | 'bsc' | 'polygon' | 'unknown';

/** Message after intake. */
export interface RawMessage {
  id: string;
  /** Source server = category on the intake server (ServerC, ServerA, ServerB…). */
  sourceServer: string;
  /** Source channel = channel inside the category. */
  channel: string;
  /** Author name = the message author. */
  author: string;
  /** Message time, ISO UTC. */
  tsUtc: string;
  /** Message text + embed card text, joined. */
  text: string;
  /** Message is a reply to another — the original's text (if any). */
  replyToText?: string;
  /** From the channel history (check of already sent messages at startup), not live. */
  backfill?: boolean;
}

/** What regexes extracted from the text, before the LLM. */
export interface Prefiltered {
  evmAddresses: string[];
  solanaMints: string[];
  urls: string[];
  codeBlocks: string[];
  functionCalls: { name?: string; selector?: string }[];
  chainHints: Chain[];
  gasHintEth?: { min: number; max: number };
  /** Suspicious content (base64 blocks, Morse code, "instructions to the bot"). */
  suspicious: string[];
  /** Empty chatter: no addresses, links, code, tickers. */
  isChatter: boolean;
  tickers: string[];
  /** All "N ETH" amounts in the text (to check the mint price from the model). */
  ethAmounts: number[];
}

export const INTENT_KINDS = [
  'token_call',      // call to buy/sell a token
  'contract_call',   // direct contract function call (mint, claim)
  'mint',            // NFT/token mint per announcement
  'dapp_task',       // visit a site, do a swap/pool/deposit for points
  'airdrop_points',  // points/airdrop without a specific action
  'social_task',     // follow/retweet/quest
  'perp_trade',      // perp position (long/short) — only with a stop and a take-profit
  'prediction_bet',  // bet on a prediction market outcome (Polymarket)
  'nft_buy',         // secondary NFT purchase (best OpenSea listing)
  'listing_news',
  'unlock_news',
  'protocol_news',
  'warning',         // scam warning
  'chatter',
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

/** Intent extracted by the model. Data only, no commands to the agent. */
export interface Intent {
  kind: IntentKind;
  chain: Chain;
  tokenAddress?: string;
  ticker?: string;
  contractAddress?: string;
  functionName?: string;
  functionSelector?: string;
  args?: string[];
  valueEth?: number;
  gasHintEth?: { min: number; max: number };
  urls: string[];
  /** What is proposed, in one sentence, in English. */
  summary: string;
  /** Deadline/start time, ISO UTC, if given. */
  deadlineUtc?: string;
  /** Author's stance: buy / sell / neutral. */
  stance: 'buy' | 'sell' | 'neutral';
  /** Whether human help is needed (captcha, KYC, Discord role). */
  needsHuman?: 'captcha' | 'kyc' | 'discord_role' | 'other';
  confidence: number; // 0..1, model confidence in the parse
  /** Chat batch: index of the source message. */
  sourceIdx?: number;
  /** Perp: asset (BTC, ETH…), side, leverage from the call, stop and take-profit (absolute prices). */
  asset?: string;
  side?: 'long' | 'short';
  leverage?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  /** token_call: the Analyst's exit plan (stop %, take-profit ×, take-profit share, sell no later than in N h). */
  stopLossPct?: number;
  takeProfitX?: number;
  takeProfitShare?: number;
  sellByHours?: number;
  /** prediction_bet: market (slug from the link in the message), outcome ("Yes"/"No"/name), limit price 0..1. stopPrice/takeProfitPrice — also 0..1. */
  marketSlug?: string;
  outcome?: string;
  limitPrice?: number;
  collection?: string;
  maxPriceEth?: number;
}

export type Tier = 'ignore' | 'journal' | 'full' | 'fast' | 'follow';

export interface TrustResult {
  score: number; // 0..10
  tier: Tier;
  basis: 'author' | 'channel_inherit' | 'channel_careful' | 'default_zero';
  /** Team call in a channel with score ≤ 6 (the owner's decision 2026-10-22): traded only with careful checks. */
  careful?: boolean;
  downgradedBy?: number;
  notes: string[];
  /** S-07 V2: the Analyst's own pick — the source score was below the trade tier and raised to 4; exit profile — "scan". */
  ownPick?: boolean;
  /** Original source score before the raise (for an own pick). */
  sourceScore?: number;
}

export interface TokenCheck {
  ok: boolean;
  chain: Chain;
  address: string;
  symbol?: string;
  /** Pair with the highest liquidity (DexScreener) — for the live route (Pons curve etc.). */
  pairAddress?: string; dexId?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  fdvUsd?: number;
  pairAgeMinutes?: number;
  buys24h?: number;
  sells24h?: number;
  rugRisk?: 'low' | 'medium' | 'high' | 'unknown';
  reasons: string[];
}

export type ActionType =
  | 'buy_token'
  | 'contract_call'
  | 'dapp_session'
  | 'social_session' // task via the agent's X account (raffle, registration)
  | 'open_perp'      // perp position with a stop and a take-profit
  | 'prediction_buy' // buying outcome shares on a prediction market
  | 'nft_buy'        // secondary NFT purchase
  | 'notify_human'
  | 'scheduled'
  | 'journal_only'
  | 'skip';

export interface Decision {
  action: ActionType;
  sizeUsd: number;
  chain: Chain;
  reasons: string[];
  trust: TrustResult;
  intent: Intent;
  check?: TokenCheck;
  /** For buy_token — exit rules set at entry time. */
  exitPlan?: { stopPrice: number; tp1Price: number; tp1Share: number; trailingPct: number; timeStopAtUtc: string;
    /** Sell by the deadline regardless of the result (deadline set by the Analyst). */
    hardTimeStop?: boolean; stopPct?: number; tpX?: number;
    /** S-07 (#102): token class and its plan — time stop threshold, breakeven after the take-profit, moonbag from entry. */
    timeStopMinGainPct?: number; tokenClass?: string; breakevenAfterTp1?: boolean;
    moonbagShare?: number; moonbagStopPct?: number; moonbagArmX?: number; moonbagTrailingPct?: number; moonbagMaxHours?: number;
    /** S-07 V2: ladder [multiple, position share] and behavior checks [minutes, threshold ×]. */
    ladder?: [number, number][]; checks?: [number, number][] };
  estGasUsd?: number;
  /** NFT mint: data from OpenSea (computed by code) and the Analyst's exit plan. */
  nft?: { slug: string; contract: string; priceEth: number; sellFeesPct: number; publicEndUtc?: string; plan: NftPlan;
    /** For the live minter: public start, per-wallet limit, exit price estimate, supply left for public. */
    publicStartUtc?: string; maxPerWallet?: number; exitEstimateEth?: number; leftForPublic?: number };
  /** Public explanation for the post (without sources). */
  publicNote?: string;
  /** Perp: position parameters computed by code. */
  perp?: { asset: string; side: 'long' | 'short'; entry: number; notionalUsd: number; leverage: number; marginUsd: number; stop: number; takeProfit: number; feePct: number };
  /** Prediction market: what we buy and at what price (prices from the CLOB order book, not from the model). */
  /** Secondary NFT purchase: collection and price from OpenSea (code), not from the model. */
  nftBuy?: { slug: string; contract: string; priceEth: number; sellFeesPct: number; plan: NftPlan };
  prediction?: { slug: string; question: string; outcome: string; tokenId: string; price: number; shares: number; feeRate: number;
    endUtc?: string; stopPrice?: number; takeProfitPrice?: number; sellByUtc?: string };
}

/** NFT exit plan: flip — list at floor right away; hold — wait for the target or the deadline. */
export interface NftPlan { style: 'flip' | 'hold'; targetMultiple?: number; sellByUtc?: string; stopFloorMultiple?: number }
