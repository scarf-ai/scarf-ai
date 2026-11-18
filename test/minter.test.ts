import { describe, it, expect } from 'vitest';
import { decodeFunctionData, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { planMint, fireAtMs, Minter, type MintCfg } from '../src/live/minter.js';
import { NftLive } from '../src/live/nftLive.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import { encodeFulfillment, SEAPORT } from '../src/live/openseaTrade.js';
import { EvmSender } from '../src/live/evm.js';

const C: MintCfg = { maxWallets: 20, maxShareOfEquity: 0.5, minMultipleForMany: 1.5, pSuccess: 0.6, gasPerMint: 200_000n, priorityMultiplier: 3 };
const drop = { slug: 'lanternfolk', contract: '0x1111111111111111111111111111111111111111', chain: 'base', startUtc: '2026-10-23T18:00:00Z', priceEth: 0.0005, maxPerWallet: 1, sellFeesPct: 5 };

describe('FCFS minter: wallet count by risk/reward (the owner 2026-10-23)', () => {
  it('no exit price → 0; negative EV → 0; weak multiple → 1; strong → as many as budget allows, capped', () => {
    expect(planMint({ ...drop }, 100, 4000, 0.00001, C).wallets).toBe(0);
    expect(planMint({ ...drop, exitEstimateEth: 0.0003 }, 100, 4000, 0.00001, C).wallets).toBe(0);
    expect(planMint({ ...drop, exitEstimateEth: 0.0006 }, 100, 4000, 0.00001, C).wallets).toBe(1);
    const strong = planMint({ ...drop, exitEstimateEth: 0.0025 }, 100, 4000, 0.00001, C);
    expect(strong.wallets).toBe(20);                       // budget 50% of $100 = 0.0125 ETH ≈ 24 wallets → cap 20
    expect(planMint({ ...drop, exitEstimateEth: 0.0025 }, 10, 4000, 0.00001, C).wallets).toBe(2); // $10: budget $5 ≈ 0.00125 ETH
    expect(planMint({ ...drop, exitEstimateEth: 0.0025, leftForPublic: 100 }, 100, 4000, 0.00001, C).wallets).toBe(2); // ≤ ~2% of the remainder
  });
  it('fire time: L2 exactly at start; Ethereum — 1.5 s before the first slot at or after start', () => {
    const t = Date.parse('2026-10-23T18:00:00Z');
    expect(fireAtMs('base', t)).toBe(t);
    const f = fireAtMs('ethereum', t);
    expect(f).toBeLessThanOrEqual(t + 12_000);
    expect((f + 1_500 - 1606824023_000) % 12_000).toBe(0);
  });
});

describe('minter arm (shadow): calldata per wallet, firewall, simulation at start time, presigned txs', () => {
  it('signs one tx per wallet to the drop contract; nothing is sent', async () => {
    const methods: string[] = [];
    const rpc = async (_u: string, m: string) => { methods.push(m); if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }; if (m === 'eth_maxPriorityFeePerGas') return '0x1'; throw new Error(m); };
    const s = new EvmSender({ chain: 'base', id: 8453, native: 'ETH', rpc: 'http://127.0.0.1:1', send: ['http://127.0.0.1:1'], priorityMatters: true }, rpc as any);
    const calldata = async (_slug: string, minter: string) => ({ to: drop.contract as `0x${string}`, data: ('0x161ac21f' + minter.slice(2).padStart(64, '0')) as `0x${string}`, value: 500_000_000_000_000n });
    const m = new Minter(s, calldata, C);
    const w = [1, 2, 3].map(i => privateKeyToAccount(`0x${String(i).repeat(64)}` as `0x${string}`));
    const armed = await m.arm({ ...drop, exitEstimateEth: 0.0025 }, { wallets: 2, perWallet: 1, perWalletCostEth: 0.0006, totalEth: 0.0012, evPerWalletEth: 0.001, why: '' }, w[0], w.slice(1), { fund: false });
    expect(armed.signed.length).toBe(2);
    expect(armed.signed[0].wallet).toBe(w[1].address);
    expect(methods).not.toContain('eth_sendRawTransaction');
    expect(armed.fireAt).toBe(Date.parse(drop.startUtc) + 250); // L2: start + 250 ms margin
  });
  it('calldata to an unexpected contract is refused by the firewall', async () => {
    const rpc = async (_u: string, m: string) => { if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }; return '0x1'; };
    const s = new EvmSender({ chain: 'base', id: 8453, native: 'ETH', rpc: 'http://127.0.0.1:1', send: [], priorityMatters: true }, rpc as any);
    const evil = async () => ({ to: '0x9999999999999999999999999999999999999999' as `0x${string}`, data: '0x12345678' as `0x${string}`, value: 0n });
    const m = new Minter(s, evil, C);
    const w = [1, 2].map(i => privateKeyToAccount(`0x${String(i).repeat(64)}` as `0x${string}`));
    await expect(m.arm({ ...drop }, { wallets: 1, perWallet: 1, perWalletCostEth: 0, totalEth: 0, evPerWalletEth: 0, why: '' }, w[0], [w[1]], { fund: false })).rejects.toThrow(/firewall/);
  });
});

