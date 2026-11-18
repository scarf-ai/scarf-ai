# Stage 2 — three visual directions (name + character + style)

2026-10-23 (UTC). Each direction is shown on a real PNL card, rendered the same way it will be on the server (satori + resvg, ~300 ms). The data is a real SWARMX paper trade and a profitable example with a long ticker and a price of 0.00000123.
Previews: brand/directions/*.png. Templates: brand/directions/<direction>/pnl.html.

## What changed since stage 1 and why the recommendation changes
The agent is different from what it was at stage 1. Back then it was a "rules-based agent": 0–5 trades a day, stock tokens. Now it is a **hunter**: memecoins on 6 chains, NFT mints, raffles, Polymarket, points; decisions are made by an analyst model. That is why the recommendation is **JACKDAW**: a jackdaw that drags off everything shiny is literally what the agent does. LOSSY remains a strong second option for honesty about losses.

## A. JACKDAW — "Night Market" (recommended)
- **Character:** a plump black jackdaw in a knitted silver scarf (a real jackdaw has a grey "collar" — here it becomes a scarf, the detail people remember), one eyebrow raised, a gold coin at its feet. Style — a premium 3D toy.
- **Palette:** night blue #0A0F1C, ice #86D6FF, silver #EEF3F8, gold #FFC857 (PAPER badge). Profit — mint #7CF2C9, loss — coral #FF7A6B. This is not Robinhood green.
- **Fonts:** Archivo Black (ticker, wordmark), JetBrains Mono (all numbers), Space Grotesk (text).
- **Pros:** an animal mascot is what the memecoin market buys (cats, VRAX); recognizable in a 48 px avatar by silhouette and eye; the card looks like a share from a trading app.
- **Cons:** a black bird on a dark background needs a glow behind it (done); poses are generated and then retouched — each has to be picked by hand.
- **Handle/domain:** @jackdaw_ai, jackdawagent.com available (checked 21.10).

## B. LOSSY — "Receipt"
- **Character:** a pixel creature whose corner crumbles into compression blocks (literally "lossy"). Drawn in code: 9 poses are ready and perfectly consistent.
- **Palette:** paper #ECE7DA / #FBF9F3, ink #141414, signal orange #FF4F1F (loss, PAPER), gold #F2B233. Profit — black with a "+" sign.
- **Fonts:** Archivo Black + JetBrains Mono.
- **Pros:** the most recognizable presentation: every trade is a printed receipt; the cheapest and fastest to produce; the 24 px icon reads perfectly.
- **Cons:** "loss" in the name; the pixel style is closer to indie games than to "premium"; the character feels less "alive".
- **Handle/domain:** @lossy available, lossy.fun available.

## C. BIDWELL — "Office Memo"
- **Character:** a clerk robot in a 1950s retro illustration style: vest, bow tie, clipboard, brass glasses.
- **Palette:** cream #F4ECDD, dark blue #14213D, brass #B8893B; profit — teal #1F6F78, loss — terracotta #D9573E.
- **Fonts:** Fraunces Black (ticker, name), IBM Plex Mono + JetBrains Mono (numbers).
- **Pros:** warm, "human", stands out among neon crypto cards; the story of an intern with a small deposit is funny.
- **Cons:** in a degen feed it may look "too cute"; generating poses in a consistent style takes the same work as A.
- **Handle/domain:** @bidwell_ai, bidwell.fun available.

## Common to all directions
- The wordmark and handle are always in the same place (top left), the PAPER badge is top right.
- Profit and loss are distinguishable without color: "+/−" sign, ▲/▼ arrow, the word PROFIT/LOSS.
- Prices: up to 4 zeros — as is (0.0000642), more — with a subscript digit (0.0₅123), as on DexScreener.
- The code picks the ticker size by length (≤8 characters — 120 px, ≤11 — 100 px, up to 14 — 80 px), because satori cannot "fit text".

## After the choice
The chosen direction is developed into a full set: 8 character poses, all cards (PNL 16:9 and 4:5, ENTRY, NFT MINT/SOLD, PREDICTION, RAFFLE, PASSED, DAILY, HALT, period PnL summary), a sample.json for each, fonts with licenses, the X profile (avatar, banner, bio, pinned post), the wordmark and the token icon.
