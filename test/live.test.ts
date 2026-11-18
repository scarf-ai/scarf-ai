import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt, decrypt, newKeyMaterial, saveKeystore, loadKeystore, Wallets, keystorePassword } from '../src/live/keystore.js';
import { EvmSender, jsonRpc, isNoAnswer, NoAnswerError, PENDING_MAX_MS, receivedFromReceipt, chainConfigs } from '../src/live/evm.js';
import { SolSender } from '../src/live/jupiter.js';
import { LiveTrader, KYBER_ROUTERS, DEFAULT_LIVE_SWAP_CHAINS } from '../src/live/trader.js';
import { NATIVE } from '../src/live/kyber.js';
import { privateKeyToAccount } from 'viem/accounts';

describe('keystore (keys only on the server, encrypted)', () => {
  it('round-trips; wrong password fails; JSON of wallets has no secrets', () => {
    const km = newKeyMaterial(2);
    const env = encrypt(km, 'correct horse battery staple');
    expect(JSON.stringify(env)).not.toContain(km.evm.treasury.slice(2, 20));
    expect(decrypt(env, 'correct horse battery staple').evm.treasury).toBe(km.evm.treasury);
    expect(() => decrypt(env, 'wrong password 123456')).toThrow(/wrong password/);
    const dir = mkdtempSync(join(tmpdir(), 'ks-'));
    saveKeystore(dir, km, 'correct horse battery staple');
    const w = new Wallets(loadKeystore(dir, 'correct horse battery staple'));
    expect(w.evmBurners.length).toBe(2);
    const dump = JSON.stringify(w);
    expect(dump).not.toContain(km.evm.treasury.slice(2));
    expect(dump).toContain(w.evmTreasury.address);
    expect(() => encrypt(km, 'short')).toThrow(/16/);
  });
  it('password from systemd credential directory or env', () => {
    expect(keystorePassword({ AGENT_KEYSTORE_PASS: 'x'.repeat(20) } as any)).toBe('x'.repeat(20));
    expect(keystorePassword({} as any)).toBeUndefined();
  });
});

describe('EVM fast sender', () => {
  const cfg = { chain: 'base' as const, id: 8453, native: 'ETH', rpc: 'http://read', send: ['http://lane0', 'http://lane1'], priorityMatters: true };
  it('one signed tx goes to every lane; receipt from the first node; nonce reserved locally', async () => {
    const sends: string[] = []; let receiptCalls = 0;
    const rpc = async (url: string, method: string, params: any[]) => {
      switch (method) {
        case 'eth_getBlockByNumber': return { baseFeePerGas: '0x3b9aca00' };
        case 'eth_maxPriorityFeePerGas': return '0x5f5e100';
        case 'eth_getTransactionCount': return '0x7';
        case 'eth_estimateGas': return '0x5208';
        case 'eth_sendRawTransaction': sends.push(url); if (url.endsWith('lane1')) throw new Error('lane down'); return '0x';
        case 'eth_getTransactionReceipt': receiptCalls++; return receiptCalls > 2 ? { blockNumber: '0x1', status: '0x1', logs: [] } : null;
      }
      throw new Error(method);
    };
    const s = new EvmSender(cfg, rpc as any);
    const acc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const r = await s.send(acc, { to: '0x000000000000000000000000000000000000dEaD', value: 1n });
    expect(r.ok).toBe(true);
    expect(sends.sort()).toEqual(['http://lane0', 'http://lane1']);
    expect(r.acceptedBy).toEqual(['lane0']);
    expect(await s.nonce(acc.address, false)).toBe(8);
  });
  it('tokens received are read from Transfer logs to our address', () => {
    const me = '0x1111111111111111111111111111111111111111';
    const r = { logs: [{ address: '0xT0K', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + me.slice(2)], data: '0x64' }] };
    expect(receivedFromReceipt(r, '0xt0k', me)).toBe(100n);
  });
  it('chains from env: send lanes default to the read RPC', () => {
    const c = chainConfigs({ RPC_BASE: 'https://b', RPC_SEND_BASE: 'https://s1, https://s2' } as any, {});
    expect(c.base?.send).toEqual(['https://s1', 'https://s2']);
    expect(c.ethereum).toBeUndefined();
  });
});

