# SCARF release log

Maintained by HQ. The version is the commit hash in `main`: git tags are not created from the Claude cloud. Times are UTC.

## 2026-10-29 · `4a43d2f` — import to GitHub
- The project moved from the owner's PC into the private `scarf-agent` repository — stage 2 of the internal GitHub migration plan.
- This commit and the next one (workflow) do not change the agent's behavior. No server update needed.

## 2026-10-29 · `70aad0f` — server checklist O-01 (#22)
- Server deployment guide (internal): "Checklist O-01" — update, shadow, Relay key, Chromium, twitterapi.io, journal check; the update archive no longer picks up `.env.local` and key files; the site is stopped and started together with the agent.
- Agent code unchanged — the server is updated by the checklist itself.

## 2026-10-29 · `a06e5eb` — Chromium on Ubuntu 26.04 (#42)
- Server deployment guide (internal): a fallback browser install path for Ubuntu 26.04 (verified on the server: `browser: Chromium ready`).

## 2026-10-29 · `12812c4` — pre-live audit, part one (#41)
- A `decimals()` error → the token is not traded (previously 18 was substituted).
- Live swaps — only on allowed chains; the check runs before the bridge and before any RPC.
- Relay bridge from EVM: mandatory simulation and state-change check (native coin only, no tokens and no new approvals).
- **Affects the agent (shadow).** The server can be updated together with the next release. Live blockers from the review — #46.


