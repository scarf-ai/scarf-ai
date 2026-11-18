// E-06 (#16), part 2: the session wallet — connecting a burner wallet and signing a MESSAGE for verification on the task site.
// The owner's decision 2026-11-17 16:34 UTC; HQ boundary: only a burner wallet without money; only message signing
// (personal_sign, Sign-In with Ethereum, Solana signMessage); no transactions and no token-permission signatures — that is E-13.
//
// The site sees an ordinary wallet in the page (window.ethereum, window.solana — the page code is in siteBrowser.ts), but every request
// comes here, to Node, and is decided by CODE, not by the model and not by the page text:
//  • connecting (address) — yes, only to the frame of the task site itself;
//  • signing readable text — yes, after checkBurnerMessage (src/safety/firewall.ts); the text goes to the journal;
//  • transactions, typed data (permits and orders live there), eth_sign (blind hash signing), batched calls — no: the request
//    is rejected and the session stops with a reason (wallet.blocked);
//  • the wallet key never appears here: the module only receives a "sign these bytes" function.
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { checkBurnerMessage, BURNER_MESSAGE_MAX } from '../safety/firewall.js';
import { sameSite } from './siteSession.js';

/** The signing side: an address and a function signing the message bytes. There is no key in the interface. */
export interface BurnerSigner {
  evm?: { address: `0x${string}`; /** personal_sign: signature of the message bytes (EIP-191). */ signMessage(bytes: Uint8Array): Promise<string> };
  sol?: { address: string; publicKey: Uint8Array; /** ed25519 signature of the message bytes. */ signMessage(bytes: Uint8Array): Promise<Uint8Array> };
}

export interface WalletRequest { kind: 'evm' | 'sol'; method: string; params: unknown[]; /** URL of the frame the request came from. */ frameUrl: string }
export type WalletResponse = { result: unknown } | { error: { code: number; message: string } };
/** A journal entry: what the site asked the wallet for and how it ended. */
export interface WalletEvent { chain: 'evm' | 'solana'; method: string; allowed: boolean; reason?: string; /** Text of the signed (or rejected) message. */ message?: string }

const err = (code: number, message: string): WalletResponse => ({ error: { code, message } });
const REJECTED = 4001; const UNAUTHORIZED = 4100; const UNSUPPORTED = 4200;

/** Methods that move money or grant rights to it: refusal and session stop. */
const EVM_MONEY = new Set(['eth_sendTransaction', 'eth_signTransaction', 'eth_sendRawTransaction', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v1',
  'eth_signTypedData_v3', 'eth_signTypedData_v4', 'wallet_sendCalls', 'wallet_grantPermissions', 'eth_decrypt', 'eth_getEncryptionPublicKey']);
const SOL_MONEY = new Set(['signTransaction', 'signAllTransactions', 'signAndSendTransaction', 'signAndSendAllTransactions', 'sendTransaction']);

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));

export class SiteWallet {
  /** Everything the site asked the wallet for (for the journal). */
  readonly events: WalletEvent[] = [];
  /** The site asked for a transaction or a permission signature: the reason for stopping the session. */
  blocked?: string;
  private connected = { evm: false, sol: false };
  private chainId = 1;
  private signedCount = 0;

  constructor(private siteHost: string, private signer: BurnerSigner, private opts: { maxSignatures?: number } = {}) {}

  get evmAddress() { return this.signer.evm?.address; }
  get solAddress() { return this.signer.sol?.address; }
  get solPublicKey() { return this.signer.sol?.publicKey; }
  /** Signed messages (the text goes to the journal, an HQ requirement). */
  get signed(): WalletEvent[] { return this.events.filter(e => e.allowed && e.message !== undefined); }
  get isConnected() { return this.connected.evm || this.connected.sol; }

  private note(e: WalletEvent) { if (this.events.length < 60) this.events.push(e); }
  private block(chain: 'evm' | 'solana', method: string, why: string): WalletResponse {
    this.note({ chain, method, allowed: false, reason: why });
    this.blocked ??= `the site asked the wallet for ${method} — ${why}`;
    return err(REJECTED, 'User rejected the request.');
  }

