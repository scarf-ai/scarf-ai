# AGENT — core logic (version 0.1, 2026-10-22 UTC)

Code: `src/`, tests: `test/` (113 tests at the time of this version, all passing). Mode — **paper**; in version 0.1 live was blocked in code.

> **Version 0.2 (2026-10-22):** an analyst layer was added on top of this core — opus/chat channel modes, a chat gatekeeper, Opus/Sonnet with dossiers, OpenSea, a watch list, deferred actions, post drafts. Description: **docs/ANALYST-LAYER.md**. The "Haiku extracts intents from a single message" path (section 1 below) remains as a fallback — when the analyst's daily limit is exhausted and the source has a score ≥ 7.

---

## 1. What already works

```
Discord (your intake server)
  │ intake/discordBot.ts — the bot only reads; category = source, channel = source channel, author = message author
  ▼
intake/normalize.ts — text + embed cards (Bark etc.) + the text of the message being replied to
  ▼
extract/prefilter.ts — regexes, no model:
  │ EVM addresses, Solana mints (…pump), links, code blocks, functions with a selector (claimPacked 0x3e1d7a52),
  │ chain hint (etherscan → ethereum, pump → solana, RH → robinhood), gas from the text (0.0016–0.002 ETH),
  │ signs of injection (commands to the bot, Morse, base64) and account compromise (connect wallet + urgency + link)
  ▼
trust/trust.ts — trust score (section 2)
  ▼
extract/extract.ts — Claude Haiku 5.5, JSON by schema only, no tools.
  │ The code drops any addresses, functions, arguments and links that are not literally in the text.
  │ Chatter without addresses/links/code/tickers is not sent to the model.
  ▼
decide/decide.ts — decision (section 3) → risk/risk.ts — size (section 4)
  ▼
exec/paper.ts — paper execution at the real DexScreener price, 1% slippage, gas
exec/exits.ts — memecoin exits (section 5), checked once a minute
  ▼
store/db.ts — SQLite journal: messages (text is erased after 7 days), decisions, positions, markouts
notify/telegram.ts — cards for you: 🆘 help (captcha, KYC, role), 📝 trades, 📊 daily report
jobs.ts — markouts (price 5 min / 1 h / 24 h / 7 days after the signal), report at 00:05 UTC,
          auto-downgrade of weak sources
safety/firewall.ts + simulate.ts — signature filter and simulation check (ready and covered by tests;
          wired into the live executors in the next step)
```

---

## 2. Trust scores (your rules)

- The author's score, if the author is in the table. An author can be listed for a specific server or for all servers (empty server).
- An author without a score gets 0. **Exception:** in a channel with a score > 6, an author without a score gets the channel's score.
- A channel without its own score takes the server's score.
- The agent **lowers** a source's score on its own: with ≥ 5 signals and a negative median 24 h price — by 1 per day, with a message to you. Only you can raise it — via the CSV.
- A message with signs of account compromise (connect wallet / claim + urgency + link; a request to sign permit/approve-all/7702) gets a score of 1, whoever wrote it.

| Score | Tier | What the agent does | Bucket share per action |
|---|---|---|---|
| 0–3 | journal | Journal and markouts only: collecting stats on unknown people too | 0 |
| 4–6 | full | Full quality + safety checks | `perActionShareByTier.full` |
| 7–9 | fast | Reduced quality checks + all safety checks | `perActionShareByTier.fast` |
| 10 | follow | Quality checks skipped, safety checks remain | `perActionShareByTier.follow` |

You set the shares yourself in `server/config/risk.json`; sample values are in `server/config/risk.example.json`.

Table: `server/config/trust-sources.csv` (sample — `trust-sources.example.csv`). List the servers, channels and authors you read and assign the scores yourself. To check what was read: `npm run check`.

---

## 3. Decisions by message type

| Type (extracted by the model) | Decision |
|---|---|
| Token call (buy) with an address | DexScreener checks (+ RugCheck for Solana) → buy with an exit plan. A repeated call on the same token — no add-on buy, counted as one more mention |
| Contract call / mint | Direct call from a single-use wallet after simulation. If gas costs more than the `maxGasShareOfCapital` share of capital — skip with a "missed: gas" note (with a small capital this is almost every mint on Ethereum) |
| Task on a website (swap, pool, deposit for points) | A browser session with a single-use wallet through the signature filter |
| Captcha / KYC / Discord role needed | 🆘 card to you in Telegram |
| Social tasks | Score ≥ 7 → card to you; later — the agent's X account |
| News, listings, unlocks, points with no action | To the journal → digest for the strategist |
| Scam warning | Addresses and domains → blacklist |
| Start time in the future | Deferred until the UTC time |

**Token checks.**
- **Safety, at any score:**
  - a tradable pair exists;
  - no freeze/mint authority (Solana);
  - not "buys only, no sells".
- **Quality at score 4–6:** liquidity ≥ $10k, pair age ≥ 10 min, ≥ 50 buys in 24 h, FDV ≤ $50M, RugCheck not "high".
- **Quality at score 7–9:** liquidity ≥ $3k.
- **Quality at score 10:** not checked.

---

## 4. Risk (server/config/risk.json — you set the numbers; sample — server/config/risk.example.json)