## 2026-11-09 · `6ec6575` — cost baseline, model call extraction, decisions (#34, #35, #36, #49)
- `a80d4a1` A-04 (#34): the model call mechanics moved to `src/llm/runner.ts`; the API request is unchanged (snapshots in `test/__snapshots__/`); the browser test decides whether to launch the same way production does (`probeBrowser()`).
- `c407ee7` C-01 (#35): `npm run cost` — a cost baseline from the review log (`src/cost/baseline.ts`, `src/tools/cost.ts`, an internal cost document); twitterapi.io call counter `src/cost/xmeter.ts`. Baseline figures come after exports from the server.
- `2e10c94` HQ (#36): the `npm run cost` command in `package.json`; `meterX` wired into `src/index.ts` — an `xapi` event in the review log.
- `b5cc8f1`, `855ca61`, `7e88bf7`, `6ec6575`: internal decision log (bridge share, model pause without credits — C-04 #49), HQ handoff notes.
- **Affects the agent:** an `xapi` event appears in the journal; model calls go through `runner.ts` (same behavior). Update the server with this release together with `12812c4` (audit E-02), if not yet rolled out.
- **Rolled out to the server 2026-11-09 ~06:00 UTC** (commit `31dc8e3`, together with `12812c4`/`a06e5eb`; the server was on `65d0626` before). Tests on the server, `browser: Chromium ready`. The agent is paused until Anthropic credits are topped up.

## 2026-11-09 · `main` after `bbe19f7` — browser, pause without credits, Telegram commands (#56, #52, #50, #53)
- `bbe19f7` #56 (Analyst, #55): the browser on the server did not read pages (`__name is not defined` in `page.evaluate` under tsx) — the page code is now passed as a string.
- `04f7885` C-04 #52 (Cost, #49): model pause without Anthropic credits — 400 "credit balance" / 402 → pause; no model calls at all; a 1-token Haiku probe every 15 min; one notification on entry (at most every 6 h, survives a restart) and one on exit; no queue, messages during the pause go to the journal only (`model paused (no API credits)`). Internal cost document: export period `FROM`/`TO`.
- `d08c348` O-05 #50 (Ops, #44): `/stop` `/resume` `/status` in Telegram (only from the owner's chat; a `/resume` older than 5 min is not executed), `npm run risk -- unhalt` on the server — clears the hard stop while the agent is stopped, after `yes`. An "Emergency stop" section in the server deployment guide (internal).
- HQ (#53): pause wiring in `src/index.ts` (`guard` on all three of the agent's model calls, `remember` via `kv`) and `src/pipeline.ts`; the `risk` script in `package.json`. **Telegram commands are not yet wired in `index.ts`** — after E-08/#58 (the `operatorHalt` flag in `risk_state`).
- **Affects the agent:** with zero credits the agent stops calling the API and sends one message; after a top-up it resumes on its own (probe ≤ 15 min). Needs a server release.

## 2026-11-09 · `main` after `e26b5fa` — live capital in risk.json, operator stop, Telegram commands wired (#61, #62, #59)
- `c91e776` S-04 #61 (Strategy, #33): `server/config/risk.json` — starting live capital (`initialCapitalUsd`) and a `live` block (slippage, bridge share, mint wallet share and count); a stretch test on the numbers. **To the server — only together with E-09 #45 (paper ledger reset)**: a saved paper ledger with a larger live capital would immediately go into a hard stop.
- `3ba9ad1` #62 (Strategy, #58): an `operatorHalt` flag in `RiskState` — `/stop` closes new entries, exits keep working, survives a restart, `/resume` clears it (the hard stop — no).
- HQ (#59, O-05): live limits are read from `risk.json` (`cfg.risk.live`); the old `AGENT_SLIPPAGE_BPS`/`AGENT_BRIDGE_MAX_SHARE`/`AGENT_MINT_MAX_*` in `.env` no longer apply — a warning at startup; the `/stop` `/resume` `/status` commands are wired in `src/index.ts`; the startup message notes "/stop active". The change was checked by an independent reviewer.
- Open question for the owner (#33): the daily stop is actually computed from a different base than the file states — options A/B/C.

## 2026-11-10 · release `42ba0c8` — to the server (without a new risk.json)
- Includes everything after `31dc8e3`: #56 browser, #52+#53 pause without credits, #50+#62 the `/stop` `/resume` `/status` commands, #59 limits from risk.json, #65 risk.json protection on update, `42ba0c8` — a thought posted to X on a social task.
- **No ledger reset (E-09)**: `server/config/risk.json` on the server stays as is (item 6 of the "Update" section in the server deployment guide). With the old file, live limits come from defaults and match the approved values.
- The owner's decisions 2026-11-10: daily stop — option C (a share of capital at 00:00 UTC, the change is with Strategy); a bot repost is not analyzed for 24 h (A-05, #64 in rework).

## 2026-11-11 · release `4a5c260` — to the server (without a new risk.json)
- Includes everything after `42ba0c8`: `e440a59` thought confidence threshold 0; `3f883e8` T-06 (#77, PR #84); `4a5c260` T-05 (#76, PR #81).
- **T-05, posts** (the owner's decisions 2026-11-10 13:59 and 2026-11-11 08:02 UTC):
  - a low-confidence thought carries the note `Low confidence on this one.`;
  - a post with no button answer in Telegram goes out on its own after a set time (`AGENT_X_AUTO_APPROVE_MIN`, 0 — off); "No" cancels; the timer publishes only if a batch of Telegram button presses was processed after the deadline;
  - posts created before the rollout are not touched by the timer; a post pending longer than 180 minutes is withdrawn;
  - a post accepted by X stays published if the notification fails; at startup, a post interrupted mid-publication is flagged and a message is sent about it;
  - a thought from a repeated note request (`note_retry`, A-08) goes out only by button.
- **T-06, Telegram:** under the "ACT" card — an "Action: none — reason" line when there is no trade or other action.
- **Affects the agent:** posts start going to X without a button press. The startup log shows `X posts: approve, no answer in N min → posts itself`. The database adds the `auto_at` column on its own.
- **No ledger reset (E-09):** `server/config/risk.json` on the server stays as is (item 6 of the "Update" section in the server deployment guide).
- Acceptance: T-05 — three independent reviewers (round 3 — passes), T-06 — two (round 2 — passes). Leftovers — T-07 (#94).
- Returned for rework 2026-11-11: #69 A-08 (round 2), #57 A-06 (round 2), #64 A-05 (round 2), #89 A-11, #91 A-10, #66 S-04 daily stop, #70 and #80 C-03.
- **Rolled out to the server 2026-11-11 ~12:30 UTC** (commit `2dee3f8`; the server was on `42ba0c8` before). In the log: `browser: Chromium ready (JS sites, task pages)`, `X posts: approve, no answer in N min → posts itself`, `keystore: not created yet` — the keystore is created separately (live deployment guide, internal).

## 2026-11-11 · hotfix `05e4692` — X posts: contract address and rechecks (T-09, #107, PR #111)
- A token post ends with the line `CA: <full address> (<chain>)`. The address comes from the agent's data, not from the model's text. A token thought without an address is not created — the journal shows `thought … not created: token post without a contract address`.
- A scheduled recheck also produces a post: no sooner than a set interval after the previous post about the project and no more than a set number of posts about the project per day.
- Post length is counted by X's rules; the position line and the address are not cut.
- Acceptance: one independent reviewer, three rounds (5 findings → 1 → passes). Tests: 341 passed | 1 skipped.
- Not done yet: the project handle and the `Thought.ca` field — Analyst, #69; the address in entry and exit posts — Execution, #110. Until the Analyst change, some token thoughts do not go out (no unambiguous address).
- Does not change `.env` or `risk.json` settings.

## 2026-11-11 · release `main` after `aa961e5` — to the server (shadow; live is not enabled)
- **E-10 (#46, PR #48)** — live blockers: a transaction mined after "dropped" triggers an address block and an alert; deferred outcomes are counted once; the last real ETH price — for sales only. Acceptance: round 5, passes. Wiring in `index.ts` (#47) — T-08 (#104), not done yet: do not enable live.
- **A-06 (#26, PR #57)** — X checks tuned for the twitterapi.io free tier: steady pace, retry on rate limit; the smart-follower check honestly says "incomplete" rather than "no". Acceptance: round 3; the last case was closed in a follow-up fix.
- **A-13 (#105, PR #112)** — the agent's own finds are traded on paper with a lower confidence threshold; outside paper — the previous, stricter threshold. Acceptance: round 1; the mandatory finding was closed in a follow-up fix.
- **T-09 (#107, PR #111)** — see the entry above (`05e4692`): contract address in posts, posts from rechecks.
- Tests: 460 passed | 1 skipped. Does not change `.env` or `risk.json` settings; `risk.json` on the server stays as is (item 6 of the "Update" section in the server deployment guide).
- Returned 2026-11-11 ~19:00 UTC: #96 E-09 (round 2, one mandatory fix), #100 E-03 (round 2, five mandatory). #69 A-08 — round 3 did not pass (four mandatory), the decision is up to the owner.

## 2026-11-12 · release `main` — to the server (shadow; live is not enabled)
- **C-05 (#10, PR #116) — lower model spend.** The brief cache is kept warm while idle (a ping every 55 minutes, ping spend counted in the budget and the journal); the Opus analysis text is cached from the first round. The model request is the same, verdicts do not change. Cost's estimate from one day of the journal: a noticeable saving on model spend. Acceptance: the reviewer found a ping hitting a cold cache (a full write instead of a read) — closed in a follow-up fix, confirmed by the reviewer.
- **A-05 (#25, PR #64), A-09 items 2–3 (#71, PR #92), A-11 (#82, PR #89)** — repeats of the same project, verdict stability, measuring savings ideas.
- **T-10** — X posts: one cashtag per post; while X rejects full addresses (the first 7 days after authorization), the `CA:` line goes out shortened, and once a day the agent tries the full address.
- **E-09 (#45, PR #96)** — a command to reset the paper ledger before live. **E-03 (#12, PR #100)** — reconciling the cash ledger with the wallets. **T-08 (#104)** — live wiring in `index.ts`. They are not used in this release: the ledger reset and enabling live are a separate step.
- Tests: 591 passed | 1 skipped. No `.env` changes required. `risk.json` on the server stays as is: the new live capital is set only together with the ledger reset.
- Post-rollout check: after 24 hours, `npm run cost -- 2026-11-12 2026-11-13` — the report has a cache ping table; Opus analyses show growing `cacheRead` and a falling price.
- Not included: #80 and #70 (Cost, need to be delivered on top of `main`), #113 S-07 and #114 (returned), #69.

## 2026-11-12 · fix `main` — a queued thought and a verdict change (T-11, #120)
- A thought waiting in the queue is not published — neither by timer nor by button — if, after it was queued, the verdict on the same project became avoid or ignore. The post is cancelled, and Telegram receives "🐦 Post #N cancelled: after it, the project verdict became AVOID".
- Reason: an incident on 2026-11-12 — a "could not read" post went to X 23 minutes after an avoid verdict.
- Implemented by an engineering agent on Opus, checked by a separate reviewer: round 1 — returned (merging cards lost the verdict; the `seen` mark overwrote avoid), round 2 — passes.
- In the database: the `post_drafts.thought_keys` column, the `projects.last_real_verdict` and `last_real_verdict_utc` columns. They are added automatically at startup; an old database still opens.
- Tests: 608 passed | 1 skipped. Does not change `.env` or `risk.json` settings.
- Not fixed yet: a link without `https://` is not read — A-15 (#119, Analyst).

## 2026-11-13 · `489f558`, `9a9ed3d`, `006900c` — Cost: savings map, shadow comparison, X API prices (C-03 #70, #80; C-06 #123)
- **C-03 (#70)** — a map of cost-saving options (internal cost document).
- **C-03 (#80)** — `npm run cost` shows a shadow comparison of saving ideas next to actual spend.
- **C-06 (#123)** — twitterapi.io prices in the call meter, checked against the provider's dashboard.
- Acceptance: one reviewer, up to two rounds. Does not change the agent's behavior or the `.env` / `risk.json` settings.

## 2026-11-14 · `45430d7`, `127ad35` — memecoin exits V2 (S-07, #113); research (S-01, S-02, A-12); A-16 (#124)
- **S-07 (#113, Strategy)** — memecoin exit profiles by token class: a ladder of partial sales, price-behavior checks, an emergency floor that depends on the source profile, and a tail (moonbag) that lives longer than the core part. The numbers are set in `risk.json` (`memecoinClasses`).
- **A-16 (#124, Analyst)** — no X smart-account check for tokens that code rejects anyway; the `smart_check` measurement is honest.
- Research only, no behavior change: trading strategies and a reconciliation registry (S-01, #63; internal), entry options A–C (S-02, #125; internal), what code can decide instead of the model (A-12, #93: `docs/ANALYST-LAYER.md`, `src/intel/modelToCodeSim.ts`).

## 2026-11-15 · `8e8185f` … `7e36bf3` — live acceptance tails (E-10 #114, E-12 #103, #95, #110, #117, #126 item 1)
- **E-10 (#114)** — a rolled-back "ghost" transaction clears its address block by itself; a rollback is recognized only by an explicit `0x0` receipt.
- **E-12 (#103)** — a shadow buy on Solana uses a placeholder public key instead of `1111…`; live without a wallet refuses before the quote.
- **#126 item 1 (#132)** — the V2 position floor is counted from the actual entry price.
- **#95 (#130)** — a `dapp_session` without an executor no longer writes gas off as a loss.
- **#110 (#131)** — the contract address in token entry and exit posts.
- **#117 items 1, 2, 4 (#133)** — `inFlight()` in the executor, a bridge-leg-in-flight flag, bridge sources, a re-check in `acceptCurrent`.
- Acceptance: two independent reviewers per request.

## 2026-11-16 · `25d8375` — a thought on X for every watch/act review (A-08, #69)
- **Analyst:** every watch or act review produces a thought for X; the project's own X account is used only when it is confirmed.
- Acceptance: three author rounds and three HQ finisher rounds; an independent reviewer confirmed it with reproductions and mutation checks.

## 2026-11-17 · `d9023c2` … `5c4e014` — package towards live (#134, #129, S-02 option B, #135, #137, #140, #141)
- **#134** — cash reconciliation accounts for `paper.inFlight()`; the bridge pauses on `legSent`; bridge sources are limited to reconcilable chains.
- **#129 (#127)** — the one-hour price change comes from DexScreener; a pair date in the future, not a number or in seconds → no pair age; a strict percentage; a quality check "no number while a minimum is set → refuse".
- **S-02 option B (#128, Strategy)** — an entry filter: do not chase a pump within the hour, skip pairs that are too fresh or too old, cap the memecoin share; the thresholds live in `risk.json`. Fresh pairs are open to the agent's own finds (a known pair age is required). **S-02b (#138)** — the pair-age exception is computed, the code is merged switched off (`null`).
- **#135** — a sale "in flight" survives a restart (stored in the database; the position is held until the outcome); honest texts for the ghost block; an hourly reminder while a hold or block stays; a rollback only on an explicit `0x0`.
- **#137** — no token post without a contract address; the actual Solana buy cost (swap amount, token account rent included).
- **#140, #117 items 3, 6** — an operation during reconciliation postpones it; price and dollar cap are checked again before arming and firing a deferred mint; the startup reconciliation waits for the sweep of single-use wallet leftovers.
- **Ops:** the `/release <tx> sold|not-sold` command clears a sale hold with an unknown outcome or a ghost block after the owner checks the wallet; `/status` shows holds.
- **#141 (#126 item 2)** — the exit deadline in the plan line of an entry post carries a date and a `core` mark.
- Acceptance: two independent reviewers per change, reproductions green.

## 2026-11-18 · `f874960` … `e1108a9` — site sessions, fail-closed stops, cheaper rechecks, project handles
- **#142 (#126 item 3)** — a position without a price: a market sale after a set time, a write-off after a longer one (`risk.json` → `noPrice`).
- **E-06 (#143, #146, #150, #148, Execution)** — sessions on task sites without money: application forms; a session proxy that blocks the internal network; a single-use wallet that may only connect and sign messages (transactions and token approvals are refused); a wider rule engine for forms; a model fallback (Haiku, then Sonnet) only for a closed set of stop codes, checked by code; spend caps per session and per day. Wired into the agent behind three `.env` switches (forms, wallet, model); `/stop` and the daily stop also stop queued sessions.
- **#145 (#147)** — Solana: after a full sale the empty token account is closed and its deposit returns to cash.
- **A-recheck (Analyst)** — a scheduled recheck is skipped without a model call when the model itself said ignore or the act was already executed; the remaining rechecks run on a cheaper model.
- **A-144 (#144)** — the analyst's page reader reaches the network only through the connection proxy; WebRTC is closed in the reader and in site sessions.
- **S-06 (#87, #66, #139, Strategy)** — stops fail closed: every money number in `risk.json` is validated; a bad field → the default from `DEFAULT_RISK` plus an "exits only" mode (new entries, mint and bridge closed; exits and reconciliation keep working); daily stop option C (a share of capital at 00:00 UTC, with a 1e-9 tolerance); the stop reason in `/status` and in the startup message.
- **A-handles (Analyst)** — project handles in X posts: from the caller's own message and from the OpenSea collection page; thoughts about several projects; unconfirmed handles are dropped.
- Acceptance: two independent reviewers per change, two to four rounds.
