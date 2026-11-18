// Signature filter. Every signature request from a site (via our wallet provider in the browser)
// and every agent transaction pass through these functions. This is CODE, not the model:
// it works at any source trust score. Any parse error = deny.
//
// Allowed automatically:
//  - sign-in by signature (EIP-4361 strictly by format / "Sign in …" with the site name), if the domain matches the site;
//  - calls ONLY to expected contracts (the action target), the action's tokens and the treasury; value — only to the target/treasury;
//  - approve for an exact amount to the expected spender; token transfers — only to the treasury.
// Always forbidden:
//  - eth_sign, unknown wallet methods, adding chains, switching to an unexpected chain;
//  - typed-data (Permit, Permit2, orders etc.), except the allowlist (contract + chain + type);
//  - EIP-7702 delegation, batched calls;
//  - unlimited approve, setApprovalForAll outside the allowlist, ERC-20/721/1155/777 transfers to foreign addresses.

export type Verdict = { allow: true; notes: string[] } | { allow: false; reason: string };

export interface FirewallContext {
  /** Host of the open site (for the sign-in-by-signature check). */
  siteHost?: string;
  /** Expected chain of the action. */
  chainId?: number;
  /** Our address (burner wallet). */
  self: `0x${string}`;
  /** Treasury address — transfers there are allowed (sweeping leftovers). */
  treasury: `0x${string}`;
  /** Contracts we deliberately call in this action (mint, router, protocol). */
  expectedTargets: string[];
  /** Tokens we work with in this action (approve, sweep to the treasury). */
  expectedTokens?: string[];
  /** Maximum approve amount per token (lowercase token address → maximum in base units). */
  expectedApprovals?: Record<string, bigint>;
  /** Operators allowed for setApprovalForAll (allowlisted marketplaces). */
  approvalOperatorsAllowlist?: string[];
  /** Typed-data allowlist: strings of the form `${verifyingContract}|${chainId}|${primaryType}` (lowercase address). */
  typedDataAllowlist?: string[];
  /** Value cap (in wei) per transaction. */
  maxValueWei: bigint;
}

const lc = (s?: string) => (s ?? '').toLowerCase();
export const MAX_SANE_APPROVAL = 10n ** 30n; // anything larger counts as an "infinite" approve

export const SELECTORS = {
  approve: '0x095ea7b3',
  increaseAllowance: '0x39509351',
  increaseApproval: '0xd73dd623',
  approveAndCall: '0xcae9ca51',
  setApprovalForAll: '0xa22cb465',
  transfer: '0xa9059cbb',
  transferFrom: '0x23b872dd',
  safeTransferFrom: '0x42842e0e',
  safeTransferFromData: '0xb88d4fde',
  erc1155SafeTransferFrom: '0xf242432a',
  erc1155SafeBatchTransferFrom: '0x2eb2c2d6',
  transferAndCall: '0x4000aea0',
  erc777Send: '0x9bd9bbc6',
  permit2Approve: '0x87517c45',
  permit2TransferFrom: '0x36c78516',
  permit: '0xd505accf',
} as const;

function word(data: string, i: number): string { return data.slice(10 + i * 64, 10 + (i + 1) * 64); }
function addrFromWord(w: string): string { return '0x' + w.slice(24); }
function needWords(data: string, n: number, exact = true) {
  const len = data.length - 10;
  if (exact ? len !== n * 64 : len < n * 64) throw new Error(`calldata length ${len / 2} bytes does not match ${n} words`);
}

function hexToUtf8(hex: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) return hex;
  return Buffer.from(h, 'hex').toString('utf8');
}

/** Registrable domain: the last two labels (app.swapnest.xyz → swapnest.xyz). */
function registrable(host: string) { return lc(host).replace(/^www\./, '').split('.').slice(-2).join('.'); }

function domainMatches(domain: string, siteHost: string) {
  const d = lc(domain).replace(/:\d+$/, ''), h = lc(siteHost);
  if (d.split('.').length < 2) return false; // "xyz" without a label is not a domain
  return d === h || h.endsWith('.' + d);
}

