// Turns a Discord message into a RawMessage.
// Fields: category = source, channel = source channel, author = message author.
import type { RawMessage } from '../types.js';

/** Minimal message shape so the function can be tested without discord.js. */
export interface DiscordLikeMessage {
  id: string;
  createdTimestamp: number;
  content: string;
  author: { username: string; globalName?: string | null; bot?: boolean };
  channelName: string;
  categoryName: string | null;
  embeds: {
    title?: string | null;
    description?: string | null;
    url?: string | null;
    author?: { name?: string | null } | null;
    fields?: { name: string; value: string }[];
    footer?: { text?: string | null } | null;
  }[];
  replyToText?: string;
}

export function embedToText(e: DiscordLikeMessage['embeds'][number]): string {
  const parts: string[] = [];
  if (e.author?.name) parts.push(e.author.name);
  if (e.title) parts.push(e.title);
  if (e.url) parts.push(e.url);
  if (e.description) parts.push(e.description);
  for (const f of e.fields ?? []) parts.push(`${f.name}: ${f.value}`);
  if (e.footer?.text) parts.push(`[footer] ${e.footer.text}`);
  return parts.join('\n');
}

/**
 * Discord markup → plain text:
 *  - timestamps <t:1792711500:F> → "2026-10-22 23:25 UTC" (Discord shows them in the viewer's time zone, the bot gets a number);
 *  - mentions of channels/roles/people of the source server (the intake server does not know them) → #channel / @role / @user.
 */
export function discordMarkupToText(t: string): string {
  return t
    .replace(/<t:(-?\d{1,12})(?::[tTdDfFR])?>/g, (_, n) => {
      const d = new Date(Number(n) * 1000);
      return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : _;
    })
    .replace(/<#\d+>/g, '#channel').replace(/<@&\d+>/g, '@role').replace(/<@!?\d+>/g, '@user')
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
}

export function normalizeMessage(m: DiscordLikeMessage): RawMessage {
  const embedText = m.embeds.map(embedToText).filter(Boolean).join('\n---\n');
  const text = discordMarkupToText([m.content, embedText].filter(s => s && s.trim()).join('\n---\n'));
  return {
    id: m.id,
    sourceServer: (m.categoryName ?? 'unknown').trim(),
    channel: m.channelName.trim(),
    author: (m.author.username || m.author.globalName || 'unknown').trim(),
    tsUtc: new Date(m.createdTimestamp).toISOString(),
    text,
    replyToText: m.replyToText ? discordMarkupToText(m.replyToText) : undefined,
  };
}
