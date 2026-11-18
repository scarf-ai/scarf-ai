// #140 (HQ): the startup reconciliation waits for sweeping leftovers from burner wallets; the NFT part (sweep and mint reserve) — in the reconciliation "in flight" list.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NftLive } from '../src/live/nftLive.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';
import { InFlight, awaitSweeps, reconcileInFlight } from '../src/liveWiring.js';

/** NftLive whose sweep is "running" until the test releases the balance read (as in test/reconcile.test.ts). */
function sweeping() {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const sender: any = { cfg: { chain: 'base', id: 8453 }, async balance() { await gate; return 0n; }, async getFees() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, at: 0 }; } };
  const nl = new NftLive({ trader: { sender: () => sender } as any, wallets: new Wallets(newKeyMaterial(2)),
    cfg: { maxWallets: 20, maxShareOfEquity: 0.3, minMultipleForMany: 1.5, pSuccess: 0.6, gasPerMint: 250_000n, priorityMultiplier: 3 },
    equityUsd: () => 100, ethUsd: () => 4000, notify: async () => {} });
  return { nl, release };
}

describe('#140: sweeping leftovers and reconciliation', () => {
  it('the reconciliation "in flight" list includes NftLive.inFlight(): the sweep is visible while running; after — empty', async () => {
    const { nl, release } = sweeping();
    const list = reconcileInFlight({ tracked: new InFlight(() => 0), executor: { inFlight: () => [] }, nft: nl });
    expect(list()).toEqual([]);
    const p = nl.sweepIdle('base');
    expect(list()).toEqual(['sweeping leftovers from burner wallets (base)']);
    release(); await p.catch(() => 0);
    expect(list()).toEqual([]);
  });

  it('awaitSweeps: waits for the sweeps to end (and their errors); a hung sweep — no longer than the deadline', async () => {
    const { nl, release } = sweeping();
    const sweeps = [nl.sweepIdle('base'), Promise.reject(new Error('rpc down'))];
    let state = 'waiting';
    const w = awaitSweeps(sweeps, 1_000).then(r => { state = r; });
    await new Promise(r => setTimeout(r, 20));
    expect(state).toBe('waiting'); // the sweep is still running — the startup reconciliation does not start
    release(); await w;
    expect(state).toBe('done'); expect(nl.inFlight()).toEqual([]);
    expect(await awaitSweeps([new Promise(() => {})], 20)).toBe('timeout');
    expect(await awaitSweeps([])).toBe('done');
  });

  it('src/index.ts: sweeps are collected in startupSweeps and awaited before reconcileScheduler.startup(); nftLive.inFlight() is passed to reconciliation', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/startupSweeps\.push\(paper\.nftLive\.sweepIdle\(c as any\)/);
    const wait = src.indexOf('await awaitSweeps(startupSweeps)'), start = src.indexOf('await reconcileScheduler.startup()');
    expect(wait).toBeGreaterThan(0); expect(start).toBeGreaterThan(wait);
    expect(src).toMatch(/reconcileInFlight\(\{ tracked: flying, executor: paper, nft: \{ inFlight: \(\) => paper\.nftLive\?\.inFlight\(\) \?\? \[\] \}/);
  });
});