/** Text signature check (personal_sign). */
export function checkPersonalSign(messageHexOrText: string, ctx: FirewallContext): Verdict {
  const text = messageHexOrText.startsWith('0x') ? hexToUtf8(messageHexOrText) : messageHexOrText;
  if (/^0x[0-9a-f]{64}$/i.test(text.trim()) || /[\x00-\x08\x0e-\x1f]/.test(text)) return { allow: false, reason: 'personal_sign of a raw hash/binary — blind signing is forbidden' };
  if (/\b(permit|approve|transfer|setapprovalforall|delegat|authoriz(e|ation) (to )?spend|withdraw|private key|export key)\b/i.test(text)) return { allow: false, reason: 'sign-in text mentions approvals/transfers/delegation/keys' };
  if (!ctx.siteHost) return { allow: false, reason: 'no site host in context' };
  if (/wants you to sign in/i.test(text)) {
    const siwe = text.match(/^([a-z0-9.-]+(?::\d+)?) wants you to sign in with your Ethereum account:\r?\n(0x[a-fA-F0-9]{40})\r?\n/i);
    if (!siwe) return { allow: false, reason: 'SIWE-like text in non-standard format' };
    if (!domainMatches(siwe[1], ctx.siteHost)) return { allow: false, reason: `SIWE domain ${siwe[1]} ≠ site ${ctx.siteHost}` };
    if (lc(siwe[2]) !== lc(ctx.self)) return { allow: false, reason: 'SIWE for a different address' };
    const chain = text.match(/^Chain ID:\s*(\d+)/mi);
    if (chain && ctx.chainId !== undefined && Number(chain[1]) !== ctx.chainId) return { allow: false, reason: `SIWE chain ${chain[1]} ≠ expected ${ctx.chainId}` };
    return { allow: true, notes: ['EIP-4361 sign-in, domain matches'] };
  }
  if (/\b(sign[ -]?in|log[ -]?in|welcome|verify (that you own|ownership)|authenticate)\b/i.test(text)) {
    const site = registrable(ctx.siteHost);
    if (!lc(text).includes(site)) return { allow: false, reason: `login text does not mention the site ${site}` };
    return { allow: true, notes: ['plain login message naming the site'] };
  }
  return { allow: false, reason: 'unrecognized personal_sign text — not a login message' };
}

/** Typed-data check (eth_signTypedData_v3/v4). Default — deny. */
export function checkTypedData(typed: unknown, ctx: FirewallContext): Verdict {
  let obj: any = typed;
  if (typeof typed === 'string') { try { obj = JSON.parse(typed); } catch { return { allow: false, reason: 'typed data is not JSON' }; } }
  const primary: string = obj?.primaryType ?? '';
  if (/permit|order|delegat|authoriz|transfer|batch|meta|approv|withdraw|send|list|swap/i.test(primary)) return { allow: false, reason: `typed data ${primary} can move assets — forbidden` };
  const key = `${lc(obj?.domain?.verifyingContract)}|${obj?.domain?.chainId ?? ''}|${primary}`;
  if (ctx.typedDataAllowlist?.includes(key)) return { allow: true, notes: [`typed data ${key} allowlisted`] };
  return { allow: false, reason: `typed data ${key} not allowlisted` };
}

export interface TxRequest { to?: string; data?: string; input?: string; value?: bigint | string | number; type?: number | string; authorizationList?: unknown[]; chainId?: number | string }

/** Static transaction check before simulation. Any parse error = deny. */
export function checkTransaction(tx: TxRequest, ctx: FirewallContext): Verdict {
  try { return checkTransactionInner(tx, ctx); }
  catch (e) { return { allow: false, reason: `cannot parse transaction: ${String((e as Error).message ?? e)}` }; }
}

