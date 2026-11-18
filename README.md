# SCARF — an autonomous AI trading agent ($SCARF, @scarf_ai)

SCARF reads signals from Discord communities, checks them with code and an analyst model, trades on-chain
(paper and shadow mode by default; live only with an explicit switch) and posts what it did on X.

This is the public, source-available copy of the project. It is exported from the private repository on every
release: same code and tests, development history in [`docs/CHANGELOG.md`](docs/CHANGELOG.md), but **no keys,
no private sources and no real trading parameters**.

## What is not here, and what to put instead

| You need | Where | What to do |
|---|---|---|
| Keys and tokens (Discord bot, Telegram, Anthropic, X, RPC) | `.env` | Copy `.env.example` to `.env` and fill it in. Never commit `.env`. |
| Risk rules: sizes, stops, exits, entry filters | `server/config/risk.json` | Copy `server/config/risk.example.json`. The numbers there are examples — set your own. |
| Which Discord servers and channels to read, gate thresholds | `server/config/gate.json` | Copy `server/config/gate.example.json` and put your sources in. |
| Trust scores of your sources (servers, channels, authors) | `server/config/trust-sources.csv` | Copy `server/config/trust-sources.example.csv`. Format: `server/config/trust-sources.README.md`. |
| Smart X accounts | `server/config/smart-accounts.csv` | Copy `server/config/smart-accounts.example.csv`. |
| Shared brief for every model | `server/config/agent-brief.md` | Copy `server/config/agent-brief.example.md` and rewrite it for your setup. |

Defaults in the code (`DEFAULT_RISK` in `src/config.ts`, gate defaults in `src/gate/triggers.ts` and similar) are
example values too. They exist so that the agent and the tests run; they are not the numbers SCARF trades with.

## Run (paper mode)

Node.js 22.13 or newer.

```
npm install
npm test
npx tsc --noEmit
npm run secrets-check
npm start
```

`npm test` uses `test/fixtures/risk.example.json` (the same file as `server/config/risk.example.json`).
Live trading stays off unless `AGENT_MODE=live`, `AGENT_EXECUTION=live` and `AGENT_LIVE_CONFIRM=yes` are all set.

## Layout

- `src/` — the agent: Discord intake, trust, gate, analyst, decisions, risk, safety firewall, paper/live execution, posts, site.
- `test/` — tests (vitest).
- `docs/` — how the agent works and how it was built (stages, changelog).
- `brand/`, `site/` — brand assets, post cards and the public site.
- `server/config/` — example configs; `server/deploy/` — systemd units.

The project is built by one owner with a team of AI departments: HQ, Analyst, Cost, Strategy, Execution, Ops and Brand.
Department names appear in the changelog and in code comments.

## License

Source-available — see [`LICENSE`](LICENSE). You may read the code and run it locally for personal evaluation and non-commercial research; commercial use, redistribution, publishing derivative works and trading real funds with it need written permission. No warranty; nothing here is financial advice.
