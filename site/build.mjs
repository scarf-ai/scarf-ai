// Site build: site/src → site/dist. The script is esbuild + obfuscation (object keys are not renamed).
//   npm run site:build
import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const src = new URL('./src/', import.meta.url).pathname, dist = new URL('./dist/', import.meta.url).pathname;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const r = await build({ entryPoints: [src + 'app.ts'], bundle: true, minify: true, format: 'iife', target: ['es2020'], write: false });
const js = JavaScriptObfuscator.obfuscate(r.outputFiles[0].text, {
  compact: true, controlFlowFlattening: false, deadCodeInjection: false, stringArray: true, stringArrayThreshold: 0.75,
  renameGlobals: false, transformObjectKeys: false, selfDefending: false,
}).getObfuscatedCode();
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const css = readFileSync(src + 'style.css', 'utf8');
writeFileSync(dist + 'app.js', js);
writeFileSync(dist + 'style.css', css);
// Version in the links, so that after an update Cloudflare and the browser fetch the new files
const html = readFileSync(src + 'index.html', 'utf8').replace('src="app.js"', `src="app.js?v=${hash(js)}"`).replace('href="style.css"', `href="style.css?v=${hash(css)}"`);
writeFileSync(dist + 'index.html', html);
cpSync(src + 'assets', dist + 'assets', { recursive: true });
writeFileSync(dist + 'robots.txt', 'User-agent: *\nAllow: /\n');
console.log(`site/dist: app.js ${(js.length / 1024).toFixed(1)} KB`);
