// Cards for X posts: HTML template with {{…}} fields → satori-html (tree) → images into the tree → satori (SVG) → resvg (PNG).
// The order follows brand/cards/README-PIPELINE.md (Brand, 2026-10-24):
//  1) images are inserted AFTER parsing the HTML (base64 in the string → ~48 s per card, after parsing — 0.3 s);
//  2) at service start one card is rendered idle (cold start ~16 s);
//  3) name/handle come from brand/brand.json, code computes numbers and colors (fields below).
// Templates: brand/cards/<kind>.html from Brand; until a kind has a template — the shared src/posts/templates/event.html in the same style.
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { html as toVdom } from 'satori-html';
import { Resvg } from '@resvg/resvg-js';
import { BRAND } from '../brand.js';

export type Mood = 'neutral' | 'win' | 'loss' | 'thinking' | 'skip' | 'minting' | 'waiting' | 'halt' | 'celebrate';
export type CardData = Record<string, string | number | boolean | undefined>;
/** Template: pnl — the approved closed-trade card; the others — Brand's own file or the shared event. */
export type CardTemplate = 'pnl' | 'thought' | 'entry' | 'nft_mint' | 'nft_buy' | 'prediction' | 'passed' | 'raffle';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const truthy = (v: unknown) => !!v && v !== 'false';

