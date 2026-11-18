# Discord source trust table

Working file: `trust-sources.csv` (sample — `trust-sources.example.csv`). List the Discord servers, channels and authors you want the agent to read, and assign the scores yourself. The file opens in Excel; save it as "CSV UTF-8 (comma delimited)". The `;` delimiter is also accepted.

**Columns:**
- `level` — `server`, `channel` or `author`.
- `server` — the source's category name on your intake server (ServerC, ServerA, ServerB…).
- `channel` — the channel name without `#` (empty for the `server` level).
- `author` — the message author's name (for example `caller1`). Empty for the `server` and `channel` levels.
- `score` — from 0 to 10. An empty score means the row has no effect (but the channel mode is still taken from it).
- `mode` — channels only:
  - `opus` — every substantive message is analyzed by the analyst (Opus; for `ServerB/scan-feed` — Sonnet, see `gate.json`);
  - `chat` — every message is read by the gatekeeper (Haiku + rules), which calls the analyst only when there is a reason;
  - `ignore` — the channel is not read.
  Empty → by name: `chat`, `success`, `general`, `memes`, `off-topic` → chat, everything else → opus.
- `inherit` — channels only: `careful` means "a team channel with a score of 4–6". An author without a score gets the channel's score, but a trade happens only if:
  - the analyst's confidence ≥ `careful.minConfidence`;
  - thesis strength ≥ `careful.minThesisStrength` (out of 10);
  - holding period ≤ `careful.maxHoldHours`.

  On top of that: extra market checks (liquidity, number of buys over 24 hours, sell-to-buy ratio, RugCheck present and not "high"), a reduced size (`careful.sizeFactor`) and stricter exits (`careful.exit`). All these numbers live in the `careful` block of `server/config/risk.json`, set by you; sample values are in `src/config.ts` (DEFAULT_RISK).
- `note` — a note for yourself.

**Rules:**
1. If the author has a score, that score is used. An author with an empty `server` applies on all servers.
2. If the author has no score → 0. But if the channel's score is > 6, the author gets the channel's score.
3. A channel without its own score takes the server's score.
4. The agent may lower a source's score on its own based on the journal results; only you can raise it.
5. A message showing signs of a compromised account gets a score of 1, whoever wrote it.

**What the scores mean:**

| Score | What the agent does | Share of the "Hunt" bucket per action |
|---|---|---|
| 0–3 | Journal only | — |
| 4–6 | Acts after a full check | up to `perActionShareByTier.full` |
| 7–9 | Acts fast, with reduced checks | up to `perActionShareByTier.fast` |
| 10 | Follows the call immediately | up to `perActionShareByTier.follow` |

Safety checks (simulation, signature filter, single-use wallet) apply at any score.

To check how the table was read: `npm run check`.
