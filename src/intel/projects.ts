// Project cards: merge different keys of one project (address + ticker + domain + X),
// store mentions and the analyst's last verdict. Merging happens only when the message has
// at most one address/collection, one ticker and one domain — otherwise two different
// projects from one message would stick together.
import type { Store } from '../store/db.js';
import type { Entity } from './entities.js';
import { isStrong, splitBlocks } from './entities.js';

export class ProjectCards {
  constructor(private store: Store) {}

  /** Records mentions and returns the ids of the projects the message belongs to. */
  /**
   * text — the source text: entities are grouped by message blocks (two projects separated by a blank line
   * or "=====" are not merged). Within a block, merging only if it has one address/collection, one ticker, one domain.
   */
  observe(entities: Entity[], m: { server: string; channel: string; author: string; tsUtc: string; id: string }, kind = 'mention', text?: string, record = true, trustScore = 10): number[] {
    if (!entities.length) return [];
    if (record) this.record(entities, m, kind);
    const groups: Entity[][] = [];
    const blocks = text ? splitBlocks(text) : [];
    const placed = new Set<string>();
    const blockOf = (b: string) => entities.filter(e => !placed.has(e.key) && (b.includes(e.display) || b.toLowerCase().includes(e.display.toLowerCase().replace(/^[@$]/, ''))));
    for (const b of blocks.length > 1 ? blocks : [text ?? '']) {
      const ents = blocks.length > 1 ? blockOf(b) : entities.filter(e => !placed.has(e.key));
      if (!ents.length) continue;
      ents.forEach(e => placed.add(e.key));
      const strong = ents.filter(isStrong), tickers = ents.filter(e => e.kind === 'ticker'), domains = ents.filter(e => e.kind === 'domain');
      const single = strong.length <= 1 && tickers.length <= 1 && domains.length <= 1;
      // Only a source with score ≥ 4 may merge keys into one project: otherwise anyone could "stitch"
      // someone else's collection/address onto a known project's card
      if (single && trustScore >= 4) groups.push(ents); else ents.forEach(e => groups.push([e]));
    }
    for (const e of entities) if (!placed.has(e.key)) groups.push([e]);
    const ids: number[] = [];
    for (const g of groups) {
      const keys = g.map(e => e.key);
      const found = this.store.projectIdsForKeys(keys).sort((a, b) => a - b);
      let id: number;
      if (!found.length) id = this.store.createProject(g.find(isStrong)?.display ?? g[0].display, m.tsUtc);
      else { id = found[0]; for (const other of found.slice(1)) this.store.mergeProjects(id, other); }
      this.store.linkKeys(id, keys);
      this.store.touchProject(id, m.tsUtc);
      ids.push(id);
    }
    // A merge may have removed an id found earlier: recompute by keys
    return this.store.projectIdsForKeys(entities.map(e => e.key)).sort((a, b) => a - b);
  }

  /** Records mentions (before counting "buzz", so the current message counts too). */
  record(entities: Entity[], m: { server: string; channel: string; author: string; tsUtc: string; id: string }, kind = 'mention') {
    for (const e of entities) this.store.addMention(e.key, m, kind);
  }

  card(id: number) {
    const p = this.store.project(id);
    if (!p) return undefined;
    return { id, name: p.name as string, category: p.category as string | null, firstSeen: p.first_seen as string, lastSeen: p.last_seen as string,
      lastVerdict: p.last_verdict as string | null, lastAnalysisUtc: p.last_analysis_utc as string | null, lastThesis: p.last_thesis as string | null,
      scores: p.scores ? JSON.parse(p.scores) : null, analyzedKeys: p.analyzed_keys ? JSON.parse(p.analyzed_keys) as string[] : [],
      lastTrust: p.last_trust as number | null, keys: this.store.projectKeys(id) };
  }
}