/** Brand's template language: {{x}} (escaped), {{#if x}}…{{else}}…{{/if}} (expanded inside out, works in style). */
export function fillTemplate(tpl: string, data: CardData): string {
  let out = tpl.replace(/<!--[\s\S]*?-->/g, '');
  const re = /\{\{#if (\w+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/;
  for (let m = out.match(re), guard = 0; m && guard < 500; m = out.match(re), guard++) {
    const [all, key, body] = m;
    const [yes, no = ''] = body.split('{{else}}');
    out = out.replace(all, () => (truthy(data[key]) ? yes : no));
  }
  return out.replace(/\{\{(\w+)\}\}/g, (_, k) => esc(String(data[k] ?? '')));
}

// ---------------- Numbers and labels (README-PIPELINE rules §3) ----------------
const SUB = '₀₁₂₃₄₅₆₇₈₉';
/** ≥1 → 2 digits; ≥0.01 → up to 4 digits; up to 4 zeros after the point — as is (0.0000642); more — 0.0₅123. */
export function fmtPrice(p?: number): string {
  if (p === undefined || !Number.isFinite(p)) return '—';
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (p <= 0) return '0';
  const s = p.toFixed(20).slice(2);
  const zeros = s.match(/^0*/)![0].length;
  const sig = s.slice(zeros, zeros + 3).replace(/0+$/, '') || '0';
  if (zeros <= 4) return `0.${'0'.repeat(zeros)}${sig}`;
  return `0.0${String(zeros).split('').map(d => SUB[Number(d)]).join('')}${sig}`;
}
/** Money with a real minus (U+2212): +$1.86 / −$0.54. */
export const fmtUsd = (v?: number, sign = false) => (v === undefined || !Number.isFinite(v) ? '—' : `${sign ? (v >= 0 ? '+' : '−') : v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`);
export const fmtPct = (v?: number) => (v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`);
/** How long it was held: 51m, 3h 12m, 2d 4h. */
export function fmtHeld(min?: number): string {
  if (min === undefined || !Number.isFinite(min)) return '—';
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
/** Ticker size: satori cannot "fit to width". */
export const tickerSize = (t: string) => (t.length <= 8 ? 120 : t.length <= 11 ? 100 : t.length <= 14 ? 80 : 64);
/** Trim at a word with "…" (a Polymarket question longer than 120 chars; the full text stays in the log). */
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}
/** The exit reason — short, for the EXIT field. */
export function exitReasonLabel(r?: string): string {
  const s = (r ?? '').toLowerCase();
  if (/stop-loss|stop hit|stop floor/.test(s)) return 'Stop hit';
  if (/trailing/.test(s)) return 'Trailing stop';
  if (/take-profit|target/.test(s)) return 'Take profit';
  if (/sell-by|time stop|time exit|deadline/.test(s)) return 'Time exit';
  if (/analyst|warning|thesis/.test(s)) return 'Thesis broke';
  if (/resolved/.test(s)) return 'Resolved';
  if (/halt|manual/.test(s)) return 'Manual';
  return r ? clip(r.replace(/ at [\d.e-]+$/i, ''), 16) : '—';
}
/** Down to n evenly spaced points (the first and last are kept). */
export function downsample(points: number[], n = 30): number[] {
  const p = points.filter(v => Number.isFinite(v) && v > 0);
  if (p.length <= n) return p;
  return Array.from({ length: n }, (_, i) => p[Math.round((i * (p.length - 1)) / (n - 1))]);
}

/** A mini price chart for the PnL card: points → SVG data URI (the same drawing as Brand's miniChart). */
export function miniChart(points: number[], o: { w: number; h: number; line: string; fill?: string; dot?: string; dotStroke?: string; baseline?: string; strokeW?: number }): string {
  const pts = points.length >= 2 ? points : [points[0] ?? 1, points[0] ?? 1];
  const { w, h, line, fill = 'none', dot = line, dotStroke = '#000', baseline, strokeW = 5 } = o;
  const pad = 14;
  const min = Math.min(...pts), max = Math.max(...pts);
  const X = (i: number) => pad + (i * (w - 2 * pad)) / (pts.length - 1);
  const Y = (v: number) => pad + (h - 2 * pad) * (1 - (v - min) / (max - min || 1));
  const d = pts.map((v, i) => `${i ? 'L' : 'M'} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  const area = `${d} L ${X(pts.length - 1)} ${h} L ${X(0)} ${h} Z`;
  const base = baseline ? `<line x1="${pad}" x2="${w - pad}" y1="${Y(pts[0])}" y2="${Y(pts[0])}" stroke="${baseline}" stroke-width="2" stroke-dasharray="8 8"/>` : '';
  const dotAt = (i: number, r: number) => `<circle cx="${X(i)}" cy="${Y(pts[i])}" r="${r}" fill="${dot}" stroke="${dotStroke}" stroke-width="4"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${fill !== 'none' ? `<path d="${area}" fill="${fill}"/>` : ''}${base}<path d="${d}" fill="none" stroke="${line}" stroke-width="${strokeW}" stroke-linejoin="round" stroke-linecap="round"/>${dotAt(0, 9)}${dotAt(pts.length - 1, 11)}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ---------------- Renderer ----------------
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
/** Brand fonts: one file per style (OFL). */
const FONTS: [string, number, string][] = [
  ['JetBrains Mono', 400, 'JetBrainsMono-Regular.ttf'], ['JetBrains Mono', 500, 'JetBrainsMono-Medium.ttf'], ['JetBrains Mono', 700, 'JetBrainsMono-Bold.ttf'],
  ['Space Grotesk', 500, 'SpaceGrotesk-Medium.ttf'], ['Space Grotesk', 700, 'SpaceGrotesk-Bold.ttf'],
  ['Archivo', 900, 'Archivo-Black.ttf'],
];
const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

export interface CardRenderer {
  render(template: CardTemplate, data: CardData): Promise<Buffer>;
  /** Idle render at startup: the first card after a cold start takes ~16 s. Returns ms. */
  warmup(): Promise<number>;
}

/** brandDir = brand/cards: templates, assets/, fonts/. */
export function cardRenderer(brandDir: string): CardRenderer {
  const fontDir = join(brandDir, 'fonts');
  const fonts = FONTS.filter(([, , f]) => existsSync(join(fontDir, f)))
    .map(([name, weight, f]) => ({ name, weight: weight as 400 | 500 | 700 | 900, style: 'normal' as const, data: readFileSync(join(fontDir, f)) }));
  if (!fonts.length) throw new Error(`card fonts not found in ${fontDir}`);
  const assetDir = join(brandDir, 'assets');
  const assetCache = new Map<string, string>();
  const asset = (name: string): string => {
    const n = basename(name);
    if (!assetCache.has(n)) {
      const p = join(assetDir, n);
      assetCache.set(n, existsSync(p) ? `data:${MIME[extname(p).toLowerCase()] ?? 'image/png'};base64,${readFileSync(p).toString('base64')}` : '');
    }
    return assetCache.get(n)!;
  };
  const tplCache = new Map<string, string>();
  const template = (t: CardTemplate): string => {
    const hit = tplCache.get(t);
    if (hit) return hit;
    const own = join(brandDir, `${t}.html`);
    const src = existsSync(own) ? own : join(BUILTIN_DIR, 'event.html');
    const s = readFileSync(src, 'utf8');
    tplCache.set(t, s);
    return s;
  };
  const inject = (node: any, data: CardData) => {
    if (!node || typeof node !== 'object') return;
    const props = node.props ?? {};
    if (node.type === 'img' && typeof props.src === 'string') {
      if (props.src.startsWith('field:')) props.src = String(data[props.src.slice(6)] ?? '');
      if (props.src.startsWith('asset:')) props.src = asset(props.src.slice(6));
    }
    const ch = props.children;
    if (Array.isArray(ch)) ch.forEach(c => inject(c, data)); else inject(ch, data);
  };
  const render = async (t: CardTemplate, data: CardData) => {
    const full: CardData = { brand_name: BRAND.name, brand_handle: BRAND.handle, ...data };
    // Pose: pose-<mood>.png if Brand has delivered it, otherwise neutral
    if (!full.pose_src) full.pose_src = `asset:pose-${data.mood && asset(`pose-${data.mood}.png`) ? data.mood : 'neutral'}.png`;
    const tree = toVdom(fillTemplate(template(t), full));
    inject(tree, full);
    const svg = await satori(tree as any, { width: 1600, height: 900, fonts });
    return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 1600 } }).render().asPng());
  };
  return {
    render,
    async warmup() {
      const t0 = performance.now();
      await render('pnl', cardFor(SAMPLE_EXIT).data);
      return Math.round(performance.now() - t0);
    },
  };
}

// ---------------- Card data per event ----------------
export interface CardEvent {
  kind: string; asset: string; chain: string; paper: boolean; nowIso: string; holding?: boolean;
  sizeUsd?: number; sizeOutUsd?: number; pnlUsd?: number; pnlPct?: number; plan?: string; note?: string;
  entryPrice?: number; exitPrice?: number; holdMinutes?: number; reason?: string; points?: number[];
  /** The thought's verdict: watch — watching. */
  verdict?: string;
}

const C = { profit: '#7CF2C9', loss: '#FF7A6B', bg: '#0A0F1C', baseline: '#3A4A68', ...BRAND.colors };
const CHAIN_NAMES: Record<string, string> = { robinhood: 'Robinhood Chain', solana: 'Solana', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', bsc: 'BNB Chain', polygon: 'Polygon', perps: 'Perps', polymarket: 'Polymarket' };
export const chainName = (c: string) => CHAIN_NAMES[c.toLowerCase()] ?? c;
const utc = (iso: string) => ({ date_utc: iso.slice(0, 10), time_utc: `${iso.slice(11, 16)} UTC` });
const quoteSize = (s: string) => (s.length <= 110 ? 46 : s.length <= 170 ? 40 : 34);

export function cardFor(e: CardEvent): { template: CardTemplate; data: CardData } {
  const win = (e.pnlUsd ?? 0) >= 0;
  const position_line = e.holding ? 'I hold this' : 'No position now';
  const mode = { paper: e.paper, live: !e.paper };
  const base = { ...utc(e.nowIso), chain: chainName(e.chain), position_line };
  const title = (t: string) => (t.length > 16 ? { title: clip(t, 120), title_long: true } : { title: t, ticker_size: tickerSize(t) });
  const note = e.note ? clip(e.note, 230) : undefined;

  // A closed trade with prices — the approved PnL card
  if (e.kind === 'exit' && e.entryPrice && e.exitPrice) {
    const ticker = e.asset.length > 14 ? clip(e.asset, 14) : e.asset;
    const pts = downsample(e.points?.length ? e.points : [e.entryPrice, e.exitPrice]);
    const line = win ? C.profit : C.loss;
    const opened = e.holdMinutes !== undefined ? new Date(Date.parse(e.nowIso) - e.holdMinutes * 60_000).toISOString() : undefined;
    return { template: 'pnl', data: {
      ...mode, mood: win ? ((e.pnlPct ?? 0) >= 100 ? 'celebrate' : 'win') : 'loss',
      chain: chainName(e.chain), ticker, ticker_size: tickerSize(ticker),
      pnl_usd: fmtUsd(e.pnlUsd, true), pnl_pct: fmtPct(e.pnlPct), is_win: win, arrow: win ? '▲' : '▼', result_word: win ? 'PROFIT' : 'LOSS',
      size_in: fmtUsd(e.sizeUsd), size_out: fmtUsd(e.sizeOutUsd ?? (e.sizeUsd !== undefined && e.pnlUsd !== undefined ? e.sizeUsd + e.pnlUsd : undefined)),
      entry_price: fmtPrice(e.entryPrice), exit_price: fmtPrice(e.exitPrice), held: fmtHeld(e.holdMinutes), exit_reason: exitReasonLabel(e.reason),
      date_utc: e.nowIso.slice(0, 10), time_range: opened && opened.slice(0, 10) === e.nowIso.slice(0, 10) ? `${opened.slice(11, 16)} → ${e.nowIso.slice(11, 16)} UTC` : `${e.nowIso.slice(11, 16)} UTC`,
      position_line,
      chart_src: miniChart(pts, { w: 816, h: 126, line, fill: win ? 'rgba(124,242,201,0.10)' : 'rgba(255,122,107,0.10)', dot: line, dotStroke: C.bg, baseline: C.baseline }),
    } };
  }
  const stats = (...s: ([string, string | undefined] | undefined)[]) => {
    const out: CardData = {};
    s.filter((x): x is [string, string] => !!x && !!x[1]).slice(0, 3).forEach(([l, v], i) => { out[`stat${i + 1}_label`] = l; out[`stat${i + 1}_value`] = v; });
    return out;
  };
  switch (e.kind) {
    case 'thought': return { template: 'thought', data: { ...base, position_line: '', ...title(e.asset), chip: e.holding ? 'IN POSITION' : 'NO POSITION', label_ice: true,
      event_label: e.verdict === 'act' ? 'ON MY LIST' : 'WATCHING', mood: 'thinking', quote: note, quote_size: note ? quoteSize(note) : 46 } };
    case 'entry': return { template: 'entry', data: { ...base, ...mode, ...title(e.asset), event_label: 'ENTRY', mood: 'thinking', quote: note, quote_size: note ? quoteSize(note) : 40,
      ...stats(['SIZE', fmtUsd(e.sizeUsd)], ['ENTRY', e.entryPrice ? fmtPrice(e.entryPrice) : undefined], ['PLAN', e.plan ? clip(e.plan, 16) : undefined]) } };
    case 'nft_mint': case 'nft_buy': return { template: e.kind, data: { ...base, ...mode, ...title(e.asset), event_label: e.kind === 'nft_mint' ? 'NFT MINT' : 'NFT BUY', mood: 'minting', quote: note, quote_size: note ? quoteSize(note) : 40,
      ...stats(['ALL-IN', fmtUsd(e.sizeUsd)], ['PLAN', e.plan ? clip(e.plan, 16) : undefined]) } };
    case 'prediction': return { template: 'prediction', data: { ...base, ...mode, title: clip(e.asset, 120), title_long: true, event_label: 'PREDICTION', mood: 'waiting',
      ...stats(['STAKE', fmtUsd(e.sizeUsd)], ['PICK', e.plan ? clip(e.plan, 16) : undefined]) } };
    case 'prediction_exit': return { template: 'prediction', data: { ...base, ...mode, title: clip(e.asset, 120), title_long: true, event_label: 'PREDICTION CLOSED', mood: win ? 'win' : 'loss',
      big: fmtUsd(e.pnlUsd, true), big2: fmtPct(e.pnlPct), is_win: win, arrow: win ? '▲' : '▼', ...stats(['RESULT', e.plan ? clip(e.plan, 18) : undefined]) } };
    case 'exit': return exitWithoutPrices(e);
    case 'raffle': return { template: 'raffle', data: { ...base, ...title(e.asset), chip: 'REGISTERED', event_label: 'RAFFLE', mood: 'waiting', quote: note, quote_size: note ? quoteSize(note) : 40 } };
    case 'skip_review': return { template: 'passed', data: { ...base, position_line: '', ...title(e.asset), chip: 'PASSED', event_label: 'PASSED · 24H LATER', mood: 'skip', quote: note, quote_size: note ? quoteSize(note) : 40 } };
    default: return { template: 'thought', data: { ...base, ...title(e.asset), event_label: e.kind.toUpperCase(), mood: 'neutral', quote: note } };
  }
}

/** A close without prices (NFT, perps without points): a card with a large result. */
function exitWithoutPrices(e: CardEvent): { template: CardTemplate; data: CardData } {
  const win = (e.pnlUsd ?? 0) >= 0;
  return { template: 'entry', data: { ...utc(e.nowIso), chain: chainName(e.chain), position_line: e.holding ? 'I hold this' : 'No position now', paper: e.paper, live: !e.paper,
    title: e.asset.length > 16 ? clip(e.asset, 120) : e.asset, title_long: e.asset.length > 16, ticker_size: tickerSize(e.asset),
    event_label: 'TRADE CLOSED', mood: win ? 'win' : 'loss', big: fmtUsd(e.pnlUsd, true), big2: fmtPct(e.pnlPct), is_win: win, arrow: win ? '▲' : '▼',
    stat1_label: 'HELD', stat1_value: fmtHeld(e.holdMinutes), stat2_label: 'EXIT', stat2_value: exitReasonLabel(e.reason) } };
}
const SAMPLE_EXIT: CardEvent = { kind: 'exit', asset: '$WARMUP', chain: 'robinhood', paper: true, nowIso: '2026-10-24T00:51:00.000Z', sizeUsd: 1.25, pnlUsd: -0.54, pnlPct: -43.2,
  entryPrice: 0.00011, exitPrice: 0.0000642, holdMinutes: 51, reason: 'stop-loss', points: [100, 104, 112, 118, 109, 96, 88, 79, 71, 66, 61, 58, 57] };
