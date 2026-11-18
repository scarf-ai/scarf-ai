import { describe, it, expect } from 'vitest';
import { Funding, relayClient, BRIDGE_COOLDOWN_MS, type RelayClient } from '../src/live/bridge.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';

const W = new Wallets(newKeyMaterial(0));
const ETH = 4000;
function setup(bal: Record<string, number>, opts: { relay?: boolean; status?: string; simulate?: 'ok' | 'unsupported' | 'revert' | 'drain' | 'approval'; leg?: { to?: string; data?: string }; noRecipient?: boolean; noOutUsd?: boolean; allowSolanaSource?: boolean; home?: string; waitMs?: number; now?: () => number } = {}) {
  const sent: any[] = []; const quotes: any[] = [];
  const evm = (c: string) => ({ cfg: { id: ({ base: 8453, robinhood: 4663, arbitrum: 42161 } as any)[c], rpc: `http://${c}` },
    async balance() { return BigInt(Math.round(((bal[c] ?? 0) / ETH) * 1e18)); },
    async getBalance() { return Math.round(((bal.solana ?? 0) / ETH) * 1e9); },
    async send(_me: any, tx: any) { sent.push({ c, ...tx }); bal.base -= Number(tx.value) / 1e18 * ETH; bal.robinhood = (bal.robinhood ?? 0) + Number(tx.value) / 1e18 * ETH * 0.99; return { ok: true, hash: '0xabc', pending: false }; } }) as any;
  const relay: RelayClient = {
    async quote(q) { quotes.push(q); const usd = Number(q.amount) / 1e18 * ETH;
      return { requestId: 'r1', details: { currencyOut: opts.noOutUsd ? {} : { amountUsd: String(usd * 0.99) }, timeEstimate: 8, ...(opts.noRecipient ? {} : { recipient: q.recipient }) },
        steps: [{ id: 'deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { to: opts.leg?.to ?? '0x1111111111111111111111111111111111111111', data: opts.leg?.data ?? '0x', value: q.amount.toString(), chainId: 8453 }, check: { endpoint: '/intents/status?requestId=r1', method: 'GET' } }] }] }; },
    async status() { return opts.status ?? 'success'; },
  };
  const notes: string[] = [];
  const f = new Funding({ relay: opts.relay === false ? undefined : relay, evm, wallets: W, nativeUsd: async () => ETH, notify: async (t) => { notes.push(t); }, home: (opts.home ?? 'base') as any,
    allowSolanaSource: opts.allowSolanaSource, waitMs: opts.waitMs, now: opts.now,
    maxShareOfEquity: 0.6, equityUsd: () => 10, sleep: async () => {}, fetchImpl: (async (_u: any, init: any) => {
      const b = JSON.parse(init.body);
      if (b.method === 'eth_gasPrice') return new Response(JSON.stringify({ result: '0x1' }));
      const mode = opts.simulate ?? 'ok';
      if (mode === 'unsupported') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'the method eth_simulateV1 does not exist/is not available' } }));
      if (mode === 'revert') return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x0', gasUsed: '0x5208', error: { message: 'out of funds' } }] }] }));
      const me = '0x' + '0'.repeat(24) + W.evmTreasury.address.slice(2).toLowerCase();
      const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      // drain: per the simulation, 3 times more ETH than the bridge amount leaves our address; approval: an approval on our token appears
      const logs = mode === 'drain' ? [{ address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [T, me, '0x' + '1'.repeat(64)], data: '0x' + (3n * BigInt(b.params[0].blockStateCalls[0].calls[0].value)).toString(16) }]
        : mode === 'approval' ? [{ address: '0x2222222222222222222222222222222222222222', topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', me, '0x' + '1'.repeat(64)], data: '0x' + (10n ** 24n).toString(16) }] : [];
      return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0x5208', logs }] }] }));
    }) as any });
  return { f, sent, quotes, notes, bal };
}

describe('funds in the trade chain first (the owner 2026-10-28)', () => {
  it('enough on the chain → no bridge', async () => {
    const s = setup({ robinhood: 5, base: 5 });
    expect((await s.f.ensure('robinhood', 2, 'live')).ok).toBe(true);
    expect(s.quotes.length).toBe(0);
  });
  it('shadow: only a quote from the richest chain, nothing is sent', async () => {
    const s = setup({ robinhood: 0, base: 8, arbitrum: 1 });
    const r = await s.f.ensure('robinhood', 2, 'shadow');
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/would bridge: Relay base→robinhood/);
    expect(s.quotes[0]).toMatchObject({ from: 'base', to: 'robinhood', recipient: W.evmTreasury.address });
    expect(s.sent.length).toBe(0);
  });
  it('live: bridges native ETH to our own address, waits for success, funds arrive', async () => {
    const s = setup({ robinhood: 0.1, base: 8 });
    const r = await s.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(true);
    expect(r.bridged).toMatchObject({ from: 'base', requestId: 'r1' });
    expect(s.sent.length).toBe(1);
    expect(s.notes[0]).toMatch(/Bridge/);
  });
  it('refuses: over 60% of equity, failed status, no bridge key', async () => {
    expect((await setup({ robinhood: 0, base: 20 }).f.ensure('robinhood', 7, 'live')).note).toMatch(/exceeds 60% of equity/);
    expect((await setup({ robinhood: 0, base: 8 }, { status: 'refund' }).f.ensure('robinhood', 2, 'live')).note).toMatch(/status: refund/);
    expect((await setup({ robinhood: 0, base: 8 }, { relay: false }).f.ensure('robinhood', 2, 'live')).note).toMatch(/RELAY_API_KEY/);
    expect((await setup({ robinhood: 0, base: 1 }).f.ensure('robinhood', 2, 'live')).note).toMatch(/no chain has/);
  });
  it('live: bridge leg without eth_simulateV1 or with a reverting simulation is refused — nothing is sent (fail-closed, E-02)', async () => {
    const u = setup({ robinhood: 0, base: 8 }, { simulate: 'unsupported' });
    const r = await u.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/simulation unavailable.*not bridging blind/);
    expect(u.sent.length).toBe(0);
    const v = setup({ robinhood: 0, base: 8 }, { simulate: 'revert' });
    expect((await v.f.ensure('robinhood', 2, 'live')).note).toMatch(/simulation reverted/);
    expect(v.sent.length).toBe(0);
  });
  it('live: a tampered Relay leg is refused — token transfer/approve calldata by the firewall, ETH drain or new approval by the simulation diff', async () => {
    // calldata transfer(attacker, …) on a treasury token instead of a deposit to the solver
    const transfer = '0xa9059cbb' + '0'.repeat(24) + 'bad0000000000000000000000000000000000bad' + (10n ** 18n).toString(16).padStart(64, '0');
    const a = setup({ robinhood: 0, base: 8 }, { leg: { to: '0x2222222222222222222222222222222222222222', data: transfer } });
    expect((await a.f.ensure('robinhood', 2, 'live')).note).toMatch(/firewall: token transfer/);
    expect(a.sent.length).toBe(0);
    const d = setup({ robinhood: 0, base: 8 }, { simulate: 'drain' });
    expect((await d.f.ensure('robinhood', 2, 'live')).note).toMatch(/simulation: native out/);
    expect(d.sent.length).toBe(0);
    const p = setup({ robinhood: 0, base: 8 }, { simulate: 'approval' });
    expect((await p.f.ensure('robinhood', 2, 'live')).note).toMatch(/simulation: unexpected approval/);
    expect(p.sent.length).toBe(0);
  });
});

