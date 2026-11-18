// Renders a contact sheet of all poses of a mascot module: node mascots/sheet.mjs jackdaw out.png
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";
const [name, out] = process.argv.slice(2);
const mod = await import(`./${name}.mjs`);
const fn = mod[name];
const keys = Object.keys(mod.POSES);
const cell = 400, cols = 5, rows = Math.ceil(keys.length / cols);
let body = "";
keys.forEach((k, i) => {
  const svg = fn(mod.POSES[k]).replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
  body += `<g transform="translate(${x} ${y}) scale(0.5)">${svg}</g><text x="${x + 16}" y="${y + 30}" font-family="sans-serif" font-size="22" fill="#9aa">${k}</text>`;
});
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell}"><rect width="100%" height="100%" fill="${process.env.BG || "#E9E4D8"}"/>${body}</svg>`;
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync(out, new Resvg(sheet).render().asPng());
for (const k of keys) { fs.mkdirSync(`assets/${name}`, { recursive: true }); fs.writeFileSync(`assets/${name}/pose-${k}.svg`, fn(mod.POSES[k])); }
console.log("ok", keys.length);