describe('LiveTrader safety', () => {
  it('unpinned router from the aggregator API is refused (shadow buy)', async () => {
    const kyber = { async swap() { return { to: '0x00000000000000000000000000000000000BaD00' as const, data: '0x12345678' as const, value: 10n, amountIn: 10n, amountOut: 5n, minOut: 4n, router: '0x00000000000000000000000000000000000BaD00' }; } };
    const t = new LiveTrader({ chains: { base: { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } }, nativeUsd: async () => 4000, slippageBps: 500, kyber });
    const r = await t.buyToken({ chain: 'base', token: '0x2222222222222222222222222222222222222222', sizeUsd: 1 }, 'shadow');
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/unexpected router/);
    expect(KYBER_ROUTERS[0]).toBe('0x6131b5fae19ea4f9d964eac0408e4408b66337b5');
    expect(NATIVE).toMatch(/^0xEeee/);
  });
  it('shadow buy: pinned router, firewall, simulation with balance override → would-get note, nothing sent', async () => {
    const TOKEN = '0x2222222222222222222222222222222222222222';
    const R = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
    const kyber = { async swap(p: any) { return { to: R as `0x${string}`, data: '0xe21fd0e9' as `0x${string}`, value: p.amountIn, amountIn: p.amountIn, amountOut: 5_000_000_000_000_000_000n, minOut: 4_600_000_000_000_000_000n, router: R }; } };
    const methods: string[] = [];
    const f: typeof fetch = async (_u: any, init: any) => {
      const b = JSON.parse(init.body); methods.push(b.method);
      if (b.method === 'eth_call') return new Response(JSON.stringify({ result: '0x' + (18).toString(16).padStart(64, '0') }));
      if (b.method === 'eth_gasPrice') return new Response(JSON.stringify({ result: '0x1' }));
      if (b.method === 'eth_simulateV1') {
        const from = b.params[0].blockStateCalls[0].calls[0].from.toLowerCase();
        expect(b.params[0].blockStateCalls[0].stateOverrides[from] ?? b.params[0].blockStateCalls[0].stateOverrides[b.params[0].blockStateCalls[0].calls[0].from]).toBeDefined();
        const log = { address: TOKEN, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + from.slice(2)], data: '0x' + (5n * 10n ** 18n).toString(16) };
        return new Response(JSON.stringify({ result: [{ calls: [{ status: '0x1', gasUsed: '0x30000', logs: [log] }] }] }));
      }
      throw new Error(b.method);
    };
    const t = new LiveTrader({ chains: { base: { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } }, nativeUsd: async () => 4000, slippageBps: 500, kyber, fetchImpl: f });
    const r = await t.buyToken({ chain: 'base', token: TOKEN, sizeUsd: 2 }, 'shadow');
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/would get 5\.00000 tokens.*simulated OK/);
    expect(methods).not.toContain('eth_sendRawTransaction');
  });

  it('decimals() that fails or answers nonsense → token is not traded (no 18 substituted), nothing sent', async () => {
    const TOKEN = '0x3333333333333333333333333333333333333333';
    const R = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
    const kyber = { async swap(p: any) { return { to: R as `0x${string}`, data: '0xe21fd0e9' as `0x${string}`, value: p.amountIn, amountIn: p.amountIn, amountOut: 5n * 10n ** 18n, minOut: 4n * 10n ** 18n, router: R }; } };
    const run = async (decimalsReply: { error?: string; result?: string }) => {
      const methods: string[] = [];
      const f: typeof fetch = async (_u: any, init: any) => {
        const b = JSON.parse(init.body); methods.push(b.method);
        if (b.method === 'eth_call') return new Response(JSON.stringify(decimalsReply.error ? { error: { message: decimalsReply.error } } : { result: decimalsReply.result }));
        if (b.method === 'eth_gasPrice') return new Response(JSON.stringify({ result: '0x1' }));
        throw new Error(b.method);
      };
      const t = new LiveTrader({ chains: { base: { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } }, nativeUsd: async () => 4000, slippageBps: 500, kyber, fetchImpl: f });
      const r = await t.buyToken({ chain: 'base', token: TOKEN, sizeUsd: 2 }, 'shadow');
      return { r, methods };
    };
    const a = await run({ error: 'execution reverted' });
    expect(a.r.ok).toBe(false);
    expect(a.r.note).toMatch(/^decimals: .*token not traded/);
    expect(a.methods).not.toContain('eth_simulateV1');
    expect(a.methods).not.toContain('eth_sendRawTransaction');
    const b = await run({ result: '0x' }); // an empty answer (not a contract) — also a refusal, not 18
    expect(b.r.ok).toBe(false);
    expect(b.r.note).toMatch(/token not traded/);
    const c = await run({ result: '0x' + (255).toString(16).padStart(64, '0') }); // 255 decimals — absurd
    expect(c.r.note).toMatch(/token not traded/);
  });

  it('live buy outside the live-swap allowlist (Ethereum mainnet, BSC by default) → refused before any RPC call; sells are not limited', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const calls: string[] = [];
    const f: typeof fetch = async (_u: any, init: any) => { calls.push(JSON.parse(init.body).method); throw new Error('no rpc in this test'); };
    const chains = { ethereum: { chain: 'ethereum', id: 1, native: 'ETH', kyber: 'ethereum', rpc: 'http://x', send: ['http://x'], priorityMatters: true }, bsc: { chain: 'bsc', id: 56, native: 'BNB', kyber: 'bsc', rpc: 'http://y', send: ['http://y'], priorityMatters: true } } as const;
    const t = new LiveTrader({ wallets: W, chains: chains as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
    for (const chain of ['ethereum', 'bsc'] as const) {
      const r = await t.buyToken({ chain, token: '0x2222222222222222222222222222222222222222', sizeUsd: 2 }, 'live');
      expect(r.ok).toBe(false);
      expect(r.note).toMatch(/live buys on .* are off \(AGENT_LIVE_CHAINS/);
    }
    expect(calls).toEqual([]);
    expect(DEFAULT_LIVE_SWAP_CHAINS).toEqual(['base', 'robinhood', 'arbitrum', 'solana']);
    // An explicit list from the owner (AGENT_LIVE_CHAINS) — the buy goes further (and hits this test's RPC, not the list)
    const t2 = new LiveTrader({ wallets: W, chains: chains as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f, liveSwapChains: ['ethereum'] });
    expect((await t2.buyToken({ chain: 'ethereum', token: '0x2222222222222222222222222222222222222222', sizeUsd: 2 }, 'live')).note).not.toMatch(/AGENT_LIVE_CHAINS/);
    // A sale on Ethereum is not limited by the list: it gets to reading the balance (RPC), not a list refusal
    const r3 = await t.sellToken({ chain: 'ethereum', token: '0x2222222222222222222222222222222222222222', share: 1 }, 'live');
    expect(r3.note).not.toMatch(/AGENT_LIVE_CHAINS/);
  });

  it('decimals() failure in live (with keystore) and in a shadow sell with shadowQty → refused, nothing signed or sent', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const TOKEN = '0x3333333333333333333333333333333333333333';
    const R = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
    const kyber = { async swap(p: any) { return { to: R as `0x${string}`, data: '0xe21fd0e9' as `0x${string}`, value: p.amountIn, amountIn: p.amountIn, amountOut: 5n * 10n ** 18n, minOut: 4n * 10n ** 18n, router: R }; } };
    const methods: string[] = [];
    const f: typeof fetch = async (_u: any, init: any) => {
      const b = JSON.parse(init.body); methods.push(b.method);
      if (b.method === 'eth_call') return new Response(JSON.stringify({ error: { message: 'execution reverted' } }));
      if (b.method === 'eth_gasPrice') return new Response(JSON.stringify({ result: '0x1' }));
      throw new Error(b.method);
    };
    const t = new LiveTrader({ wallets: W, chains: { base: { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } }, nativeUsd: async () => 4000, slippageBps: 500, kyber, fetchImpl: f });
    const live = await t.buyToken({ chain: 'base', token: TOKEN, sizeUsd: 2 }, 'live');
    expect(live.ok).toBe(false);
    expect(live.note).toMatch(/^decimals: .*token not traded/);
    expect(methods).not.toContain('eth_simulateV1');
    expect(methods).not.toContain('eth_sendRawTransaction');
    // a shadow sale with no tokens in the wallet (quantity from paper): decimals() is needed to convert the quantity — refusal, not 18
    const sell = await t.sellToken({ chain: 'base', token: TOKEN, share: 1, shadowQty: 5 }, 'shadow');
    expect(sell.ok).toBe(false);
    expect(sell.note).toMatch(/^sell: decimals\(\)|^sell: .*execution reverted/);
    expect(methods).not.toContain('eth_sendRawTransaction');
  });

  it('live without keystore → refuses', async () => {
    const t = new LiveTrader({ chains: {}, nativeUsd: async () => 4000, slippageBps: 500 });
    expect((await t.buyToken({ chain: 'base', token: '0x2222222222222222222222222222222222222222', sizeUsd: 1 }, 'live')).note).toMatch(/keystore locked/);
  });
});

describe('review fixes: nonce race, fast fail, key leaks', () => {
  it('parallel sends from one wallet get distinct nonces; the highest pending nonce across nodes wins', async () => {
    const rpc = async (url: string, m: string) => { if (m === 'eth_getTransactionCount') { await new Promise(r => setTimeout(r, 5)); return url.endsWith('lag') ? '0x5' : '0x7'; } throw new Error(m); };
    const s = new EvmSender({ chain: 'base', id: 8453, native: 'ETH', rpc: 'http://lag', send: ['http://fresh'], priorityMatters: true }, rpc as any);
    const a = '0x' + '1'.repeat(40);
    expect((await Promise.all([s.nonce(a), s.nonce(a), s.nonce(a)])).sort()).toEqual([7, 8, 9]);
  });
  it('a tx no lane accepted fails fast (no 45 s wait) and is not "pending"; "already known" counts as accepted', async () => {
    let n = 0;
    const rpc = async (_u: string, m: string) => { if (m === 'eth_sendRawTransaction') throw new Error(n++ ? 'already known' : 'insufficient funds'); if (m === 'eth_getTransactionReceipt' || m === 'eth_getTransactionByHash') return null; throw new Error(m); };
    const s = new EvmSender({ chain: 'base', id: 8453, native: 'ETH', rpc: 'http://r', send: ['http://r'], priorityMatters: true }, rpc as any);
    const t0 = Date.now();
    const r = await s.broadcast('0x01', '0x' + '2'.repeat(64) as any, { waitMs: 400 });
    expect(r.ok).toBe(false); expect(r.pending).toBe(false); expect(Date.now() - t0).toBeLessThan(4_000);
    const r2 = await s.broadcast('0x01', '0x' + '2'.repeat(64) as any, { waitMs: 300 });
    expect(r2.pending).toBe(true);
  });
  it('wallets never print secrets via inspect; password leaves the environment after reading', async () => {
    const { inspect } = await import('node:util');
    const km = newKeyMaterial(1);
    const w = new Wallets(km);
    expect(inspect({ deps: { w } }, { depth: 10 })).not.toContain(km.solana.treasury.slice(0, 20));
    const env: any = { AGENT_KEYSTORE_PASS: 'y'.repeat(20) };
    expect(keystorePassword(env)).toBe('y'.repeat(20));
    expect(env.AGENT_KEYSTORE_PASS).toBeUndefined();
  });
});

