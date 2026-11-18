// Discord bot: reads ONLY the intake server (category = source, channel = source channel). Permissions: View Channel + Read Message History.
// Writes nothing to Discord and does not react to chat commands.
import { Client, Events, GatewayIntentBits, Partials, ChannelType, type Message, type TextChannel } from 'discord.js';
import { normalizeMessage, type DiscordLikeMessage } from './normalize.js';
import type { RawMessage } from '../types.js';

export async function toDiscordLike(m: Message): Promise<DiscordLikeMessage> {
  const ch: any = m.channel;
  let replyToText: string | undefined;
  if (m.reference?.messageId) {
    try { const ref = await m.fetchReference(); replyToText = [ref.content, ...ref.embeds.map(e => [e.title, e.description].filter(Boolean).join('\n'))].filter(Boolean).join('\n'); } catch { /* the original message is unavailable */ }
  }
  return {
    id: m.id, createdTimestamp: m.createdTimestamp, content: m.content ?? '',
    author: { username: m.author?.username ?? 'unknown', globalName: m.author?.globalName, bot: m.author?.bot },
    channelName: ch?.name ?? 'unknown', categoryName: ch?.parent?.name ?? null,
    embeds: m.embeds.map(e => ({ title: e.title, description: e.description, url: e.url, author: e.author ? { name: e.author.name } : null,
      fields: e.fields?.map(f => ({ name: f.name, value: f.value })), footer: e.footer ? { text: e.footer.text } : null })),
    replyToText,
  };
}

/** Config error (token, intents, bot not on the server): a restart will not help — the owner must act. */
export class DiscordConfigError extends Error {}

/** A readable reason for a discord.js error. */
export function explainDiscordError(e: unknown): string {
  const s = String((e as Error)?.message ?? e);
  if (/disallowed intents|4014/i.test(s)) return 'Message Content Intent is not enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents → Message Content Intent → Save Changes).';
  if (/invalid token|TokenInvalid|401|4004/i.test(s)) return 'Invalid Discord bot token (DISCORD_BOT_TOKEN). Developer Portal → Bot → Reset Token → put the new one into .env.';
  return `Discord: ${s.slice(0, 200)}`;
}

/**
 * Discord login. Returns the client only after a successful login; on a config error — DiscordConfigError.
 * Live messages start arriving in onMessage right after login.
 */
export async function startDiscord(token: string, guildId: string | undefined, onMessage: (m: RawMessage) => Promise<void>, log = console.log): Promise<Client> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
  const ready = new Promise<void>((res) => client.once(Events.ClientReady, c => { log(`discord: logged in as ${c.user.tag}`); res(); }));
  client.on(Events.MessageCreate, async (m) => {
    try {
      if (guildId && m.guildId !== guildId) return;
      if (m.author?.id === client.user?.id) return;
      await onMessage(normalizeMessage(await toDiscordLike(m)));
    } catch (e) { log(`discord handler error: ${String(e)}`); }
  });
  try { await client.login(token); } catch (e) { throw new DiscordConfigError(explainDiscordError(e)); }
  await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Discord: no ready event in 60 s')), 60_000))]);
  if (guildId && !client.guilds.cache.has(guildId)) {
    const names = [...client.guilds.cache.values()].map(g => `${g.name} (${g.id})`).join(', ') || 'none';
    await client.destroy();
    throw new DiscordConfigError(`The bot is not added to the server with ID ${guildId} (DISCORD_GUILD_ID). The bot is currently on servers: ${names}. Invite it with a link from OAuth2 → URL Generator.`);
  }
  return client;
}

/**
 * Messages already posted on the intake server in the last `hours` hours, in ascending time order.
 * Channels without the "Read Message History" permission are skipped (their list is returned).
 */
export async function fetchHistory(client: Client, guildId: string, hours: number, maxPerChannel = 300, log = console.log): Promise<{ messages: RawMessage[]; skipped: string[] }> {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const since = Date.now() - hours * 3600_000;
  const out: RawMessage[] = []; const skipped: string[] = [];
  for (const ch of channels.values()) {
    if (!ch || ch.type !== ChannelType.GuildText) continue;
    const tc = ch as TextChannel;
    let before: string | undefined; let n = 0;
    try {
      while (n < maxPerChannel) {
        const batch = await tc.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        let older = false;
        for (const m of batch.values()) {
          if (m.createdTimestamp < since) { older = true; continue; }
          if (m.author?.id === client.user?.id) continue;
          out.push(normalizeMessage(await toDiscordLike(m))); n++;
        }
        before = batch.last()?.id;
        if (older || batch.size < 100) break;
      }
    } catch (e) { skipped.push(`${tc.parent?.name ?? '?'}/#${tc.name}: ${String((e as Error).message ?? e).slice(0, 80)}`); }
  }
  out.sort((a, b) => Date.parse(a.tsUtc) - Date.parse(b.tsUtc));
  log(`discord: history ${hours} h — ${out.length} messages from ${channels.size} channels${skipped.length ? `, skipped ${skipped.length}` : ''}`);
  return { messages: out, skipped };
}
