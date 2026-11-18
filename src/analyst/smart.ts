// Smart X accounts: server/config/smart-accounts.csv (kept by the owner; starting list — tech chat 2026-10-27, addition 2026-11-11).
// Matching against project followers: by name in the follower sample and by ID among all (up to 5k).
// Name IDs are cached in the log for 7 days (≈ $0.0002 per name).
// An analysis never waits for name resolution (acceptance #57, round 2: a cold list of 56 names held an analysis 5+ min): ids() returns
// what is already there, or undefined ("list warming up"), and resolution runs in the background via the X queue (background lane).
// An empty map is not "checked" (round 3): ids() returns undefined; a partial one — coverage() shows how many are unresolved.
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Store } from '../store/db.js';
import type { XProvider } from './enrich.js';
import { parseSmartCsv, type SmartAccounts } from './xresearch.js';
import { review as reviewLog } from '../review/log.js';

/** Names missing on X (typo, renamed) — re-request every 6 h; X failure (402, 429, network) — after 30 min; other cache — 7 days. */
const MISSING_RETRY_MS = 6 * 3600_000;
const FAILED_RETRY_MS = 30 * 60_000;
const TTL_MS = 7 * 86400_000;
/** Warm-up in chunks: saved to the log after each one. */
const WARM_CHUNK = 10;
type Cache = { at: number; key: string; ids: [string, string][]; missing?: string[]; failed?: string[] };

export function smartAccounts(path: string, x: XProvider, store: Store, now: () => number, log: (s: string) => void = () => {}): SmartAccounts {
  let handles = new Map<string, string>(); let mtime = 0;
  const load = () => {
    try { if (existsSync(path)) { const m = statSync(path).mtimeMs; if (m !== mtime) { handles = parseSmartCsv(readFileSync(path, 'utf8')); mtime = m; } } } catch { /* old list */ }
    return handles;
  };
  load();
  const cached = (): Cache | null => { try { return JSON.parse(store.kvGet('smart_ids') ?? 'null') as Cache | null; } catch { return null; } };
  let pending: Promise<void> | undefined;
  /** Resolve names to IDs in the background. Missing on X — a "typo?" line for the owner; X failure — a separate line with reasons (not a typo). */
  const warm = (names: string[], have: [string, string][], key: string) => {
    if (pending || !x.ids) return;
    pending = (async () => {
      // Chunks of 10, saved after each (acceptance #57, round 2, item 3): a restart in the middle of a 15-minute warm-up
      // does not lose what is resolved; names not yet asked are saved as "failure" — re-request in 30 min, not 6 h
      const got: Map<string, string> & { failed?: { handle: string; reason: string }[] } = Object.assign(new Map<string, string>(), { failed: [] as { handle: string; reason: string }[] });
      for (let i = 0; i < names.length; i += WARM_CHUNK) {
        const part = await x.ids!(names.slice(i, i + WARM_CHUNK));
        for (const [id, h] of part) got.set(id, h);
        got.failed!.push(...(part.failed ?? []));
        if (i + WARM_CHUNK < names.length) {
          const sofar = new Map([...have, ...got]);
          const done = new Set([...sofar.values()].map(h => h.toLowerCase()));
          const tried = new Set(names.slice(0, i + WARM_CHUNK).map(h => h.toLowerCase()));
          const failedNow = new Set(got.failed!.map(f => f.handle.toLowerCase()));
          const rest = [...load().keys()].filter(h => !done.has(h));
          store.kvSet('smart_ids', JSON.stringify({ at: now(), key, ids: [...sofar],
            missing: rest.filter(h => tried.has(h) && !failedNow.has(h)), failed: rest.filter(h => !tried.has(h) || failedNow.has(h)) } satisfies Cache));
        }
      }
      const ids = new Map([...have, ...got]);
      const found = new Set([...ids.values()].map(h => h.toLowerCase()));
      const failedSet = new Set((got.failed ?? []).map(f => f.handle.toLowerCase()));
      const failed = [...load().keys()].filter(h => !found.has(h) && failedSet.has(h));
      const missing = [...load().keys()].filter(h => !found.has(h) && !failedSet.has(h));
      store.kvSet('smart_ids', JSON.stringify({ at: now(), key, ids: [...ids], missing, failed } satisfies Cache));
      if (missing.length) log(`smart accounts: X has no account for ${missing.length} of ${load().size}: ${missing.join(', ')} (typo or renamed? — fix server/config/smart-accounts.csv)`);
      if (failed.length) {
        const why = [...new Set((got.failed ?? []).map(f => f.reason.replace(/\s+/g, ' ').slice(0, 60)))].slice(0, 3).join('; ');
        log(`smart accounts: X lookup failed for ${failed.length} of ${load().size} (${why}) — retry in ${FAILED_RETRY_MS / 60_000} min`);
      }
      if (missing.length || failed.length) reviewLog.write('smart_ids', { resolved: ids.size, missing, failed, reasons: (got.failed ?? []).slice(0, 5) });
    })().catch(e => { log(`smart accounts: ID lookup failed: ${String((e as Error).message ?? e).slice(0, 160)}`); reviewLog.write('smart_ids', { error: String((e as Error).message ?? e).slice(0, 200) }); })
      .finally(() => { pending = undefined; });
  };
  const acc: SmartAccounts = {
    get handles() { return load(); },
    /** Map id → handle of what is resolved; undefined — the list is warming up or no name resolved (no ID check). */
    ids: async () => {
      const list = [...load().keys()].sort();
      const key = list.join(',');
      const c = cached();
      if (c && c.key === key && now() - c.at < TTL_MS) {
        // Only the missing ones, in the background, not the whole list again (a cold start of 170 names ≈ 15 min on the free X tier)
        const retryAfter = c.failed?.length ? FAILED_RETRY_MS : MISSING_RETRY_MS;
        const unresolved = [...(c.failed ?? []), ...(c.missing ?? [])];
        if (unresolved.length && now() - c.at >= retryAfter) warm(unresolved, c.ids, key);
        return c.ids.length ? new Map(c.ids) : undefined;
      }
      // No cache, the list changed or the cache is older than 7 days: warm up in the background; the old map (if any) is better than nothing meanwhile
      warm(list, [], key);
      return c?.ids.length ? new Map(c.ids) : undefined;
    },
    whenWarm: () => pending ?? Promise.resolve(),
    // Count against the CURRENT list (acceptance #57, round 3): after a CSV edit ids() returns the old map while the new list warms up,
    // — a new name without an ID must give "check incomplete", not "no smart followers"
    coverage: () => {
      const c = cached(); if (!c) return undefined;
      const list = load(); const have = new Set(c.ids.map(([, h]) => h.toLowerCase()));
      return { resolved: [...list.keys()].filter(h => have.has(h)).length, total: list.size };
    },
  };
  return acc;
}
