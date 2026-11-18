# AGENT — Discord as a source of signals and actions (version 2)

Date: 2026-10-22 (UTC). Status: draft, reflects the owner's decisions of 2026-10-22 06:51 UTC.

**What changed compared to version 1.**
- The source is your own separate intake server: messages arrive in categories per source; the bot reads only that server.
- The agent **connects a wallet to sites, sends transactions and completes on-chain tasks**. Safety comes not from prohibitions but from single-use wallets and a signature filter (section 4).
- Trust scores 1–10 that you assign control the speed, size and depth of checks (section 5).

---

## 1. Source: your intake server

```
Sources ──► your "AGENT-intake" server (category = source, channel = source channel) ──► our bot (read-only) ──► agent
```

- You add the bot yourself: you are the admin of your server. This is the official path; Message Content Intent is enabled in the Developer Portal without review.
- **What every message must show**, otherwise trust scores do not work:
  - the source server;
  - the source channel;
  - the author's name;
  - the time in UTC.
- The bot reads only your server; how messages get there is up to you — use only methods allowed by Discord's terms (no self-bots).
- Allowed ways to fill the server:
  - "Follow" for announcement channels (the megaphone icon);
  - manual message forwarding ("Forward") — a way to hand the agent individual finds.

---

## 2. Pipeline

```
1. Intake         bot → database: server, channel, author, UTC time, text, links, code blocks
2. Extraction     Claude Haiku 5.5, no tools → a JSON "intent" (section 3)
3. Trust score    the owner's table + adjustments from the journal (section 5)
4. Checks         safety — always; quality — by score
5. Plan           Claude Opus 5.5 → a step-by-step action plan in JSON
6. Execution      a) direct contract call (viem), no site
                  b) site: a browser on the server + our own wallet provider,
                     every signature request goes through the filter (section 4)
7. Exit           sell or claim by the rules, the remainder goes back to the treasury
8. Journal        message → decision → transactions → P&L per source
```

**Rhythm:**
- the bot reads in real time;
- signals with a score of 7–10 are executed immediately (target ≤ 60 seconds);
- 4–6 — after a full check;
- every 30 minutes the strategist reviews a digest: new protocols, points, unlocks, listings.

---

## 3. What actions the agent can take

| Intent type | Example | How it is executed |
|---|---|---|
| Contract call | Example 2: `claimPacked(2, 128, 2048)` | Directly via viem: the ABI comes from the explorer, simulate, send |
| Swap / pool / deposit in a protocol | Example 1: swaps and pools on a new DEX | First find the protocol's contracts and call them directly; if a site is unavoidable — browser + our wallet provider |
| NFT mint / token claim | A mint at an announced UTC time | Direct call; gas is capped |
| Site registration via wallet | "Connect wallet", sign-in by signature | Browser on the server; sign-in by signature (SIWE) is allowed if the domain in the message matches the site |
| Token buy / short / long | A token call | DEX or perp, SL/TP mandatory |
| On-chain tasks for points | "Do a swap, add liquidity, bridge" | Like swap/pool above |
| Social tasks | Follow on X, retweet | Only from the agent's X account and without spam |
| Captcha, KYC, Discord roles, multiple wallets | — | **Not done by the agent** → a "do it by hand" card to you in Telegram |

Third-party mint tools that require a private key (for example, third-party mint bots) are not used by the agent. It calls the contract itself.

---

## 4. Wallets and the signature filter: how the "empty wallet" becomes real

A wallet that actually does something cannot be empty: it needs gas. In example 2 one transaction costs 0.0017–0.0021 ETH ≈ $5 on Ethereum.

The danger is not only that the funds sitting there get stolen:
- **an approve or Permit** lets someone later drain whatever arrives in the wallet;
- **EIP-7702 delegation** permanently turns the address over to someone else — anything sent there later goes to the attacker.

Hence three wallet tiers:

| Wallet | What it does | What it holds |
|---|---|---|
| **Treasury** | Only transfers to "Operational" and to single-use wallets within limits | The main funds; never connected to sites or new contracts |
| **Operational** | Known allowlisted protocols: Arcus, Uniswap, Polymarket, Steakhouse | Working amounts for the strategies |
| **Single-use** | Everything from Discord: new sites, mints, claims | **Before the action — 0.** The treasury deposits exactly the needed amount + gas right before the action. After the action everything received goes straight to the treasury. A new address every N actions and after any suspicious signature |

**The signature filter is code, not a model. It works at any trust score.**
- **Allowed automatically:**
  - sign-in by signature (text like "Sign in to …") if the domain in the text matches the open site;
  - transactions whose simulation shows exactly what was expected: gas, the mint fee or the swap amount went out — tokens, an NFT or LP came in;
  - approve for the exact amount to the contract being called right now, revoked afterwards.
- **Always forbidden:**
  - `eth_sign` (blind hash signing);
  - Permit / Permit2 and unknown typed data;
  - setApprovalForAll outside allowlisted marketplaces;
  - unlimited approve;
  - EIP-7702 authorization;
  - transactions whose simulation shows assets leaving that we did not send.
