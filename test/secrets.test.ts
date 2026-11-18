// The secrets check before GitHub (an internal plan document, section 1.4).
// The secrets in this file are assembled from pieces during the test, so that the file itself contains none.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { forbiddenFile, ignoreMatcher, scanRepo, scanText } from '../src/tools/secrets.js';

const hex = (n: number, c = 'a7') => c.repeat(n / 2);
const b58 = (n: number) => '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'.repeat(4).slice(0, n);
const kinds = (t: string) => scanText('f.ts', t).map(f => f.kind);

describe('secrets-check: lines', () => {
  it('finds service keys', () => {
    expect(kinds(`const k = "${'sk-' + 'ant-' + 'api03-' + 'x'.repeat(40)}"`)).toEqual(['Anthropic key']);
    expect(kinds(`token: ${'gh' + 'p_' + 'A'.repeat(36)}`)).toEqual(['GitHub token']);
    expect(kinds(`bot ${'123456789' + ':AA' + 'b'.repeat(33)}`)).toEqual(['Telegram bot token']);
    expect(kinds(`cloudflared service install ${'eyJh' + 'Ijoi' + 'Q'.repeat(80)}`)).toEqual(['Cloudflare tunnel token']);
    expect(kinds('-----BEGIN ' + 'PRIVATE KEY-----')).toEqual(['private key (PEM)']);
  });

  it('finds filled-in secret .env lines, but not empty ones and not placeholders', () => {
    expect(kinds(`ANTHROPIC_API_KEY=${'real' + 'value12345'}`)).toEqual(['filled-in line ANTHROPIC_API_KEY']);
    expect(kinds(`OWNER_PK=0x${hex(64)}`)).toContain('filled-in line OWNER_PK');
    expect(kinds('ANTHROPIC_API_KEY=')).toEqual([]);
    expect(kinds('X_ACCESS_TOKEN=your-access-token')).toEqual([]);
    expect(kinds('const key = process.env.ANTHROPIC_API_KEY;')).toEqual([]);
  });

  it('an EVM key — only next to key words or as a whole line; a transaction hash is not a key', () => {
    expect(kinds(`const privateKey = '0x${hex(64)}'`)).toEqual(['EVM private key']);
    expect(kinds(`0x${hex(64)}`)).toEqual(['EVM private key']);
    expect(kinds(`  txHash: '0x${hex(64)}', block: 1`)).toEqual([]);
    // The well-known Hardhat #1 test key — not a secret.
    expect(kinds(`privateKeyToAccount('0x${'59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'}')`)).toEqual([]);
  });

  it('a Solana key: base58 and an array of 64 numbers; a piece of base64 in SVG is not a key', () => {
    expect(kinds(`secret: "${b58(88)}"`)).toEqual(['Solana secret key (base58)']);
    expect(kinds(`[${Array.from({ length: 64 }, (_, i) => i).join(',')}]`)).toEqual(['Solana secret key (array)']);
    expect(kinds(`data:image/png;base64,AAAA+${b58(88)}/BBBB==`)).toEqual([]);
  });

  it('a line marked allow is skipped, and the secret itself is not printed', () => {
    expect(kinds(`const privateKey = '0x${hex(64)}' // secrets-check: allow`)).toEqual([]);
    const f = scanText('f.ts', `const privateKey = '0x${hex(64)}'`)[0];
    expect(f.hint).not.toContain(hex(64));
  });
});

describe('secrets-check: files', () => {
  it('forbidden files', () => {
    expect(forbiddenFile('.env')).toBe('.env file');
    expect(forbiddenFile('.env.local')).toBe('.env file');
    expect(forbiddenFile('.env.example')).toBeUndefined();
    expect(forbiddenFile('server/data/keystore.json')).toBeDefined();
    expect(forbiddenFile('server/config/trust-sources.csv')).toBeDefined();
    expect(forbiddenFile('server/config/trust-sources.example.csv')).toBeUndefined();
  });

  it('parsing .gitignore', () => {
    const ig = ignoreMatcher(['node_modules/', '.env', '.env.*', '!.env.example', 'server/data/', '*.pem']);
    expect(ig('node_modules', true)).toBe(true);
    expect(ig('.env.local', false)).toBe(true);
    expect(ig('.env.example', false)).toBe(false);
    expect(ig('server/data', true)).toBe(true);
    expect(ig('a/b/c.pem', false)).toBe(true);
    expect(ig('src/index.ts', false)).toBe(false);
  });

  it('a folder without git: ignored files are not checked, the rest are', () => {
    const d = mkdtempSync(join(tmpdir(), 'secrets-'));
    writeFileSync(join(d, '.gitignore'), '.env\nserver/data/\n');
    writeFileSync(join(d, '.env'), `ANTHROPIC_API_KEY=${'real' + 'value12345'}\n`);
    mkdirSync(join(d, 'server/data'), { recursive: true });
    writeFileSync(join(d, 'server/data/keystore.json'), '{}');
    writeFileSync(join(d, 'ok.ts'), 'export const a = 1;\n');
    expect(scanRepo(d).findings).toEqual([]);
    writeFileSync(join(d, 'leak.ts'), `const privateKey = '0x${hex(64)}'\n`);
    expect(scanRepo(d).findings.map(f => f.file)).toEqual(['leak.ts']);
  });

  it('the project itself has no secrets (what will go to GitHub)', () => {
    const { findings } = scanRepo(resolve(__dirname, '..'));
    expect(findings.map(f => `${f.file}:${f.line} ${f.kind}`)).toEqual([]);
  });
});
