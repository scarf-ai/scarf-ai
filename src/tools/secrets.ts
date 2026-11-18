// Secrets check before pushing to GitHub (the owner 2026-10-28: "option B, only with caveats" —
// internal GitHub plan, section 1.4). Run:  npm run secrets-check            (whole project)
//                                           npm run secrets-check -- D:\path   (another folder)
// Only what goes into the repository is checked: with git — `git ls-files`, otherwise a folder walk
// honoring .gitignore. Forbidden: files (.env*, key storage, trust-sources.csv …) and lines that look like
// keys (EVM/Solana, Anthropic, Telegram, Discord, GitHub, Cloudflare, X, filled-in secret .env lines).
// The secret itself is never printed: only the file, line, kind and first 4 characters.
// An exception line (test data) is marked with the comment `secrets-check: allow`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Finding { file: string; line: number; kind: string; hint: string }

/** Files that must not be in the repository regardless of content. */
const FORBIDDEN_FILES: { test: (rel: string, base: string) => boolean; kind: string }[] = [
  { test: (_r, b) => /^\.env(\..+)?$/.test(b) && b !== '.env.example', kind: '.env file' },
  { test: (_r, b) => /keystore.*\.json$/i.test(b), kind: 'key storage' },
  { test: (_r, b) => /\.(pem|key|p12|pfx)$/i.test(b) || /^id_(rsa|ed25519|ecdsa)$/.test(b), kind: 'key file' },
  { test: (r) => r === 'server/config/trust-sources.csv', kind: 'source scores (.example only)' },
  { test: (r) => r.startsWith('server/data/'), kind: 'server data' },
];

/** Well-known Hardhat/Anvil test keys (accounts 0–2) — not secrets. */
const KNOWN_TEST_KEYS = new Set([
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
]);

const SECRET_ENV = /^\s*(?:export\s+)?(ANTHROPIC_API_KEY|TWITTERAPI_IO_KEY|X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET|DISCORD_BOT_TOKEN|TELEGRAM_BOT_TOKEN|RELAY_API_KEY|OPENSEA_API_KEY|OWNER_PK|SIGNER_PK|AGENT_KEYSTORE_PASS|[A-Z_]*PRIVATE_KEY|[A-Z_]*SECRET_KEY)\s*=\s*['"]?([^\s'"#]{8,})/;

const PATTERNS: { kind: string; re: RegExp; check?: (m: RegExpExecArray, line: string) => boolean }[] = [
  { kind: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: 'Telegram bot token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { kind: 'Discord bot token', re: /\b[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,40}\b/g },
  { kind: 'Cloudflare tunnel token', re: /\beyJhIjoi[A-Za-z0-9+/=_-]{60,}/g },
  { kind: 'private key (PEM)', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'Solana secret key (array)', re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g },
  { kind: 'Solana secret key (base58)', re: /(?<![A-Za-z0-9+/=_-])[1-9A-HJ-NP-Za-km-z]{86,90}(?![A-Za-z0-9+/=_-])/g }, // not a piece of base64 (images in SVG)
  {
    // 64 hex is also a transaction hash, so it counts as a key only next to key-related words or as a whole line.
    kind: 'EVM private key', re: /(?<![0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g,
    check: (m, line) => !KNOWN_TEST_KEYS.has(m[1].toLowerCase()) &&
      (/priv|secret|mnemonic|seed|\bpk\b|_pk\b|signer|owner_?key|wallet_?key/i.test(line) || line.trim().replace(/^['"]|['"],?$/g, '').replace(/^0x/, '').length === 64),
  },
];

/** Placeholders in examples (`X_API_KEY=your-key`) — not secrets. */
const PLACEHOLDER = /^(your|<|xxx|change|example|placeholder|dummy|test|\.\.\.|\$\{|\*{3})/i;

const mask = (s: string) => `${s.slice(0, 4)}…(${s.length})`;

/** Check of a single file's text. */
export function scanText(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('secrets-check: allow')) return;
    const env = SECRET_ENV.exec(line);
    if (env && !PLACEHOLDER.test(env[2])) out.push({ file, line: i + 1, kind: `filled-in line ${env[1]}`, hint: mask(env[2]) });
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(line))) {
        if (p.check && !p.check(m, line)) continue;
        out.push({ file, line: i + 1, kind: p.kind, hint: mask(m[0]) });
      }
    }
  });
  return out;
}

export function forbiddenFile(rel: string): string | undefined {
  const r = rel.split(sep).join('/');
  return FORBIDDEN_FILES.find(f => f.test(r, basename(r)))?.kind;
}

/** Simple .gitignore parsing: lines like `dir/`, `*.ext`, `path`, `!exception`. */
export function ignoreMatcher(patterns: string[]): (rel: string, isDir: boolean) => boolean {
  const rules = patterns.map(p => p.trim()).filter(p => p && !p.startsWith('#')).map(p => {
    const neg = p.startsWith('!'); let s = neg ? p.slice(1) : p;
    const dirOnly = s.endsWith('/'); if (dirOnly) s = s.slice(0, -1);
    const anchored = s.includes('/'); if (s.startsWith('/')) s = s.slice(1);
    const rx = new RegExp(`^${s.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return { neg, dirOnly, anchored, rx };
  });
  return (rel, isDir) => {
    const r = rel.split(sep).join('/');
    let ignored = false;
    for (const u of rules) {
      if (u.dirOnly && !isDir) continue;
      const hit = u.anchored ? u.rx.test(r) : u.rx.test(r.split('/').pop()!);
      if (hit) ignored = !u.neg;
    }
    return ignored;
  };
}

/** Files that will go into the repository. */
export function repoFiles(root: string): string[] {
  if (existsSync(join(root, '.git'))) {
    try {
      return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    } catch { /* git unavailable — walk the folder */ }
  }
  const gi = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/) : [];
  const ignored = ignoreMatcher(['.git/', 'node_modules/', ...gi]);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name); const rel = relative(root, abs);
      let st; try { st = statSync(abs); } catch { continue; }
      // Parent folder ignored — everything inside is ignored (as in git).
      if (ignored(rel, st.isDirectory())) continue;
      if (st.isDirectory()) walk(abs); else out.push(rel);
    }
  };
  walk(root);
  return out;
}

export function scanRepo(root: string): { files: number; findings: Finding[] } {
  const files = repoFiles(root);
  const findings: Finding[] = [];
  for (const rel of files) {
    const kind = forbiddenFile(rel);
    if (kind) { findings.push({ file: rel, line: 0, kind, hint: 'file must not go into the repository' }); continue; }
    const abs = join(root, rel);
    let buf: Buffer; try { buf = readFileSync(abs); } catch { continue; }
    if (buf.length > 2_000_000 || buf.subarray(0, 8000).includes(0)) continue; // binary and very large files
    findings.push(...scanText(rel, buf.toString('utf8')));
  }
  return { files: files.length, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { files, findings } = scanRepo(root);
  for (const f of findings) console.log(`${f.file}${f.line ? `:${f.line}` : ''} — ${f.kind} [${f.hint}]`);
  console.log(`secrets-check: files checked ${files}, findings ${findings.length}`);
  process.exit(findings.length ? 1 : 0);
}