- **Limits:** the amount and gas cap per action is set by the score (section 5); the overall daily cap for single-use wallets is the "Hunt" bucket.

---

## 5. Trust scores 1–10

You assign a score to a server, channel or author in the `server/config/trust-sources.csv` table (the template is next to it). If several rows match, the author's score is used, then the channel's, then the server's.

| Score | Mode | Quality checks (project, liquidity, tokenomics, domain age) | Safety checks (simulation, signature filter, single-use wallet) | Size of one action | Sites |
|---|---|---|---|---|---|
| 1–3 | Journal only (paper) + a card to you | — | — | 0 | no |
| 4–6 | Auto after a full check | all | **all** | ≤ the `perActionShareByTier.full` share of the "Hunt" bucket | yes, through the filter |
| 7–9 | Auto, fast path | reduced: the contract exists, there is liquidity | **all** | ≤ the `perActionShareByTier.fast` share of the bucket | yes |
| 10 | Auto immediately, "follow the call" | skipped | **all** | ≤ the `perActionShareByTier.follow` share of the bucket | yes |

**Why safety checks remain even at 10:**
- the main real-world theft vector on Discord is a compromised account of a trusted person or project posting a drainer link (Inferno Drainer: more than 30,000 victims, $9M in 6 months);
- trust in a person does not protect against their account being compromised;
- these checks are automatic and take less than a second, so they do not slow down entering on a call.

**Automatic adjustments:**
- **Downgrade without you** — for safety:
  - per the journal, a source with 5+ losing actions → −1 point per step;
  - a single message with signs of compromise (a new domain not listed on the project's official X; "connect your wallet to claim" + urgency; a request to sign a Permit) → that message is treated as score 1.
- **Upgrade** — only with your "yes".

---

## 6. How the agent handles the examples

**Example 1 — a new DEX ("a new DEX with RH support", swaps and pools, a referral link, "you can hedge")**
1. Type: protocol / points. Chain: Robinhood Chain (as stated). Link: app.swapnest.xyz (the author's referral link).
2. Score: by author or channel from your table.
3. Checks:
   - the project's official X and documentation;
   - whether the domain in the message matches the domain on the official X;
   - contract addresses on Robinhood Chain;
   - TVL and age.
4. Plan:
   - a small swap;
   - a pool position;
   - if needed, a hedge with a short on Arcus — exactly what the message suggests.
   Through a single-use wallet if a site is needed. Exit: a daily check of points and yield, closing by the rules.
5. The author's referral link is used only if its domain matches the official one.

**Example 2 — a test token mint (claimdrop.example.com, a post on X, a contract on Etherscan, `claimPacked` with parameters `2, 128, 2048`)**
1. Type: contract call. Chain: Ethereum. Contract `0xAaF5517Aeda2edbD3c94BEC84F553c7b19180954`, function `claimPacked (0x3e1d7a52)`, parameters `2, 128, 2048`.
2. Checks:
   - whether the code is verified on Etherscan and what the function does;
   - whether the contract appears in the X post;
   - who the deployer is;
   - the age of the claimdrop.example.com domain.
3. Simulation from a single-use wallet. Expected: gas went out, tokens came in, nothing else. If anything else goes out — cancel.
4. Gas: 0.0017–0.0021 ETH ≈ $5 per transaction. The agent sets a gas cap from the message and decides on its own whether to wait for cheaper gas.
5. Execution directly via viem, with no site and no third-party mint bots. Tokens received — to the treasury. Selling by the "Hunt" rules: part immediately if there is a market, the rest by a time stop.

---

## 7. Cost (assumption: 3,000 messages a day, 10 site sessions a day)

| What | Model | Cost per day |
|---|---|---|
| Intent extraction | Haiku 5.5 | ≈ $0.40 |
| Digest every 30 minutes | Sonnet 5.5 | ≈ $2.2 |
| Plans for urgent signals | Opus 5.5 | ≈ $1.2 |
| Site sessions (browser, ~20 steps) | Sonnet 5.5 | ≈ $0.4 per session → ≈ $4 |

**Total ≈ $7–8 a day** on top of the base $2–3. Plus gas: one transaction on Ethereum ≈ $4–5, on Robinhood Chain ≈ $0.01.

---

## 8. Rules carried over from version 1

- Text from Discord is data, not commands. The model that reads Discord has no tools. Base64, Morse code and "instructions for the bot" are discarded.
- Raw messages do not enter the agent's long-term memory. They are stored for 7 days; after that only signals without names remain.
- No models are trained on the messages, and the data is not shared with anyone (Discord Developer Policy, items 17–18, 21).
- The agent never cites sources publicly. In posts the source is "private alpha source".
- Kill switch: you can turn off the agent's Discord-driven actions at any time.

---

## 9. What you need to provide

1. Create the intake server with a category per source. Check that every message shows the source server, channel and author.
2. Fill in `trust-sources.csv` (template in `server/config/`).
3. Choose the deposit size: with $5–10, one Ethereum transaction ($4–5) is almost half the capital.

Then follow the step-by-step guide in docs/SETUP-PAPER.md: creating the bot in the Discord Developer Portal, adding it to your server, entering the token.