function checkTransactionInner(tx: TxRequest, ctx: FirewallContext): Verdict {
  if (tx.authorizationList?.length || String(tx.type) === '4' || lc(String(tx.type)) === '0x4') return { allow: false, reason: 'EIP-7702 delegation — forbidden' };
  if (!tx.to) return { allow: false, reason: 'contract deployment from burner — forbidden' };
  if (tx.input !== undefined && tx.data !== undefined && lc(tx.input) !== lc(tx.data)) return { allow: false, reason: 'input and data differ' };
  if (tx.chainId !== undefined && ctx.chainId !== undefined && Number(tx.chainId) !== ctx.chainId) return { allow: false, reason: `tx chain ${tx.chainId} ≠ expected ${ctx.chainId}` };
  const value = BigInt(tx.value ?? 0);
  if (value < 0n) return { allow: false, reason: 'negative value' };
  if (value > ctx.maxValueWei) return { allow: false, reason: `value ${value} wei > cap ${ctx.maxValueWei}` };
  const data = lc(tx.data ?? tx.input ?? '0x');
  if (!/^0x[0-9a-f]*$/.test(data)) return { allow: false, reason: 'calldata is not hex' };
  const to = lc(tx.to);
  const targets = ctx.expectedTargets.map(lc);
  const tokens = [...(ctx.expectedTokens ?? []), ...Object.keys(ctx.expectedApprovals ?? {})].map(lc);
  const treasury = lc(ctx.treasury);

  // 1. Who may receive transactions at all: the action target, the action's tokens, the treasury
  if (!targets.includes(to) && !tokens.includes(to) && to !== treasury) return { allow: false, reason: `call to unexpected address ${to}` };
  // 2. value — only to the action target (paid mint, swap) or the treasury
  if (value > 0n && !targets.includes(to) && to !== treasury) return { allow: false, reason: 'value sent to a token contract' };
  if (data.length < 10) {
    if (data.length > 2) return { allow: false, reason: 'malformed calldata' };
    return { allow: true, notes: ['plain transfer to expected address'] };
  }
  const sel = data.slice(0, 10);
  const notes: string[] = [];
  switch (sel) {
    case SELECTORS.approve:
    case SELECTORS.increaseAllowance:
    case SELECTORS.increaseApproval: {
      needWords(data, 2);
      const spender = lc(addrFromWord(word(data, 0)));
      const amount = BigInt('0x' + word(data, 1));
      if (amount >= MAX_SANE_APPROVAL) return { allow: false, reason: 'unlimited approve — forbidden' };
      if (!targets.includes(spender)) return { allow: false, reason: `approve to unexpected spender ${spender}` };
      const cap = ctx.expectedApprovals?.[to];
      if (cap === undefined || amount > cap) return { allow: false, reason: `approve amount ${amount} exceeds expected for token ${to}` };
      notes.push('exact approve to expected spender');
      break;
    }
    case SELECTORS.setApprovalForAll: {
      needWords(data, 2);
      const operator = lc(addrFromWord(word(data, 0)));
      const approved = BigInt('0x' + word(data, 1)) !== 0n;
      if (approved && !(ctx.approvalOperatorsAllowlist ?? []).map(lc).includes(operator)) return { allow: false, reason: `setApprovalForAll to non-allowlisted operator ${operator}` };
      notes.push(approved ? 'setApprovalForAll to allowlisted marketplace' : 'revoke approval');
      break;
    }
    case SELECTORS.transfer:
    case SELECTORS.transferAndCall:
    case SELECTORS.erc777Send: {
      needWords(data, sel === SELECTORS.transfer ? 2 : 2, sel === SELECTORS.transfer);
      const toAddr = lc(addrFromWord(word(data, 0)));
      if (toAddr !== treasury) return { allow: false, reason: `token transfer to ${toAddr} (not treasury)` };
      notes.push('sweep to treasury');
      break;
    }
    case SELECTORS.transferFrom:
    case SELECTORS.safeTransferFrom:
    case SELECTORS.safeTransferFromData:
    case SELECTORS.erc1155SafeTransferFrom:
    case SELECTORS.erc1155SafeBatchTransferFrom: {
      needWords(data, sel === SELECTORS.transferFrom || sel === SELECTORS.safeTransferFrom ? 3 : 2, sel === SELECTORS.transferFrom || sel === SELECTORS.safeTransferFrom);
      const from = lc(addrFromWord(word(data, 0)));
      const toAddr = lc(addrFromWord(word(data, 1)));
      if (toAddr !== treasury) return { allow: false, reason: `transferFrom ${from} → ${toAddr} (not treasury)` };
      notes.push('transfer to treasury');
      break;
    }
    case SELECTORS.approveAndCall:
    case SELECTORS.permit2Approve:
    case SELECTORS.permit2TransferFrom:
    case SELECTORS.permit:
      return { allow: false, reason: 'approveAndCall/permit/permit2 — forbidden' };
    default:
      if (!targets.includes(to)) return { allow: false, reason: `unknown function ${sel} on non-target ${to}` };
      notes.push(`call ${sel} on expected target`);
  }
  return { allow: true, notes };
}