- Starting capital — `initialCapitalUsd`. Share of capital in the "Hunt" bucket — `huntBucketShare`.
- Minimum action — `minActionUsd`. No more than `maxOpenPositions` positions at once.
- Gas: an action is skipped if gas costs more than the `maxGasShareOfCapital` share of capital or the `maxGasShareOfAction` share of the action amount.
- **Daily stop:** the bucket's loss for the UTC day (realized + unrealized) ≥ the `dailyLossStopShareOfDayStart` share of the bucket at 00:00 UTC (option C) → new entries are blocked until 00:00 UTC.
- **Hard stop:** capital < the `hardStopEquityShare` share of the starting capital → everything stops, with a message to you.
- The final check before any trade (`assertWithinLimits`) throws an exception if a limit is exceeded. A fuzz test on 5,000 random cases confirms that the limits are not exceeded.

---

## 5. Memecoin exits (the `memecoinExit` block in risk.json; your own numbers)

1. Stop loss `stopLossPct` from entry.
2. At the `takeProfit1x` multiple, the `takeProfit1Share` share is sold.
3. The rest — a trailing stop `trailingStopPct` from the peak.
4. After `timeStopHours`, if the gain is < `timeStopMinGainPct` and the first take-profit has not triggered — a time-based exit.

Later (stage S-07) exit profiles by token class were added — the `memecoinClasses` block: a sell ladder, price behavior checks, an emergency floor and a "tail". Sample — in `server/config/risk.example.json`.

---

## 6. Signature filter (code, at any score)

- **Allowed:**
  - sign-in by signature (EIP-4361 / "Sign in") if the domain matches the site;
  - approve for the exact amount to the expected contract;
  - a call to the expected contract;
  - withdrawal to the treasury.
- **Forbidden:**
  - `eth_sign`;
  - any typed data with Permit / Order / Delegation / Transfer;
  - EIP-7702;
  - unlimited approve;
  - setApprovalForAll outside the allowlist;
  - token transfers to a third-party address;
  - a call to an unexpected contract;
  - value above the limit.
- **Simulation** (`eth_simulateV1`): nothing may leave our wallet except gas and the payment. If the RPC cannot simulate, the action is not executed.

---

## 7. Protections added after an independent code review

- **Signature filter.**
  - Transactions go only to the action target, the action's tokens and the treasury; value — only to the target or the treasury.
  - ERC-1155 and ERC-777 transfers, transferAndCall, approveAndCall, Permit2 are recognized.
  - The calldata length is checked. Any parse error = forbidden. The `input` field cannot override `data`.
  - A plain login is allowed only if the text contains the site name; SIWE — strictly by format.
  - The chain is switched only to the expected one; the site cannot add chains.
- **Simulation.**
  - Runs with the same gas fields as the real transaction (`validation: true`): a contract cannot "detect" the simulation.
  - Catches ERC-1155 and third-party approvals.
  - For swaps, the specific expected asset and minimum are checked, not just "something arrived".
- **Risk.**
  - Messages are processed strictly one at a time: two simultaneous calls will not open two positions.
  - Mints and sites are also stopped by the daily and hard stops.
  - Capital, cash, the daily result, the hard stop and open positions are persisted and survive a restart. Only you can clear the hard stop.
  - Open positions are marked to market every minute — the stops see unrealized losses too.
  - Exit gas and mint costs are accounted for in paper.
- **Trust.**
  - A channel downgrade is counted toward the "> 6" threshold.
  - Auto-downgrade works with any letter case in names and does not repeat on old signals.
  - A CSV from a localized Excel (`;` and a comma as the decimal separator) is read correctly.
- **Model.**
  - Addresses are accepted only on an exact match with those found in the text (Solana — case-sensitive). Links and arguments — exact too.
  - Gas and chain come from the text; the mint price — only from "N ETH" amounts present in the text.
  - Model confidence below 0.5 → journal only.
  - An address found only in a quote (someone else's message) is not executed.
  - The data block in the model request is wrapped in a random marker.
  - Suspicious messages are not sent to the model.
- **The blacklist** is fed by warnings only from sources with a score ≥ 4. Common domains (x.com, dexscreener, etherscan…) never go into it. All links in the text are checked.

**Known limitation:** the author is identified by the message author's display name. An impostor in a source can take a trusted caller's nickname. Mitigation — give high scores to authors on a specific server (not "on all servers") and, if intake can pass the user ID, switch to IDs.

## 8. Next steps (in progress)

1. **Live executors:**
   - Solana — buy and sell via Jupiter;
   - EVM — viem, simulation + filter;
   - single-use wallets: creation, funding from the treasury with exactly the needed amount, sweeping the remainder.
2. **Browser sessions:** Chromium on the server, our own wallet provider through which every signature request goes into the filter. Actions on the site are performed by Claude.
3. **Telegram:** "done / skip" replies to help cards.
4. **Deferred actions** by UTC time.
5. **Launching the agent's own memecoins** via a launch tool: a bundle with public addresses and a locker.
6. **Strategist** (Opus 5.5): reads the news and points digest every 30 minutes.

---

## 9. Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (once) |
| `npm run check` | Self-check: keys, trust table, risk |
| `npm run tg-chatid` | Find your Telegram chat_id |
| `npm start` | Start the agent (paper) |
| `npm test` | Tests |
