// Mini price chart for cards: points -> SVG data URI (server code does the same).
// opts: w, h, line, fill (area under line, rgba), entryIdx, exitIdx, dot, dotStroke, baseline (dashed entry level)
export function miniChart(points, o) {
  const { w, h, line, fill = "none", entryIdx = 0, exitIdx = points.length - 1, dot = line, dotStroke = "#000", baseline = null, strokeW = 5 } = o;
  const pad = 14;
  const min = Math.min(...points), max = Math.max(...points);
  const X = (i) => pad + (i * (w - 2 * pad)) / (points.length - 1);
  const Y = (v) => pad + (h - 2 * pad) * (1 - (v - min) / (max - min || 1));
  const d = points.map((v, i) => `${i ? "L" : "M"} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const area = `${d} L ${X(points.length - 1)} ${h} L ${X(0)} ${h} Z`;
  const base = baseline ? `<line x1="${pad}" x2="${w - pad}" y1="${Y(points[entryIdx])}" y2="${Y(points[entryIdx])}" stroke="${baseline}" stroke-width="2" stroke-dasharray="8 8"/>` : "";
  const dotAt = (i, r) => `<circle cx="${X(i)}" cy="${Y(points[i])}" r="${r}" fill="${dot}" stroke="${dotStroke}" stroke-width="4"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${fill !== "none" ? `<path d="${area}" fill="${fill}"/>` : ""}${base}
    <path d="${d}" fill="none" stroke="${line}" stroke-width="${strokeW}" stroke-linejoin="round" stroke-linecap="round"/>
    ${dotAt(entryIdx, 9)}${dotAt(exitIdx, 11)}</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// Price formatting rule for all cards: up to 4 leading zeros as-is, more -> 0.0₅123 (DexScreener style).
export function fmtPrice(p) {
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const s = p.toFixed(20).slice(2);
  const zeros = s.match(/^0*/)[0].length;
  const sig = s.slice(zeros, zeros + 3).replace(/0+$/, "") || "0";
  if (zeros <= 4) return "0." + "0".repeat(zeros) + sig;
  const sub = String(zeros).split("").map((d) => "₀₁₂₃₄₅₆₇₈₉"[d]).join("");
  return `0.0${sub}${sig}`;
}