describe('E-10: bridge blockers and hardening', () => {
  it('blocker 2: Solana is not a bridge source by default (even when it is the richest chain); explicit opt-in only', async () => {
    const s = setup({ robinhood: 0, base: 8, solana: 50 });
    (s.f as any).d.sol = { getBalance: async () => 50 / ETH * 1e9 };
    const r = await s.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(true);
    expect(s.quotes[0].from).toBe('base'); // not solana, even though it has the most
    const only = setup({ robinhood: 0, base: 0.5, solana: 50 });
    (only.f as any).d.sol = { getBalance: async () => 50 / ETH * 1e9 };
    expect((await only.f.ensure('robinhood', 2, 'live')).note).toMatch(/no chain has/);
    // No keys, the "home" deposit is on Solana — in shadow no quote is requested, a refusal with a reason
    const noKeys = new Funding({ relay: { async quote() { throw new Error('must not be called'); }, async status() { return 'success'; } }, evm: () => undefined, nativeUsd: async () => ETH, home: 'solana', maxShareOfEquity: 0.6, equityUsd: () => 10 });
    expect((await noKeys.ensure('base', 2, 'shadow')).note).toMatch(/bridge from solana is off/);
  });
  it('item 7: quote without recipient or without amountUsd is refused; a second bridge to the same chain while one is in flight is refused; after a status timeout the chain is paused', async () => {
    expect((await setup({ robinhood: 0, base: 8 }, { noRecipient: true }).f.ensure('robinhood', 2, 'live')).note).toMatch(/no recipient/);
    expect((await setup({ robinhood: 0, base: 8 }, { noOutUsd: true }).f.ensure('robinhood', 2, 'live')).note).toMatch(/no currencyOut.amountUsd/);
    let t = 0;
    const s = setup({ robinhood: 0, base: 8 }, { status: 'pending', waitMs: 10, now: () => t });
    const [a, b] = await Promise.all([s.f.ensure('robinhood', 2, 'live'), s.f.ensure('robinhood', 2, 'live')]);
    const notes = [a.note, b.note].sort();
    expect(notes.find(n => /already in progress/.test(n))).toBeDefined();
    expect(notes.find(n => /status: timeout/.test(n))).toBeDefined();
    expect(s.sent.length).toBe(1);
    // Pause: the money may still arrive — a new bridge there not before BRIDGE_COOLDOWN_MS (the send mock already credited the money — remove it so the bridge is needed again)
    s.bal.robinhood = 0;
    expect((await s.f.ensure('robinhood', 2, 'live')).note).toMatch(/paused until/);
    t = BRIDGE_COOLDOWN_MS + 1;
    expect((await s.f.ensure('robinhood', 2, 'live')).note).not.toMatch(/paused until/);
    // The leg went out, status refund or failure — pause (the deposit is debited, the refund comes later; a second bridge 15 s later would double the money in transit)
    for (const status of ['refund', 'failure']) {
      const r = setup({ robinhood: 0, base: 8 }, { status, now: () => 0 });
      expect((await r.f.ensure('robinhood', 2, 'live')).note).toMatch(new RegExp(`status: ${status}`));
      r.bal.robinhood = 0;
      expect((await r.f.ensure('robinhood', 2, 'live')).note).toMatch(/paused until/);
    }
  });
  it('M-4: unknown balance on the target chain in live → no bridge (not "zero")', async () => {
    const s = setup({ base: 8 });
    (s.f as any).d.evm = (c: string) => c === 'robinhood' ? { cfg: { id: 4663, rpc: 'http://x' }, async balance() { throw new Error('rpc down'); } } : (s.f as any).d.evm(c);
    const r = await s.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(false); expect(r.note).toMatch(/balance on robinhood unknown/); expect(s.quotes.length).toBe(0); expect(s.sent.length).toBe(0);
  });
  it('item 8: the Relay API key goes only to the Relay host — a status endpoint on another host is refused', async () => {
    const urls: string[] = [];
    const inits: any[] = [];
    const c = relayClient('secret-key', (async (u: any, init: any) => { urls.push(String(u)); inits.push(init); return new Response(JSON.stringify({ status: 'success' })); }) as any);
    expect(await c.status('/intents/status?requestId=1')).toBe('success');
    expect(await c.status('https://api.relay.link/intents/status?requestId=2')).toBe('success');
    await expect(c.status('https://evil.example/collect')).rejects.toThrow(/endpoint origin https:\/\/evil.example is not https:\/\/api.relay.link/);
    await expect(c.status('http://api.relay.link/collect')).rejects.toThrow(/origin/); // without TLS the key would go out in plain text
    await expect(c.status('https://api.relay.link@evil.example/collect')).rejects.toThrow(/origin/);
    expect(urls.every(u => u.startsWith('https://api.relay.link/'))).toBe(true);
    expect(inits.every(i => i.redirect === 'error')).toBe(true); // a 302 redirect to another host is not followed — the key does not leave
  });
});

