import { describe, it, expect } from 'vitest';
import { oauth1Header, stripLinks, xApiPoster } from '../src/posts/x.js';

describe('X API (official, OAuth 1.0a)', () => {
  it('signature matches the reference example from X docs', () => {
    const k = { apiKey: 'xvz1evFS4wEEPTGEFPHBog', apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' };
    const h = oauth1Header('POST', 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true', k, 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', '1318622958',
      { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' });
    expect(h).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });

  it('links are stripped (a post with a link costs ~13x more)', () => {
    expect(stripLinks('Closed $SWARMX −$0.54. https://dexscreener.com/x/y No position now.')).toBe('Closed $SWARMX −$0.54. No position now.');
  });

  it('uploads the card, then posts with the media id', async () => {
    const calls: { url: string; body: any }[] = [];
    const f: typeof fetch = async (url: any, init: any) => {
      calls.push({ url: String(url), body: init.body });
      if (String(url).endsWith('/2/media/upload')) return new Response(JSON.stringify({ data: { id: 'M1' } }), { status: 200 });
      return new Response(JSON.stringify({ data: { id: 'T1', text: 'x' } }), { status: 201 });
    };
    const p = xApiPoster({ apiKey: 'a', apiSecret: 'b', accessToken: 'c', accessSecret: 'd' }, f);
    const r = await p.post('Entered $SWARMX https://x.com/a', Buffer.from([1, 2, 3]));
    expect(r.id).toBe('T1');
    expect(JSON.parse(calls[1].body)).toEqual({ text: 'Entered $SWARMX', media: { media_ids: ['M1'] } });
  });
});
