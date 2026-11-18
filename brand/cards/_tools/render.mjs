// Card renderer: HTML template with {{fields}} -> satori -> SVG -> resvg -> PNG.
// Same pipeline the server will use. Usage:
//   node render.mjs <template.html> <data.json> <out.png> [width] [height]
import fs from "node:fs";
import path from "node:path";
import satori from "satori";
import { html } from "satori-html";
import { Resvg } from "@resvg/resvg-js";

const FONT_DIR = process.env.FONT_DIR || path.resolve("fonts");

// Each font = one file per weight, as the tech spec requires.
const FONTS = [
  ["JetBrains Mono", 400, "JetBrainsMono-Regular.ttf"],
  ["JetBrains Mono", 500, "JetBrainsMono-Medium.ttf"],
  ["JetBrains Mono", 700, "JetBrainsMono-Bold.ttf"],
  ["Space Grotesk", 500, "SpaceGrotesk-Medium.ttf"],
  ["Space Grotesk", 700, "SpaceGrotesk-Bold.ttf"],
  ["Archivo", 500, "Archivo-Medium.ttf"],
  ["Archivo", 800, "Archivo-ExtraBold.ttf"],
  ["Archivo", 900, "Archivo-Black.ttf"],
  ["Archivo Narrow", 500, "ArchivoNarrow-Medium.ttf"],
  ["Archivo Narrow", 700, "ArchivoNarrow-Bold.ttf"],
  ["Fraunces", 600, "Fraunces-SemiBold.ttf"],
  ["Fraunces", 900, "Fraunces-Black.ttf"],
  ["IBM Plex Mono", 400, "IBMPlexMono-Regular.ttf"],
  ["IBM Plex Mono", 500, "IBMPlexMono-Medium.ttf"],
  ["IBM Plex Mono", 600, "IBMPlexMono-SemiBold.ttf"],
];

let fontCache = null;
function loadFonts() {
  if (fontCache) return fontCache;
  fontCache = FONTS.filter(([, , f]) => fs.existsSync(path.join(FONT_DIR, f))).map(([name, weight, f]) => ({
    name, weight, style: "normal", data: fs.readFileSync(path.join(FONT_DIR, f)),
  }));
  return fontCache;
}

// Minimal template language: {{field}}, {{#if field}}…{{else}}…{{/if}} (no nesting of the same block needed).
export function fill(tpl, data) {
  let out = tpl;
  // resolve innermost #if blocks repeatedly
  const re = /\{\{#if (\w+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/;
  let m;
  while ((m = out.match(re))) {
    const [all, key, body] = m;
    const [yes, no = ""] = body.split("{{else}}");
    const v = data[key];
    out = out.replace(all, v && v !== "false" ? yes : no);
  }
  return out.replace(/\{\{(\w+)\}\}/g, (_, k) => (data[k] ?? "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

// Assets: template says src="asset:file.png". We parse the HTML FIRST and only then put
// image bytes into the tree. Putting base64 into the HTML string makes satori-html parse
// for ~50 s per card (measured); post-parse injection keeps a card under ~300 ms.
const assetCache = new Map();
function assetURI(p) {
  if (!assetCache.has(p)) {
    const buf = fs.readFileSync(p);
    const mime = p.endsWith(".svg") ? "image/svg+xml" : p.endsWith(".png") ? "image/png" : "image/jpeg";
    assetCache.set(p, `data:${mime};base64,${buf.toString("base64")}`);
  }
  return assetCache.get(p);
}
function injectAssets(node, assetDir, data) {
  if (!node || typeof node !== "object") return;
  const props = node.props || {};
  if (node.type === "img" && typeof props.src === "string") {
    // field:x -> value from event data (chart data URI from code, or asset:pose-loss.png chosen by code)
    if (props.src.startsWith("field:")) props.src = data[props.src.slice(6)] || "";
    if (props.src.startsWith("asset:")) props.src = assetURI(path.join(assetDir, props.src.slice(6)));
  }
  const ch = props.children;
  if (Array.isArray(ch)) ch.forEach((c) => injectAssets(c, assetDir, data)); else injectAssets(ch, assetDir, data);
}

export async function render(tplPath, data, outPath, width = 1600, height = 900) {
  const t0 = performance.now();
  const tpl = fs.readFileSync(tplPath, "utf8");
  const assetDir = path.resolve(path.dirname(tplPath), "assets");
  const tree = html(fill(tpl, data));
  injectAssets(tree, assetDir, data);
  const t1 = performance.now();
  const svg = await satori(tree, { width, height, fonts: loadFonts() });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  fs.writeFileSync(outPath, png);
  return { total: Math.round(performance.now() - t0), render: Math.round(performance.now() - t1) };
}

if (process.argv[1] && process.argv[1].endsWith("render.mjs")) {
  const [tpl, dataFile, out, w, h] = process.argv.slice(2);
  const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const ms = await render(tpl, data, out, Number(w) || 1600, Number(h) || 900);
  console.log(`${out}: ${JSON.stringify(ms)} ms`);
}
