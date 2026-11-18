// Review #144, item 4: a proxy server error after startup (EMFILE on accept, etc.) does not crash the agent process.
// A separate file: node:http is substituted here to get at the proxy server itself.
import { describe, it, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import { connect } from 'node:net';

const servers: Server[] = [];
vi.mock('node:http', async (orig) => {
  const m = await orig<typeof import('node:http')>();
  return { ...m, createServer: (...a: Parameters<typeof m.createServer>) => { const s = m.createServer(...a); servers.push(s); return s; } };
});
const { startEgressProxy } = await import('../src/exec/siteProxy.js');

describe('review #144: a proxy server error after listen', () => {
  it('EMFILE on the server — not an unhandled exception; the proxy keeps answering', async () => {
    const p = await startEgressProxy({ ports: () => true });
    try {
      const srv = servers.at(-1)!;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Without a handler EventEmitter throws 'error' right from emit — in production that crashes the agent process
      expect(() => srv.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))).not.toThrow();
      expect(() => srv.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1); // to the log — once, without a stream of lines
      warn.mockRestore();
      const line = await new Promise<string>((ok) => {
        const s = connect(Number(new URL(p.url).port), '127.0.0.1', () => s.write('CONNECT 127.0.0.1:80 HTTP/1.1\r\n\r\n'));
        let b = ''; s.on('data', (c) => { b += c; if (b.includes('\r\n')) { ok(b.split('\r\n')[0]); s.destroy(); } }); s.on('error', () => ok('error'));
      });
      expect(line).toBe('HTTP/1.1 403 Forbidden');
    } finally { await p.close(); }
  });
});
