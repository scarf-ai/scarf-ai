// Robinhood Chain (4663): Pons launchpad tokens (ported from an earlier internal tool).
// v2 — bonding curve: curve.buy(quoteIn, minTokensOut, recipient) with ETH / curve.sell(tokensIn, minQuoteOut, recipient).
// v1 — Uniswap v3 pool (fee 1%): SwapRouter.exactInputSingle(WETH→token) with ETH.
// After v2 graduation the token moves to Uniswap v4 — this path is not supported yet (the trade is skipped with a reason).
import { encodeFunctionData, decodeFunctionResult, parseAbi, keccak256, toHex } from 'viem';

export const PONS = {
  V2_FACTORY: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  UNI_V3_SWAP_ROUTER: '0xCaf681a66D020601342297493863E78C959E5cb2',
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  V1_POOL_FEE: 10_000,
} as const;

export const CURVE_ABI = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'function readyToGraduate() view returns (bool)',
]);
const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

export interface PonsRoute { kind: 'curve' | 'v1'; to: `0x${string}`; data: `0x${string}`; value: bigint; quotedOut: bigint; minOut: bigint }
type Call = (to: string, data: string, from: string, value?: bigint) => Promise<string>;

/**
 * Buy on Pons: the pair from DexScreener (dexId pons*) is a curve candidate; the curve is confirmed by an eth_call buy (quote > 0).
 * Otherwise — v1 (Uniswap v3 1% pool) via SwapRouter. Quote — the same eth_call, minimum with slippage.
 */
export async function ponsBuyRoute(p: { token: `0x${string}`; pairAddress?: string; dexId?: string; amountIn: bigint; from: `0x${string}`; slippageBps: number; call: Call }): Promise<PonsRoute> {
  const slip = (v: bigint) => (v * BigInt(10_000 - p.slippageBps)) / 10_000n;
  if (p.pairAddress && /pons/i.test(p.dexId ?? '')) {
    const data = encodeFunctionData({ abi: CURVE_ABI, functionName: 'buy', args: [p.amountIn, 0n, p.from] });
    const out = await p.call(p.pairAddress, data, p.from, p.amountIn).then(r => decodeFunctionResult({ abi: CURVE_ABI, functionName: 'buy', data: r as `0x${string}` }) as bigint).catch(() => 0n);
    if (out > 0n) {
      const min = slip(out);
      return { kind: 'curve', to: p.pairAddress as `0x${string}`, value: p.amountIn, quotedOut: out, minOut: min,
        data: encodeFunctionData({ abi: CURVE_ABI, functionName: 'buy', args: [p.amountIn, min, p.from] }) };
    }
  }
  const params = { tokenIn: PONS.WETH, tokenOut: p.token, fee: PONS.V1_POOL_FEE, recipient: p.from, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), amountIn: p.amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n } as const;
  const q = await p.call(PONS.UNI_V3_SWAP_ROUTER, encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [params] }), p.from, p.amountIn)
    .then(r => decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'exactInputSingle', data: r as `0x${string}` }) as bigint).catch(() => 0n);
  if (q <= 0n) throw new Error('pons: no curve and no v1 pool quote (graduated to Uniswap v4? not supported yet)');
  const min = slip(q);
  return { kind: 'v1', to: PONS.UNI_V3_SWAP_ROUTER, value: p.amountIn, quotedOut: q, minOut: min,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ ...params, amountOutMinimum: min }] }) };
}

/** Sell on the v2 curve (the caller makes the exact-amount approve to the curve). */
export async function ponsSellRoute(p: { curve: `0x${string}`; tokensIn: bigint; from: `0x${string}`; slippageBps: number; call: Call }): Promise<PonsRoute> {
  const q = await p.call(p.curve, encodeFunctionData({ abi: CURVE_ABI, functionName: 'sell', args: [p.tokensIn, 0n, p.from] }), p.from)
    .then(r => decodeFunctionResult({ abi: CURVE_ABI, functionName: 'sell', data: r as `0x${string}` }) as bigint).catch(() => 0n);
  if (q <= 0n) throw new Error('pons: sell quote failed (curve closed or graduated)');
  const min = (q * BigInt(10_000 - p.slippageBps)) / 10_000n;
  return { kind: 'curve', to: p.curve, value: 0n, quotedOut: q, minOut: min, data: encodeFunctionData({ abi: CURVE_ABI, functionName: 'sell', args: [p.tokensIn, min, p.from] }) };
}

/** topic0 of the v2 factory event TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold). */
export const TOKEN_LAUNCHED_TOPIC = keccak256(toHex('TokenLaunched(address,address,address,address,uint256,uint256)'));

/**
 * The token's curve — by the Pons v2 factory event (not by DexScreener's word): otherwise any contract answering buy()
 * would get our ETH and a sell approval. getLogs: factory address + topic1 = token.
 */
export async function ponsCurveOf(token: string, getLogs: (filter: object) => Promise<any[]>, latestBlock?: () => Promise<bigint>): Promise<string | undefined> {
  const topics = [TOKEN_LAUNCHED_TOPIC, '0x' + token.toLowerCase().slice(2).padStart(64, '0')];
  let logs = await getLogs({ address: PONS.V2_FACTORY, fromBlock: '0x0', toBlock: 'latest', topics }).catch(() => undefined);
  // The provider limits the block range — search in windows back from the latest block (up to ~2M blocks)
  if (!logs && latestBlock) {
    const head = await latestBlock();
    for (let to = head, i = 0; i < 20 && !logs?.length; i++, to -= 100_000n) {
      const from = to > 100_000n ? to - 99_999n : 0n;
      logs = await getLogs({ address: PONS.V2_FACTORY, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics }).catch(() => []);
      if (from === 0n) break;
    }
  }
  const l = logs?.[0];
  return l?.topics?.[2] ? ('0x' + String(l.topics[2]).slice(26)).toLowerCase() : undefined;
}