describe('E-12 (#73): shadow bridge quote without a keystore', () => {
  const SYSTEM = '11111111111111111111111111111111';
  function noKeys(over: Record<string, unknown> = {}) {
    const quotes: any[] = [];
    const relay: RelayClient = {
      async quote(q) { quotes.push(q);
        // like the real Relay: a program address cannot be the recipient
        if (q.recipient === SYSTEM || q.user === SYSTEM) throw new Error(`relay quote HTTP 400: Recipient address ${SYSTEM} is a token contract and cannot receive funds`);
        return { requestId: 'r1', details: { currencyOut: { amountUsd: String(Number(q.amount) / 10 ** (q.from === 'solana' ? 9 : 18) * ETH * 0.99) }, timeEstimate: 8, recipient: q.recipient }, steps: [] }; },
      async status() { return 'success'; },
    };
    const f = new Funding({ relay, evm: () => undefined, nativeUsd: async () => ETH, home: 'base', maxShareOfEquity: 0.6, equityUsd: () => 10, ...over } as any);
    return { f, quotes };
  }
  const isPubkey = async (a: string) => { const { PublicKey } = await import('@solana/web3.js'); return new PublicKey(a).toBase58() === a; };

  it('a buy on Solana, no wallets: the quote recipient is a regular address, not the system program; the check passes and says the address is a placeholder', async () => {
    const s = noKeys();
    const r = await s.f.ensure('solana', 2.36, 'shadow');
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/would bridge: Relay base→solana: .*keystore not created yet: quoted for a placeholder address, nothing can be sent/);
    expect(s.quotes.length).toBe(1);
    expect(s.quotes[0].recipient).not.toBe(SYSTEM);
    expect(await isPubkey(s.quotes[0].recipient)).toBe(true);
    expect(s.quotes[0].user).toBe('0x000000000000000000000000000000000000dEaD'); // the EVM side — the same placeholder as before
    // one placeholder per process: the second quote goes to the same address
    await s.f.ensure('solana', 2.36, 'shadow');
    expect(s.quotes[1].recipient).toBe(s.quotes[0].recipient);
  });

  it('the source is Solana (enabled explicitly), no wallets: the quote sender is not the system program either', async () => {
    const s = noKeys({ home: 'solana', allowSolanaSource: true });
    const r = await s.f.ensure('base', 2, 'shadow');
    expect(r.ok).toBe(true);
    expect(s.quotes[0].user).not.toBe(SYSTEM); expect(await isPubkey(s.quotes[0].user)).toBe(true);
    expect(s.quotes[0].recipient).toBe('0x000000000000000000000000000000000000dEaD');
  });

  it('live without wallets: it never gets to a quote, nothing is sent — the placeholder cannot reach a send', async () => {
    const s = noKeys();
    for (const chain of ['solana', 'base'] as const) {
      const r = await s.f.ensure(chain, 2, 'live');
      expect(r.ok).toBe(false);
      expect(r.note).toMatch(/balance on .* unknown|keystore locked/);
    }
    expect(s.quotes.length).toBe(0);
    // even if the balance "were readable", the inner check does not go further without wallets
    const inner = await (s.f as any).ensureInner('solana', 2, 2.5, 0, 'live');
    expect(inner).toEqual({ ok: false, note: 'keystore locked — the bridge needs unlocked wallets' });
    expect(s.quotes.length).toBe(0);
  });

  it('with wallets nothing changed: the recipient is our Solana address, no placeholder mark', async () => {
    const s = noKeys({ wallets: W, evm: (c: string) => ({ cfg: { id: 8453, rpc: 'http://x' }, async balance() { return BigInt(Math.round((c === 'base' ? 8 : 0) / ETH * 1e18)); } }), sol: { async getBalance() { return 0; } } });
    const r = await s.f.ensure('solana', 2, 'shadow');
    expect(r.ok).toBe(true); expect(r.note).not.toMatch(/placeholder/);
    expect(s.quotes[0].recipient).toBe(W.solTreasury.publicKey.toBase58());
    expect(s.quotes[0].user).toBe(W.evmTreasury.address);
  });
});

