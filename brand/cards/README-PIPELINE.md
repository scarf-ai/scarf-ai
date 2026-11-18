# Cards: how to render

Verified on 2026-10-23 with satori 0.12.2 + satori-html 0.3.2 + @resvg/resvg-js 2.6.2, Node 22. A working reference renderer is brand/cards/_tools/render.mjs (the same code that produced the previews).

## 1. Key point: images go in AFTER the HTML is parsed
If you embed an image into the HTML string as base64 (`<img src="data:image/png;base64,...">`), satori-html takes **~48 seconds** to parse that string (measured: an 800×800 PNG character = 430 KB of base64). Therefore:
1. fill the fields into the template (`fill`) → 2. `html()` from satori-html → 3. walk the tree and replace `src` on each `<img>` → 4. `satori(tree)` → 5. resvg.

Templates use two kinds of image references:
- `src="asset:bg.svg"` — a static file from the assets/ folder next to the template (cache the data URI in memory);
- `src="field:pose_src"` / `src="field:chart_src"` — a value from the event data: a chart data URI produced by the code, or `asset:pose-loss.png` chosen by the code.

Result: 260–430 ms per 1600×900 card, of which ~150 ms is resvg. **The first card after a cold start can take 15+ s** (measured 24.10: 16.5 s, then 290–370 ms): when the service starts, render one throwaway card before the first real post.

The name and handle in templates are the fields `{{brand_name}}`, `{{brand_handle}}`: take them from the shared brand config.

## 2. Template language
- `{{field}}` — escaped (& < >).
- `{{#if field}}…{{else}}…{{/if}}` — also works inside the style attribute (profit/loss color). Falsy: empty, false, "false".
- Every `div` with children is `display:flex`; inline styles only.

## 3. Fields computed by the code (not the template)
| Field | Rule |
|---|---|
| `ticker_size` | ticker length ≤8 → 120, ≤11 → 100, ≤14 → 80 (px) |
| `entry_price`, `exit_price` | ≥1 → 2 decimals; ≥0.01 → up to 4 decimals; up to 4 zeros after the point — as is (0.0000642); more — `0.0₅123` (JetBrains Mono has subscript digits). Function `fmtPrice` in _tools/chart.mjs |
| `pnl_usd`, `pnl_pct` | signed: `+$1.86`, `−$0.54` (a real minus sign U+2212), `+62.0%` |
| `arrow` | ▲ / ▼ (available only in JetBrains Mono — templates set the arrows in this font) |
| `result_word` | PROFIT / LOSS |
| `chart_src` | SVG data URI built from points: the template sets size and colors (see `miniChart` in _tools/chart.mjs) |
| `pose_src` | `asset:pose-<pose>.png` by event and sign of the result |
| `paper` | true/false — the PAPER badge |

## 4. Fonts
OFL-licensed TTF only (Google Fonts), one file per style — brand/cards/fonts/ plus licenses. No WOFF2.

## 5. Links and posts
Post text contains no links (a post with a link costs $0.20 in the X API versus $0.015). The tx hash goes in as text.
