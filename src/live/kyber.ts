// Swap on EVM chains (Ethereum, Base, Arbitrum, BNB, Polygon) via the KyberSwap aggregator: public API without a key.
// 1) GET /{chain}/api/v1/routes → best route; 2) POST /{chain}/api/v1/route/build → calldata for the router.
// Token addresses come from code (from the message text), the router is checked against the route response.
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export interface SwapTx { to: `0x${string}`; data: `0x${string}`; value: bigint; amountIn: bigint; amountOut: bigint; minOut: bigint; gas?: bigint; router: string;
  /** For a token sale: which approve the router needs (exact amount). */
  approve?: { token: `0x${string}`; spender: `0x${string}`; amount: bigint }; amountOutUsd?: number }

export interface KyberClient { swap(p: { chain: string; tokenIn: string; tokenOut: string; amountIn: bigint; from: string; slippageBps: number }): Promise<SwapTx> }

export function kyberClient(fetchImpl: typeof fetch = fetch, base = 'https://aggregator-api.kyberswap.com'): KyberClient {
  const headers = { 'x-client-id': 'agent', accept: 'application/json', 'content-type': 'application/json' };
  return {
    async swap({ chain, tokenIn, tokenOut, amountIn, from, slippageBps }) {
      const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString() });
      const r1 = await fetchImpl(`${base}/${chain}/api/v1/routes?${q}`, { headers, signal: AbortSignal.timeout(8_000) });
      const j1: any = await r1.json().catch(() => ({}));
      const rs = j1?.data?.routeSummary;
      if (!r1.ok || !rs) throw new Error(`kyber route: ${j1?.message ?? r1.status}`);
      const r2 = await fetchImpl(`${base}/${chain}/api/v1/route/build`, { method: 'POST', headers, signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ routeSummary: rs, sender: from, recipient: from, slippageTolerance: slippageBps, deadline: Math.floor(Date.now() / 1000) + 300, source: 'agent' }) });
      const j2: any = await r2.json().catch(() => ({}));
      const b = j2?.data;
      if (!r2.ok || !b?.data || !b?.routerAddress) throw new Error(`kyber build: ${j2?.message ?? r2.status}`);
      const router = String(b.routerAddress) as `0x${string}`;
      if (j1.data.routerAddress && String(j1.data.routerAddress).toLowerCase() !== router.toLowerCase()) throw new Error('kyber: router mismatch between route and build');
      const amountOut = BigInt(b.amountOut ?? rs.amountOut);
      const minOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
      const isNativeIn = tokenIn.toLowerCase() === NATIVE.toLowerCase();
      return { to: router, data: b.data, value: BigInt(b.transactionValue ?? (isNativeIn ? amountIn : 0n)), amountIn, amountOut, minOut, router,
        gas: b.gas ? BigInt(b.gas) : undefined, amountOutUsd: Number(b.amountOutUsd ?? rs.amountOutUsd) || undefined,
        approve: isNativeIn ? undefined : { token: tokenIn as `0x${string}`, spender: router, amount: amountIn } };
    },
  };
}