  /** The only entry point: a site request to the wallet. Never throws. */
  async request(q: WalletRequest): Promise<WalletResponse> {
    try {
      if (typeof q?.method !== 'string' || q.method.length > 80 || !Array.isArray(q.params)) return err(-32600, 'invalid request');
      // The wallet answers only the frame of the task site itself: not an embedded foreign frame (ad, widget)
      if (!sameSite(q.frameUrl, this.siteHost)) { this.note({ chain: q.kind === 'sol' ? 'solana' : 'evm', method: q.method, allowed: false, reason: 'request from a frame outside the task site' }); return err(UNAUTHORIZED, 'unauthorized'); }
      return q.kind === 'sol' ? await this.sol(q.method, q.params) : await this.evm(q.method, q.params);
    } catch (e) { return err(-32603, `internal: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
  }

  private async signText(chain: 'evm' | 'solana', method: string, bytes: Uint8Array, self: string): Promise<{ ok: true } | { ok: false; res: WalletResponse }> {
    const hex = `0x${Buffer.from(bytes).toString('hex')}`;
    const text = Buffer.from(bytes).toString('utf8').slice(0, BURNER_MESSAGE_MAX);
    const v = checkBurnerMessage(hex, { siteHost: this.siteHost, self, chain });
    if (!v.allow) {
      // A signature refusal is not "money": the session does not stop by itself, the site gets an ordinary user rejection
      this.note({ chain, method, allowed: false, reason: v.reason, message: text.slice(0, 600) });
      return { ok: false, res: err(REJECTED, 'User rejected the request.') };
    }
    if (this.signedCount >= (this.opts.maxSignatures ?? 3)) { this.note({ chain, method, allowed: false, reason: 'signature limit per session reached', message: text.slice(0, 600) }); return { ok: false, res: err(REJECTED, 'User rejected the request.') }; }
    this.signedCount++;
    this.note({ chain, method, allowed: true, reason: v.notes.join('; '), message: text });
    return { ok: true };
  }

  private async evm(method: string, params: unknown[]): Promise<WalletResponse> {
    const s = this.signer.evm;
    if (!s) return err(UNSUPPORTED, 'no EVM account');
    if (EVM_MONEY.has(method)) return this.block('evm', method, 'transactions, typed-data signatures and blind signing are not allowed in a site session (E-13)');
    switch (method) {
      case 'eth_requestAccounts': this.connected.evm = true; this.note({ chain: 'evm', method, allowed: true }); return { result: [s.address] };
      case 'eth_accounts': return { result: this.connected.evm ? [s.address] : [] };
      case 'eth_coinbase': return { result: this.connected.evm ? s.address : null };
      case 'eth_chainId': return { result: `0x${this.chainId.toString(16)}` };
      case 'net_version': return { result: String(this.chainId) };
      case 'web3_clientVersion': return { result: 'SCARF/1' };
      // The site may pick any chain: the wallet signs no transactions, so switching moves nothing
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain': {
        const id = Number((params[0] as { chainId?: string } | undefined)?.chainId);
        if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) return err(-32602, 'bad chainId');
        this.chainId = id; return { result: null };
      }
      case 'wallet_requestPermissions': this.connected.evm = true; return { result: [{ parentCapability: 'eth_accounts' }] };
      case 'wallet_getPermissions': return { result: this.connected.evm ? [{ parentCapability: 'eth_accounts' }] : [] };
      case 'wallet_revokePermissions': this.connected.evm = false; return { result: null };
      case 'wallet_watchAsset': return { result: true };
      case 'wallet_getCapabilities': return { result: {} };
      case 'eth_getBalance': return { result: '0x0' }; // a wallet without money — that is indeed the case
      case 'eth_getTransactionCount': return { result: '0x0' };
      case 'personal_sign': {
        if (!this.connected.evm) return err(UNAUTHORIZED, 'not connected');
        const [a, b] = params as unknown[];
        // wallets and libraries pass the parameters in different orders: [message, address] or [address, message]
        const raw = typeof a === 'string' && a.toLowerCase() === s.address.toLowerCase() ? b : a;
        const other = raw === a ? b : a;
        if (typeof other === 'string' && /^0x[0-9a-fA-F]{40}$/.test(other) && other.toLowerCase() !== s.address.toLowerCase()) return err(UNAUTHORIZED, 'unknown account');
        if (typeof raw !== 'string' || !raw || raw.length > BURNER_MESSAGE_MAX * 4) return err(-32602, 'bad message');
        const bytes = /^0x([0-9a-fA-F]{2})*$/.test(raw) ? hexToBytes(raw) : Uint8Array.from(Buffer.from(raw, 'utf8'));
        const ok = await this.signText('evm', method, bytes, s.address);
        if (!ok.ok) return ok.res;
        return { result: await s.signMessage(bytes) };
      }
      default: return err(UNSUPPORTED, `method ${method.slice(0, 60)} is not supported by this wallet`);
    }
  }

  private async sol(method: string, params: unknown[]): Promise<WalletResponse> {
    const s = this.signer.sol;
    if (!s) return err(UNSUPPORTED, 'no Solana account');
    if (SOL_MONEY.has(method)) return this.block('solana', method, 'transactions are not allowed in a site session (E-13)');
    switch (method) {
      case 'connect': this.connected.sol = true; this.note({ chain: 'solana', method, allowed: true }); return { result: { publicKey: s.address } };
      case 'disconnect': this.connected.sol = false; return { result: null };
      case 'signMessage': {
        if (!this.connected.sol) return err(UNAUTHORIZED, 'not connected');
        const m = params[0];
        if (!Array.isArray(m) || m.length === 0 || m.length > BURNER_MESSAGE_MAX * 4 || !m.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) return err(-32602, 'bad message');
        const bytes = Uint8Array.from(m as number[]);
        const ok = await this.signText('solana', method, bytes, s.address);
        if (!ok.ok) return ok.res;
        return { result: { signature: Array.from(await s.signMessage(bytes)), publicKey: s.address } };
      }
      default: return err(UNSUPPORTED, `method ${method.slice(0, 60)} is not supported by this wallet`);
    }
  }
}

/** EVM signing side from a viem account (privateKeyToAccount): the key stays inside the account. */
export function evmSigner(account: { address: `0x${string}`; signMessage(a: { message: { raw: Uint8Array } }): Promise<string> }): NonNullable<BurnerSigner['evm']> {
  return { address: account.address, signMessage: (bytes) => account.signMessage({ message: { raw: bytes } }) };
}

/** Solana signing side from a Keypair (@solana/web3.js): ed25519 using Node, no new packages. */
export function solSigner(kp: { publicKey: { toBase58(): string; toBytes(): Uint8Array }; secretKey: Uint8Array }): NonNullable<BurnerSigner['sol']> {
  // secretKey — 64 bytes: seed (32) + public key (32). PKCS#8 for Ed25519 — a constant prefix + the seed
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  return { address: kp.publicKey.toBase58(), publicKey: kp.publicKey.toBytes(), signMessage: async (bytes) => new Uint8Array(edSign(null, Buffer.from(bytes), key)) };
}

/**
 * Check of the HQ boundary "only a burner wallet without money" for SiteSessions.wallet.hasNoMoney: the address's native coin balance
 * is zero on EACH of the given nodes. Without the native coin not a single transaction can be sent from the address (nothing to pay gas with),
 * and the session wallet rejects permission signatures itself. Tokens and NFTs on the address are not visible to this check — a known limit.
 * A node did not answer or the answer was not parsed — an exception: the session wallet is not given (a refusal, not a skip).
 */
export function burnerHasNoMoney(d: { evmRpcs: string[]; solRpc?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): (kind: 'evm' | 'sol', address: string) => Promise<boolean> {
  const f = d.fetchImpl ?? fetch;
  const rpc = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(d.timeoutMs ?? 8_000) });
    if (!r.ok) throw new Error(`${method}: http ${r.status}`);
    const j = await r.json() as { result?: unknown; error?: { message?: string } };
    if (j.error || j.result === undefined || j.result === null) throw new Error(`${method}: ${String(j.error?.message ?? 'no result').slice(0, 80)}`);
    return j.result;
  };
  return async (kind, address) => {
    if (kind === 'evm') {
      if (!d.evmRpcs.length) throw new Error('no EVM node to check the balance');
      for (const url of d.evmRpcs) {
        const v = await rpc(url, 'eth_getBalance', [address, 'latest']);
        if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error('eth_getBalance: bad answer');
        if (BigInt(v) !== 0n) return false;
      }
      return true;
    }
    if (!d.solRpc) throw new Error('no Solana node to check the balance');
    const v = await rpc(d.solRpc, 'getBalance', [address]) as { value?: unknown };
    if (typeof v?.value !== 'number' || !Number.isFinite(v.value)) throw new Error('getBalance: bad answer');
    return v.value === 0;
  };
}
