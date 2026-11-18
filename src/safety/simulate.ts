// Simulation of an EVM transaction via eth_simulateV1 (with traceTransfers) and calculation of balance changes
// of our address. If the RPC does not support simulation — the action is NOT executed (fail-closed).
import type { BalanceDiff } from './firewall.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
const NATIVE_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const TRANSFER_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

const lc = (s: string) => s.toLowerCase();
const topicAddr = (t: string) => '0x' + t.slice(26).toLowerCase();

export interface SimLog { address: string; topics: string[]; data: string }

/** Pure function: computes balance changes of the self address from the simulation logs. */
export function diffFromLogs(self: string, logs: SimLog[], gasCostWei: bigint): BalanceDiff {
  const me = lc(self);
  const diff: BalanceDiff = { native: -gasCostWei, erc20: {}, nftOut: {}, newApprovals: [], codeDelegated: false };
  for (const l of logs) {
    const t0 = lc(l.topics[0] ?? '');
    const addr = lc(l.address);
    if (t0 === TRANSFER && l.topics.length >= 3) {
      const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]);
      if (addr === NATIVE_PSEUDO) {
        const v = BigInt(l.data === '0x' ? 0 : l.data);
        if (from === me) diff.native -= v;
        if (to === me) diff.native += v;
        continue;
      }
      if (l.topics.length === 4) { // ERC-721: tokenId in topic3
        if (from === me) diff.nftOut[addr] = (diff.nftOut[addr] ?? 0) + 1;
        if (to === me) diff.erc20[addr] = (diff.erc20[addr] ?? 0n) + 1n; // an NFT arrived — count it as +1
        continue;
      }
      const v = BigInt(l.data === '0x' ? 0 : l.data);
      if (from === me) diff.erc20[addr] = (diff.erc20[addr] ?? 0n) - v;
      if (to === me) diff.erc20[addr] = (diff.erc20[addr] ?? 0n) + v;
    } else if ((t0 === TRANSFER_SINGLE || t0 === TRANSFER_BATCH) && l.topics.length >= 4) {
      // ERC-1155: topics = [sig, operator, from, to]
      const from = topicAddr(l.topics[2]), to = topicAddr(l.topics[3]);
      if (from === me) diff.nftOut[addr] = (diff.nftOut[addr] ?? 0) + 1;
      if (to === me) diff.erc20[addr] = (diff.erc20[addr] ?? 0n) + 1n;
    } else if (t0 === APPROVAL && l.topics.length >= 3 && topicAddr(l.topics[1]) === me) {
      diff.newApprovals.push({ token: addr, spender: topicAddr(l.topics[2]), amount: BigInt(l.data === '0x' ? 0 : l.data) });
    } else if (t0 === APPROVAL_FOR_ALL && l.topics.length >= 3 && topicAddr(l.topics[1]) === me) {
      const approved = BigInt(l.data === '0x' ? 0 : l.data) !== 0n;
      if (approved) diff.newApprovals.push({ token: addr, spender: topicAddr(l.topics[2]), amount: 'all' });
    }
  }
  return diff;
}

export interface SimResult { supported: boolean; success?: boolean; error?: string; diff?: BalanceDiff; gasUsed?: bigint; gasCostWei?: bigint }

/**
 * Simulates exactly the transaction that will be signed: with gas and nonce fields and validation: true,
 * so the contract cannot detect the simulation by a zero gas price. For paper, stateOverrides can be passed
 * (for example, the burner wallet balance).
 */
