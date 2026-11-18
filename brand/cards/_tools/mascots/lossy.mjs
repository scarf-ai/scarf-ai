// LOSSY mascot — pixel creature whose lower-right corner breaks into compression blocks.
// 20x20 grid, 40px cells -> 800x800 SVG, transparent background.
export const PALETTE = { ink: "#141414", paper: "#F3EFE4", eye: "#FFFFFF", hot: "#FF4F1F", grey: "#8C8778", grey2: "#C9C3B3", gold: "#F2B233", ink2: "#2E2C29", ink3: "#4A4640" };
const C = 40;

// body: rounded square cols 3..16, rows 3..16 (14x14), corners trimmed
function bodyCells() {
  const cells = [];
  for (let y = 3; y <= 16; y++) for (let x = 3; x <= 16; x++) {
    const corner = (x === 3 || x === 16) && (y === 3 || y === 16);
    // lossy corner: bottom-right triangle is missing (replaced by blocks)
    const lost = x + y >= 29 || (x >= 15 && y >= 13) || (x >= 13 && y >= 15);
    if (!corner && !lost) cells.push([x, y]);
  }
  return cells;
}
// compression debris: bigger blocks drifting from the lost corner
const DEBRIS = [
  [13, 15, 1, "ink2"], [14, 14, 1, "ink2"], [15, 13, 1, "ink3"], [16, 12, 1, "ink3"], [12, 16, 1, "ink3"],
  [14, 16, 2, "ink2"], [16, 14, 2, "ink3"], [17, 17, 2, "hot"], [18, 12, 1, "grey"], [16, 17, 1, "grey"], [19, 15, 1, "hot"], [15, 19, 1, "grey2"],
];

const EYES = {
  open:   { l: [[7, 7, 2, 3]], r: [[11, 7, 2, 3]], pl: [], pr: [] },
  wide:   { l: [[7, 6, 2, 4]], r: [[11, 6, 2, 4]], pl: [], pr: [] },
  half:   { l: [[7, 9, 2, 1]], r: [[11, 9, 2, 1]], pl: [], pr: [] },
  sad:    { l: [[7, 8, 2, 2], [8, 7, 1, 1]], r: [[11, 8, 2, 2], [11, 7, 1, 1]], pl: [], pr: [] },
  side:   { l: [[6, 7, 2, 3]], r: [[10, 7, 2, 3]], pl: [], pr: [] },
  up:     { l: [[7, 6, 2, 3]], r: [[11, 6, 2, 3]], pl: [], pr: [] },
  happy:  { l: [[6, 9, 1, 1], [7, 8, 2, 1], [9, 9, 1, 1]], r: [[10, 9, 1, 1], [11, 8, 2, 1], [13, 9, 1, 1]], pl: [], pr: [] },
  narrow: { l: [[7, 9, 2, 1]], r: [[11, 7, 2, 3]], pl: [], pr: [] },
};
const MOUTHS = {
  flat:  [[8, 13, 4, 1]],
  smile: [[7, 12, 1, 1], [8, 13, 4, 1], [12, 12, 1, 1]],
  frown: [[7, 14, 1, 1], [8, 13, 4, 1], [12, 14, 1, 1]],
  open:  [[8, 12, 4, 2]],
  side:  [[9, 13, 3, 1]],
};

function rect(x, y, w, h, fill, extra = "") { return `<rect x="${x * C}" y="${y * C}" width="${w * C}" height="${h * C}" fill="${fill}" ${extra}/>`; }

function prop(kind, P) {
  const r = (x, y, w, h, f) => rect(x, y, w, h, f);
  switch (kind) {
    case "coin": return r(1, 15, 3, 3, P.gold) + r(2, 16, 1, 1, P.ink);
    case "cracked": return r(1, 15, 3, 3, P.gold) + r(2, 15, 1, 1, P.ink) + r(2, 16, 1, 1, P.ink) + r(1, 17, 1, 1, P.ink);
    case "glass": return r(16, 5, 3, 3, P.grey2) + r(17, 6, 1, 1, P.paper) + r(18, 8, 1, 1, P.ink) + r(19, 9, 1, 1, P.ink);
    case "stamp": return r(0, 13, 3, 2, P.hot) + r(1, 15, 1, 2, P.ink) + r(0, 17, 3, 1, P.ink);
    case "clock": return r(16, 3, 3, 3, P.paper) + r(17, 3, 1, 2, P.ink) + r(17, 4, 2, 1, P.ink) + `<rect x="${16 * C}" y="${3 * C}" width="${3 * C}" height="${3 * C}" fill="none" stroke="${P.ink}" stroke-width="10"/>`;
    case "halt": return r(16, 2, 4, 4, P.hot) + r(17, 3.5, 2, 1, P.paper);
    case "stack": return r(0, 16, 3, 2, P.gold) + r(1, 14, 3, 2, P.gold) + r(17, 16, 3, 2, P.gold);
    default: return "";
  }
}

export function lossy({ eye = "open", mouth = "flat", prop: pr = "none", debris = true, sweat = false } = {}, P = PALETTE) {
  let s = "";
  for (const [x, y] of bodyCells()) s += rect(x, y, 1, 1, P.ink);
  s += rect(4, 4, 2, 1, "#2C2C2C") + rect(4, 5, 1, 1, "#2C2C2C");
  if (debris) for (const [x, y, z, k] of DEBRIS) s += rect(x, y, z, z, P[k]);
  const e = EYES[eye];
  for (const [x, y, w, h] of [...e.l, ...e.r]) s += rect(x, y, w, h, P.eye);
  for (const [x, y, w, h] of [...e.pl, ...e.pr]) s += rect(x, y, w, h, P.ink);
  for (const [x, y, w, h] of MOUTHS[mouth]) s += rect(x, y, w, h, P.eye);
  if (sweat) s += rect(2, 5, 1, 2, "#7FB8FF");
  // feet
  s += rect(6, 17, 2, 1, P.ink) + rect(10, 17, 2, 1, P.ink);
  s += prop(pr, P);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800" shape-rendering="crispEdges">${s}</svg>`;
}

export const POSES = {
  neutral:   { eye: "open", mouth: "flat" },
  win:       { eye: "wide", mouth: "smile", prop: "coin" },
  loss:      { eye: "sad", mouth: "frown", prop: "cracked", sweat: true },
  thinking:  { eye: "narrow", mouth: "side", prop: "glass" },
  skip:      { eye: "side", mouth: "flat" },
  minting:   { eye: "wide", mouth: "flat", prop: "stamp" },
  waiting:   { eye: "up", mouth: "flat", prop: "clock" },
  halt:      { eye: "half", mouth: "flat", prop: "halt" },
  celebrate: { eye: "happy", mouth: "open", prop: "stack" },
};