describe('#117 item 1: the "bridge leg sent" flag (legSent) and the list of bridges in transit (inTransit)', () => {
  it('the transfer arrived: legSent = true, nothing in transit', async () => {
    const s = setup({ robinhood: 0, base: 8 });
    const r = await s.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(true); expect(r.legSent).toBe(true);
    expect(s.f.inTransit()).toEqual([]);
  });

  it('the leg went out, Relay status is not success: legSent = true, the bridge to the target chain counts as in transit until the pause ends', async () => {
    let now = Date.UTC(2026, 10, 14, 9);
    const s = setup({ robinhood: 0, base: 8 }, { status: 'refund', now: () => now });
    const r = await s.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(false); expect(r.legSent).toBe(true); expect(s.sent.length).toBe(1);
    expect(s.f.inTransit()).toEqual(['bridge to robinhood: paused until 09:15:00 UTC (status refund, request r1)']);
    // a repeat call during the pause sends nothing itself — no flag, but the bridge is still in transit
    s.bal.robinhood = 0; // the money has not arrived yet (the send stub credits it at once)
    const again = await s.f.ensure('robinhood', 2, 'live');
    expect(again.ok).toBe(false); expect(again.note).toMatch(/paused until/); expect(again.legSent).toBeUndefined();
    expect(s.sent.length).toBe(1); expect(s.f.inTransit().length).toBe(1);
    now += BRIDGE_COOLDOWN_MS + 1;
    expect(s.f.inTransit()).toEqual([]);
  });

  it('the Relay step name does not affect the flag: step "quote-and-deposit" with a sent leg — legSent = true', async () => {
    const s = setup({ robinhood: 0, base: 8 }, { status: 'pending', waitMs: 30 });
    const relay = (s.f as any).d.relay; const quote = relay.quote.bind(relay);
    relay.quote = async (q: any) => { const r = await quote(q); r.steps[0].id = 'quote-and-deposit'; return r; };
    const r = await s.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(false); expect(r.note).toMatch(/status: timeout \(pending\)/); expect(r.legSent).toBe(true);
  });

  it('the leg transaction is "in flight" without a receipt: legSent = true and a pause; the node rejected the leg — no flag', async () => {
    const s = setup({ robinhood: 0, base: 8 });
    const evm = (s.f as any).d.evm;
    (s.f as any).d.evm = (c: string) => ({ ...evm(c), async send() { return { ok: false, pending: true, hash: '0xpend' }; } });
    const r = await s.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(false); expect(r.note).toMatch(/pending 0xpend/); expect(r.legSent).toBe(true);
    expect(s.f.inTransit()[0]).toMatch(/^bridge to robinhood: paused until .* \(previous leg pending/);
    const t = setup({ robinhood: 0, base: 8 });
    const evm2 = (t.f as any).d.evm;
    (t.f as any).d.evm = (c: string) => ({ ...evm2(c), async send() { return { ok: false, pending: false, hash: '0xfail' }; } });
    const r2 = await t.f.ensure('robinhood', 2, 'live');
    expect(r2.ok).toBe(false); expect(r2.note).toMatch(/failed 0xfail/); expect(r2.legSent).toBeUndefined(); expect(t.f.inTransit()).toEqual([]);
  });

  it('refusals before sending and shadow: no flag, nothing in transit', async () => {
    const cases: [Record<string, number>, Record<string, unknown>, 'live' | 'shadow', RegExp][] = [
      [{ robinhood: 0, base: 8 }, { simulate: 'revert' }, 'live', /simulat/],
      [{ robinhood: 0, base: 8 }, { simulate: 'drain' }, 'live', /./],
      [{ robinhood: 0, base: 8 }, { noRecipient: true }, 'live', /no recipient/],
      [{ robinhood: 0, base: 0.5 }, {}, 'live', /no chain has/],
      [{ robinhood: 0, base: 8 }, { relay: false }, 'live', /no bridge configured/],
      [{ robinhood: 0, base: 8 }, {}, 'shadow', /would bridge/],
      [{ robinhood: 5, base: 5 }, {}, 'live', /funds on robinhood/],
    ];
    for (const [bal, opts, mode, re] of cases) {
      const s = setup(bal, opts as any);
      const r = await s.f.ensure('robinhood', 2, mode);
      expect([String(re), r.note]).toEqual([String(re), expect.stringMatching(re)]);
      expect(r.legSent).toBeUndefined(); expect(s.sent.length).toBe(0); expect(s.f.inTransit()).toEqual([]);
    }
  });

  it('while the transfer is running, the bridge counts as in transit', async () => {
    const s = setup({ robinhood: 0, base: 8 });
    let during: string[] = [];
    const relay = (s.f as any).d.relay; const status = relay.status.bind(relay);
    relay.status = async (e: string) => { during = s.f.inTransit(); return status(e); };
    await s.f.ensure('robinhood', 2, 'live');
    expect(during).toEqual(['bridge to robinhood: running']);
  });
});

describe('#117 item 2: the bridge source is only a chain from the sources list', () => {
  it('the most money is on a chain outside the list → it is not a source; a chain from the list is taken, and if it is short — refusal before sending', async () => {
    // arbitrum is richer, but only base and robinhood are in the reconciled list
    const s = setup({ robinhood: 0, base: 8, arbitrum: 50 });
    (s.f as any).d.sources = ['base', 'robinhood'];
    const r = await s.f.ensure('robinhood', 2, 'live');
    expect(r.ok).toBe(true); expect(s.quotes[0].from).toBe('base');
    const t = setup({ robinhood: 0, base: 0.5, arbitrum: 50 });
    (t.f as any).d.sources = ['base', 'robinhood'];
    const r2 = await t.f.ensure('robinhood', 2, 'live');
    expect(r2.ok).toBe(false); expect(r2.note).toMatch(/no chain has/); expect(r2.legSent).toBeUndefined(); expect(t.sent.length).toBe(0);
  });

  it('without a list — as before: the source is the chain with the largest free balance', async () => {
    const s = setup({ robinhood: 0, base: 8, arbitrum: 50 });
    await s.f.ensure('robinhood', 2, 'live');
    expect(s.quotes[0].from).toBe('arbitrum');
  });
});
