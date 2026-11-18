# Running AGENT in paper mode on your PC (step by step)

Paper = the agent reads the server, makes decisions and writes them to the journal and to Telegram, but **makes no real trades**. Over 14 days this shows which channels and people actually produce a profit. The PC must stay on; the agent can be moved to a server later.

Only you enter tokens and keys, into the `.env` file on your PC. Never send them to anyone.

---

## Step 1. Discord bot

1. Open https://discord.com/developers/applications → **New Application** button → name `AGENT intake` → consent checkbox → **Create**.
2. On the left, **Bot** → **Reset Token** button → **Yes, do it!** → **Copy**. Save the token in a text file — you will need it in step 5.
3. Lower on the same page, in the **Privileged Gateway Intents** block, turn on **Message Content Intent** → **Save Changes** at the bottom.
4. On the left, **OAuth2** → **URL Generator**:
   - under **Scopes**, check `bot`;
   - under **Bot Permissions**, check `View Channels` and `Read Message History`;
   - copy the **Generated URL** at the bottom.
5. Paste this link into the browser → choose your intake server → **Authorize** → pass the check.
6. Server ID:
   - in Discord open **Settings** (gear icon) → **Advanced** → turn on **Developer Mode**;
   - close settings, right-click your server's icon → **Copy Server ID**.

## Step 2. Telegram bot

1. In Telegram open **@BotFather** → send `/newbot`.
2. Name: `AGENT alerts`. Username — anything, it must end with `bot` (for example `agent_alerts_bot`).
3. BotFather sends a token — save it in the text file.
4. Open your new bot and send it `/start`.

## Step 3. Anthropic API key

https://console.anthropic.com → **API Keys** → **Create Key** → save the key. Top up the balance (~$50–100 is enough for 14 days of paper).

## Step 3a. Data keys for the analyst

1. **OpenSea** — get an API key from OpenSea. You will paste it into `.env` in step 5.5.
2. **X (twitterapi.io)**: open https://twitterapi.io → **Sign up** → log in → in the **Dashboard** copy the **API Key**. Top up $5: at typical volumes this lasts several weeks (a profile ≈ $0.00018, a tweet ≈ $0.00015).

## Step 4. Trust table

1. Open the file `C:\path\to\scarf\server\config\trust-sources.csv` in Excel.
2. Enter the servers and channels you want the agent to read. Put scores 0–10 in the **score** column. Fill in the **mode** column: alpha channels — `opus`, chats and success — `chat`.
3. Add people as rows: `author` · server (or empty = all servers) · empty · the message author's name · score.
4. Save: **File → Save As → type "CSV UTF-8 (comma delimited)"** → replace.

## Step 5. Launch

Press **Win + R** → type `cmd` → **Enter**. Then one command at a time.

1. Go to the project folder:
   ```
   cd /d C:\path\to\scarf
   ```
   No output.

2. Check Node.js:
   ```
   node -v
   ```
   You need `v22.13.0` or higher (for example `v24.11.0`). If lower — download the **LTS** from https://nodejs.org, install with the default options, close and reopen cmd, repeat item 1.

3. Install dependencies:
   ```
   npm install
   ```
   Expected: `added … packages` (1–2 minutes).

4. Create the settings file:
   ```
   copy .env.example .env
   ```
   Expected: `1 file(s) copied.`

5. Open it in Notepad:
   ```
   notepad .env
   ```
   Enter after `=`, without spaces:
   - `DISCORD_BOT_TOKEN=` the token from step 1.2;
   - `DISCORD_GUILD_ID=` the server ID from step 1.6;
   - `TELEGRAM_BOT_TOKEN=` the token from step 2.3;
   - `ANTHROPIC_API_KEY=` the key from step 3;
   - `OPENSEA_API_KEY=` the OpenSea key from step 3a;
   - `TWITTERAPI_IO_KEY=` the twitterapi.io key from step 3a.

   **Ctrl + S**, close Notepad.

6. Find your Telegram chat_id:
   ```
   npm run tg-chatid
   ```
   Expected: a line like `TELEGRAM_CHAT_ID=123456789   (owner)`.

7. Enter it:
   ```
   notepad .env
   ```
   Paste the number into the `TELEGRAM_CHAT_ID=` line → **Ctrl + S** → close.

8. Self-check:
   ```
   npm run check
   ```
   Expected: `OK` everywhere, a trust table line with no errors, the mode (`opus`/`chat`) and score for each channel; an analyst line showing it is on and the daily UTC limits for Opus, Sonnet and the gatekeeper.

9. Start:
   ```
   npm start
   ```
   Expected: `discord: logged in as AGENT intake#…` in the window, and a "🤖 AGENT started (paper)" message in Telegram. Do not close the window. To stop — **Ctrl + C**.

## What arrives in Telegram
- 📝 PAPER BUY / SELL / NFT MINT / X TASK — what the agent would have done, with the analyst's breakdown.
- ⏰ Scheduled — an action at a UTC time (public mint, raffle registration); the decision is made again when the time comes.
- 🐦 X post draft — only after an action, without sources, with the position disclosed. Nothing is published until you say "yes".
- 🆘 Help needed — captcha, KYC, a Discord role.
- 📊 Daily report at 00:05 UTC — capital, decisions, analyst breakdowns, model spend, projects on watch, best and worst sources, score downgrades.
