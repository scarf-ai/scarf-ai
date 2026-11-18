# AGENT — analyst layer: alpha channels, chats, NFT, posts (version 0.2, 2026-10-22 UTC)

Based on the owner's decisions of 2026-10-22 09:42 and 10:03 UTC. Code: `src/intel/`, `src/gate/`, `src/analyst/`, `src/posts/`, `src/llm/`. Deployment: an internal server deployment guide. Tests: `test/intel.test.ts`. 132 tests in total, all passing, 13 of them regression tests from an independent review. Mode — paper.

---

## 1. Two channel modes

| Mode | Channels (default) | What happens |
|---|---|---|
| **opus** | alpha, core-calls, degen, member-calls, core-alpha, scan-feed | Every substantive message gets an analyst review. "gm", "lol" without links or topics — no |
| **chat** | chat, token-chat, success | Every message is read by the gatekeeper (code rules + Haiku with context). It calls the analyst only when there is a reason |
| **ignore** | — | The channel is not read |

The mode is set by the `mode` column in `server/config/trust-sources.csv`. Empty → by channel name.

**Models:**
- **Opus 5.5** — all alpha channels.
- **Sonnet 5.5** — memecoin scans `ServerB/scan-feed` (the owner's decision: "a simpler model"). Configured in `server/config/gate.json`, section `channelModels`.
- **Haiku 5.5** — the chat gatekeeper.

---

## 2. A message's path

```
Discord (intake server)
  │ timestamps <t:…> → "2026-10-22 23:25 UTC", <#…> → #channel, <@&…> → @role
  ▼
channel mode (opus / chat / ignore) · trust score · injection check (anything suspicious goes to no model at all)
  ▼
entities (code): EVM/Solana addresses, $tickers, project domains, X accounts, NFT collections (OpenSea / Magic Eden)
  │ the mention is recorded right away → "noise" within a server and across servers is computed from it
  ▼
chat: gatekeeper ──── not interesting → journal only
  │ interesting
opus: immediately
  ▼
project cards (a message is split into blocks: two projects separated by "=====" — two cards)
  ▼
repeat protection: project already reviewed < 24 h ago and no new data → do not review
  │ (exceptions: an alert on our position; a "watch" project + new noise, at most once an hour)
  ▼
dossier (code): DexScreener, RugCheck, OpenSea (drop, phases, floor), X, domain age, site text
  ▼
analyst: the surrounding conversation + dossier + project history + portfolio → can request more data on its own
  │ (read-only, up to 5 requests) → JSON verdict
  ▼
verdict → address check → decide() → risk gate → execution (paper) → Telegram card + post draft
```

---

## 3. Chat channels: batches of 50, Haiku first, then Opus (the owner's decisions of 2026-10-22 and 2026-10-23 06:56 UTC)

Previously, every chat message with an address or from an author with a score ≥ 7 went to Opus on its own: $0.01–0.04 per message. Then — batches of 30 straight to Opus. Since 2026-10-23 it works like this:

1. Chat channel messages accumulate in a buffer. The buffer is stored in the journal and survives a restart.
2. **Step 1 — Haiku (triage).** When 50 have accumulated → Haiku reads the whole batch: number, time, author and their score, text. No dossier and no tools. It answers one thing: whether to call Opus, which messages to look at, and why.
   - It escalates if there is: a token, contract or mint link that people are buying or minting; a launch, mint, listing, airdrop or points task with a date or link; an action from an author with a score ≥ 7; several people excited about one project; a credible alert (rug, exploit, dev sold).
   - It does not escalate: chatter, price talk without a project, questions, memes, old news.
   - Message numbers and names from Haiku are verified by the code (non-existent ones are dropped).
3. **Step 2 — Sonnet (option 2, the owner's decision of 2026-10-23 07:58 UTC)**, only on a Haiku signal:
   - sees only the messages flagged by Haiku and up to 10 context messages before them (2 before each flagged one, the rest before the first), in the original numbering; no flags — the last 15;
   - a note "cheap triage flagged it: … — look first at messages [n]";
   - a narrower dossier: up to 2 tokens, 1 X account, 1 page, up to 7000 characters;
   - 2 tool calls (previously 5): every call re-reads the whole review, which is what made it expensive;
   - its own daily UTC limit — `AGENT_CHAT_DAILY_USD=1`. Exhausted → Haiku keeps triaging, flagged batches go to the journal only. Model — `AGENT_CHAT_REVIEW_MODEL` (default `claude-sonnet-5-5`).
   - Before: Opus on the whole batch ≈ $0.13. Now (estimate): ≈ $0.02–0.03.
4. The analyst answers with a single verdict: what is worth acting on, what is worth watching, what is noise.
5. Every action references the number of its source message:
   - the address is checked against the text of that very message;
   - the action is executed with the score of that message's author;
   - a warning message ("rug", "scam", "avoid") cannot be the source of a buy, even from a trusted author.
6. **With no waiting, no Haiku, and in full (to the analyst through the regular queue, Opus)** goes only an alert about something the agent holds (rug, exploit, dev sold next to our token). Exit — if the author's score is ≥ 4, otherwise ⚠️ to the owner.
7. **Slow chat:** if a batch has not filled up in 3 hours but has ≥ 5 messages, it goes to step 1. Any batch goes after 12 hours.
8. Haiku limit exhausted → the batch goes to the journal only. Haiku's answer failed to parse or the API is down → journal only as well.

Batch size and wait time — `AGENT_CHAT_BATCH=50`, `AGENT_CHAT_MAX_WAIT_MIN=180` in `.env`. Every triage is written to the review log (`trigger = chat_triage(50)`, verdict `ignore` / `escalate`). Mentions and per-server "noise" are still counted by the code for every message, at no cost.

**Estimate:** triaging a batch of 50 ≈ $0.0005 on Haiku. A Sonnet review ≈ $0.02–0.03 — only for batches where Haiku found something, and no more than $1 a day.

**Review cache (all models).** The review text is marked for caching: the second and later tool rounds read it at 0.1× the input price. This also makes Opus reviews in alpha channels cheaper.

In the service journal (`journalctl -u agent`) every message produces a line: `chat: buffered 12/50`, a skip with a reason, or the review result.

## 4. Analyst

**Receives:**
- the shared brief `server/config/agent-brief.md` (English, the same for all models) — the main goal: grow capital as fast as possible using access to private communities of experienced traders; the rule "not losing matters more"; what counts as a scam; what the agent can and cannot do;
- the message and the conversation around it;
- the project history: how many authors and servers mentioned it over 24 hours, the previous verdict;
- the dossier and the portfolio.

**Can request on its own (read-only):** the token's market, an X profile and X search, domain age, page text (only links from messages and the dossier), mention counts.

**Returns:**
- a verdict: `act` / `watch` / `ignore` / `avoid`;
- a verdict per project, if there are several;
- scores: source, socials, mechanics, team, market, timing;
- thesis and risks;
- actions;
- exits from our positions;
- an NFT exit plan (flip / hold, target, deadline);
- recheck times;
- a public line for the post.

**What the code does with the verdict:**
- Confidence < 0.6 → journal only.
- **Addresses:** only from the Discord text, or an NFT contract obtained by the code from OpenSea via a collection link in the message. An address from a website or an X post is never accepted.
- **Whose score:**
  - address in the message itself → the author's score;
  - address only in the quoted message being replied to → act only if the replier's score is ≥ 7 (confirmation);
  - address from a message above that the gatekeeper explicitly pointed to → the replier's score if it is ≥ 7, otherwise the lower of the two.
  - The whole channel window is not scanned: an address is not "attributed" to whoever posted it first (they may have written "this is a scam").
- **Size:** set by the risk gate. The analyst can only reduce it (`sizeFactor`), never increase it.
- **Own find** (author with a score of 0–3, analyst confidence ≥ `OWN_PICK_CONFIDENCE`, memecoins only): treated as score 4, full checks. Currently **paper only** — pending the owner's decision.
- **An alert on our position** with confidence ≥ 0.6:
  - from a source with a score ≥ 4 → the position is closed;
  - from an unverified one → only ⚠️ to the owner (anyone can write "rug"), stops work as usual.
  - Without a price the position is not closed — retried at the next check.

**Budget (per UTC day):**

| Model | Limit | What happens after the limit |
|---|---|---|
| Opus | `AGENT_OPUS_DAILY_USD` | switch to Sonnet |
| Sonnet | `AGENT_SONNET_DAILY_USD` | at score ≥ 7 — cheap Haiku extraction, otherwise journal only |
| Haiku gatekeeper | `AGENT_GATE_DAILY_USD` | code rules only |

You set the limits yourself in `.env`; the defaults in `src/config.ts` are examples.

Cost is computed from the actual tokens in the API response. The brief is cached: a cache read for Opus/Sonnet costs 0.05× the input price.

**Cost estimate:**
- Opus: ≈ $0.04–0.08 per review → 20–30 messages a day plus rechecks ≈ $1–2.5.
- Sonnet on scan-feed: ≈ $0.02–0.04 per token → 3 new tokens an hour ≈ $1.5–3 (repeats are not reviewed).
- Gatekeeper: ≈ $0.0002 per message.

---

## 3a. Scanner channels (ServerB scan-feed, ServerA token-chat): code first, then the cheapest model (the owner's decisions of 2026-10-22 15:09 and 15:29 UTC)

1. **A free code filter** (DexScreener + RugCheck). A token goes to the model only if:
   - there is a tradable pair;
   - liquidity and the number of buys over 24 hours are not below the `scanPrefilter` thresholds in `server/config/gate.json` (your own numbers; sample — `gate.example.json`);
   - there is at least one sell;
   - there is no freeze/mint authority;
   - RugCheck is not "high".

   Filtered-out tokens are written to the journal with their price: after 24 h you can see whether the filter threw away a "hidden gem".
2. **Tokens that pass the filter are reviewed by Claude Haiku 5.5:** ≈ $0.001 per scan instead of ≈ $0.02 with Sonnet. No more than 2 extra data requests per scan.
3. **A repeat scan** of the same token within 24 h is not reviewed.
4. **Limit:** the shared Haiku limit, `AGENT_GATE_DAILY_USD` (its own daily limit).

Filter thresholds — `server/config/gate.json`, section `scanPrefilter`. The list of scanner channels is there too, `scanChannels`.

**ServerA token-chat** works the same way. A message without a token address (conversation) is not shown to the model; a message with an address goes through the code filter, then Haiku. Batches of 30 are disabled for this channel.

## 3c. A low-score source: research rather than filter out (the owner's decision of 2026-10-23 07:07 UTC)

Case: a Rick bot card with the KEG token (BNB), author score 0. Haiku answered ignore (0.9): "no thesis, catalyst or human commentary", and BNB was not supported at the time. The owner's position: a low score is not a reason to filter out. The agent should go to X and the website itself, understand the subtext, compare with current trends, and decide with maximum skepticism.

Now, if the source's score is ≤ 3 (and it is not a "careful" team call) and the message contains a token:
1. **Trends are added to the dossier by the code** (`dossier.trends`):
   - trending pools on the token's chain (GeckoTerminal);
   - tokens with a paid boost (DexScreener) on that chain;
   - what our communities have discussed most over 24 hours.
2. **A LOW-TRUST RESEARCH instruction is added to the review.** The post proves nothing on its own and is not a reason to filter out. The model checks:
   - the token's X: age, followers versus engagement, who mentions it;
   - the website and domain age;
   - narrative and subtext: whether the token rides a live trend or copies someone else's name;
   - on-chain flow: liquidity versus FDV, buys and sells, volume;
   - red flags.
3. **Acting is allowed only on its own thesis**: a strong thesis and confidence not below the "own finds" threshold (`OWN_PICK_CONFIDENCE` in code). A quick trade is fine. A refusal must name what the research found, not "the post has no thesis".
4. **Tool budget — 6 calls** (usually Haiku 3, Opus 5). The new `trends(chain)` tool is always available to the analyst.
5. The model does not change: scans still run on Haiku, per the owner's decision.

**Manual recheck:** `npm run recheck -- <address|ticker>` queues the project with a "now" deadline. The agent rebuilds the dossier and reviews the original message again.

## 3b. Perps: longs and shorts from calls (2026-10-22)

Position calls like "opened a low-leverage BTC long" used to end up as "watch": the agent had no such trade type. Now there is `perp_trade` — paper at Hyperliquid prices.

- **The asset** must be named in the message text (BTC, $ETH, bitcoin…).
- **Stop and take-profit are mandatory.** The analyst sets them from the call's levels. If the stop is missing or on the wrong side, the code sets a default stop and take-profit (`perp.defaultStopPct`, `perp.defaultRewardRisk`).
- **Leverage:** from the call, but no higher than `perp.maxLeverage`. Liquidation must be at least `perp.liqBuffer` times farther than the stop.
- **Size:** the loss at the stop including fees ≤ the `perp.riskPerTradeShare` share of capital. Margin ≤ the trust tier cap. The numbers — the `perp` block in `risk.json`, your own.
- **Exit:** strictly at the stop or take-profit (checked once a minute) or on an analyst alert. A 0.05% fee on entry and exit. Funding is not accounted for yet.
- **With a small capital** the position notional may be below the Hyperliquid minimum order ($10): fine for paper, live needs more capital.
- **Hedging** is not done yet — a separate decision.

## 3c-2. Token address from the project's official X (the owner's decision of 2026-10-23, the LARPCHECK case)

Previously, the address (CA) was taken only from the Discord message text. Now it can also be taken from the project's official X. The code checks three conditions:
1. **The X account comes from the message itself** (`@handle` or an x.com link): the Discord source itself pointed to whose project it is.
2. **The address is taken from that account's bio or from its own post.** Replies, other people's posts and websites do not count: fake CAs are often planted there.
3. **DexScreener confirms:** a trading pair exists, and either the token profile links to the same X, or the token's ticker matches the ticker in the message (if a ticker is named).

If the message has no address but does have the project's X, the code itself looks for a CA in the account's bio and recent posts and puts what it finds into `dossier.officialCas`. The analyst may act on such an address. The decision reason states where it came from ("in the bio of @…", "posted by @…", "DexScreener profile links @…").

## 3c-3. The project's @handle in an X thought (A-08, the owner's decision of 2026-11-11 08:50 UTC, acceptance #69, round 3)

The handle in a post is set by the code (`withHandle`), and only a confirmed X of **the same** project. Each X found is stored together with its entity: `dossier.projectX[] = {entity, name, handle, how}`.

Where candidates come from:
- collection — the OpenSea page and X links from the collection's website;
- token — the DexScreener profile and X links from the websites listed there;
- name (a project without an address or collection) — X links from the message itself and an X search by name.

A tweet link (`/status/`) and service pages (`/i/…`) are not counted as an account. Social networks and services (t.me, linktr.ee, discord, x.com, opensea.io, medium, etc.) are not the project's website.

When a candidate is confirmed (`confirmProjectX`):
- **token** — only by a cross-link to its address: the address is in the X bio, in X posts (search `from:<handle> <address>`) or on the website next to a link to this X. The DexScreener profile is self-declared: a clone lists the real project's X and website.
  - Round 3, items 1–2: the token's website and "twitter" come from the DexScreener profile, which the deployer fills in. So the website counts only if the X itself links to it in the bio. An X post with the address counts only if the X bio links to that address (the token website from DexScreener does not count — the deployer fills it in). Tokens that the code cuts off without the model (A-16) do not confirm a project X — there are no paid X requests for that. This way a caller whose tweet appears in the token profile does not become the token's X.
- A handle found by name (`name:`, `collection:`) is not attached to a token thought: the thought card has `evm:`/`sol:`/`ticker:` or the topic starts with `$` (round 3, item 3). An X search by name is not run for such thoughts.
- **collection or name** — a strong argument: the collection's OpenSea page points to the X, the project's website links to the X, or the X links to the website or a collection from the dossier. Otherwise a similar handle and ≥ 2 smart followers are required, or 1 smart follower and a mutual link with a collection of the same name. A similar handle — equal or a prefix, if the name has at least 6 characters and the handle is no more than 4 characters longer than the name.
- The verification checkmark only orders the candidates; the follower count is not considered. If two candidates are tied with no strong argument, no handle is set.
- Rejection reasons (rejected, tie, smart list not ready, OpenSea or X failure) are written to `dossier.errors` and to the journal (`project_x`).

When:
- tokens and collections are confirmed in the dossier, before the model, with a 5 s limit;
- the name search runs after exits and trades, also with a 5 s limit; the result is cached for 24 h (`kv xname:<name>`).

If the handle was not confirmed in time, the thought goes out without it.

## 3d. Memecoin exit plan — from the analyst (2026-10-23, after the first SWARMX trade)

The analyst sets the exit right in the intent; the code applies the numbers:
- `stopLossPct` — tightening only: from 5% up to the stop in `risk.json`;
- `takeProfitX` (×1.05–×100) and `takeProfitShare` (25–100%, 1 = exit fully);
- `sellByHours` — sell by the deadline regardless of the result, no later than the default deadline.

Without these fields — the `risk.json` values. Memecoins are checked every 15 s (NFT, perps, bets — once a minute). The monitor no longer waits in the shared queue behind the analyst: the executor has its own position lock.

## 3e. Prediction markets — Polymarket (paper; the owner's decision of 2026-10-23)

1. A `polymarket.com/event/…` or `/market/…` link in a message → the code fetches the market from the Gamma API:
   - question, outcomes, resolution rules, end date, volume, liquidity;
   - the best prices for each outcome from the CLOB order book.
2. The analyst estimates the probability itself. Edge = its probability − price − fee (fee = category rate × p × (1 − p)). It acts (`prediction_bet`) only if the edge is ≥ 5 points and the rules are unambiguous.
3. The code checks:
   - the market is in the dossier and comes from a link in the source message;
   - the market is open, ≥ 30 min before resolution;
   - price 0.02–0.97, spread ≤ 0.10, price not above the analyst's limit;
   - size by the source's score;
   - ≥ 5 shares — the venue minimum.
4. Position: exit at the target, stop or deadline at the best bid; otherwise — settled at resolution ($1 per share of the winning outcome).
5. Live — only after legal confirmation. Polymarket blocks the US and a number of other countries.

## 3f. Buying NFTs on the secondary market (2026-10-23)

`nft_buy`: the collection comes only from the OpenSea dossier via a link in the message. Price — the floor from the code, no higher than the analyst's `maxPriceEth`. Size — by the source's score; the "gas ≤ 20% of the trade" rule applies. Exit — by `nftPlan`; in live — selling into the best OpenSea offer.

## 3g. Real execution (shadow / live)

- `AGENT_EXECUTION=shadow` — next to every paper trade a real transaction is built: route, signature filter, simulation. Nothing is sent. The result arrives in Telegram marked 🔬.
- `live` — only with `AGENT_MODE=live` + `AGENT_EXECUTION=live` + `AGENT_LIVE_CONFIRM=yes` and unlocked keys.
- Routes:
  - Ethereum, Base, Arbitrum, BNB — KyberSwap (the router is pinned; a different address from the API — rejected);
  - Robinhood — the Pons v2 curve or a v1 pool;
  - Solana — Jupiter.
- FCFS minter (`src/live/minter.ts`):
  - the number of wallets — by EV per wallet, within the `live.mintMaxShareOfEquity` share of capital, capped at `live.mintMaxWallets`;
  - 3 min before the start: funding the wallets, OpenSea calldata, an "at start" simulation, signatures;
  - at the start (Ethereum — at the slot) all transactions go out simultaneously to all RPC lanes.
- Launch details are in an internal live deployment guide.

## 3h. X research, website and code cutoffs (2026-10-27)

Trigger — the OOLONG review. The analyst wrote that there was no X account and the website was empty. In fact the X request had failed, and the website was a JavaScript app.

**A failure is not an argument "against".** If a check fails, the analyst sees it as a failure:
- `LOOKUP FAILED (…) — unknown, not evidence` — an X failure, credits or rate limit;
- `unchecked` in the dossier;
- `age unknown` — the `.trade`, `.fun` and some other zones have no domain age data (RDAP).

The words "no account" are allowed only if X explicitly answered "user not found".

**X research by code before the model** (`src/analyst/xresearch.ts`, all in parallel, 2–4 s, ≈ $0.02–0.04 per project, 30 min cache):
- profile: age, followers, links from the bio; the website from the bio is read too;
- the project's own timeline by userId: how many posts, when the last one was, average likes and views, the 3 best posts. It is visible even if X has hidden the account from search — then a `hiddenFromSearch` flag is set;
- who writes about the project: `$TICKER` (Top and Latest), the address, `@handle` (excluding the project's own posts). For each query — how many posts and distinct authors, freshness, likes and views, notable authors (5K+ followers and smart accounts), the top 5 posts;
- followers — a sample of new ones, up to 600:
  - notable (10K+ followers);
  - **smart accounts** from `server/config/smart-accounts.csv` — by name within the sample, by ID among all followers (up to 5K);
  - the share of empty accounts and accounts younger than 30 days — a sign of inflated numbers;
- narrative: chain trends (GeckoTerminal, DexScreener) and discussions in our communities — now for any token, not only for low-score sources.

**Website.** The title, description (meta) and useful links are read: X, Telegram, docs, GitHub, app. If the site is a JS app (`jsApp`) or nearly empty, its documentation is read through the links on the site itself. The analyst is told explicitly: little text on a JS app is normal.

**One or two rounds instead of four to six.** The data is collected in advance, so the tool limit is 2, and 3 for low-score source research. The dossier is passed without empty fields; page text is trimmed to 1,500 characters.

**Code cutoffs, without the model** (`src/checks/hardcheck.ts`) — facts only:
- a honeypot per the honeypot.is simulation (Ethereum, BNB Chain, Base) or a sell tax of 50% or more;
- on Solana the token still has mint or freeze authority;
- 30+ buys and 0 sells over 24 hours;
- liquidity below $3K — only for sources with a score ≤ 6 and only for pairs older than an hour: fresh tokens on the Pons curve start with small liquidity.

There is **no** "pair older than 30 days and −90%" rule: tokens and NFTs make comebacks (the owner's call). The cutoff fires only if all tokens in the message are cut off and it contains no NFTs or prediction markets. The reason is visible in the journal and in `npm run why`. A repeat of the same token after such a cutoff is not reviewed for 7 days.

## 4a. Team calls in channels with a score ≤ 6 (the owner's decision of 2026-10-22 12:25 UTC)

Team channels with a score of 4–6 can be marked `inherit=careful`. Authors without their own score get the channel's score, but with "maximum caution":

1. **No analyst — no trade.** If the analyst limit is exhausted, the call goes to the journal only.
2. **The analyst sees a CAREFUL SOURCE flag.** A trade is possible only if:
   - confidence ≥ `careful.minConfidence`;
   - thesis strength ≥ `careful.minThesisStrength` out of 10;
   - expected hold ≤ `careful.maxHoldHours`.

   A weak thesis or a long hold → skip, with the reason recorded.
3. **Extra market checks:**
   - liquidity ≥ `careful.minLiquidityUsd`;
   - buys over 24 hours ≥ `careful.minBuys24h`;
   - sell-to-buy ratio ≥ `careful.minSellBuyRatio` (there is someone to sell to);
   - RugCheck present and not "high".
4. **Size** is multiplied by `careful.sizeFactor`.
5. **Stricter exits** — the `careful.exit` block (stop, take-profit, trailing, time-based exit).

Authors with their own score follow their own score without these restrictions. Values — in `server/config/risk.json`, section `careful`.

## 5. NFT and OpenSea

From a collection link, the code fetches the drop, the collection and the stats, then computes on its own:
- how much is reserved by whitelists (wallets × limit) and how much will remain for the public sale **at minimum**;
- whether the whitelist is over-allocated;
- the public sale price and duration;
- the break-even floor = (public price + mint gas) / (1 − sale fees).

**Exit price** (lesson from Lanternfolk 2026-10-22): max(best collection offer, median of secondary sales over the last hour, from sale events). Without them — floor × 0.8. OpenSea's "sales / volume" stats are not used: OpenSea counts drop mints (including free ones at 0 ETH) as sales.

**Project socials.** The dossier itself takes the X and website from the token's DexScreener profile and from the OpenSea collection page, even if the message has no links. For X: the profile, the project's recent posts and who writes about it.

**Mint by the numbers** — `nftAutoMint.windowMinutes` before the public sale and during it. All three conditions are required (the numbers — the `nftAutoMint` block in `risk.json`, your own):
- exit price ≥ break-even × `minFloorToBreakEven`;
- sales over the hour ≥ `minSales`;
- share of the whitelist minted ≥ `minWlMintedShare`.

The model can only veto (avoid). 1 item per wallet.

**Automatic rechecks:**
- 30 minutes after the first phase starts (demand);
- 30 minutes before the public sale.

The analyst can add its own.

**Ethereum gas** — at the live price from the RPC (refreshed every 2 minutes; an action ≈ 180,000 gas × 1.3). The fixed floor of 0.0015 ETH remains only for when the RPC does not respond.

**NFT position in paper.** Valued at the OpenSea floor. Exit:
- **flip** — at the floor when there are sales;
- **hold** — at the target (default ×2) or by the deadline (default one hour before the public sale ends);
- **stop** — floor ≤ 70% of cost after 6 h.

The sale accounts for fees (creator + OpenSea) and the gas for the marketplace approval.

### Lanternfolk — an example (synthetic data in the shape of an OpenSea response; the tests are built on it)

| Phase | UTC | Price | Wallets × limit |
|---|---|---|---|
| Team | 17:15–17:30 | 0 | 1 × 30 |
| Whitelist | 17:30–23:25 | 0 | 2 742 × 1 |
| Public | 23:25 22.10 – 23:25 25.10 | 0.001 ETH | all × 1 |

- Supply 4 444 → at least 1 672 for the public sale. Sale fees 6%.
- Break-even ≈ 0.00116 ETH (at 0.5 gwei gas).
- Rechecks: 17:45 and 22:55 UTC.

**What the agent will do:**
1. First review → "watch".
2. At 22:55 — floor, sales, share of the whitelist minted, socials.
3. If there is demand → a mint is scheduled for 23:25. At 23:25 the decision is made again against the current limits.

**Cap:** the trust tier's share of the bucket is computed from the mint price; gas is checked separately (the owner's decision: option A).

---

## 6. Deferred actions and the watch list

- **A deferred action** is an action with a start time in the future (raffle, public mint).
  - It is written to the journal, and the owner receives ⏰.
  - When the time comes, the decision is made **again**: risk, limits, prices — as of that moment.
- **The watch list** — a recheck of a project at a set time with a fresh dossier, without a new message.
- All of this goes into the same queue as Discord messages: two events cannot take the same limit at the same time.

---

## 7. Posts on X (the owner's rules of 2026-10-22)

- A post — only after a completed action (entry, mint, registration, exit) or a finished review.
- Never name the server, the channel or the caller, and never write "Discord", "group", "caller". The code checks every draft. If it contains a source name, the draft is not created.
- Every post about a token/NFT discloses whether the agent holds a position.
- While in paper and without the owner's "yes" on auto-publishing — only a draft in Telegram (🐦).
- The character's voice will come from the brand persona (Brand). For now it is a neutral first-person template.

**The agent will have its own X account with full access:** it does raffles and registrations itself (the `X TASK` action). Captcha and KYC → a card to the owner.

Rule for signing in to websites via X:
- access is granted only if the verdict is "act";
- access to direct messages is never granted;
- access is revoked after the raffle.

A browser-based executor is the next step.

---

## 7a. Protections from the independent review (2026-10-22)

- **Project cards:**
  - only a source with a score ≥ 4 can merge keys (address + ticker + domain) — someone else's collection cannot be "stitched" onto a known project;
  - ids are recomputed after a merge — no crash.
- **Rechecks** take addresses and collections only from the original message. If the text has already been erased (7 days) — the review goes to the journal only, with no actions.
- **Everything untrusted is inside data markers:** the author's name, the gatekeeper's note, card names and theses, tool responses (websites, X posts).
- **Deferred actions:**
  - the same action is queued only once;
  - when the time comes, the score is recomputed (with downgrades); for NFTs — fresh OpenSea data: whether it sold out, whether the public sale is on, the price.
- **Time without a zone** is treated as UTC, not as the server's time.
- **Repeats:** a message from a trusted author (≥ 7) is reviewed even if an unknown person posted the token before. Reviewed keys accumulate.
- **The position monitor** runs in the same queue as messages; passes do not overlap.
- **Websites:** the connection goes exactly to the verified IP (protection against DNS spoofing); all non-public ranges are blocked.
- **Model spend** is counted even when the analyst fails.
- **Gas:** the larger of the hint in the text and the live price is used.
- **Posts:** checked against all servers, channels and authors in the journal, including names like "caller1".
- **NFT:**
  - a free mint opens a position (cost — gas);
  - Magic Eden is not looked up via OpenSea;
  - without a floor an NFT is not sold "for zero".

## 8. The owner's decisions on open questions (2026-10-22 10:57 UTC)

1. **NFT mints** — option A: the tier cap is computed from the mint price; gas has its own rule (the `maxGasShareOfCapital` share of capital).
2. **The analyst's own finds** — paper only for the first day. A separate line in the daily report; the decision after that is based on the numbers.
3. **X data** — twitterapi.io, the key in `.env`.

## 9. Not done yet

- Live executors:
  - EVM / SeaDrop mint with simulation and the signature filter;
  - Solana / Jupiter;
  - a browser with a wallet provider;
  - the agent's X account (raffles, posts).
- "done / skip" replies in Telegram.
- Magic Eden and other NFT venues (currently OpenSea data only).
- The analyst has never run on live messages with real models — the tests use mocked responses. The first run — in paper on your PC.

---

## 10. What code can decide instead of the model (A-12, #83; the owner's decision of 2026-11-11 ~08:00 UTC)

Goal: move functions from the model to the agent's own code where possible, to save model credits. The rule: the code answers on its own only if the data is **complete and confirmed**. Otherwise — the model, as before.

**Where the numbers come from.** The review log 2026-10-29 19:08 … 2026-11-10 10:31 UTC: 11.6 days, 534 reviews. 493 of them are no-credit errors, but the message text and the dossier are in the log for them too. So "how many reviews a rule would have closed" is computed over all 534, while verdicts are visible only for the successful ones. Counts are per day; Cost computes the dollar figures from its own log for 10–11.11. To recompute: `npx tsx src/intel/modelToCodeSim.ts server/data/review/review-<period>.jsonl`.

Each item is enabled **by its own card** under the internal cost-gate procedure: shadow ≥ 2 days, Cost's numbers, the owner's "yes".

### 10.1. Decisions the code can make

| # | What the code decides | On what data | Incomplete data → | Reviews per day (log) | Complexity | Verdict schema |
|---|---|---|---|---|---|---|
| K1 | **A chain the agent does not trade on** (Cost candidate 1). The only entity is a token on a chain outside the traded list (Solana, Robinhood Chain, Base, Arbitrum, BSC, Ethereum), and nothing else (mint, task site, collection) → `ignore` by code, like `hard_check`. | The pair's chain from DexScreener (`market.chain`) — before the model | Chain `unknown` (pair not found) is not a "foreign chain": model | 0 in this log. Cost's MONTRA on Elysium case, $0.17 Opus — in the 10–11.11 log | Low: a check in `analyzeAndAct` next to `hard_check` | No |
| K2 | **NFT sold out** (candidate 2). `minted ≥ maxSupply` per OpenSea → no recheck needed; review only for a secondary trade (needs a collection link in the message) | OpenSea `drop.max_supply`, `total_supply` | No `maxSupply` or `minted` — model | 0.7 (8 Opus reviews: sold out, 5 of them scheduled rechecks) | Low: in `recheckDue` — as already done in `runScheduled` | No |
| K3 | **The message has no entities at all** (candidate 3): no address, link, ticker, @, domain, perp asset (the code finds them), and no words long/short/leverage. **Initially only for scheduled rechecks**: an original message without entities has nothing to recheck | `codeEntities` and perp assets from the text — code | There is a perp asset, or it is a reply to a message with entities — model (a "Long XMR" call without $ — model too) | 5.8 (67 reviews, 65 of them Opus: "Today's Parlay", "if you have money on nance"…). How many of them were rechecks — 0 in this log; in Cost's data "gMinted" was rechecked 4 times | Low for rechecks; for regular messages — only after shadow: the model has the conversation window | No |
| K4 | **Scanner bot card → structure** (candidate 4). Rick/ServerB/Bark: FDV, liquidity, age, 1h, holders — the code parses the card into fields; the model gets a data line instead of the card text. It does not remove the review but makes it cheaper and reduces false "new keys" (A-05) | Card text: a stable format (`FDV:`, `Liq:`, `Age:`, `TH:`) | Not recognized — text as is (always the case now) | 17.2 cards a day reached the model (200: 182 Haiku in scan-feed, 18 Opus). Savings — in input tokens; idea 4 (`batch-compact`) already measures this in shadow (A-11) | Medium: parsing the formats of 3–4 bots, tests on live cards | No (only the review text changes) |
| K5 | **A repeat with no new data** — batches (idea 1), `ignore` rechecks (idea 2a), merging within 3 min (idea 3) | Project cards, journal | — | See A-11 (#82): `cost_shadow` events are already being written | Done in shadow | Idea 2b: a `watch` condition field |
| K6 | **The code checks the `watch` condition** (idea 2b). The model writes the condition as a structure (`{metric: 'fdvUsd', op: '>', value: 170000}`), the code compares it with the fresh market: not met — no recheck (but the model at least once every 6 h) | DexScreener — by the address from the card | No market or unknown metric — model | ≈ $0.45/day per Cost's estimate ($Wobblet: 3 Opus rechecks, the condition was not met) | Medium: a schema field (Analyst) + a check function (Cost, `src/cost/`) | **Yes**: `watchCondition: {metric, op, value}` in the verdict |
| K7 | **"Act" with no action** — done in A-09 (#71): a `skip` decision with a reason instead of silence. The model is not needed to explain why there is no trade | Code decisions | — | — | Done | No |
| K8 | **A site task without a human** — done in A-10 (#72): `needsHuman: other` is dropped by the code instead of repeated "help" reviews | — | — | 2 "🆘 other" cards on 11.11 | Done | `steps`, `depositUsd` |

**What NOT to hand over to code** (incomplete data, or the decision needs an understanding of the text):
- **Non-crypto assets** (candidate 6): 4 reviews in 11.6 days (0.3 a day), the signals are unreliable ("Out of stock now" is not stocks, "XOM up 27%" is stocks). Leave to the model.
- **Updates to past calls** ("KNTQ | UPDATE — 2x…"): the model sets `ignore`, but a text rule would also catch new calls. Only after shadow, verifying that no `act` is missed.
- **News and rumors without a token** (the Binance hack on 29.10, 8 Sonnet reviews): they have no entities, but sometimes they matter (exiting a position). Not by code — by merging (idea 3).

### 10.2. Risk rules — decided by Strategy and the owner, not by Analyst

| # | Rule | Data | Reviews per day | Whose decision |
|---|---|---|---|---|
| R1 | **A fresh pool with tiny liquidity** (candidate 5): pair ≤ 10 min old and liquidity < $15K → filtered out by code before the model (like `scanPrefilter` for scan-feed, but for all channels) | DexScreener `pairAgeMinutes`, `liquidityUsd` | 1.4 (16 Haiku reviews: successful ones — 1 avoid, 1 watch) | Thresholds — Strategy (`risk.json` / `gate.json`), the owner's "yes" |
| R2 | The "own find" threshold `OWN_PICK_CONFIDENCE` for authors without a score | — | — | Do not change without the owner (A-09) |

**Suggested order** (by gain and risk): K2 and K3 rechecks (low risk, simple) → K6 (together with Cost) → K4 (after the `batch-compact` numbers) → K1 (when a chain outside the list shows up in the log). K3 for regular messages — only after shadow.