describe('second review fixes', () => {
  it('"nonce too low" is not counted as accepted: send is not pending and the nonce is re-read', async () => {
    let counts = 0;
    const rpc = async (_u: string, m: string) => {
      if (m === 'eth_getTransactionCount') { counts++; return '0x3'; }
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x1';
      if (m === 'eth_sendRawTransaction') throw new Error('nonce too low');
      if (m === 'eth_getTransactionReceipt' || m === 'eth_getTransactionByHash') return null;
      throw new Error(m);
    };
    const s = new EvmSender({ chain: 'base', id: 8453, native: 'ETH', rpc: 'http://r', send: ['http://r'], priorityMatters: true }, rpc as any);
    const acc = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    vi.useFakeTimers();
    try {
      // All lanes refused — not "never happened" right away (the gateway may have forwarded it): "in flight" with immediate background resolution by hash and nonce
      const p = s.send(acc, { to: '0x000000000000000000000000000000000000dEaD', value: 1n, gas: 21_000n }); await vi.advanceTimersByTimeAsync(5_000); const r = await p;
      expect(r.pending).toBe(true); expect(r.ok).toBe(false); expect(r.unknown).toEqual(['rejected-by-all-lanes']);
      expect(s.hasPending(acc.address)).toBeDefined();
      await vi.advanceTimersByTimeAsync(40_000); // nobody knows the hash, counters = nonce, repeat after 30 s → dropped
      expect(s.hasPending(acc.address)).toBeUndefined(); expect(s.outcomes.get(r.hash.toLowerCase())?.state).toBe('dropped');
      expect(await s.nonce(acc.address, false)).toBe(3); // nonce re-read from the nodes (the local 4 is forgotten)
      expect(counts).toBeGreaterThanOrEqual(4);
    } finally { vi.useRealTimers(); }
  });
});