describe('OpenSea fulfillment → Seaport calldata', () => {
  it('object args in struct order are encoded and decode back', () => {
    const fn = 'fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32)';
    const order = { parameters: { offerer: '0x' + '1'.repeat(40), zone: '0x' + '0'.repeat(40),
      offer: [{ itemType: 2, token: '0x' + '2'.repeat(40), identifierOrCriteria: '7', startAmount: '1', endAmount: '1' }],
      consideration: [{ itemType: 0, token: '0x' + '0'.repeat(40), identifierOrCriteria: '0', startAmount: '1000', endAmount: '1000', recipient: '0x' + '1'.repeat(40) }],
      orderType: 0, startTime: '1', endTime: '9999999999', zoneHash: '0x' + '0'.repeat(64), salt: '5', conduitKey: '0x' + '0'.repeat(64), totalOriginalConsiderationItems: 1 },
      signature: '0x' + 'ab'.repeat(65) };
    const tx = encodeFulfillment({ function: fn, to: SEAPORT[0], value: '1000', input_data: { order, fulfillerConduitKey: '0x' + '0'.repeat(64) } });
    expect(tx.value).toBe(1000n);
    const dec = decodeFunctionData({ abi: [parseAbiItem(`function ${fn}`)], data: tx.data });
    expect((dec.args as any)[0][0][2][0][3]).toBe(1n);   // the offer's startAmount
    expect((dec.args as any)[0][0][3][0][3]).toBe(1000n);
    expect(() => encodeFulfillment({ function: fn, to: SEAPORT[0], value: '0', input_data: { order } })).toThrow(/missing fulfillerConduitKey/);
    // JSON keys in a different order — encoded the same way (by names)
    const shuffled = { fulfillerConduitKey: '0x' + '0'.repeat(64), order: { signature: order.signature, parameters: { ...order.parameters } } };
    expect(encodeFulfillment({ function: fn, to: SEAPORT[0], value: '1000', input_data: shuffled }).data).toBe(tx.data);
    expect(() => encodeFulfillment({ function: fn, to: '0x0000000000000000000000000000000000000bad', value: '0', input_data: shuffled })).toThrow(/not Seaport/);
    expect(() => encodeFulfillment({ function: 'transferFrom(address,address,uint256)', to: SEAPORT[0], value: '0', input_data: {} })).toThrow(/unknown function/);
  });
});