export async function simulateEvm(rpcUrl: string, tx: { from: string; to: string; data?: string; value?: bigint; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; nonce?: number },
  fetchImpl: typeof fetch = fetch, stateOverrides?: Record<string, { balance?: string }>): Promise<SimResult> {
  const gp = await gasPrice(rpcUrl, fetchImpl);
  const hex = (v: bigint | number) => '0x' + v.toString(16);
  const call: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data ?? '0x', value: hex(tx.value ?? 0n),
    maxFeePerGas: hex(tx.maxFeePerGas ?? gp * 2n), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? 0n) };
  if (tx.gas !== undefined) call.gas = hex(tx.gas);
  if (tx.nonce !== undefined) call.nonce = hex(tx.nonce);
  const block: Record<string, unknown> = { calls: [call] };
  if (stateOverrides) block.stateOverrides = stateOverrides;
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [block], traceTransfers: true, validation: true }, 'latest'] };
  let j: any;
  try {
    const r = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    j = await r.json();
  } catch (e) { return { supported: false, error: String(e) }; }
  if (j.error) return { supported: !isUnsupported(j.error), success: false, error: j.error.message };
  const res = j.result?.[0]?.calls?.[0];
  if (!res) return { supported: false, error: 'empty simulation result' };
  const gasUsed = BigInt(res.gasUsed ?? 0);
  if (res.status !== '0x1') return { supported: true, success: false, error: res.error?.message ?? 'reverted', gasUsed };
  return { supported: true, success: true, gasUsed, gasCostWei: gasUsed * gp, diff: diffFromLogs(tx.from, res.logs ?? [], gasUsed * gp) };
}

/**
 * Several calls in a row in one block (for example, approve → swap, setApprovalForAll → sale into a bid):
 * success — only if all passed; balance changes — from the logs of all calls.
 */
export async function simulateEvmCalls(rpcUrl: string, from: string, calls: { to: string; data?: string; value?: bigint }[], fetchImpl: typeof fetch = fetch,
  stateOverrides?: Record<string, { balance?: string }>): Promise<SimResult> {
  const gp = await gasPrice(rpcUrl, fetchImpl);
  const hex = (v: bigint | number) => '0x' + v.toString(16);
  const block: Record<string, unknown> = { calls: calls.map(c => ({ from, to: c.to, data: c.data ?? '0x', value: hex(c.value ?? 0n), maxFeePerGas: hex(gp * 2n), maxPriorityFeePerGas: '0x0' })) };
  if (stateOverrides) block.stateOverrides = stateOverrides;
  let j: any;
  try {
    const r = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [block], traceTransfers: true, validation: true }, 'latest'] }) });
    j = await r.json();
  } catch (e) { return { supported: false, error: String(e) }; }
  if (j.error) return { supported: !isUnsupported(j.error), success: false, error: j.error.message };
  const res: any[] = j.result?.[0]?.calls ?? [];
  if (res.length !== calls.length) return { supported: false, error: 'empty simulation result' };
  const bad = res.findIndex(c => c.status !== '0x1');
  const gasUsed = res.reduce((a, c) => a + BigInt(c.gasUsed ?? 0), 0n);
  if (bad >= 0) return { supported: true, success: false, error: `call ${bad + 1}: ${res[bad].error?.message ?? 'reverted'}`, gasUsed };
  return { supported: true, success: true, gasUsed, gasCostWei: gasUsed * gp, diff: diffFromLogs(from, res.flatMap(c => c.logs ?? []), gasUsed * gp) };
}

/**
 * "The node cannot do eth_simulateV1": JSON-RPC code −32601 or text about a missing method. Everything else (including a revert
 * whose text happens to contain the word "method") — is supported and did NOT pass: in shadow this must show as a rejection.
 */
export function isUnsupported(err: { code?: number | string; message?: string }): boolean {
  if (Number(err?.code) === -32601) return true;
  return /method (not found|not supported|not available|does not exist|is not available)|unsupported method|does not exist\/is not available/i.test(err?.message ?? '');
}

async function gasPrice(rpcUrl: string, fetchImpl: typeof fetch): Promise<bigint> {
  try {
    const r = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }), signal: AbortSignal.timeout(8_000) });
    const j: any = await r.json();
    return BigInt(j.result ?? 0);
  } catch { return 0n; }
}