describe('E-10: blockers from the independent review', () => {
  const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;
  const R = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
  const TOKEN = '0x4444444444444444444444444444444444444444';
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const A = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
  const w64 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
  const topicAddr = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();

  it('blocker 4: a lane that never answers (timeout / network) makes the send "pending" with the hash, nonce is NOT reset; a node rejection still fails fast', async () => {
    let counts = 0;
    const mk = (fail: () => never) => {
      const rpc = async (_u: string, m: string) => {
        if (m === 'eth_getTransactionCount') { counts++; return '0x3'; }
        if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
        if (m === 'eth_maxPriorityFeePerGas') return '0x1';
        if (m === 'eth_sendRawTransaction') fail();
        if (m === 'eth_getTransactionReceipt' || m === 'eth_getTransactionByHash') return null;
        throw new Error(m);
      };
      return new EvmSender({ ...chain, rpc: 'http://r', send: ['http://r'] }, rpc as any);
    };
    const acc = privateKeyToAccount(newKeyMaterial(0).evm.treasury);
    const tx = { to: '0x' + '2'.repeat(40) as `0x${string}`, value: 1n, gas: 21_000n };
    // No answer (fetch failed) — pending, the nonce is taken: the second send takes the next nonce without a new read from the node
    const s1 = mk(() => { throw new TypeError('fetch failed'); });
    vi.useFakeTimers();
    try {
      const p1 = s1.send(acc, tx); await vi.advanceTimersByTimeAsync(60_000); const r1 = await p1;
      expect(r1.pending).toBe(true); expect(r1.ok).toBe(false); expect(r1.unknown).toEqual(['lane0']); expect(r1.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r1.nonce).toBe(3); expect(s1.hasPending(acc.address)?.hash).toBe(r1.hash); // "in flight" registered: new sends from the address wait for its outcome
      expect(await s1.nonce(acc.address, false)).toBe(4); expect(counts).toBe(2); // 2 = reads from two addresses at init, no repeat read
      // An explicit node refusal — not pending, the nonce is re-read
      counts = 0;
      const s2 = mk(() => { throw new Error('eth_sendRawTransaction: insufficient funds for gas * price + value'); });
      const p2 = s2.send(acc, tx); await vi.advanceTimersByTimeAsync(5_000); const r2 = await p2;
      expect(r2.pending).toBe(true); expect(r2.unknown).toEqual(['rejected-by-all-lanes']); // a node refusal ≠ "never happened": resolved in the background
      await vi.advanceTimersByTimeAsync(40_000);
      expect(s2.hasPending(acc.address)).toBeUndefined(); expect(await s2.nonce(acc.address, false)).toBe(3); // ~35 s: dropped → nonce re-read
    } finally { vi.useRealTimers(); }
  });

  it('blocker 1: approve "in flight" is not a sale — no pending/tx, approveTx only; the sell is retried only after the approve confirms, and approve is skipped when allowance suffices', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const me = W.evmTreasury.address;
    const amount = 5n * 10n ** 18n;
    const kyber = { async swap(p: any) { return { to: R as `0x${string}`, data: '0xe21fd0e9' as `0x${string}`, value: 0n, amountIn: p.amountIn, amountOut: 10n ** 16n, minOut: 9n * 10n ** 15n, router: R }; } };
    const state = { allowance: 0n, known: true, approveReceipt: null as any, sentRaw: [] as string[], receipts: new Map<string, any>() };
    const f: typeof fetch = async (_u: any, init: any) => {
      const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ result }));
      switch (b.method) {
        case 'eth_call': { const sel = String(b.params[0].data).slice(0, 10);
          if (sel === '0x70a08231') return res(w64(amount)); // balanceOf
          if (sel === '0xdd62ed3e') return res(w64(state.allowance)); // allowance
          if (sel === '0x313ce567') return res(w64(18n)); // decimals
          throw new Error(`eth_call ${sel}`); }
        case 'eth_gasPrice': return res('0x1');
        case 'eth_simulateV1': { const calls = b.params[0].blockStateCalls[0].calls;
          const approveLogs = [{ address: TOKEN, topics: [A, topicAddr(me), topicAddr(R)], data: w64(amount) }];
          const swapLogs = [{ address: TOKEN, topics: [T, topicAddr(me), topicAddr(R)], data: w64(amount) }, { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [T, topicAddr(R), topicAddr(me)], data: w64(10n ** 16n) }];
          // the last call is the swap; before it (if any) — the approve
          return res([{ calls: calls.map((_: any, i: number) => ({ status: '0x1', gasUsed: '0x5208', logs: i === calls.length - 1 ? swapLogs : approveLogs })) }]); }
        case 'eth_getBlockByNumber': return res({ baseFeePerGas: '0x1' });
        case 'eth_maxPriorityFeePerGas': return res('0x1');
        case 'eth_getTransactionCount': return res('0x0');
        case 'eth_sendRawTransaction': { state.sentRaw.push(b.params[0]); throw new TypeError('fetch failed'); } // the node did not answer — the transaction is "in flight"
        case 'eth_getTransactionReceipt': return res(state.receipts.get(String(b.params[0]).toLowerCase()) ?? null);
        case 'eth_getTransactionByHash': return res(state.known ? { hash: b.params[0] } : null);
        default: throw new Error(b.method);
      }
    };
    const t = new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, kyber, fetchImpl: f });
    vi.useFakeTimers();
    try {
      const args = { chain: 'base' as const, token: TOKEN, share: 1, amountRaw: amount };
      const p1 = t.sellToken(args, 'live'); await vi.advanceTimersByTimeAsync(60_000); const r1 = await p1;
      expect(r1.ok, r1.note).toBe(false); expect(r1.pending).toBeFalsy(); expect(r1.tx).toBeUndefined();
      expect(r1.note).toMatch(/approve pending/); expect(r1.approveTx).toMatch(/^0x[0-9a-f]{64}$/); expect(r1.note).toMatch(/approve pending .* sell retried after it confirms/);
      expect(state.sentRaw.length).toBe(1);
      // A repeat while the approve is undecided (the nodes know it): nothing is sent, no route is requested
      const p2 = t.sellToken(args, 'live'); await vi.advanceTimersByTimeAsync(5_000); const r2 = await p2;
      expect(r2.note).toMatch(/still pending/); expect(state.sentRaw.length).toBe(1);
      // the approve dropped from the network (no node knows the hash): the background (from the first minute, not after 10) decides "dropped", nonce anew;
      // the next sale takes the ready result without waiting and signs the approve again
      state.known = false;
      await vi.advanceTimersByTimeAsync(120_000); // 45 s + 2 s + 30 s repeat + 2 s → dropped
      expect(t.sender('base')!.outcomes.get(r1.approveTx!.toLowerCase())?.state).toBe('dropped');
      const p2b = t.sellToken(args, 'live'); await vi.advanceTimersByTimeAsync(60_000); const r2b = await p2b;
      expect(r2b.note).toMatch(/approve pending/); expect(state.sentRaw.length).toBe(2); // the same nonce from the node → the same signature: this is the repeat, not a new transaction
      state.known = true;
      // Longer than 20 min in the mempool — an alarm, no sale
      vi.setSystemTime(Date.now() + 21 * 60_000);
      const p2c = t.sellToken(args, 'live'); await vi.advanceTimersByTimeAsync(5_000); const r2c = await p2c;
      expect(r2c.note).toMatch(/pending for over 20 min/); expect(state.sentRaw.length).toBe(2);
      state.receipts.set(r2b.approveTx!.toLowerCase(), { status: '0x1', blockNumber: '0x1' });
      // the approve confirmed, allowance is enough → the approve is not repeated, only the swap goes out (its receipt is a success)
      state.allowance = amount;
      const sentBefore = state.sentRaw.length;
      // The node will accept the swap: answer the send with a hash and put a receipt for any new hash
      const p3 = t.sellToken(args, 'live');
      await vi.advanceTimersByTimeAsync(3_000);
      // after the swap is sent, put a receipt (swap hash = keccak of the raw transaction; we find it from the receipt request)
      await vi.advanceTimersByTimeAsync(60_000);
      const r3 = await p3;
      expect(state.sentRaw.length).toBe(sentBefore + 1); // only the swap, no second approve
      expect(r3.approveTx).toBeUndefined();
      expect(r3.pending).toBe(true); expect(r3.tx).toMatch(/^0x[0-9a-f]{64}$/); // the swap "in flight" — this is already a real sale in flight
      // #135 F3: nonce and the sender address — to resolve the outcome after a restart
      expect(Number.isInteger(r3.nonce)).toBe(true); expect(r3.from?.toLowerCase()).toBe(W.evmTreasury.address.toLowerCase());
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('item 7: the bridge runs after route, firewall and decimals — an unpinned router never triggers funding; item 9: balance read error in live is a refusal, not "nothing to sell"', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const order: string[] = [];
    const kyberBad = { async swap() { order.push('route'); return { to: '0x00000000000000000000000000000000000BaD00' as const, data: '0x12345678' as const, value: 10n, amountIn: 10n, amountOut: 5n, minOut: 4n, router: '0x00000000000000000000000000000000000BaD00' }; } };
    const f: typeof fetch = async (_u: any, init: any) => { const b = JSON.parse(init.body); order.push(b.method); throw new Error('rpc down'); };
    const t = new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, kyber: kyberBad, fetchImpl: f });
    t.funding = { async ensure() { order.push('funding'); return { ok: true, note: 'x' }; } } as any;
    const r = await t.buyToken({ chain: 'base', token: TOKEN, sizeUsd: 2 }, 'live');
    expect(r.note).toMatch(/unexpected router/);
    expect(order).toEqual(['route']);
    const sell = await t.sellToken({ chain: 'base', token: TOKEN, share: 1 }, 'live');
    expect(sell.ok).toBe(false); expect(sell.note).toMatch(/^balance read failed/);
  });
});

