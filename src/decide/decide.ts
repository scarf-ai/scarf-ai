// Decision on one intent: what to do, at what size, with which exit rules.
// Order: injections/hacks → blacklist → model confidence → kind → trust → risk stops → checks → size.
// Everything that affects money (address, chain, gas, mint price) is taken from the text (prefilter), not from the model's word.
import type { RiskConfig } from '../config.js';
import type { Clock } from '../clock.js';
import type { Chain, Decision, Intent, Prefiltered, TrustResult } from '../types.js';
import { evaluateToken, type MarketClient } from '../checks/token.js';
import { utcMs } from '../time.js';
import type { PerpClient } from '../checks/perp.js';
import { estimateGasUsd, haltReason, sizeAction, type RiskState } from '../risk/risk.js';
import { pmFee, type PmMarket } from '../checks/polymarket.js';
import { classesFrom, classesProblem, profileFor, legacyExit } from './tokenClass.js';
import { checkEntry, entryRules, runUp1h, type MarketWithChange, type NoH1Watch } from './entry.js';

/** Domains that never go on the blacklist (they appear in almost every message). */
const NEVER_BLACKLIST = new Set(['x.com', 'twitter.com', 't.me', 'discord.com', 'discord.gg', 'dexscreener.com', 'etherscan.io', 'basescan.org',
  'arbiscan.io', 'solscan.io', 'pump.fun', 'gmgn.ai', 'birdeye.so', 'jup.ag', 'uniswap.org', 'app.uniswap.org', 'robinhoodchain.blockscout.com',
  'geckoterminal.com', 'coingecko.com', 'youtube.com', 'github.com', 'medium.com', 'mirror.xyz', 'bark.gg', 'klipy.com']);

export class Blacklist {
  private items = new Set<string>();
  add(x: string) { const v = x.toLowerCase(); if (!NEVER_BLACKLIST.has(v)) this.items.add(v); }
  has(x?: string) { return !!x && this.items.has(x.toLowerCase()); }
  hasDomain(url: string) { try { const h = new URL(url).hostname.toLowerCase(); return this.items.has(h) || this.items.has(h.split('.').slice(-2).join('.')); } catch { return false; } }
  entries() { return [...this.items]; }
}

export interface DecideDeps { cfg: RiskConfig; risk: RiskState; market: MarketClient; clock: Clock; blacklist: Blacklist; ethUsd: () => number;
  /** Perp prices (Hyperliquid). Without it, perp trades go to the journal only. */
  perp?: PerpClient;
  /** The "1h change unavailable" watchdog (#128): sees every memecoin entry check. Without it — decision journal only. */
  entryWatch?: NoH1Watch }
export interface DecideContext {
  /** Addresses from the message's own text (without the quote it replied to). */
  mainTextAddresses: Set<string>;
  /** OpenSea drop found by code from a link in the message: contract, chain and price are taken from here, not from the model. */
  nft?: { contract: string; chain: Chain; priceEth: number };
  /** The decision comes after the Analyst's review (for "careful" sources there are no trades without it). */
  analyst?: boolean;
  /** Prediction market from the dossier (by a link in the message). */
  prediction?: PmMarket;
  /** NFT to buy on the secondary market: from the OpenSea dossier (by a link in the message). */
  nftBuy?: { slug: string; contract?: string; chain: Chain; floorEth?: number; sellFeesPct: number };
}

export const MIN_CONFIDENCE = 0.5;

/** Chain: hints from the text outweigh the model's opinion. On conflict — unknown. */
export function resolveChain(intent: Intent, pre: Prefiltered): Chain {
  const hints = pre.chainHints.filter(h => h !== "unknown");
  if (hints.length === 1) return hints[0];
  if (hints.length > 1) return (hints as Chain[]).includes(intent.chain) ? intent.chain : 'unknown';
  if (intent.tokenAddress && pre.solanaMints.includes(intent.tokenAddress)) return 'solana';
  return intent.chain;
}

