// Buying and selling NFTs via OpenSea (Seaport): OpenSea returns a ready "fulfillment_data" transaction
// (Seaport function + arguments), we encode it, check it with the signature filter (target — only Seaport,
// approval — only to the OpenSea conduit), simulate and send it from the right wallet.
//   buy: best collection listing → /api/v2/listings/fulfillment_data
//   sell: best offer → /api/v2/offers/fulfillment_data (needs setApprovalForAll to the OpenSea conduit)
import { encodeFunctionData, parseAbiItem, parseAbi, toFunctionSignature, type AbiFunction, type AbiParameter } from 'viem';

export const SEAPORT = ['0x0000000000000068f116a894984e2db1123eb395', '0x00000000000000adc04c56bf30ac9d3c0aaf14dc'];
export const OPENSEA_CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';

/**
 * Seaport with field names (structs from Seaport 1.5/1.6). We encode by NAMES, not by JSON key order:
 * otherwise swapped fields of the same type would be encoded silently and wrongly.
 */
export const SEAPORT_ABI = parseAbi([
  'struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }',
  'struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }',
  'struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }',
  'struct Order { OrderParameters parameters; bytes signature; }',
  'struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }',
  'struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }',
  'struct AdditionalRecipient { uint256 amount; address recipient; }',
  'struct BasicOrderParameters { address considerationToken; uint256 considerationIdentifier; uint256 considerationAmount; address offerer; address zone; address offerToken; uint256 offerIdentifier; uint256 offerAmount; uint8 basicOrderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 offererConduitKey; bytes32 fulfillerConduitKey; uint256 totalOriginalAdditionalRecipients; AdditionalRecipient[] additionalRecipients; bytes signature; }',
  'struct FulfillmentComponent { uint256 orderIndex; uint256 itemIndex; }',
  'function fulfillBasicOrder(BasicOrderParameters parameters) payable returns (bool fulfilled)',
  'function fulfillBasicOrder_efficient_6GL6yc(BasicOrderParameters parameters) payable returns (bool fulfilled)',
  'function fulfillOrder(Order order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)',
  'function fulfillAdvancedOrder(AdvancedOrder advancedOrder, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)',
  'function fulfillAvailableAdvancedOrders(AdvancedOrder[] advancedOrders, CriteriaResolver[] criteriaResolvers, FulfillmentComponent[][] offerFulfillments, FulfillmentComponent[][] considerationFulfillments, bytes32 fulfillerConduitKey, address recipient, uint256 maximumFulfilled) payable returns (bool[] availableOrders, ((uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient) item, address offerer, bytes32 conduitKey)[] executions)',
]);

/** A value by parameter description (with names): object → fields by name, numbers → bigint, bool — strictly. */
function byName(v: any, p: AbiParameter): any {
  if (v === undefined || v === null) throw new Error(`seaport encode: missing ${p.name ?? p.type}`);
  if (p.type.endsWith('[]')) {
    const inner = { ...p, type: p.type.slice(0, -2) } as AbiParameter;
    if (!Array.isArray(v)) throw new Error(`seaport encode: ${p.name ?? p.type} must be an array`);
    return v.map(x => byName(x, inner));
  }
  if (p.type === 'tuple') {
    const comps = (p as any).components as AbiParameter[];
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`seaport encode: ${p.name} must be an object`);
    const out: Record<string, unknown> = {};
    for (const c of comps) { if (!(c.name! in v)) throw new Error(`seaport encode: missing field ${p.name}.${c.name}`); out[c.name!] = byName(v[c.name!], c); }
    return out;
  }
  if (/^u?int/.test(p.type)) return BigInt(v);
  if (p.type === 'bool') { if (v === true || v === 'true') return true; if (v === false || v === 'false') return false; throw new Error('seaport encode: bad bool'); }
  return v;
}

/**
 * Transaction from the fulfillment_data response → { to, data, value }. The function must be one of the known Seaport functions
 * with the same types OpenSea sent; arguments — by name; the recipient (if any) — only us.
 */
