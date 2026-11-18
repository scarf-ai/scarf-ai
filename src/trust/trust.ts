// Source trust scores (the owner's rules of 2026-10-22):
// 1. A score is set for a server, for each channel separately and for individual users.
// 2. User with a score → their score is used.
// 3. User without a score → 0. Exception: if the channel has a score > 6,
//    a user without a score gets the channel score.
// 4. A channel without its own score takes the server score.
// 5. The agent may LOWER a score itself based on the journal results; only the owner raises it (via CSV).
// 6. A message with signs of a compromised account is treated as score 1 regardless of the author.
import { readFileSync, existsSync } from 'node:fs';
import type { Tier, TrustResult } from '../types.js';

export type ChannelMode = 'opus' | 'chat' | 'ignore';

export interface TrustRow {
  level: 'server' | 'channel' | 'author';
  /** Channel mode: opus — Opus analyzes every message; chat — context-based gatekeeper; ignore — do not read. */
  mode?: ChannelMode;
  /** careful — unscored authors get the channel score even when it is ≤ 6, but with careful checks (team channels). */
  inherit?: 'careful';
  server: string;
  channel: string;
  author: string;
  score: number;
  note: string;
}

const norm = (s: string | undefined) => (s ?? '').trim().replace(/^#/, '').toLowerCase();

/** Minimal CSV parser with quote and BOM support. The delimiter is detected from the header (',' or ';'). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

export function parseTrustCsv(text: string): { rows: TrustRow[]; errors: string[] } {
  const all = parseCsv(text);
  const errors: string[] = [];
  if (!all.length) return { rows: [], errors: ['empty file'] };
  const header = all[0].map(norm);
  const idx = (k: string) => header.indexOf(k);
  for (const k of ['level', 'server', 'channel', 'author', 'score']) if (idx(k) < 0) errors.push(`missing column ${k}`);
  if (errors.length) return { rows: [], errors };
  const rows: TrustRow[] = [];
  all.slice(1).forEach((r, i) => {
    const level = norm(r[idx('level')]) as TrustRow['level'];
    const scoreRaw = (r[idx('score')] ?? '').trim();
    if (!['server', 'channel', 'author'].includes(level)) { errors.push(`row ${i + 2}: bad level "${r[idx('level')]}"`); return; }
    const inheritRaw = idx('inherit') >= 0 ? norm(r[idx('inherit')]) : '';
    if (inheritRaw && inheritRaw !== 'careful') { errors.push(`row ${i + 2}: inherit must be empty or careful`); return; }
    const modeOnly = idx('mode') >= 0 ? norm(r[idx('mode')]) : '';
    if (scoreRaw === '' && level === 'channel' && modeOnly) {
      if (!['opus', 'chat', 'ignore'].includes(modeOnly)) { errors.push(`row ${i + 2}: mode must be opus/chat/ignore`); return; }
      rows.push({ level, server: norm(r[idx('server')]), channel: norm(r[idx('channel')]), author: '', score: -1, note: '', mode: modeOnly as ChannelMode });
      return;
    }
    if (scoreRaw === '') return; // empty score = template row, skip
    const score = Number(scoreRaw.replace(',', '.'));
    if (!Number.isFinite(score) || score < 0 || score > 10) { errors.push(`row ${i + 2}: score must be 0..10`); return; }
    const modeRaw = idx('mode') >= 0 ? norm(r[idx('mode')]) : '';
    if (modeRaw && !['opus', 'chat', 'ignore'].includes(modeRaw)) { errors.push(`row ${i + 2}: mode must be opus/chat/ignore`); return; }
    rows.push({ level, server: norm(r[idx('server')]), channel: norm(r[idx('channel')]), author: norm(r[idx('author')]),
      score: Math.round(score), note: idx('note') >= 0 ? (r[idx('note')] ?? '').trim() : '', mode: (modeRaw || undefined) as ChannelMode | undefined,
      inherit: inheritRaw === 'careful' && level === 'channel' ? 'careful' : undefined });
  });
  return { rows, errors };
}

export function tierFor(score: number): Tier {
  if (score >= 10) return 'follow';
  if (score >= 7) return 'fast';
  if (score >= 4) return 'full';
  return 'journal';
}

export class TrustTable {
  private serverScore = new Map<string, number>();
  private channelScore = new Map<string, number>();
  private authorScore = new Map<string, number>(); // key server|author, server may be '*'
  /** Automatic downgrades (negative only). Key — same as the author's, or channel:server|channel. */
  private downgrades = new Map<string, number>();
  private modes = new Map<string, ChannelMode>();
  private careful = new Set<string>();

  constructor(rows: TrustRow[] = []) {
    for (const r of rows) {
      if (r.level === 'channel' && r.mode) this.modes.set(`${r.server}|${r.channel}`, r.mode);
      if (r.score < 0) continue; // mode-only row
      if (r.level === 'server') this.serverScore.set(r.server, r.score);
      else if (r.level === 'channel') { this.channelScore.set(`${r.server}|${r.channel}`, r.score); if (r.inherit === 'careful') this.careful.add(`${r.server}|${r.channel}`); }
      else this.authorScore.set(`${r.server || '*'}|${r.author}`, r.score);
    }
  }

  static fromFile(path: string): { table: TrustTable; errors: string[] } {
    if (!existsSync(path)) return { table: new TrustTable(), errors: [`trust file not found: ${path} — all sources get 0`] };
    const { rows, errors } = parseTrustCsv(readFileSync(path, 'utf8'));
    return { table: new TrustTable(rows), errors };
  }

  /** Score downgrade by the agent. Raising is not possible this way — only via CSV from the owner. */
  downgrade(key: string, by: number) {
    if (!(by > 0)) throw new Error('downgrade amount must be positive');
    this.downgrades.set(key, (this.downgrades.get(key) ?? 0) - by);
  }
  restoreDowngrades(entries: [string, number][]) { for (const [k, v] of entries) if (v < 0) this.downgrades.set(k, v); }
  downgradeEntries() { return [...this.downgrades.entries()]; }

  /**
   * Channel mode. If not set in the table: channels with "chat" in the name and "success" — chat,
   * the rest — opus (alpha, calls, degen, member-calls…).
   */
  channelMode(server: string, channel: string): ChannelMode {
    const m = this.modes.get(`${norm(server)}|${norm(channel)}`);
    if (m) return m;
    const c = norm(channel);
    return /chat|general|success|wins|memes?|off-?topic/.test(c) ? 'chat' : 'opus';
  }

  channelScoreOf(server: string, channel: string): number | undefined {
    const s = norm(server), c = norm(channel);
    return this.channelScore.get(`${s}|${c}`) ?? this.serverScore.get(s);
  }

  /** Key under which the author's score is stored (and downgraded). */
  authorKeyOf(server: string, author: string): string {
    const s = norm(server), a = norm(author);
    return this.authorScore.has(`${s}|${a}`) ? `${s}|${a}` : this.authorScore.has(`*|${a}`) ? `*|${a}` : `${s}|${a}`;
  }
  channelKeyOf(server: string, channel: string) { return `channel:${norm(server)}|${norm(channel)}`; }

  resolve(server: string, channel: string, author: string, opts: { compromisedSigns?: string[] } = {}): TrustResult {
    const s = norm(server), c = norm(channel), a = norm(author);
    const notes: string[] = [];
    const authorKey = this.authorScore.has(`${s}|${a}`) ? `${s}|${a}` : this.authorScore.has(`*|${a}`) ? `*|${a}` : undefined;
    // Effective channel score: channel downgrade first, then comparison with the > 6 threshold
    const chRaw = this.channelScoreOf(s, c);
    const chDown = this.downgrades.get(this.channelKeyOf(s, c)) ?? 0;
    const ch = chRaw === undefined ? undefined : Math.max(0, chRaw + chDown);
    let score: number; let basis: TrustResult['basis'];
    let downgradedBy = 0;
    if (authorKey) {
      const aDown = this.downgrades.get(authorKey) ?? 0;
      score = Math.max(0, this.authorScore.get(authorKey)! + aDown); basis = 'author'; downgradedBy = aDown;
      notes.push(`author score ${this.authorScore.get(authorKey)}${aDown ? ` (auto-downgrade ${aDown})` : ''}`);
    } else if (ch !== undefined && ch > 6) {
      const aDown = this.downgrades.get(`${s}|${a}`) ?? 0;
      score = Math.max(0, ch + aDown); basis = 'channel_inherit'; downgradedBy = chDown + aDown;
      notes.push(`unscored author inherits channel score ${ch}${chDown ? ` (channel auto-downgrade ${chDown})` : ''}`);
    } else if (ch !== undefined && ch >= 4 && this.careful.has(`${s}|${c}`)) {
      // Team channel with score 4–6: an unscored author gets the channel score, but trades only with careful checks
      const aDown = this.downgrades.get(`${s}|${a}`) ?? 0;
      score = Math.max(0, ch + aDown); basis = 'channel_careful'; downgradedBy = chDown + aDown;
      notes.push(`team channel ${ch}: unscored author inherits it with careful checks`);
    } else { score = 0; basis = 'default_zero'; notes.push(`unscored author in channel ${ch ?? 'unscored'} → 0`); }

    if (opts.compromisedSigns?.length) {
      score = Math.min(score, 1);
      notes.push(`possible compromised account: ${opts.compromisedSigns.join('; ')} → capped at 1`);
    }
    return { score, tier: tierFor(score), basis, downgradedBy: downgradedBy || undefined, notes, careful: basis === 'channel_careful' && score >= 4 ? true : undefined };
  }
}
