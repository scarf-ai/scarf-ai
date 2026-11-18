// Context window per channel: the last N messages (default 25), no older than 3 hours.
// Needed to understand "this", "it", "anyone got in?" — which message above a phrase refers to.
// Kept in memory; after a restart the window fills up again (the texts are in the log anyway).
import type { RawMessage } from '../types.js';

export interface WindowMsg { idx: number; id: string; author: string; tsUtc: string; text: string; replyToText?: string }

export class ContextWindows {
  private w = new Map<string, RawMessage[]>();
  constructor(private size = 25, private maxAgeMs = 3 * 3600_000) {}
  private key(server: string, channel: string) { return `${server.toLowerCase()}|${channel.toLowerCase()}`; }

  add(m: RawMessage) {
    const k = this.key(m.sourceServer, m.channel);
    const arr = this.w.get(k) ?? [];
    arr.push(m);
    while (arr.length > this.size) arr.shift();
    this.w.set(k, arr);
  }

  /** Channel messages BEFORE the current one (excluding it), numbered for the model to reference. */
  before(m: RawMessage, nowMs: number): WindowMsg[] {
    const arr = this.w.get(this.key(m.sourceServer, m.channel)) ?? [];
    return arr.filter(x => x.id !== m.id && nowMs - Date.parse(x.tsUtc) <= this.maxAgeMs)
      .map((x, i) => ({ idx: i + 1, id: x.id, author: x.author, tsUtc: x.tsUtc, text: x.text, replyToText: x.replyToText }));
  }
}
