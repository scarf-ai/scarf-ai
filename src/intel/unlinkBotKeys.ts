// Breaking up the scanner-bot "mega-card" (#57, A-06, acceptance round 2). Before A-06 the key x:rickburpbot / x:rick merged all
// Rick cards (score ≥ 4) into one project: it held the addresses of dozens of different tokens, and repeat protection and "project history"
// lied for them. After A-06 no new bot keys are created; this script unlinks the keys of old merged projects.
// Each token gets its own card at its next mention (and is analysed again — the merged card's verdict belonged to someone else).
//   npx tsx src/intel/unlinkBotKeys.ts server/data/agent.sqlite            — show only (changes nothing)
//   npx tsx src/intel/unlinkBotKeys.ts server/data/agent.sqlite --apply    — unlink
// Before --apply: stop the agent and back up the database (steps are with Ops).
import { pathToFileURL } from 'node:url';
import { Store } from '../store/db.js';
import { SCANNER_BOT_HANDLES } from './entities.js';

export interface UnlinkReport { projects: { id: number; keys: number; sample: string[] }[]; removed: number }

export function unlinkBotKeys(store: Store, apply: boolean): UnlinkReport {
  const ids = store.projectIdsForKeys([...SCANNER_BOT_HANDLES].map(h => `x:${h}`));
  const report: UnlinkReport = { projects: [], removed: 0 };
  for (const id of ids) {
    const keys = store.projectKeys(id);
    report.projects.push({ id, keys: keys.length, sample: keys.slice(0, 6) });
    if (apply) report.removed += Number(store.db.prepare('DELETE FROM project_keys WHERE project_id = ?').run(id).changes ?? 0);
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [path, flag] = process.argv.slice(2);
  if (!path) { console.error('Usage: npx tsx src/intel/unlinkBotKeys.ts <agent.sqlite> [--apply]'); process.exit(1); }
  const r = unlinkBotKeys(new Store(path), flag === '--apply');
  for (const p of r.projects) console.log(`project ${p.id}: ${p.keys} keys (${p.sample.join(', ')}${p.keys > p.sample.length ? ', …' : ''})`);
  console.log(flag === '--apply' ? `removed ${r.removed} keys` : `${r.projects.length} project(s) found; nothing changed (add --apply)`);
}