describe('E-10 second round (reviewer A)', () => {
  const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;
  it('H-1: HTTP 504 with an HTML body from a gateway is "no answer" → pending, nonce kept; a JSON-RPC error with HTTP 500 is still a rejection', async () => {
    const acc = privateKeyToAccount(newKeyMaterial(0).evm.treasury);
    let counts = 0;
    const mk = (onSend: () => Response) => new EvmSender({ ...chain, rpc: 'http://r', send: ['http://r'] }, jsonRpc(async (_u: any, init: any) => {
      const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ result }));
      if (b.method === 'eth_getTransactionCount') { counts++; return res('0x3'); }
      if (b.method === 'eth_getBlockByNumber') return res({ baseFeePerGas: '0x1' });
      if (b.method === 'eth_maxPriorityFeePerGas') return res('0x1');
      if (b.method === 'eth_sendRawTransaction') return onSend();
      if (b.method === 'eth_getTransactionReceipt' || b.method === 'eth_getTransactionByHash') return res(null);
      throw new Error(b.method);
    }));
    const tx = { to: '0x' + '2'.repeat(40) as `0x${string}`, value: 1n, gas: 21_000n };
    vi.useFakeTimers();
    try {
      const s1 = mk(() => new Response('<html>504 Gateway Time-out</html>', { status: 504 }));
      const p1 = s1.send(acc, tx); await vi.advanceTimersByTimeAsync(60_000); const r1 = await p1;
      expect(r1.pending).toBe(true); expect(r1.unknown).toEqual(['lane0']);
      expect(await s1.nonce(acc.address, false)).toBe(4); expect(counts).toBe(2);
      counts = 0;
      const s2 = mk(() => new Response(JSON.stringify({ error: { code: -32000, message: 'network error: nonce too low' } }), { status: 500 }));
      const p2 = s2.send(acc, tx); await vi.advanceTimersByTimeAsync(5_000); const r2 = await p2;
      expect(r2.pending).toBe(true); expect(r2.unknown).toEqual(['rejected-by-all-lanes']); // a parsed refusal, but resolved by the rules, not at once
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await s2.nonce(acc.address, false)).toBe(3); // dropped → nonce re-read
    } finally { vi.useRealTimers(); }
    expect(isNoAnswer(new NoAnswerError('x'))).toBe(true); expect(isNoAnswer(new SyntaxError('Unexpected token <'))).toBe(true);
    expect(isNoAnswer(new TypeError('fetch failed'))).toBe(true); expect(isNoAnswer(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isNoAnswer(new Error('eth_sendRawTransaction: network error'))).toBe(false); // text from the node — still an answer
    expect(isNoAnswer(new Error('eth_sendRawTransaction: nonce too low'))).toBe(false);
    // M-3: JSON 200 without result and without error ({"message":"rate limited"}) — not a node answer, not "accepted"
    const rpc = jsonRpc(async () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 200 }));
    await expect(rpc('http://r', 'eth_sendRawTransaction', ['0x'])).rejects.toBeInstanceOf(NoAnswerError);
    const rpcNull = jsonRpc(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })));
    expect(await rpcNull('http://r', 'eth_getTransactionByHash', ['0x'])).toBeNull(); // a legitimate null — with the result key
  });
  it('round 3: all lanes rejected, but a node already knows the hash (gateway forwarded it) → treated as pending, nonce kept', async () => {
    const acc = privateKeyToAccount(newKeyMaterial(0).evm.treasury);
    let counts = 0;
    const rpc = async (_u: string, m: string, params: any[]) => {
      if (m === 'eth_getTransactionCount') { counts++; return '0x3'; }
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x1';
      if (m === 'eth_sendRawTransaction') throw new Error('eth_sendRawTransaction: internal error');
      if (m === 'eth_getTransactionReceipt') return null;
      if (m === 'eth_getTransactionByHash') return { hash: params[0] };
      throw new Error(m);
    };
    const s = new EvmSender({ ...chain, rpc: 'http://r', send: ['http://r'] }, rpc as any);
    vi.useFakeTimers();
    try {
      const p = s.send(acc, { to: '0x' + '2'.repeat(40) as `0x${string}`, value: 1n, gas: 21_000n }); await vi.advanceTimersByTimeAsync(10_000); const r = await p;
      expect(r.pending).toBe(true); expect(r.unknown).toEqual(['rejected-by-all-lanes']);
      await vi.advanceTimersByTimeAsync(60_000); // the node knows the hash → unknown, the record lives on, the nonce is taken
      expect(s.hasPending(acc.address)?.hash).toBe(r.hash);
      expect(await s.nonce(acc.address, false)).toBe(4); expect(counts).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it('H-3: receipt polling survives an RPC outage — errors back off but never give up before the deadline', async () => {
    let calls = 0;
    const rpc = async (_u: string, m: string) => { if (m !== 'eth_getTransactionReceipt') throw new Error(m); calls++; if (Date.now() < 30_000) throw new TypeError('fetch failed'); return { status: '0x1', blockNumber: '0x1' }; };
    const s = new EvmSender({ ...chain, rpc: 'http://r', send: ['http://r'] }, rpc as any);
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const p = s.waitLate('0x' + 'e'.repeat(64)); await vi.advanceTimersByTimeAsync(60_000); const r = await p;
      expect(r?.status).toBe('0x1'); expect(calls).toBeGreaterThan(3); expect(calls).toBeLessThan(40); // the first 30 s — errors with a growing pause, then the receipt
      const s2 = new EvmSender({ ...chain, rpc: 'http://r', send: ['http://r'] }, (async () => { throw new TypeError('fetch failed'); }) as any);
      const p2 = s2.waitLate('0x' + 'f'.repeat(64), 20_000); await vi.advanceTimersByTimeAsync(25_000); expect(await p2).toBeUndefined(); // give up only on time
    } finally { vi.useRealTimers(); }
  });
  it('M-2 (Solana): the signature is known before sending; lanes with no answer → wait for status, not "not sent"; explicit rejections → not sent', async () => {
    const { Keypair, VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } = await import('@solana/web3.js');
    const kp = Keypair.generate();
    const mk = () => new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey('11111111111111111111111111111111'), lamports: 1 })] }).compileToV0Message());
    const ss = new SolSender('http://sol', ['http://sol']);
    let status: any = null;
    (ss as any).read = { getSignatureStatuses: async () => ({ value: [status] }), getBlockHeight: async () => 10 };
    (ss as any).lanes = [{ sendRawTransaction: async () => { throw new TypeError('fetch failed'); } }];
    vi.useFakeTimers();
    try {
      const p = ss.send(mk(), kp, 100, 5_000); await vi.advanceTimersByTimeAsync(2_000); status = { confirmationStatus: 'confirmed' }; await vi.advanceTimersByTimeAsync(2_000); const r = await p;
      expect(r.ok).toBe(true); expect(r.sig.length).toBeGreaterThan(40); // confirmed, although no lane answered
      // A gateway HTTP error comes from web3.js as a plain Error('504 Gateway Time-out: <html>…') — not a node answer: wait for the status
      status = null;
      (ss as any).lanes = [{ sendRawTransaction: async () => { throw new Error('504 Gateway Time-out: <html><body>504</body></html>'); } }];
      const pg = ss.send(mk(), kp, 100, 5_000); await vi.advanceTimersByTimeAsync(1_000); status = { confirmationStatus: 'confirmed' }; await vi.advanceTimersByTimeAsync(2_000);
      expect((await pg).ok).toBe(true);
      // A parsed node refusal (SendTransactionError / simulation / blockhash) — not sent
      (ss as any).lanes = [{ sendRawTransaction: async () => { throw new Error('Transaction simulation failed: Blockhash not found'); } }];
      const r2 = await ss.send(mk(), kp, 100, 5_000);
      expect(r2.ok).toBe(false); expect(r2.error).toMatch(/all send lanes rejected/); expect(r2.sig.length).toBeGreaterThan(40);
      (ss as any).lanes = [{ sendRawTransaction: async () => { throw Object.assign(new Error('boom'), { name: 'SendTransactionError' }); } }];
      expect((await ss.send(mk(), kp, 100, 5_000)).error).toMatch(/all send lanes rejected/);
    } finally { vi.useRealTimers(); }
  });
  it('M-2: pending resolution — known → unknown; counter above nonce → unknown; free slot twice → dropped; no record → unknown; slot taken everywhere → dropped; ghost mined later → address blocked', async () => {
    const W = new Wallets(newKeyMaterial(0));
    let counts = 0; let known = true; let latest = 3; let receipt: any = null;
    const f: typeof fetch = async (_u: any, init: any) => { const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ result }));
      if (b.method === 'eth_getTransactionCount') { counts++; return res(b.params[1] === 'latest' ? '0x' + latest.toString(16) : '0x3'); }
      if (b.method === 'eth_getTransactionReceipt') return res(receipt);
      if (b.method === 'eth_getTransactionByHash') return res(known ? { hash: b.params[0] } : null);
      throw new Error(b.method); };
    const t = new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, fetchImpl: f });
    const s = t.sender('base')!;
    vi.useFakeTimers();
    try {
      const H = ('0x' + 'c'.repeat(64)) as `0x${string}`;
      const addr = W.evmTreasury.address.toLowerCase();
      await s.nonce(W.evmTreasury.address); expect(counts).toBe(2);
      s.pendingTx.set(H, { addr, nonce: 3, hash: H, atMs: Date.now() });
      const p1 = t.settleTx('base', H); await vi.advanceTimersByTimeAsync(11 * 60_000); expect(await p1).toBe('unknown');
      expect(await s.nonce(W.evmTreasury.address, false)).toBe(4); // the nodes know the hash — the nonce is left alone (the local next stays 4)
      known = false;
      // Nobody knows the hash, latest = nonce (the slot is free), but the node's pending counter (3) is above the tx nonce (2): someone holds it → not dropped (inconsistent load balancer / malicious node)
      latest = 2;
      s.pendingTx.set(H, { addr, nonce: 2, hash: H, atMs: Date.now() });
      const p1b = t.settleTx('base', H); await vi.advanceTimersByTimeAsync(11 * 60_000); expect(await p1b).toBe('unknown');
      expect(await s.nonce(W.evmTreasury.address, false)).toBe(4);
      latest = 3;
      // Nobody knows the hash, counters == nonce (the slot is free), and the same 30 s later → dropped, nonce re-read
      s.pendingTx.set(H, { addr, nonce: 3, hash: H, atMs: Date.now() });
      const p2 = t.settleTx('base', H); await vi.advanceTimersByTimeAsync(11 * 60_000); expect(await p2).toBe('dropped');
      expect(await s.nonce(W.evmTreasury.address, false)).toBe(3); // nonce re-read from the nodes (3), not the local 4
      expect(s.pendingTx.size).toBe(0);
      s.pendingTx.set(H, { addr, nonce: 3, hash: H, atMs: Date.now() });
      const p3 = t.settleBuy({ chain: 'base', token: '0x' + '2'.repeat(40), sizeUsd: 1, tx: H, decimals: 18 }); await vi.advanceTimersByTimeAsync(11 * 60_000); const b3 = await p3;
      expect(b3.ok).toBe(false); expect(b3.pending).toBe(false); expect(b3.note).toMatch(/dropped/);
      // Without a nonce record (after a restart) we do not decide "dropped" — only unknown (OVERRIDES: by hash AND nonce)
      const p4 = t.settleTx('base', ('0x' + 'd'.repeat(64)) as `0x${string}`); await vi.advanceTimersByTimeAsync(11 * 60_000); expect(await p4).toBe('unknown');
      // The nonce slot is taken in a block on all nodes (latest = 5 > 3), no receipt for the hash — replaced manually: outcome "will not execute" (dropped), without a 3-hour block
      latest = 5;
      s.pendingTx.set(H, { addr, nonce: 3, hash: H, atMs: Date.now() });
      const p5 = t.settleTx('base', H); await vi.advanceTimersByTimeAsync(11 * 60_000); expect(await p5).toBe('dropped');
      latest = 3;
      // Ghost: declared dropped, but 2 min later a receipt was found → the address is blocked for buys/sales until reconciliation
      s.trackPending(addr, 3, H); // as in production: re-registration erases the old result ("replaced" from the previous step)
      const p6 = t.settleTx('base', H); await vi.advanceTimersByTimeAsync(11 * 60_000); expect(await p6).toBe('dropped');
      receipt = { status: '0x1', blockNumber: '0x10', transactionHash: H };
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(s.ghostMined.get(H)?.hash).toBe(H); expect(s.hasPending(addr)?.ghost).toBe(true); // the block key is the hash (round 4), the address is blocked
      expect((await t.sellToken({ chain: 'base', token: '0x' + '2'.repeat(40), share: 1 }, 'live')).note).toMatch(/declared dropped but later mined/);
    } finally { vi.useRealTimers(); }
  });
});

