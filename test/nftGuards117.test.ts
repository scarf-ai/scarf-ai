// Incoming #117 item 6: the ETH price and the $ cap are re-checked when a deferred mint is armed and fired, and on a floor buy.
import { describe, it, expect } from 'vitest';
import { NftLive } from '../src/live/nftLive.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';

const CFG = { maxWallets: 20, maxShareOfEquity: 0.3, minMultipleForMany: 1.5, pSuccess: 0.6, gasPerMint: 250_000n, priorityMultiplier: 3 };
const CONTRACT = '0x' + '5'.repeat(40);
const drop = (): any => ({ chain: 'base', nft: { slug: 'drop', contract: CONTRACT, priceEth: 0.0005, sellFeesPct: 5, plan: { style: 'flip' },
  publicStartUtc: new Date(Date.now() - 1000).toISOString(), maxPerWallet: 1, exitEstimateEth: 0.005, leftForPublic: 1000 } });

function rig(o: { budgetUsd?: number } = {}) {
  const st = { ethUsd: 4000, equity: 100 };
  const notes: string[] = []; const sent: string[] = [];
  const sender: any = { cfg: { chain: 'base', id: 8453, rpc: 'http://x' }, resetNonce() {}, async balance() { return 0n; },
    async getFees() { return { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, at: 0 }; },
    async send() { sent.push('send'); return { ok: true, hash: '0x1', pending: false }; }, async broadcast() { sent.push('broadcast'); return { ok: true }; } };
  const nl = new NftLive({ trader: { sender: () => sender } as any, wallets: new Wallets(newKeyMaterial(25)), cfg: CFG,
    equityUsd: () => st.equity, ethUsd: () => st.ethUsd, notify: async (t) => { notes.push(t); }, budgetUsd: o.budgetUsd === undefined ? undefined : () => o.budgetUsd!,
    calldata: async (_s: string, minter: string) => ({ to: CONTRACT as `0x${string}`, data: ('0x161ac21f' + minter.slice(2).padStart(64, '0')) as `0x${string}`, value: 500_000_000_000_000n }),
    guard: () => undefined });
  return { nl, st, notes, sent };
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 80 && !ok(); i++) await new Promise(r => setTimeout(r, 25)); };

describe('#117 item 6: budgetProblem — mint price and cap at the current moment', () => {
  it('no fresh price → refusal; $ budget within the cap → undefined; ETH went up or the decision budget is smaller → refusal with numbers', () => {
    const a = rig();
    expect(a.nl.budgetProblem(0.005, drop())).toBeUndefined(); // $20 with a $30 cap (30 % of $100)
    a.st.ethUsd = 0; expect(a.nl.budgetProblem(0.005, drop())).toBe('no fresh ETH price');
    a.st.ethUsd = NaN; expect(a.nl.budgetProblem(0.005, drop())).toBe('no fresh ETH price');
    a.st.ethUsd = 6100; expect(a.nl.budgetProblem(0.005, drop())).toBeUndefined(); // $30.50 — within the 2 % margin
    a.st.ethUsd = 7000; expect(a.nl.budgetProblem(0.005, drop())).toBe('mint budget $35.00 at the current ETH price exceeds the cap $30.00');
    a.st.ethUsd = 4000; a.st.equity = 50; expect(a.nl.budgetProblem(0.005, drop())).toMatch(/exceeds the cap \$15\.00/); // capital fell
    const b = rig({ budgetUsd: 10 });
    expect(b.nl.budgetProblem(0.005, drop())).toMatch(/\$20\.00 at the current ETH price exceeds the cap \$10\.00/);
  });
});

describe('#117 item 6: a deferred mint re-checks the price and the cap before arming', () => {
  it('no fresh ETH price by arming time → the mint did not happen, nothing sent, the reason is in the message', async () => {
    const x = rig();
    expect(await x.nl.schedule(drop(), 'live')).toMatch(/^armed: /);
    x.st.ethUsd = 0; // the price went stale while the mint waited for its time
    await until(() => x.notes.length > 0);
    expect(x.notes[0]).toMatch(/Mint drop did not happen: risk control before arming: no fresh ETH price/);
    expect(x.sent).toEqual([]);
    await until(() => x.nl.reserved() === 0);
    expect(x.nl.reserved()).toBe(0); // the reserve is released
  });

  it('by arming time ETH went up so much that the $ budget is above the cap → the mint did not happen, nothing sent', async () => {
    const x = rig();
    const d = drop();
    expect(await x.nl.schedule(d, 'live')).toMatch(/^armed: /);
    x.st.ethUsd = 40_000;
    await until(() => x.notes.length > 0);
    expect(x.notes[0]).toMatch(/Mint drop did not happen: risk control before arming: mint budget \$[\d.]+ at the current ETH price exceeds the cap \$30\.00/);
    expect(x.sent).toEqual([]);
  });
});

describe('#117 item 6: a floor buy checks the $ cap itself', () => {
  function floor(priceEth: number, ethUsd: number) {
    const calls: string[] = [];
    const sender: any = { cfg: { chain: 'base', id: 8453, rpc: 'http://x' } };
    const trade: any = { async bestListing() { calls.push('listing'); return { priceWei: BigInt(Math.round(priceEth * 1e18)) }; }, async buyListingTx() { calls.push('tx'); throw new Error('reached the order build'); } };
    const nl = new NftLive({ trader: { sender: () => sender } as any, wallets: new Wallets(newKeyMaterial(0)), cfg: CFG, trade,
      equityUsd: () => 100, ethUsd: () => ethUsd, notify: async () => {} });
    return { nl, calls };
  }
  const args = (maxUsd?: number) => ({ slug: 'col', contract: CONTRACT, chain: 'base', maxPriceEth: 0.001, ...(maxUsd === undefined ? {} : { maxUsd }) });

  it('the ETH price did not change, but ETH went up: $6 with a decision size of $4 → refusal before the order is built', async () => {
    const x = floor(0.001, 6000);
    const r = await x.nl.buyFloor(args(4), 'live');
    expect(r.ok).toBe(false); expect(r.note).toBe('price $6.00 at the current ETH price exceeds the decision size $4.00');
    expect(x.calls).toEqual(['listing']);
  });

  it('within the decision size (2 % margin) and without a cap — the buy goes on, as before', async () => {
    const a = floor(0.001, 4050); // $4.05 vs $4 — within the margin
    expect((await a.nl.buyFloor(args(4), 'live')).note).not.toMatch(/exceeds the decision size/);
    expect(a.calls).toEqual(['listing', 'tx']);
    const b = floor(0.001, 6000);
    expect((await b.nl.buyFloor(args(), 'live')).note).not.toMatch(/exceeds the decision size/);
    expect(b.calls).toEqual(['listing', 'tx']);
  });
});