describe('NftLive.schedule (shadow)', () => {
  it('plans wallets by EV, arms right away when the start has passed, reports without sending; second call for the same drop is ignored', async () => {
    const { NftLive } = await import('../src/live/nftLive.js');
    const methods: string[] = [];
    const rpc = async (_u: string, m: string) => { methods.push(m); if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }; return '0x1'; };
    const sender = new EvmSender({ chain: 'base', id: 8453, native: 'ETH', rpc: 'http://127.0.0.1:1', send: [], priorityMatters: true }, rpc as any);
    const trader = { sender: () => sender } as any;
    const notes: string[] = [];
    const calldata = async (_s: string, minter: string) => ({ to: drop.contract as `0x${string}`, data: ('0x161ac21f' + minter.slice(2).padStart(64, '0')) as `0x${string}`, value: 500_000_000_000_000n });
    const nl = new NftLive({ trader, cfg: C, equityUsd: () => 100, ethUsd: () => 4000, notify: async t => { notes.push(t); }, calldata, guard: () => 'hard stop' });
    const d: any = { chain: 'base', nft: { slug: 'lanternfolk', contract: drop.contract, priceEth: 0.0005, sellFeesPct: 5, plan: { style: 'flip' }, publicStartUtc: new Date(Date.now() - 1000).toISOString(), maxPerWallet: 1, exitEstimateEth: 0.0025 } };
    expect(await nl.schedule(d, 'shadow')).toMatch(/shadow-armed: 20 wallet/);
    expect(await nl.schedule(d, 'shadow')).toBe('already armed for this drop');
    for (let i = 0; i < 40 && !notes.length; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 20)); // finally after the report
    expect(notes[0]).toMatch(/SHADOW — would be armed on 20/);
    expect(methods).not.toContain('eth_sendRawTransaction');
    expect(await nl.schedule(d, 'shadow')).toMatch(/shadow-armed/); // after the report shadow is allowed again
    // live under a hard stop — not armed at all (no keystore → that reason first; we provide wallets)
    const { Wallets, newKeyMaterial } = await import('../src/live/keystore.js');
    const live = new NftLive({ trader, cfg: C, equityUsd: () => 100, ethUsd: () => 4000, notify: async () => {}, calldata, guard: () => 'hard stop', wallets: new Wallets(newKeyMaterial(25)) });
    expect(await live.schedule({ ...d, nft: { ...d.nft, slug: 'other' } }, 'live')).toMatch(/blocked by risk control: hard stop/);
  });

  it('free and dust-priced mints no longer crash the value cap (wei math)', async () => {
    const { ethToWei } = await import('../src/live/minter.js');
    expect(ethToWei(0)).toBe(0n);
    expect(ethToWei(1e-7)).toBe(100_000_000_000n);
    expect(ethToWei(0.0005)).toBe(500_000_000_000_000n);
  });

  it('ERC-1155 mints are counted (TransferSingle)', async () => {
    const { nftsReceived } = await import('../src/live/minter.js');
    const w = '0x' + 'a'.repeat(40);
    const r = { logs: [{ topics: ['0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', '0x' + '0'.repeat(64), '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + w.slice(2)], data: '0x' + (7n).toString(16).padStart(64, '0') + (2n).toString(16).padStart(64, '0') }] };
    expect(nftsReceived(r, w)).toEqual({ count: 2, tokenIds: ['7'] });
  });
});

describe('E-10 item 4: without an ETH price a mint is not planned or funded', () => {
  it('planMint: ethUsd 0 → 0 wallets (no division by zero and no "infinite" budget)', () => {
    const drop = { slug: 'd', contract: '0x' + '5'.repeat(40), chain: 'base', startUtc: '2026-11-01T00:00:00.000Z', priceEth: 0.001, sellFeesPct: 5, exitEstimateEth: 0.01 };
    const cfg = { maxWallets: 20, maxShareOfEquity: 0.3, minMultipleForMany: 1.5, pSuccess: 0.6, gasPerMint: 250_000n, priorityMultiplier: 3 };
    const p = planMint(drop, 50, 0, 0.0001, cfg);
    expect(p.wallets).toBe(0); expect(p.totalEth).toBe(0); expect(p.why).toMatch(/no ETH price/);
    expect(planMint(drop, 50, 4000, 0.0001, cfg).wallets).toBeGreaterThan(0);
  });
  it('nftLive: at a price ≤ 0 schedule() and buyFloor() refuse before the plan, the quote and the bridge', async () => {
    const calls: string[] = [];
    const trader: any = { sender: () => ({ getFees: async () => { calls.push('fees'); return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, at: 0 }; }, cfg: { id: 8453, rpc: 'http://x' } }),
      funding: { ensure: async () => { calls.push('funding'); return { ok: true, note: '' }; } } };
    const trade: any = { bestListing: async () => { calls.push('listing'); return undefined; } };
    const live = new NftLive({ trader, wallets: new Wallets(newKeyMaterial(1)), openseaKey: 'k', trade, cfg: { maxWallets: 20, maxShareOfEquity: 0.3, minMultipleForMany: 1.5, pSuccess: 0.6, gasPerMint: 250_000n, priorityMultiplier: 3 },
      equityUsd: () => 50, ethUsd: () => 0, notify: async () => {}, calldata: async () => { calls.push('calldata'); return { to: '0x' + '5'.repeat(40) as `0x${string}`, data: '0x' as `0x${string}`, value: 0n }; } });
    const d: any = { chain: 'base', nft: { slug: 'd', contract: '0x' + '5'.repeat(40), priceEth: 0.001, sellFeesPct: 5, exitEstimateEth: 0.01, publicStartUtc: '2026-11-01T00:00:00.000Z', plan: { style: 'flip' } }, trust: { tier: 'follow' } };
    expect(await live.schedule(d, 'live')).toMatch(/no fresh ETH price/);
    const r = await live.buyFloor({ slug: 'd', contract: '0x' + '5'.repeat(40), chain: 'base', maxPriceEth: 0.01 }, 'live');
    expect(r.ok).toBe(false); expect(r.note).toMatch(/no fresh ETH price/);
    expect(calls).toEqual([]); // no fees, no calldata, no listing, no bridge
  });
});