describe('E-10, follow-up after HQ acceptance (PR #48)', () => {
  const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;
  const R = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
  const TOKEN = '0x4444444444444444444444444444444444444444';
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const A = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
  const w64 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
  const topicAddr = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const mkTrader = (W: Wallets, state: { allowance: bigint; known: boolean; sentRaw: string[]; nativeUsd?: () => Promise<number | undefined> }) => {
    const me = W.evmTreasury.address; const amount = 5n * 10n ** 18n;
    const kyber = { async swap(p: any) { return { to: R as `0x${string}`, data: '0xe21fd0e9' as `0x${string}`, value: 0n, amountIn: p.amountIn, amountOut: 10n ** 16n, minOut: 9n * 10n ** 15n, router: R }; } };
    const f: typeof fetch = async (_u: any, init: any) => {
      const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ result }));
      switch (b.method) {
        case 'eth_call': { const sel = String(b.params[0].data).slice(0, 10);
          if (sel === '0x70a08231') return res(w64(amount)); if (sel === '0xdd62ed3e') return res(w64(state.allowance)); if (sel === '0x313ce567') return res(w64(18n));
          throw new Error(`eth_call ${sel}`); }
        case 'eth_gasPrice': return res('0x1');
        case 'eth_simulateV1': { const calls = b.params[0].blockStateCalls[0].calls;
          const approveLogs = [{ address: TOKEN, topics: [A, topicAddr(me), topicAddr(R)], data: w64(amount) }];
          const swapLogs = [{ address: TOKEN, topics: [T, topicAddr(me), topicAddr(R)], data: w64(amount) }, { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [T, topicAddr(R), topicAddr(me)], data: w64(10n ** 16n) }];
          return res([{ calls: calls.map((_: any, i: number) => ({ status: '0x1', gasUsed: '0x5208', logs: i === calls.length - 1 ? swapLogs : approveLogs })) }]); }
        case 'eth_getBlockByNumber': return res({ baseFeePerGas: '0x1' });
        case 'eth_maxPriorityFeePerGas': return res('0x1');
        case 'eth_getTransactionCount': return res('0x0');
        case 'eth_sendRawTransaction': { state.sentRaw.push(b.params[0]); throw new TypeError('fetch failed'); }
        case 'eth_getTransactionReceipt': return res(null);
        case 'eth_getTransactionByHash': return res(state.known ? { hash: b.params[0] } : null);
        default: throw new Error(b.method);
      }
    };
    return { t: new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: state.nativeUsd ?? (async () => 4000), slippageBps: 500, kyber, fetchImpl: f }), amount };
  };

  it('item 1 (reviewer repro A): the approve dropped and was resolved by the background watchPending first → the next sale signs the approve again rather than hanging "over 20 min"', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const state = { allowance: 0n, known: true, sentRaw: [] as string[] };
    const { t, amount } = mkTrader(W, state);
    vi.useFakeTimers();
    try {
      const args = { chain: 'base' as const, token: TOKEN, share: 1, amountRaw: amount };
      const p1 = t.sellToken(args, 'live'); await vi.advanceTimersByTimeAsync(60_000); const r1 = await p1;
      expect(r1.note).toMatch(/approve pending/); expect(state.sentRaw.length).toBe(1);
      // The price came back, the monitor does not call a sale; the approve dropped from the mempools; the background resolves it itself
      state.known = false;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const s = t.sender('base')!;
      expect(s.pendingTx.size).toBe(0); expect(s.outcomes.get(r1.approveTx!.toLowerCase())?.state).toBe('dropped');
      // An hour later the stop fires: the result is known by hash → approve again, not "pending for over 20 min"
      vi.setSystemTime(Date.now() + 60 * 60_000);
      const p2 = t.sellToken(args, 'live'); await vi.advanceTimersByTimeAsync(60_000); const r2 = await p2;
      expect(r2.note).not.toMatch(/over 20 min|still pending/);
      expect(r2.note).toMatch(/approve pending/); expect(state.sentRaw.length).toBe(2);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('item 1: settleTx gets the result decided by the background (dropped), instead of waiting 10 min or answering unknown', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const state = { allowance: 0n, known: false, sentRaw: [] as string[] };
    const { t } = mkTrader(W, state);
    const s = t.sender('base')!;
    vi.useFakeTimers();
    try {
      const sent = s.send(W.evmTreasury, { to: ('0x' + '2'.repeat(40)) as `0x${string}`, value: 1n, gas: 21_000n }); await vi.advanceTimersByTimeAsync(60_000); const r = await sent;
      expect(r.pending).toBe(true);
      await vi.advanceTimersByTimeAsync(11 * 60_000); // background: 10 min of receipt polling + resolution → dropped
      expect(s.pendingTx.size).toBe(0);
      const t0 = Date.now();
      const p = t.settleTx('base', r.hash); await vi.advanceTimersByTimeAsync(10_000); const st = await p;
      expect(st).toBe('dropped'); expect(Date.now() - t0).toBeLessThan(60_000); // not 10 minutes
    } finally { vi.useRealTimers(); }
  });

  it('item 3: a sale runs on the last known native price (accounting in $), a buy — only on a fresh one', async () => {
    const W = new Wallets(newKeyMaterial(0));
    let fresh: number | undefined = 4000;
    const state = { allowance: 5n * 10n ** 18n, known: true, sentRaw: [] as string[], nativeUsd: async () => fresh };
    const { t, amount } = mkTrader(W, state);
    vi.useFakeTimers();
    try {
      // The first sale — at a fresh price (the price is remembered); allowance is enough → one swap "in flight"
      const p1 = t.sellToken({ chain: 'base', token: TOKEN, share: 1, amountRaw: amount }, 'live'); await vi.advanceTimersByTimeAsync(60_000); const r1 = await p1;
      expect(r1.pending).toBe(true); expect(r1.proceedsUsd).toBeGreaterThan(0);
      // The price is gone (DexScreener pause / #47 returns undefined): the stop must work
      fresh = undefined;
      t.sender('base')!.pendingTx.clear(); // the previous swap is "resolved" to keep the scenario clean
      const p2 = t.sellToken({ chain: 'base', token: TOKEN, share: 1, amountRaw: amount }, 'live'); await vi.advanceTimersByTimeAsync(60_000); const r2 = await p2;
      expect(r2.note).not.toMatch(/native price/); expect(r2.pending).toBe(true); expect(r2.proceedsUsd).toBeCloseTo(r1.proceedsUsd, 6);
      // A buy without a fresh price — refusal
      const b = await t.buyToken({ chain: 'base', token: TOKEN, sizeUsd: 2 }, 'live');
      expect(b.ok).toBe(false); expect(b.note).toMatch(/no fresh base native price/);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('item 5 (Solana): after a confirmed send the balance could not be read or did not grow → pending with the signature, not "failure without a position"', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const t = new LiveTrader({ wallets: W, chains: {}, solRpc: { rpc: 'http://sol', send: [] }, nativeUsd: async () => 150, slippageBps: 500 });
    const sol: any = (t as any).sol;
    let reads = 0;
    sol.verifySwap = async () => ({ ok: true }); sol.simulate = async () => ({ ok: true });
    sol.send = async () => ({ sig: 'SIG111', ok: true });
    sol.tokenBalance = async () => { reads++; if (reads === 1) return 0n; throw new Error('rpc down'); };
    (t as any).solDecimals = async () => 6;
    (t as any).jup = { build: async () => ({ tx: {}, inAmount: 1n, outAmount: 1000n, minOut: 900n }) };
    const r = await t.buyToken({ chain: 'solana', token: 'Mint111111111111111111111111111111111111111', sizeUsd: 1 }, 'live');
    expect(r.ok).toBe(false); expect(r.pending).toBe(true); expect(r.tx).toBe('SIG111'); expect(r.note).toMatch(/settling by tx/);
    // the balance is readable but has not grown yet (a lagging node) — also pending, not "got 0"
    sol.tokenBalance = async () => 0n;
    const r2 = await t.buyToken({ chain: 'solana', token: 'Mint111111111111111111111111111111111111111', sizeUsd: 1 }, 'live');
    expect(r2.pending).toBe(true); expect(r2.tx).toBe('SIG111'); expect(r2.note).toMatch(/not yet visible/);
  });
});

describe('E-10, follow-up after HQ acceptance, round 2 (PR #48)', () => {
  const chain = { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } as const;
  const R = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
  const TOKEN = '0x4444444444444444444444444444444444444444';
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const A = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
  const w64 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
  const topicAddr = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();

  it('blocker 2 (repro A, Solana): settle=ok, but the transaction cannot be read or the node does not return it → pending, not "failure without a position"; 0 per meta → alarm, also pending', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const t = new LiveTrader({ wallets: W, chains: {}, solRpc: { rpc: 'http://sol', send: [] }, nativeUsd: async () => 150, slippageBps: 500 });
    const sol: any = (t as any).sol;
    sol.settle = async () => 'ok';
    sol.spentLamportsInTx = async () => undefined; // no network in the test: spend = the decision size (#135 item 3 is checked in tails135.test.ts)
    (t as any).solDecimals = async () => 6;
    const args = { chain: 'solana' as const, token: 'Mint111111111111111111111111111111111111111', sizeUsd: 1, tx: 'SIG', decimals: 6 };
    sol.receivedInTx = async () => { throw new Error('rpc down'); };
    let r = await t.settleBuy(args); expect(r.ok).toBe(false); expect(r.pending).toBe(true); expect(r.note).toMatch(/tx read failed/);
    sol.receivedInTx = async () => undefined;
    r = await t.settleBuy(args); expect(r.pending).toBe(true); expect(r.note).toMatch(/does not return the tx yet/);
    sol.receivedInTx = async () => 0n;
    r = await t.settleBuy(args); expect(r.pending).toBe(true); expect(r.note).toMatch(/received 0 per tx meta/);
    sol.receivedInTx = async () => 123_000n;
    r = await t.settleBuy(args); expect(r.ok).toBe(true); expect(r.qty).toBeCloseTo(0.123, 6);
  });

  it('item 3 (Solana): "already been processed" from all lanes — the transaction is executed: wait for the status, not a refusal', async () => {
    const { Keypair, VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } = await import('@solana/web3.js');
    const kp = Keypair.generate();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey('11111111111111111111111111111111'), lamports: 1 })] }).compileToV0Message());
    const ss = new SolSender('http://sol', ['http://sol']);
    (ss as any).read = { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed' }] }), getBlockHeight: async () => 10 };
    (ss as any).lanes = [{ sendRawTransaction: async () => { throw new Error('Transaction simulation failed: This transaction has already been processed'); } }];
    const r = await ss.send(tx, kp, 100, 5_000);
    expect(r.ok).toBe(true); expect(r.sig.length).toBeGreaterThan(40);
  });

  it('item 5 (repro B): the node rejects the approve with "insufficient funds" — the reason is visible in the note, the monitor tick does not wait 30 s, no sleeping under the lock', async () => {
    const W = new Wallets(newKeyMaterial(0)); const me = W.evmTreasury.address; const amount = 5n * 10n ** 18n;
    const sent: string[] = [];
    const kyber = { async swap(p: any) { return { to: R as `0x${string}`, data: '0xe21fd0e9' as `0x${string}`, value: 0n, amountIn: p.amountIn, amountOut: 10n ** 16n, minOut: 9n * 10n ** 15n, router: R }; } };
    const f: typeof fetch = async (_u: any, init: any) => {
      const b = JSON.parse(init.body); const res = (result: any) => new Response(JSON.stringify({ result }));
      switch (b.method) {
        case 'eth_call': { const sel = String(b.params[0].data).slice(0, 10);
          if (sel === '0x70a08231') return res(w64(amount)); if (sel === '0xdd62ed3e') return res(w64(0n)); if (sel === '0x313ce567') return res(w64(18n)); throw new Error(sel); }
        case 'eth_gasPrice': return res('0x1');
        case 'eth_simulateV1': { const calls = b.params[0].blockStateCalls[0].calls;
          const approveLogs = [{ address: TOKEN, topics: [A, topicAddr(me), topicAddr(R)], data: w64(amount) }];
          const swapLogs = [{ address: TOKEN, topics: [T, topicAddr(me), topicAddr(R)], data: w64(amount) }, { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [T, topicAddr(R), topicAddr(me)], data: w64(10n ** 16n) }];
          return res([{ calls: calls.map((_: any, i: number) => ({ status: '0x1', gasUsed: '0x5208', logs: i === calls.length - 1 ? swapLogs : approveLogs })) }]); }
        case 'eth_getBlockByNumber': return res({ baseFeePerGas: '0x1' });
        case 'eth_maxPriorityFeePerGas': return res('0x1');
        case 'eth_getTransactionCount': return res('0x3');
        case 'eth_sendRawTransaction': { sent.push(b.params[0]); return new Response(JSON.stringify({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } })); }
        case 'eth_getTransactionReceipt': return res(null);
        case 'eth_getTransactionByHash': return res(null);
        default: throw new Error(b.method);
      }
    };
    const t = new LiveTrader({ wallets: W, chains: { base: chain } as any, nativeUsd: async () => 4000, slippageBps: 500, kyber, fetchImpl: f });
    vi.useFakeTimers();
    try {
      const args = { chain: 'base' as const, token: TOKEN, share: 1, amountRaw: amount };
      const p1 = t.sellToken(args, 'live'); await vi.advanceTimersByTimeAsync(10_000); const r1 = await p1;
      expect(r1.note).toMatch(/insufficient funds/); expect(r1.approveTx).toBeDefined(); // the node's refusal reason is visible
      // A monitor tick 15 s later: an answer within seconds (no 30 s recheck in the caller), the reason is still visible
      await vi.advanceTimersByTimeAsync(15_000);
      let done = false; const p2 = t.sellToken(args, 'live').then(r => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(4_000); expect(done).toBe(true);
      const r2 = await p2; expect(r2.note).toMatch(/still pending.*insufficient funds/);
      // The background resolved "dropped" (~35 s): the next tick signs the approve again — again with a visible reason
      await vi.advanceTimersByTimeAsync(60_000);
      const p3 = t.sellToken(args, 'live'); await vi.advanceTimersByTimeAsync(10_000); const r3 = await p3;
      expect(sent.length).toBe(2); expect(r3.note).toMatch(/approve pending .*insufficient funds/);
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it('item 6: the background checks "dropped" from the first minute — the address is unblocked in ~1.5 min, not after 10', async () => {
    const acc = privateKeyToAccount(newKeyMaterial(0).evm.treasury);
    const rpc = async (_u: string, m: string) => {
      if (m === 'eth_getTransactionCount') return '0x3';
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' };
      if (m === 'eth_maxPriorityFeePerGas') return '0x1';
      if (m === 'eth_sendRawTransaction') throw new TypeError('fetch failed');
      if (m === 'eth_getTransactionReceipt' || m === 'eth_getTransactionByHash') return null;
      throw new Error(m);
    };
    const s = new EvmSender({ ...chain, rpc: 'http://r', send: ['http://r'] }, rpc as any);
    vi.useFakeTimers();
    try {
      const p = s.send(acc, { to: '0x000000000000000000000000000000000000dEaD', value: 1n, gas: 21_000n }); await vi.advanceTimersByTimeAsync(50_000); const r = await p;
      expect(r.pending).toBe(true); expect(s.hasPending(acc.address)).toBeDefined();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(s.hasPending(acc.address)).toBeUndefined(); expect(s.outcomes.get(r.hash.toLowerCase())?.state).toBe('dropped');
    } finally { vi.useRealTimers(); }
  });
});

describe('#48 round 4 item 7: the last real ETH price for sales comes from outside', () => {
  it('without a single price from the trader a sale waits; after noteNativePrice the stop goes out; a default/garbage is not accepted', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const TOKEN = '0x4444444444444444444444444444444444444444';
    const t = new LiveTrader({ wallets: W, chains: { base: { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } } as any,
      nativeUsd: async () => undefined, slippageBps: 500, fetchImpl: (async () => { throw new Error('rpc not expected before price'); }) as any });
    const r0 = await t.sellToken({ chain: 'base', token: TOKEN, share: 1 }, 'live');
    expect(r0.note).toMatch(/no base native price ever received/);
    t.noteNativePrice('base', 0); t.noteNativePrice('base', NaN);
    expect((await t.sellToken({ chain: 'base', token: TOKEN, share: 1 }, 'live')).note).toMatch(/no base native price ever received/);
    t.noteNativePrice('base', 3900.5);
    const r1 = await t.sellToken({ chain: 'base', token: TOKEN, share: 1 }, 'live');
    expect(r1.note).not.toMatch(/native price/); // reached the node (here it fails — that is already the next stage)
    expect(r1.note).toMatch(/balance read failed|unresolved|rpc not expected/);
  });

  it('#48 leftover: a "fresh" price of Infinity / negative / NaN is not a price: the buy refuses, it is not remembered for sales', async () => {
    const W = new Wallets(newKeyMaterial(0));
    const TOKEN = '0x4444444444444444444444444444444444444444';
    for (const bad of [Infinity, -4000, NaN, 0]) {
      const t = new LiveTrader({ wallets: W, chains: { base: { chain: 'base', id: 8453, native: 'ETH', kyber: 'base', rpc: 'http://x', send: ['http://x'], priorityMatters: true } } as any,
        nativeUsd: async () => bad, slippageBps: 500, fetchImpl: (async () => { throw new Error('rpc not expected before price'); }) as any });
      expect((await t.buyToken({ chain: 'base', token: TOKEN, sizeUsd: 2 }, 'live')).note).toMatch(/no fresh base native price/);
      expect((await t.sellToken({ chain: 'base', token: TOKEN, share: 1 }, 'live')).note).toMatch(/no base native price ever received/);
    }
  });
});