export function encodeFulfillment(tx: { function: string; to: string; value: string | number; input_data: Record<string, any>; calldata_suffix?: string | null }, self?: string): { to: `0x${string}`; data: `0x${string}`; value: bigint } {
  const sent = parseAbiItem(`function ${tx.function}`) as AbiFunction;
  const known = SEAPORT_ABI.find(x => x.type === 'function' && x.name === sent.name) as AbiFunction | undefined;
  if (!known) throw new Error(`seaport encode: unknown function ${sent.name}`);
  if (toFunctionSignature(known) !== toFunctionSignature(sent)) throw new Error(`seaport encode: signature mismatch for ${sent.name}`);
  const args = known.inputs.map(p => byName(tx.input_data?.[p.name!], p));
  const ri = known.inputs.findIndex(p => p.name === 'recipient');
  if (ri >= 0 && self) {
    const r = String(args[ri]).toLowerCase();
    if (r !== self.toLowerCase() && r !== '0x0000000000000000000000000000000000000000') throw new Error(`seaport encode: recipient ${r} is not our wallet`);
  }
  if (!SEAPORT.includes(String(tx.to).toLowerCase())) throw new Error(`seaport encode: target ${tx.to} is not Seaport`);
  const data = encodeFunctionData({ abi: [known], functionName: known.name, args });
  return { to: tx.to as `0x${string}`, data, value: BigInt(tx.value ?? 0) };
}

export interface OpenSeaTrade {
  bestListing(slug: string): Promise<{ hash: string; protocol: string; chain: string; priceWei: bigint } | undefined>;
  bestOffer(slug: string): Promise<{ hash: string; protocol: string; chain: string; priceWei: bigint } | undefined>;
  buyListingTx(l: { hash: string; protocol: string; chain: string }, fulfiller: string): Promise<{ to: `0x${string}`; data: `0x${string}`; value: bigint }>;
  acceptOfferTx(o: { hash: string; protocol: string; chain: string }, fulfiller: string, contract: string, tokenId: string): Promise<{ to: `0x${string}`; data: `0x${string}`; value: bigint }>;
}

export function openSeaTrade(apiKey: string, fetchImpl: typeof fetch = fetch, base = 'https://api.opensea.io/api/v2'): OpenSeaTrade {
  const h = { 'x-api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' };
  const get = async (u: string) => { const r = await fetchImpl(`${base}${u}`, { headers: h, signal: AbortSignal.timeout(8_000) }); if (!r.ok) throw new Error(`opensea ${u}: ${r.status}`); return r.json() as any; };
  const post = async (u: string, body: unknown) => {
    const r = await fetchImpl(`${base}${u}`, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`opensea ${u}: ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
    return j;
  };
  const pick = (o: any) => o ? { hash: String(o.order_hash), protocol: String(o.protocol_address), chain: String(o.chain ?? o.protocol_data?.parameters?.chain ?? ''),
    priceWei: BigInt(o.price?.current?.value ?? o.price?.value ?? 0) } : undefined;
  return {
    async bestListing(slug) { const j = await get(`/listings/collection/${encodeURIComponent(slug)}/best?limit=1`); return pick(j?.listings?.[0]); },
    async bestOffer(slug) { const j = await get(`/offers/collection/${encodeURIComponent(slug)}/best`); return pick(j?.offers?.[0] ?? j); },
    async buyListingTx(l, fulfiller) {
      const j = await post('/listings/fulfillment_data', { listing: { hash: l.hash, chain: l.chain, protocol_address: l.protocol }, fulfiller: { address: fulfiller } });
      return encodeFulfillment(j.fulfillment_data.transaction, fulfiller);
    },
    async acceptOfferTx(o, fulfiller, contract, tokenId) {
      const j = await post('/offers/fulfillment_data', { offer: { hash: o.hash, chain: o.chain, protocol_address: o.protocol }, fulfiller: { address: fulfiller },
        consideration: { asset_contract_address: contract, token_id: tokenId } });
      return encodeFulfillment(j.fulfillment_data.transaction, fulfiller);
    },
  };
}
