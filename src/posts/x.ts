// Official X API (pay-per-use): a post with an image. Requests are signed with OAuth 1.0a on behalf of the agent's account.
// The owner puts the keys (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET) into .env on the server personally.
// Cost (2026): a post ≈ $0.015, a post with a link ≈ $0.20 — so links are cut from the text.
import { createHmac, randomBytes } from 'node:crypto';

export interface XKeys { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string }
export interface XPoster { post(text: string, image?: Buffer): Promise<{ id: string }> }

const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** The Authorization header per OAuth 1.0a (HMAC-SHA1). JSON and multipart bodies are not signed — only query and oauth_*. */
export function oauth1Header(method: string, url: string, k: XKeys, nonce = randomBytes(16).toString('hex'), ts = Math.floor(Date.now() / 1000).toString(), formParams: Record<string, string> = {}): string {
  const u = new URL(url);
  const oauth: Record<string, string> = { oauth_consumer_key: k.apiKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: ts, oauth_token: k.accessToken, oauth_version: '1.0' };
  const params: [string, string][] = [...Object.entries(oauth), ...[...u.searchParams.entries()], ...Object.entries(formParams)];
  const norm = params.map(([a, b]) => [pct(a), pct(b)]).sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1)).map(([a, b]) => `${a}=${b}`).join('&');
  const base = `${method.toUpperCase()}&${pct(`${u.origin}${u.pathname}`)}&${pct(norm)}`;
  const sig = createHmac('sha1', `${pct(k.apiSecret)}&${pct(k.accessSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: sig }).map(([a, b]) => `${pct(a)}="${pct(b)}"`).join(', ');
}

/** Links in the text: X charges ~13 times more for a post with a link. Links go only in the bio/pinned post. */
export const stripLinks = (t: string) => t.replace(/https?:\/\/\S+/gi, '').replace(/\b[\w-]+\.(?:com|xyz|io|fun|gg|app|org|net|ai|so|co)\/\S*/gi, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]*\n\s*/g, '\n').trim();

export function xApiPoster(k: XKeys, fetchImpl: typeof fetch = fetch, base = 'https://api.x.com'): XPoster {
  return {
    async post(text, image) {
      let mediaId: string | undefined;
      if (image) {
        const url = `${base}/2/media/upload`;
        const form = new FormData();
        form.append('media', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'card.png');
        form.append('media_category', 'tweet_image');
        form.append('media_type', 'image/png');
        const r = await fetchImpl(url, { method: 'POST', headers: { authorization: oauth1Header('POST', url, k) }, body: form, signal: AbortSignal.timeout(30_000) });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`X media upload http ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
        mediaId = String(j?.data?.id ?? j?.media_id_string ?? '');
        if (!mediaId) throw new Error('X media upload: no media id');
      }
      const url = `${base}/2/tweets`;
      const body = JSON.stringify({ text: stripLinks(text).slice(0, 280), ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) });
      const r = await fetchImpl(url, { method: 'POST', headers: { authorization: oauth1Header('POST', url, k), 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20_000) });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j?.data?.id) throw new Error(`X post http ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      return { id: String(j.data.id) };
    },
  };
}
