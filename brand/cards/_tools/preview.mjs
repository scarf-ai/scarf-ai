// Render PNL previews for a direction: node preview.mjs a-jackdaw
import { render } from "./render.mjs";
import { miniChart } from "./chart.mjs";
import { PNL_SAMPLES, prep } from "./samples.mjs";
import fs from "node:fs";

const dir = process.argv[2];
const THEME = {
  "a-jackdaw": { win: "#7CF2C9", loss: "#FF7A6B", dotStroke: "#0A0F1C", base: "#3A4A68", w: 816, h: 126, pose: (s) => "asset:pose-neutral.png" },
  "b-lossy":   { win: "#141414", loss: "#FF4F1F", dotStroke: "#F3EFE4", base: "#B9B2A0", w: 700, h: 170, pose: (s) => `asset:pose-${s.is_win ? "win" : "loss"}.svg` },
  "c-bidwell": { win: "#1F6F78", loss: "#D9573E", dotStroke: "#F4ECDD", base: "#C9B48C", w: 780, h: 130, pose: (s) => "asset:pose-neutral.png" },
}[dir];

fs.mkdirSync("out", { recursive: true });
for (const [name, raw] of Object.entries(PNL_SAMPLES)) {
  const s = prep(raw);
  const color = s.is_win ? THEME.win : THEME.loss;
  s.chart_src = miniChart(s.points, { w: THEME.w, h: THEME.h, line: color, fill: color + "22", dot: color, dotStroke: THEME.dotStroke, baseline: THEME.base, exitIdx: s.points.length - 1 });
  s.pose_src = THEME.pose(s);
  const ms = await render(`directions/${dir}/pnl.html`, s, `out/${dir}-pnl-${name}.png`);
  console.log(`${dir} ${name}: ${JSON.stringify(ms)}`);
}
