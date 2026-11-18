# SPEC-BRAND — SCARF project brand

A reference for developers: name, ticker, persona, tone, palette, fonts, screens. Maintained by Brand.
All times are UTC. Everything public (name, tagline, site and dashboard copy, posts, trailer) is in English.
Status: **stage 3 — approved: the name SCARF / $SCARF / @scarf_ai, the mascot (a bird in a scarf) and the "Night Market" card style. Values — brand/brand.json.**

## Rules for developers
- The name SCARF, ticker $SCARF and handle @scarf_ai come only from brand/brand.json, never hardcoded.
- No domains in the UI or templates — use "link in bio" everywhere until a domain is bought.
- All times in the UI, logs and events are UTC, format `2026-10-21 18:50 UTC`.
- UI copy is in English; final wording will come in section 7.

---

## 0. Market grounds (internal market report)
What drives the positioning and the visuals:

1. **We are a show, not rails.** The AI projects on RH Chain are infrastructure, with small audiences. "AI" as a meme wrapper lives for days. So the brand centers on the character and its account balance, not on the word "AI". The unit of content is a trade with a tx hash.
2. **The main visual object is money you can see.** P&L, the equity curve, "paid out to holders". This works for LONG, Hens.farm (payouts in GLD), StonkFun. A trade card must read in a second and without context — like a screenshot people forward.
3. **A loss is content, not failure.** Public "down −92%" posts build trust; "what went wrong" is a genre. The brand must look equally good in green and in red; the character's personality is tested by a loss.
4. **Trust matters more than hype.** The chain has a fresh history of rug pulls and copycat clones. Visual carriers of honesty: a public address, the tx hash, a "verified on-chain" badge, and the only source of the CA is our X account at an announced UTC time. The "check the last characters of the address" ritual is part of the brand.
5. **We need P&L spectators, not players.** Our "Early Access" is public paper trading before the token: people come to watch the balance; the bet is to trust the agent.
6. **A format for the channels that already distribute reach.** Recap accounts, "Currently Trending on Pons" and Moonshot like "stats as news". The agent's daily report should give one headline number that is easy to quote.
7. **Robinhood Chain is the setting, not our brand.** Chain-level news is the main catalyst, but it is a lottery. The character naturally lives on the chain and trades stock tokens (NVDA, GLD, SPCX), which gives reasons to react, but the palette and mark must not resemble Robinhood's signature green — otherwise it looks like an imitation. Green and red remain only as functional P&L colors.

Reference points: LONG (reach, stock pairs), Pons (hub presentation), Embervale (funnel and presentation), Moonshot (product).

---

## 1. Name and ticker — approved 24.10
**SCARF / $SCARF**, X **@scarf_ai** (not registered). The scarf is the mascot's key detail; the slang "to scarf (down)" means to greedily sweep up. Config: brand/brand.json.

## 2. Persona — visual chosen 24.10 (the full voice is planned for stage 4)
A black bird in a knitted silver scarf, one eyebrow raised, a gold coin at its feet; a premium 3D toy. Personality — a fast, cunning collector of everything shiny (memecoins, mints, raffles, bets) who honestly calls out duds. Card style — direction A, "Night Market" (docs/STAGE2-DIRECTIONS.md).

## 3. Tone — accepted
- Only the character speaks in public, from one X account. There is no dev voice yet.
- Numbers — absolutely serious and precise; the voice — with humor and self-irony (~60–70%).
- A loss is posted right away and no less prominently than a profit; days without trades are a post too.
- Taboo: return forecasts in percent and "buy"; real people as characters; imitating Robinhood/Pons; politics; naming other projects in a negative light.
- No-guarantee statement (bio/pinned): "I'm an AI trading to grow this treasury — every trade, win or loss, posted with its tx. I make mistakes, and you'll see all of them. Nothing here is a guarantee or financial advice."
- Stock token disclaimer: "Stock tokens on Robinhood Chain aren't available to residents of the US, UK, Canada, Switzerland or the UAE. This account shows what an AI does with them — it's not an offer to anyone, and nothing here is financial advice."

## 3a. Audience — accepted based on research
Buyers are crypto degens (the RH Chain and memecoin audience). The AI audience is reach through the story only; we do not sell the token to them. Stock token holders — through trade content.
## 4. Palette — approved (brand/brand.json)
Background #0A0F1C, panels #10182A, borders #1E2B45, text #EEF3F8 / #7F8BA3 / #AFC0D8, ice #86D6FF, PAPER #FFC857, profit #7CF2C9, loss #FF7A6B.
## 5. Typography — approved
Archivo Black — wordmark and ticker; JetBrains Mono — all numbers (the only one with ▲▼ and subscript digits); Space Grotesk — text. TTF + OFL in brand/cards/fonts/.
## 6. Components and design system — _stage 3_
## 7. Dashboard screens (desktop + mobile), sizes, spacing, copy — _stage 3_
## 8. Image templates for posts (trade_opened / trade_closed / daily_report) — _stage 3_
