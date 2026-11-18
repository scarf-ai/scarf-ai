// Messages to the owner in Telegram: help requests (captcha, KYC, Discord role), entries/exits,
// risk stops, the daily report. Without a bot token — writes to the console (handy for tests and paper).

export interface Notifier {
  send(text: string): Promise<void>;
  /** An image with a caption and buttons (callback_data). Returns message_id. */
  sendPhoto?(png: Buffer, caption: string, buttons?: { text: string; data: string }[][]): Promise<number | undefined>;
  /** Replace the caption (and remove the buttons) of a sent message. */
  editCaption?(messageId: number, caption: string): Promise<void>;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function telegramNotifier(botToken: string | undefined, chatId: string | undefined, fetchImpl: typeof fetch = fetch): Notifier {
  if (!botToken || !chatId) return { async send(t) { console.log(`[telegram:dry] ${t}`); } };
  const api = (m: string) => `https://api.telegram.org/bot${botToken}/${m}`;
  return {
    async sendPhoto(png, caption, buttons) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'card.png');
      form.append('caption', caption.slice(0, 1024));
      form.append('parse_mode', 'HTML');
      if (buttons?.length) form.append('reply_markup', JSON.stringify({ inline_keyboard: buttons.map(r => r.map(b => ({ text: b.text, callback_data: b.data }))) }));
      const r = await fetchImpl(api('sendPhoto'), { method: 'POST', body: form });
      if (!r.ok) { console.error(`[telegram] sendPhoto http ${r.status}`); return undefined; }
      const j: any = await r.json().catch(() => ({}));
      return j?.result?.message_id;
    },
    async editCaption(messageId, caption) {
      await fetchImpl(api('editMessageCaption'), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, caption: caption.slice(0, 1024), parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }) }).catch(() => {});
    },
    async send(text) {
      const r = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if (!r.ok) console.error(`[telegram] http ${r.status}`);
    },
  };
}

export function helpCard(p: { need: string; summary: string; source: string; urls: string[]; score: number }): string {
  return [
    `🆘 <b>Help needed: ${esc(p.need)}</b>`,
    esc(p.summary),
    `Source: ${esc(p.source)} (trust ${p.score})`,
    ...p.urls.map(u => esc(u)),
    'Do it by hand and reply "done", or "skip".',
  ].join('\n');
}

export function decisionCard(p: { action: string; summary: string; source: string; sizeUsd: number; chain: string; mode: string; reasons: string[] }): string {
  return [
    `${p.mode === 'paper' ? '📝 PAPER' : '⚡ LIVE'} <b>${esc(p.action)}</b> $${p.sizeUsd.toFixed(2)} · ${esc(p.chain)}`,
    esc(p.summary),
    `Source: ${esc(p.source)}`,
    `Why: ${esc(p.reasons.slice(-3).join('; '))}`,
  ].join('\n');
}

/** An analyst verdict "act" or "watch" goes to the owner at once (ignore/avoid only to the log and the daily report). */
export function verdictCard(p: { verdict: string; source: string; thesis: string; model: string; confidence: number; costUsd: number; risks?: string[] }): string | undefined {
  if (p.verdict !== 'act' && p.verdict !== 'watch') return undefined;
  // The whole thesis (the owner 2026-10-29: "the reasoning does not arrive in full" — it used to be cut to 600 chars); Telegram limit 4096
  return [
    `${p.verdict === 'act' ? '⚡ ACT' : '👀 WATCH'} · ${esc(p.source)}`,
    esc(p.thesis.slice(0, 2500)),
    p.risks?.length ? `<b>Risks:</b> ${esc(p.risks.slice(0, 5).map(r => r.slice(0, 160)).join('; '))}` : '',
    `<i>${esc(p.model.replace('claude-', ''))}, confidence ${p.confidence}, analysis $${p.costUsd.toFixed(3)}</i>`,
  ].filter(Boolean).join('\n');
}
