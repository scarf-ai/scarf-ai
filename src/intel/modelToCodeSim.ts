// A-12 (#83): how many review-log analyses each "code instead of model" rule would have closed (docs/ANALYST-LAYER.md, section 10).
// Reads the log only, agent behaviour does not change:
//   npx tsx src/intel/modelToCodeSim.ts server/data/review/review-<period>.jsonl
import { readFileSync } from 'node:fs';
import { codeEntities, isStrong } from './entities.js';
import { prefilter } from '../extract/prefilter.js';

if (!process.argv[2]) { console.error('Usage: npx tsx src/intel/modelToCodeSim.ts <review-*.jsonl>'); process.exit(1); }
const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const an = rows.filter((r: any) => r.kind === 'analysis');
const t0 = Date.parse(an[0].ts), t1 = Date.parse(an[an.length - 1].ts);
const days = (t1 - t0) / 86400_000;
const TRADABLE = new Set(['solana', 'robinhood', 'base', 'arbitrum', 'bsc', 'ethereum']);
const isBotCard = (t: string) => /\b(FDV|MC)\b\s*:?/.test(t) && /(dexscreener\.com|pump\.fun|t\.me\/rick|flap\.sh|birdeye\.so|gmgn\.ai)/i.test(t);
const count: Record<string, { n: number; models: Record<string, number>; verdicts: Record<string, number>; ex: string[] }> = {};
const hit = (k: string, r: any, ex: string) => {
  const c = (count[k] ??= { n: 0, models: {}, verdicts: {}, ex: [] });
  c.n++; const m = String(r.model).replace('claude-', '').replace(/-5-5$/, ''); c.models[m] = (c.models[m] ?? 0) + 1;
  const v = r.error ? 'error' : (r.verdict?.verdict ?? '?'); c.verdicts[v] = (c.verdicts[v] ?? 0) + 1;
  if (c.ex.length < 3) c.ex.push(ex.slice(0, 90));
};
for (const r of an) {
  const msg = String(r.case ?? '').match(/THE MESSAGE:\n<DATA_\w+>\n([\s\S]*?)\n<\/DATA_/)?.[1];
  const dosRaw = String(r.case ?? '').match(/Dossier \(fetched by code[^\n]*\n<DATA_\w+>\n([\s\S]*?)\n<\/DATA_/)?.[1] ?? '';
  let dos: any = {}; try { dos = JSON.parse(dosRaw); } catch { /* truncated */ }
  const trig = String(r.trigger ?? '');
  if (msg === undefined) { hit('batch (no single message)', r, String(r.source)); continue; }
  const pre = prefilter(msg);
  const ents = codeEntities(msg, pre);
  // 1. Only tokens on a chain we do not trade, and nothing else (mint, site, task)
  const toks = (dos.tokens ?? []) as any[];
  const chains = toks.map(t => t.market?.chain ?? t.chain).filter(Boolean);
  const other = ents.filter(e => !['evm', 'sol', 'ticker', 'x'].includes(e.kind));
  if (chains.length && chains.every((c: string) => c !== 'unknown' && !TRADABLE.has(c)) && !other.length && !(dos.nft ?? []).length) hit('1 untradable chain only', r, `${chains.join(',')} ${msg}`);
  // 2. NFT sold out / no public stage and the mint is not live
  for (const n of (dos.nft ?? []) as any[]) {
    const soldOut = n.maxSupply && n.minted >= n.maxSupply;
    if (soldOut) { hit('2 NFT sold out (OpenSea)', r, `${n.slug} ${n.minted}/${n.maxSupply} ${trig}`); break; }
  }
  // 3. The message has no entity at all (address, link, ticker, @, domain)
  const perpish = !!dos.perps || /\b(long|short|perp|leverage|lev|x\d+|\d+x)\b/i.test(msg);
  if (!ents.length && !pre.urls.length && !perpish) hit(`3 no entities in the message${trig.startsWith('scheduled_recheck') ? ' (recheck)' : ''}`, r, msg);
  // 4. A bot card — code reads the structure
  if (isBotCard(msg)) hit('4 scanner-bot card (parse by code)', r, `${r.source}`);
  // 5. A fresh pool with tiny liquidity (risk rule)
  const fresh = toks.find(t => (t.market?.pairAgeMinutes ?? 1e9) <= 10 && (t.market?.liquidityUsd ?? 1e12) < 15_000);
  if (fresh) hit('5 pool ≤ 10 min and liquidity < $15K (risk rule)', r, `${fresh.market.liquidityUsd} ${fresh.market.pairAgeMinutes}min`);
  // 6. Only perps on non-crypto assets (stocks etc.) — by tickers without a token: approximate
  if (!toks.length && !ents.some(isStrong) && /\b(stock|shares|nasdaq|nyse|earnings)\b/i.test(msg)) hit('6 non-crypto asset talk (stocks)', r, msg);
}
console.log(`window ${an[0].ts} … ${an[an.length - 1].ts} = ${days.toFixed(1)} days, analyses ${an.length}`);
for (const [k, c] of Object.entries(count).sort()) console.log(`${k}: ${c.n} (${(c.n / days).toFixed(1)}/day) models ${JSON.stringify(c.models)} verdicts ${JSON.stringify(c.verdicts)}\n   e.g. ${c.ex.map(x => JSON.stringify(x)).join(' | ')}`);