export async function decide(intent: Intent, trust: TrustResult, pre: Prefiltered, d: DecideDeps, ctx?: DecideContext): Promise<Decision> {
  const nftMatch = !!(ctx?.nft && intent.contractAddress && intent.contractAddress.toLowerCase() === ctx.nft.contract.toLowerCase());
  const chain = nftMatch ? ctx!.nft!.chain : resolveChain(intent, pre);
  const base = { intent, trust, chain, sizeUsd: 0 };
  const reasons: string[] = [...trust.notes];
  if (chain !== intent.chain) reasons.push(`chain from text: ${chain} (model said ${intent.chain})`);

  if (pre.suspicious.length) return { ...base, action: 'skip', reasons: [...reasons, ...pre.suspicious, 'message looks like an injection attempt'] };

  // A scam warning adds to the blacklist only from sources with score ≥ 4
  if (intent.kind === 'warning') {
    if (trust.tier === 'journal' || trust.tier === 'ignore') return { ...base, action: 'journal_only', reasons: [...reasons, 'scam warning from low-trust source — logged, blacklist unchanged'] };
    for (const a of [intent.tokenAddress, intent.contractAddress, ...pre.evmAddresses, ...pre.solanaMints]) if (a) d.blacklist.add(a);
    for (const u of pre.urls) { try { d.blacklist.add(new URL(u).hostname); } catch { /* ignore */ } }
    return { ...base, action: 'journal_only', reasons: [...reasons, 'scam warning → blacklist updated'] };
  }
  const allAddrs = [intent.tokenAddress, intent.contractAddress, ...pre.evmAddresses, ...pre.solanaMints];
  if (allAddrs.some(a => d.blacklist.has(a)) || pre.urls.some(u => d.blacklist.hasDomain(u))) return { ...base, action: 'skip', reasons: [...reasons, 'blacklisted address/domain'] };

  if (['chatter', 'listing_news', 'unlock_news', 'protocol_news', 'airdrop_points'].includes(intent.kind))
    return { ...base, action: 'journal_only', reasons: [...reasons, `${intent.kind}: information for strategist digest`] };

  if (trust.tier === 'journal' || trust.tier === 'ignore') {
    // A call without the right to trade is still scored by price: after 5 min / 1 h / 24 h / 7 days it shows which
    // low-score authors make good calls (candidates for promotion in the daily report)
    let check: Decision['check'];
    if (intent.kind === 'token_call' && intent.stance === 'buy' && intent.tokenAddress) {
      const m = await d.market.market(intent.tokenAddress).catch(() => undefined);
      if (m?.priceUsd) check = { ok: false, chain: m.chain, address: intent.tokenAddress, priceUsd: m.priceUsd, liquidityUsd: m.liquidityUsd, fdvUsd: m.fdvUsd, reasons: ['journal only: price recorded for markouts'] };
    }
    return { ...base, check, action: 'journal_only', reasons: [...reasons, `trust ${trust.score}: journal only (paper markouts)`] };
  }
  if (trust.careful && !ctx?.analyst) return { ...base, action: 'journal_only', reasons: [...reasons, 'team channel (careful): trades only after the analyst checks the thesis'] };
  if (intent.confidence < MIN_CONFIDENCE) return { ...base, action: 'journal_only', reasons: [...reasons, `model confidence ${intent.confidence} < ${MIN_CONFIDENCE}`] };

  // An address only from the quote (another author's message) is not the replier's action
  const target = intent.tokenAddress ?? intent.contractAddress;
  if (target && ctx && !nftMatch && ![...ctx.mainTextAddresses].some(a => a.toLowerCase() === target.toLowerCase()))
    return { ...base, action: 'journal_only', reasons: [...reasons, 'address only in quoted message — not acted on'] };

  if (intent.needsHuman) return { ...base, action: 'notify_human', reasons: [...reasons, `needs human: ${intent.needsHuman}`] };

  if (intent.deadlineUtc && intent.kind !== 'prediction_bet') { // for a bet the deadline is the resolution date, not the action time
    const due = utcMs(intent.deadlineUtc);
    if (Number.isFinite(due) && due - d.clock.now() > 2 * 60_000) return { ...base, action: 'scheduled', reasons: [...reasons, `scheduled for ${intent.deadlineUtc}`] };
  }

  const halt = haltReason(d.cfg, d.risk);
  if (halt && ['token_call', 'contract_call', 'mint', 'dapp_task', 'perp_trade', 'prediction_bet', 'nft_buy'].includes(intent.kind)) return { ...base, action: 'skip', reasons: [...reasons, halt] };

  const ethUsd = d.ethUsd();
  const estGasUsd = estimateGasUsd(chain, ethUsd, pre.gasHintEth, d.clock.now());

  switch (intent.kind) {
    case 'token_call': {
      if (intent.stance !== 'buy') return { ...base, action: 'journal_only', reasons: [...reasons, `stance ${intent.stance}`] };
      if (!intent.tokenAddress) return { ...base, action: 'journal_only', reasons: [...reasons, 'no contract address in message'] };
      if (d.risk.holds(intent.tokenAddress)) return { ...base, action: 'journal_only', reasons: [...reasons, 'already in position (counted as extra mention)'] };
      const market = await d.market.market(intent.tokenAddress);
      const mChain = market?.chain && market.chain !== 'unknown' ? market.chain : chain;
      const rug = await d.market.rug(mChain, intent.tokenAddress);
      // Own pick: fresh pairs are open (the owner's decision 2026-11-16 "Yes, open"); people's calls — the previous age threshold
      const check = evaluateToken(intent.tokenAddress, trust.tier, market, rug, { ownPick: trust.ownPick === true });
      if (check.ok && trust.careful && market) {
        // Extra checks for team calls in channels ≤ 6
        const c = d.cfg.careful;
        if ((market.liquidityUsd ?? 0) < c.minLiquidityUsd) check.reasons.push(`careful: liquidity $${Math.round(market.liquidityUsd ?? 0)} < $${c.minLiquidityUsd}`);
        if ((market.buys24h ?? 0) < c.minBuys24h) check.reasons.push(`careful: buys24h ${market.buys24h ?? 0} < ${c.minBuys24h}`);
        if ((market.sells24h ?? 0) < (market.buys24h ?? 0) * c.minSellBuyRatio) check.reasons.push(`careful: sells ${market.sells24h ?? 0} < ${c.minSellBuyRatio * 100}% of buys (exit liquidity doubtful)`);
        if (mChain === 'solana' && (!rug || rug.risk === 'unknown' || rug.risk === 'high')) check.reasons.push(`careful: rugcheck ${rug?.risk ?? 'missing'}`);
        check.ok = check.reasons.length === 0;
      }
      if (!check.ok) return { ...base, chain: mChain, check, action: 'skip', reasons: [...reasons, ...check.reasons] };
      // S-02 option B (the owner's decision 2026-11-13): don't chase the pump, pair age "fresh or older than a day", stake share ≤ cap
      const er = entryRules(d.cfg);
      if (er.kind === 'invalid') return { ...base, chain: mChain, check, action: 'skip', reasons: [...reasons, `entry rules invalid (risk.json memecoinEntry: ${er.why}) — memecoins are not bought until fixed`] };
      // Invalid memecoinClasses exit block (the owner's decision 2026-11-18 ~00:00 UTC, "Don't buy new ones"): new memecoins are not bought,
      // other entries work; open positions follow the exit plan saved at entry (the block is not read for them)
      const whyClasses = classesProblem(d.cfg);
      if (whyClasses) return { ...base, chain: mChain, check, action: 'skip', reasons: [...reasons, `exit classes invalid (risk.json memecoinClasses: ${whyClasses}) — new memecoins are not bought until fixed`] };
      // S-02b: source score and own-pick flag — for the exemption from the pair-age rule (off while risk.json has null)
      const entry = er.kind === 'on' ? checkEntry(er.rules, market as MarketWithChange, { score: trust.score, ownPick: trust.ownPick === true }) : undefined;
      if (entry) d.entryWatch?.note(runUp1h(market as MarketWithChange) === undefined, market?.pairAgeMinutes);
      if (entry && !entry.ok) return { ...base, chain: mChain, check, action: 'skip', reasons: [...reasons, entry.why] };
      if (entry) reasons.push(entry.why);
      const gas = estimateGasUsd(mChain, ethUsd, undefined, d.clock.now());
      const size = sizeAction(d.cfg, d.risk, { tier: trust.tier, chain: mChain, estGasUsd: gas * 2 /* entry + exit */, shareCap: er.kind === 'on' ? er.rules.shareOfCapital : undefined });
      if (!size.ok) return { ...base, chain: mChain, check, action: 'skip', reasons: [...reasons, ...size.reasons], estGasUsd: gas * 2 };
      const px = check.priceUsd!;
      // S-07 V2: exit plan by source profile ("call" / "scan"); "careful" sources — the previous strict careful rules
      const classes = trust.careful ? undefined : classesFrom(d.cfg);
      if (classes) {
        const pf = profileFor(classes, trust); const ex = classes.profiles[pf.profile];
        // Floor — from the profile; the Analyst tightens it only if allowed (the owner's decision 2026-11-13: does not tighten)
        const aStop = classes.analystStopTightens !== false && ctx?.analyst && Number.isFinite(intent.stopLossPct) ? Math.max(5, intent.stopLossPct!) : undefined;
        const floorPct = aStop !== undefined ? Math.min(ex.floorPct, aStop) : ex.floorPct;
        // Analyst deadline: 'core' (decision 1b) — core part only, the moonbag lives by the profile; 'all' — the whole position, no moonbag
        const sellBy = ctx?.analyst && Number.isFinite(intent.sellByHours) && intent.sellByHours! > 0 ? Math.max(0.25, intent.sellByHours!) : undefined;
        const hours = Math.min(ex.holdHours, sellBy ?? Infinity);
        const sellByKillsMoon = sellBy !== undefined && classes.analystSellByScope !== 'core';
        // Limit of concurrent positions with a moonbag: reached — trade without a moonbag (old tails are not force-sold)
        const moon = sellByKillsMoon || d.risk.tailCount() >= classes.maxOpenMoonbags ? 0 : ex.moonbag.share;
        const [x1, s1] = ex.ladder[0];
        const exitText = `exit [${pf.profile}: ${pf.why}]: floor −${floorPct}%, ladder ${ex.ladder.map(([x, sh]) => `${Math.round(sh * 100)}%@${x}x`).join(' ')}`
          + `${ex.breakevenAfterFirst ? ', then breakeven' : ''}${ex.trailingPct ? `, trail ${ex.trailingPct}%` : ''}`
          + `, checks ${ex.checks.map(([m, x]) => `${m}m<${x}x`).join(' ') || 'none'}, core by ${hours}h${sellBy !== undefined ? ' (analyst sell-by)' : ''}`
          + (moon > 0 ? `; moonbag ${Math.round(moon * 100)}%: stop −${ex.moonbag.stopPct}%, trail ${ex.moonbag.trailingPct}% after ${ex.moonbag.armX}x, up to ${Math.round(ex.moonbag.maxHours / 24)}d` : '');
        return {
          ...base, chain: mChain, check, action: 'buy_token', sizeUsd: size.sizeUsd, estGasUsd: gas * 2,
          reasons: [...reasons, `buy $${size.sizeUsd} at ~$${px}`, exitText],
          exitPlan: {
            stopPrice: px * (1 - floorPct / 100), tp1Price: px * x1, tp1Share: s1, stopPct: floorPct, tpX: x1,
            trailingPct: ex.trailingPct, timeStopAtUtc: new Date(d.clock.now() + hours * 3600_000).toISOString(), hardTimeStop: true, timeStopMinGainPct: 0,
            tokenClass: pf.profile, breakevenAfterTp1: ex.breakevenAfterFirst, ladder: ex.ladder.map(([x, sh]) => [x, sh] as [number, number]), checks: ex.checks.map(([m, x]) => [m, x] as [number, number]),
            ...(moon > 0 ? { moonbagShare: moon, moonbagStopPct: ex.moonbag.stopPct, moonbagArmX: ex.moonbag.armX, moonbagTrailingPct: ex.moonbag.trailingPct, moonbagMaxHours: ex.moonbag.maxHours } : {}),
          },
        };
      }
      const ex = trust.careful ? { ...legacyExit(d.cfg), ...d.cfg.careful.exit } : legacyExit(d.cfg);
      const plan = memecoinPlan(ex, intent, !!ctx?.analyst);
      return {
        ...base, chain: mChain, check, action: 'buy_token', sizeUsd: size.sizeUsd, estGasUsd: gas * 2,
        reasons: [...reasons, `buy $${size.sizeUsd} at ~$${px}`, `exit: stop −${plan.stopPct}%, ${Math.round(plan.share * 100)}% at ${plan.tpX}x, ${plan.hard ? 'sell by' : 'time stop'} ${plan.hours}h`],
        exitPlan: {
          stopPrice: px * (1 - plan.stopPct / 100), tp1Price: px * plan.tpX, tp1Share: plan.share, stopPct: plan.stopPct, tpX: plan.tpX,
          trailingPct: ex.trailingStopPct, timeStopAtUtc: new Date(d.clock.now() + plan.hours * 3600_000).toISOString(), hardTimeStop: plan.hard,
        },
      };
    }
    case 'contract_call':
    case 'mint': {
      if (!intent.contractAddress) return { ...base, action: 'journal_only', reasons: [...reasons, 'no contract address'] };
      if (chain === 'unknown') return { ...base, action: 'skip', reasons: [...reasons, 'chain unclear from text'] };
      if (estGasUsd > d.risk.equityUsd * d.cfg.maxGasShareOfCapital) return { ...base, action: 'skip', estGasUsd, reasons: [...reasons, `missed: gas ~$${estGasUsd.toFixed(2)} > ${d.cfg.maxGasShareOfCapital * 100}% of capital $${d.risk.equityUsd.toFixed(2)}`] };
      // Mint price: only "N ETH" amounts that are in the text and are not a gas hint
      const gasVals = new Set([pre.gasHintEth?.min, pre.gasHintEth?.max].filter(v => v !== undefined));
      const priceCandidates = pre.ethAmounts.filter(v => !gasVals.has(v));
      const modelValue = intent.valueEth && pre.ethAmounts.includes(intent.valueEth) ? intent.valueEth : 0;
      const valueEth = nftMatch ? ctx!.nft!.priceEth : Math.max(modelValue, ...priceCandidates, 0);
      const valueUsd = valueEth * ethUsd;
      const cap = d.risk.bucketUsd * ({ follow: d.cfg.perActionShareByTier.follow, fast: d.cfg.perActionShareByTier.fast, full: d.cfg.perActionShareByTier.full } as Record<string, number>)[trust.tier];
      const capped = d.cfg.mintCapExcludesGas ? valueUsd : valueUsd + estGasUsd;
      if (capped > cap || valueUsd + estGasUsd > d.risk.cashUsd) return { ...base, chain, action: 'skip', estGasUsd, reasons: [...reasons, `mint cost $${(valueUsd + estGasUsd).toFixed(2)} (price $${valueUsd.toFixed(2)} + gas $${estGasUsd.toFixed(2)}) exceeds tier cap $${cap.toFixed(2)} or cash`] };
      return { ...base, chain, action: 'contract_call', sizeUsd: valueUsd, estGasUsd, reasons: [...reasons, `direct contract call via burner after simulation (mint price ${valueEth} ETH${nftMatch ? ', from OpenSea drop' : ''})`] };
    }
    case 'dapp_task': {
      const size = sizeAction(d.cfg, d.risk, { tier: trust.tier, chain, estGasUsd: estGasUsd * 3 });
      if (!size.ok) return { ...base, action: 'skip', estGasUsd: estGasUsd * 3, reasons: [...reasons, ...size.reasons] };
      return { ...base, action: 'dapp_session', sizeUsd: size.sizeUsd, estGasUsd: estGasUsd * 3, reasons: [...reasons, 'browser session with burner wallet through signing firewall'] };
    }
    case 'prediction_bet': {
      // Paper (the owner's decision 2026-10-23): live — only after the lawyer confirms. Prices — from the CLOB book.
      const m = ctx?.prediction;
      if (!m) return { ...base, chain: 'polygon', action: 'journal_only', reasons: [...reasons, 'prediction: market not in the dossier'] };
      const pb = { ...base, chain: 'polygon' as Chain };
      const o = m.outcomes.find(x => x.name.toLowerCase() === (intent.outcome ?? '').toLowerCase());
      if (!o) return { ...pb, action: 'skip', reasons: [...reasons, `prediction: outcome "${intent.outcome ?? '?'}" not in market ${m.slug}`] };
      if (m.closed || !m.active) return { ...pb, action: 'skip', reasons: [...reasons, 'prediction: market closed'] };
      const minsLeft = m.endUtc ? (utcMs(m.endUtc) - d.clock.now()) / 60_000 : Infinity;
      if (minsLeft < 30) return { ...pb, action: 'skip', reasons: [...reasons, `prediction: resolves in ${Math.round(minsLeft)} min — too late`] };
      if (!o.ask || o.ask <= 0.02 || o.ask >= 0.97) return { ...pb, action: 'skip', reasons: [...reasons, `prediction: no sane ask (${o.ask ?? 'none'})`] };
      if (o.bid !== undefined && o.ask - o.bid > 0.1) return { ...pb, action: 'skip', reasons: [...reasons, `prediction: spread ${(o.ask - o.bid).toFixed(2)} too wide`] };
      if (intent.limitPrice && o.ask > intent.limitPrice) return { ...pb, action: 'skip', reasons: [...reasons, `prediction: ask ${o.ask} above analyst limit ${intent.limitPrice}`] };
      const size = sizeAction(d.cfg, d.risk, { tier: trust.tier, chain: 'polygon', estGasUsd: 0 });
      if (!size.ok) return { ...pb, action: 'skip', reasons: [...reasons, ...size.reasons] };
      const shares = Math.floor((size.sizeUsd / (o.ask * (1 + m.feeRate * (1 - o.ask)))) * 100) / 100;
      if (shares < m.minOrderShares) return { ...pb, action: 'skip', reasons: [...reasons, `prediction: ${shares} shares < venue minimum ${m.minOrderShares} (need ~$${(m.minOrderShares * o.ask).toFixed(2)})`] };
      const fee = pmFee(shares, o.ask, m.feeRate);
      const sane = (v?: number) => (v !== undefined && v > 0 && v < 1 ? v : undefined);
      const stop = sane(intent.stopPrice) !== undefined && intent.stopPrice! < o.ask ? intent.stopPrice : undefined;
      const tp = sane(intent.takeProfitPrice) !== undefined && intent.takeProfitPrice! > o.ask ? intent.takeProfitPrice : undefined;
      const sellBy = intent.sellByHours ? new Date(d.clock.now() + Math.max(0.25, intent.sellByHours) * 3600_000).toISOString() : undefined;
      return { ...pb, action: 'prediction_buy', sizeUsd: Math.round((shares * o.ask + fee) * 100) / 100,
        reasons: [...reasons, `buy ${shares} × "${o.name}" at ${o.ask} (implied ${Math.round(o.ask * 100)}%), fee $${fee.toFixed(3)}; pays $${shares.toFixed(2)} if "${o.name}" wins${m.endUtc ? ` (ends ${m.endUtc.slice(0, 16)} UTC)` : ''}`],
        prediction: { slug: m.slug, question: m.question, outcome: o.name, tokenId: o.tokenId, price: o.ask, shares, feeRate: m.feeRate, endUtc: m.endUtc, stopPrice: stop, takeProfitPrice: tp, sellByUtc: sellBy } };
    }
    case 'nft_buy': {
      const n = ctx?.nftBuy;
      if (!n || !n.contract) return { ...base, action: 'journal_only', reasons: [...reasons, 'nft_buy: collection not in the dossier'] };
      const nb = { ...base, chain: n.chain };
      if (!n.floorEth) return { ...nb, action: 'skip', reasons: [...reasons, 'nft_buy: no floor listing'] };
      if (intent.maxPriceEth && n.floorEth > intent.maxPriceEth) return { ...nb, action: 'skip', reasons: [...reasons, `nft_buy: floor ${n.floorEth} ETH above limit ${intent.maxPriceEth}`] };
      const g = estimateGasUsd(n.chain, ethUsd, undefined, d.clock.now()) * 2; // buy + later sell
      const priceUsd = n.floorEth * ethUsd;
      const size = sizeAction(d.cfg, d.risk, { tier: trust.tier, chain: n.chain, estGasUsd: g });
      if (!size.ok) return { ...nb, action: 'skip', reasons: [...reasons, ...size.reasons] };
      if (priceUsd > size.sizeUsd) return { ...nb, action: 'skip', estGasUsd: g, reasons: [...reasons, `nft_buy: floor $${priceUsd.toFixed(2)} > allowed size $${size.sizeUsd}`] };
      return { ...nb, action: 'nft_buy', sizeUsd: Math.round(priceUsd * 100) / 100, estGasUsd: g, reasons: [...reasons, `buy 1 ${n.slug} at floor ${n.floorEth} ETH ($${priceUsd.toFixed(2)})`],
        nftBuy: { slug: n.slug, contract: n.contract, priceEth: n.floorEth, sellFeesPct: n.sellFeesPct, plan: { style: 'hold' } } };
    }
    case 'perp_trade': {
      // Perp: stop and take-profit are mandatory; size — from risk (loss at the stop ≤ riskPerTradeShare of capital), leverage is capped
      const P = d.cfg.perp;
      if (!intent.asset || !intent.side) return { ...base, action: 'journal_only', reasons: [...reasons, 'perp: asset or side not clear from text'] };
      if (!d.perp) return { ...base, action: 'journal_only', reasons: [...reasons, 'perp: no price source configured'] };
      if (d.risk.holds(`perp:${intent.asset}`)) return { ...base, action: 'journal_only', reasons: [...reasons, `perp: already in ${intent.asset}`] };
      const px = await d.perp.price(intent.asset).catch(() => undefined);
      if (!px) return { ...base, action: 'skip', reasons: [...reasons, `perp: no market for ${intent.asset}`] };
      const long = intent.side === 'long';
      // Stop from the verdict if it is on the correct side and within reasonable bounds; otherwise — the default stop
      let stop = intent.stopPrice; let stopPct = stop ? Math.abs(px - stop) / px * 100 : NaN;
      const stopOk = stop !== undefined && (long ? stop < px : stop > px) && stopPct >= P.minStopPct && stopPct <= P.maxStopPct;
      if (!stopOk) { stopPct = P.defaultStopPct; stop = long ? px * (1 - stopPct / 100) : px * (1 + stopPct / 100); reasons.push(`perp: default stop ${stopPct}%`); }
      let tp = intent.takeProfitPrice;
      const tpOk = tp !== undefined && (long ? tp > px : tp < px) && Math.abs(tp - px) / px * 100 >= stopPct;
      if (!tpOk) { tp = long ? px * (1 + stopPct * P.defaultRewardRisk / 100) : px * (1 - stopPct * P.defaultRewardRisk / 100); reasons.push(`perp: default take-profit ${P.defaultRewardRisk}R`); }
      // Leverage: from the call, but ≤ the maximum and such that liquidation is liqBuffer times further than the stop
      const levCap = Math.max(1, Math.floor(0.9 / (P.liqBuffer * stopPct / 100)));
      const lev = Math.max(1, Math.min(intent.leverage ?? P.defaultLeverage, P.maxLeverage, levCap));
      // Size: loss at the stop (with fees) ≤ capital share; margin ≤ tier cap and cash
      const riskUsd = d.risk.equityUsd * P.riskPerTradeShare;
      let notional = riskUsd / (stopPct / 100 + 2 * P.feePct / 100);
      const tierCap = d.risk.bucketUsd * ({ follow: d.cfg.perActionShareByTier.follow, fast: d.cfg.perActionShareByTier.fast, full: d.cfg.perActionShareByTier.full } as Record<string, number>)[trust.tier];
      notional = Math.min(notional, tierCap * lev, (d.risk.cashUsd - 0.01) * lev);
      notional = Math.floor(notional * 100) / 100;
      const margin = Math.round(notional / lev * 100) / 100;
      if (margin < d.cfg.minActionUsd / 2 || notional <= 0) return { ...base, action: 'skip', reasons: [...reasons, `perp: size too small (notional $${notional})`] };
      if (notional < P.venueMinNotionalUsd) reasons.push(`perp: notional $${notional} below venue minimum $${P.venueMinNotionalUsd} (ok in paper; live needs more capital)`);
      const halt2 = haltReason(d.cfg, d.risk);
      if (halt2) return { ...base, action: 'skip', reasons: [...reasons, halt2] };
      return { ...base, chain: 'unknown', action: 'open_perp', sizeUsd: margin,
        perp: { asset: intent.asset, side: intent.side, entry: px, notionalUsd: notional, leverage: lev, marginUsd: margin, stop: stop!, takeProfit: tp!, feePct: P.feePct },
        reasons: [...reasons, `perp ${intent.side} ${intent.asset} at ${px}: notional $${notional}, ${lev}x, margin $${margin}, stop ${stop!.toPrecision(6)} (−${stopPct.toFixed(2)}%), take ${tp!.toPrecision(6)}`] };
    }
    case 'social_task':
      // The agent does it itself via its X account (raffles, registrations); captcha/KYC and above go to the owner
      return { ...base, action: trust.tier === 'fast' || trust.tier === 'follow' || trust.tier === 'full' ? 'social_session' : 'journal_only', reasons: [...reasons, 'social task via agent X account'] };
    default:
      return { ...base, action: 'journal_only', reasons: [...reasons, 'no rule for this intent'] };
  }
}

