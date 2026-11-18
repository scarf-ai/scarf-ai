import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ReviewLog } from '../src/review/log.js';

describe('review journal files', () => {
  it('one JSON line per event in the UTC-day file; long text clipped; files older than 30 days removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rev-'));
    writeFileSync(join(dir, '2026-09-01.jsonl'), '{}\n');
    let now = Date.parse('2026-10-28T23:59:00Z');
    const log = new ReviewLog(dir, () => now);
    log.write('message', { text: 'x'.repeat(20_000), n: 5n });
    now += 120_000;
    log.write('telegram', { text: 'hi' });
    expect(readdirSync(dir).sort()).toEqual(['2026-10-28.jsonl', '2026-10-29.jsonl']);
    const r = JSON.parse(readFileSync(join(dir, '2026-10-28.jsonl'), 'utf8').trim());
    expect(r).toMatchObject({ ts: '2026-10-28T23:59:00.000Z', kind: 'message', n: '5' });
    expect(r.text.length).toBeLessThan(16_100);
  });
  it('npm run review builds a readable summary and a full jsonl for the period', () => {
    const root = mkdtempSync(join(tmpdir(), 'revx-'));
    const dir = join(root, 'server/data/review');
    const log = new ReviewLog(dir, () => Date.parse('2026-10-28T10:00:00Z'));
    log.write('message', { source: 'ServerB/#chat/a', skipped: 'chat: buffered 3/50' });
    log.write('analysis', { source: 'ServerA/#core-calls/mh17x', model: 'claude-opus-5-5', costUsd: 0.083, usage: { rounds: 1, input: 9000, cacheWrite: 0, cacheRead: 2800, output: 1500 },
      verdict: { verdict: 'watch', confidence: 0.6, thesis: 'Variational points', publicNote: 'Watching Variational.' },
      trace: [{ thinking: ['Points need volume; capital is tiny.'], tools: [{ name: 'x_search', input: { query: 'variational' }, output: '[...]' }] }], case: 'THE MESSAGE …' });
    log.write('telegram', { text: '🔬 LIVE check BUY $2: ✅ kyber' });
    const outp = execFileSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(process.cwd(), 'src/tools/review.ts'), '2026-10-28'], { cwd: root, env: { ...process.env, AGENT_ROOT: root } }).toString();
    expect(outp).toMatch(/analyses 1/);
    const md = readFileSync(join(dir, 'review-2026-10-28.md'), 'utf8');
    expect(md).toContain('opus-5-5 → watch (0.6) · $0.083');
    expect(md).toContain('Reasoning (round 1): Points need volume');
    expect(md).toContain('Tool `x_search`');
    expect(md).toContain('LIVE check');
    expect(md).toMatch(/chat: buffered N\/N — 1/);
    expect(existsSync(join(dir, 'review-2026-10-28.jsonl'))).toBe(true);
  }, 30_000);
});
