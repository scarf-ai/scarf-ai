// Finds the Telegram chat_id: send your bot any message, then run `npm run tg-chatid`.
import 'dotenv/config';
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.log('There is no TELEGRAM_BOT_TOKEN in the .env file'); process.exit(1); }
const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const j: any = await r.json();
const chats = new Map<string, string>();
for (const u of j.result ?? []) { const c = u.message?.chat; if (c) chats.set(String(c.id), c.username ?? c.first_name ?? ''); }
if (!chats.size) console.log('No messages. Send your bot any word in Telegram and run the command again.');
for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