/**
 * Memecoin exit plan. The Analyst can only TIGHTEN the stop (not wider than risk.json, not narrower than 5%),
 * set a take-profit (×1.05–×100, share 25–100%) and a sell-by time (≤ the default). Without the Analyst — risk.json values.
 * (The owner 2026-10-23: first trade SWARMX — the code did not apply the Analyst's plan "FDV below $80k, +40–60%, 4 h".)
 */
export function memecoinPlan(ex: { stopLossPct: number; takeProfit1x: number; takeProfit1Share: number; timeStopHours: number }, intent: Pick<Intent, 'stopLossPct' | 'takeProfitX' | 'takeProfitShare' | 'sellByHours'>, fromAnalyst: boolean) {
  const ok = (v: number | undefined) => fromAnalyst && typeof v === 'number' && Number.isFinite(v);
  const stopPct = ok(intent.stopLossPct) ? Math.min(ex.stopLossPct, Math.max(5, intent.stopLossPct!)) : ex.stopLossPct;
  const tpX = ok(intent.takeProfitX) && intent.takeProfitX! >= 1.05 ? Math.min(100, intent.takeProfitX!) : ex.takeProfit1x;
  const share = ok(intent.takeProfitShare) ? Math.min(1, Math.max(0.25, intent.takeProfitShare!)) : ex.takeProfit1Share;
  const hard = ok(intent.sellByHours) && intent.sellByHours! > 0;
  const hours = hard ? Math.min(ex.timeStopHours, Math.max(0.25, intent.sellByHours!)) : ex.timeStopHours;
  return { stopPct, tpX, share, hours, hard };
}