const READ_ONLY = new Set(['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionByHash',
  'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs', 'eth_estimateGas', 'eth_blockNumber', 'eth_gasPrice',
  'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'net_version', 'eth_chainId', 'eth_accounts', 'eth_requestAccounts', 'web3_clientVersion']);

/** Single entry point for EIP-1193 requests from a site. */
export function checkRpcRequest(method: string, params: unknown[], ctx: FirewallContext): Verdict {
  try {
    switch (method) {
      case 'eth_sign': return { allow: false, reason: 'eth_sign (blind hash signing) — forbidden' };
      case 'personal_sign': {
        const [a, b] = params as string[];
        const msg = lc(a) === lc(ctx.self) ? b : a; // wallets pass the parameters in different orders
        return checkPersonalSign(String(msg ?? ''), ctx);
      }
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4': return checkTypedData(params[1] ?? params[0], ctx);
      case 'eth_sendTransaction':
      case 'eth_signTransaction': return checkTransaction((params[0] ?? {}) as TxRequest, ctx);
      case 'wallet_switchEthereumChain': {
        const id = Number((params[0] as any)?.chainId);
        if (ctx.chainId === undefined || id !== ctx.chainId) return { allow: false, reason: `switch to chain ${id} ≠ expected ${ctx.chainId}` };
        return { allow: true, notes: ['switch to expected chain'] };
      }
      case 'wallet_requestPermissions':
        return { allow: true, notes: ['eth_accounts permission only'] };
      case 'wallet_watchAsset':
        return { allow: true, notes: ['watch asset is harmless'] };
      default:
        if (READ_ONLY.has(method)) return { allow: true, notes: ['read-only'] };
        return { allow: false, reason: `wallet method ${method} not allowed` };
    }
  } catch (e) { return { allow: false, reason: `cannot parse request: ${String(e)}` }; }
}

// ---------- Simulation result check ----------

export interface BalanceDiff {
  /** Native balance change (wei), including gas. Negative = went out. */
  native: bigint;
  /** ERC-20 changes (and incoming NFTs as +1): token → delta. */
  erc20: Record<string, bigint>;
  /** NFTs (ERC-721/1155) that left our address: collection → count. */
  nftOut: Record<string, number>;
  /** New approvals granted by our address (spender/operator). */
  newApprovals: { token: string; spender: string; amount: bigint | 'all' }[];
  /** Address code delegation (7702) — must be false. */
  codeDelegated: boolean;
}

export interface Expectation {
  maxNativeOutWei: bigint;                    // value + gas
  allowedErc20Out?: Record<string, bigint>;   // tokens we deliberately give away (swap)
  /** Specific assets and minimum amounts that must arrive (swap/mint/claim). */
  minReceive?: Record<string, bigint>;
  /** Without minReceive: something must arrive (weak check). */
  mustReceiveSomething: boolean;
  /** Approvals that may remain: token → { spenders, max }. */
  allowedApprovals?: Record<string, { spenders: string[]; max: bigint }>;
  approvalOperatorsAllowlist?: string[];
  /** NFTs we deliberately give away (sale into a bid): collection → count. */
  allowedNftOut?: Record<string, number>;
}

export function checkSimulationDiff(diff: BalanceDiff, exp: Expectation): Verdict {
  if (diff.codeDelegated) return { allow: false, reason: 'simulation: address code delegated (7702)' };
  if (-diff.native > exp.maxNativeOutWei) return { allow: false, reason: `simulation: native out ${-diff.native} > expected ${exp.maxNativeOutWei}` };
  for (const [tok, d] of Object.entries(diff.erc20)) {
    if (d >= 0n) continue;
    const allowed = exp.allowedErc20Out?.[lc(tok)] ?? 0n;
    if (-d > allowed) return { allow: false, reason: `simulation: unexpected outflow of token ${tok}: ${-d}` };
  }
  for (const [col, n] of Object.entries(diff.nftOut)) if (n > (exp.allowedNftOut?.[lc(col)] ?? 0)) return { allow: false, reason: `simulation: NFT leaves wallet (${col} ×${n})` };
  for (const a of diff.newApprovals) {
    if (a.amount === 'all') {
      if (!(exp.approvalOperatorsAllowlist ?? []).map(lc).includes(lc(a.spender))) return { allow: false, reason: `simulation: approval-for-all to ${a.spender}` };
      continue;
    }
    if (a.amount === 0n) continue; // approval revoke
    const rule = exp.allowedApprovals?.[lc(a.token)];
    if (!rule || !rule.spenders.map(lc).includes(lc(a.spender)) || a.amount > rule.max) return { allow: false, reason: `simulation: unexpected approval ${a.token} → ${a.spender} (${a.amount})` };
  }
  if (exp.minReceive) {
    for (const [tok, min] of Object.entries(exp.minReceive)) {
      const got = lc(tok) === 'native' ? diff.native : (diff.erc20[lc(tok)] ?? 0n);
      if (got < min) return { allow: false, reason: `simulation: received ${got} of ${tok}, expected ≥ ${min}` };
    }
  } else if (exp.mustReceiveSomething) {
    const got = Object.values(diff.erc20).some(d => d > 0n) || diff.native > 0n;
    if (!got) return { allow: false, reason: 'simulation: nothing received' };
  }
  return { allow: true, notes: ['simulation diff matches expectation'] };
}

// ---------- Message signing by a burner wallet without money (E-06, part 2) ----------

/**
 * The owner's decision 2026-11-17 16:34 UTC: a task site may connect a burner wallet and sign a MESSAGE for verification
 * (personal_sign, Sign-In with Ethereum, Solana signMessage). HQ boundary: the wallet holds no money; no transactions and no
 * token-permission signatures — the session wallet rejects them (src/exec/siteWallet.ts), they never get here.
 *
 * Difference from checkPersonalSign (a wallet with money, E-13): there only a sign-in with the site name in the text passes. Here any
 * readable verification text passes ("Sign this message to verify your wallet. Nonce: 123") — otherwise the agent would skip ordinary tasks.
 * Rejected is what must not be signed blindly even with an empty wallet:
 *  • a hash or binary data (blind signature: a transaction or an order may hide under a hash);
 *  • text about approvals, transfers, delegation, withdrawals, keys;
 *  • JSON with an amount, a recipient or a token (an exchange request or an order, not a sign-in);
 *  • an EIP-4361 / Sign-In with Solana sign-in for a foreign domain or a foreign address (sign-in phishing).
 */
export interface BurnerMessageContext { siteHost: string; self: string; chain: 'evm' | 'solana' }
export const BURNER_MESSAGE_MAX = 4000;
export function checkBurnerMessage(messageHexOrText: string, ctx: BurnerMessageContext): Verdict {
  try {
    let text = messageHexOrText;
    if (/^0x([0-9a-fA-F]{2})*$/.test(messageHexOrText)) {
      const bytes = Buffer.from(messageHexOrText.slice(2), 'hex');
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { allow: false, reason: 'message is binary, not text — blind signing is forbidden' }; }
    }
    const t = text.trim();
    if (!t) return { allow: false, reason: 'empty message' };
    if (text.length > BURNER_MESSAGE_MAX) return { allow: false, reason: `message is longer than ${BURNER_MESSAGE_MAX} characters` };
    if (/^(0x)?[0-9a-f]{40,}$/i.test(t) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f�]/.test(text)) return { allow: false, reason: 'message is a raw hash or binary — blind signing is forbidden' };
    if (/^[A-Za-z0-9+/=_-]{80,}$/.test(t)) return { allow: false, reason: 'message is an opaque encoded blob — blind signing is forbidden' };
    if (/\b(permit\d*|approv(e|al)s?|allowance|spender|transfer(s|red)?|setapprovalforall|delegat\w*|authoriz(e|ation) (to )?spend|withdraw\w*|private key|seed phrase|recovery phrase|export key)\b/i.test(text))
      return { allow: false, reason: 'message mentions approvals, transfers, delegation, withdrawals or keys' };
    if (/^[{[]/.test(t)) {
      let obj: unknown; try { obj = JSON.parse(t); } catch { obj = undefined; }
      const keys: string[] = []; const walk = (v: unknown, d = 0) => { if (v && typeof v === 'object' && d < 6) for (const [k, x] of Object.entries(v as Record<string, unknown>)) { keys.push(k); walk(x, d + 1); } };
      walk(obj);
      if (obj === undefined || keys.some(k => /amount|value|recipient|destination|receiver|token|price|order|nonce.*tx|calldata/i.test(k)))
        return { allow: false, reason: 'message is a structured payload (amount, recipient, token or order) — not a verification text' };
    }
    const signIn = text.match(/^([^\s]+) wants you to sign in with your (Ethereum|Solana) account:\r?\n([^\s]+)(\r?\n|$)/i);
    if (/wants you to sign in/i.test(text)) {
      if (!signIn) return { allow: false, reason: 'sign-in message in a non-standard format' };
      if (!domainMatches(signIn[1], ctx.siteHost)) return { allow: false, reason: `sign-in domain ${signIn[1].slice(0, 60)} ≠ site ${ctx.siteHost}` };
      const same = ctx.chain === 'evm' ? lc(signIn[3]) === lc(ctx.self) : signIn[3] === ctx.self;
      if (!same) return { allow: false, reason: 'sign-in message for a different address' };
      const uri = text.match(/^URI:\s*(\S+)/mi);
      if (uri) { let h = ''; try { h = new URL(uri[1]).hostname; } catch { h = ''; } if (!h || !(domainMatches(h, ctx.siteHost) || domainMatches(ctx.siteHost, h))) return { allow: false, reason: `sign-in URI ${uri[1].slice(0, 60)} is not the task site` }; }
      return { allow: true, notes: [`standard sign-in (${signIn[2]}), domain and address match`] };
    }
    return { allow: true, notes: ['readable verification message'] };
  } catch (e) { return { allow: false, reason: `cannot parse message: ${String(e).slice(0, 120)}` }; }
}
