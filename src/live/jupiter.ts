// Solana: swap via Jupiter (public lite-api, no key). The transaction is built by Jupiter, signed
// by us, simulated before sending; sent to all RPCs from RPC_SEND_SOLANA at once.
import { Connection, VersionedTransaction, PublicKey, TransactionInstruction, TransactionMessage, type Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export interface SolSwap { tx: VersionedTransaction; inAmount: bigint; outAmount: bigint; minOut: bigint; priceImpactPct?: number; lastValidBlockHeight?: number }

/** Programs a top-level swap transaction may call (Jupiter routes across pools internally). */
export const SOL_PROGRAM_ALLOWLIST = new Set(['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'ComputeBudget111111111111111111111111111111', '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);

/** Solana filter: only our key pays and signs; top-level programs — only from the allowlist. */
export function checkSolTx(tx: VersionedTransaction, owner: string): { ok: boolean; reason?: string } {
  const m = tx.message;
  const keys = m.staticAccountKeys.map(k => k.toBase58());
  if (keys[0] !== owner) return { ok: false, reason: `fee payer ${keys[0]} is not our wallet` };
  if (m.header.numRequiredSignatures !== 1) return { ok: false, reason: `${m.header.numRequiredSignatures} signers required` };
  for (const ix of m.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    if (!prog || !SOL_PROGRAM_ALLOWLIST.has(prog)) return { ok: false, reason: `unexpected program ${prog ?? '?'}` };
  }
  return { ok: true };
}

// ── Closing an empty token account (#145; the owner's decision 2026-11-17: "Yes, we close empty accounts") ──────────────────────────────────────
// Solana opens an account for every token and takes a deposit for it (~0.00204 SOL). The deposit is returned only if the account is closed.
// After a full sale the agent closes the account in a separate transaction: [Burn dust] + CloseAccount, the deposit goes to our wallet.

/** Close transaction fee: one signature, no priority fee. */
export const CLOSE_FEE_LAMPORTS = 5_000n;
/** A balance on the account counts as dust if, at the sale price itself, it is worth less than this share of the returned deposit. */
export const DUST_SHARE_OF_RENT = 0.1;
export interface TokenAccountInfo { address: string; program: string; amount: bigint; lamports: bigint }
export interface CloseResult { closed: number; burnedRaw: bigint; refundLamports: bigint; sig?: string; note: string }

/** Close instructions: for an account with dust — Burn(balance), then CloseAccount returning the deposit to the account owner. */
export function closeInstructions(owner: string, mint: string, accounts: TokenAccountInfo[]): TransactionInstruction[] {
  const ownerPk = new PublicKey(owner); const mintPk = new PublicKey(mint); const out: TransactionInstruction[] = [];
  for (const a of accounts) {
    const acc = new PublicKey(a.address); const programId = new PublicKey(a.program);
    if (a.amount > 0n) {
      const data = Buffer.alloc(9); data[0] = 8; data.writeBigUInt64LE(a.amount, 1); // Burn
      out.push(new TransactionInstruction({ programId, data, keys: [{ pubkey: acc, isSigner: false, isWritable: true }, { pubkey: mintPk, isSigner: false, isWritable: true }, { pubkey: ownerPk, isSigner: true, isWritable: false }] }));
    }
    out.push(new TransactionInstruction({ programId, data: Buffer.from([9]), // CloseAccount
      keys: [{ pubkey: acc, isSigner: false, isWritable: true }, { pubkey: ownerPk, isSigner: false, isWritable: true }, { pubkey: ownerPk, isSigner: true, isWritable: false }] }));
  }
  return out;
}

/**
 * Check of the close transaction before signing (same logic as for the swap: code, not trust in whoever built the transaction):
 * only our key pays and signs; programs — only Token and Token-2022; instructions — only Burn and CloseAccount on accounts
 * from the list; exactly the expected balance of this mint is burned; the deposit returns to us; no address tables.
 */
export function checkCloseTx(tx: VersionedTransaction, owner: string, mint: string, accounts: TokenAccountInfo[]): { ok: boolean; reason?: string } {
  const base = checkSolTx(tx, owner);
  if (!base.ok) return base;
  const m = tx.message;
  if (m.addressTableLookups.length) return { ok: false, reason: 'close tx must not use lookup tables' };
  const keys = m.staticAccountKeys.map(k => k.toBase58());
  const byAddr = new Map(accounts.map(a => [a.address, a]));
  const closed = new Set<string>();
  for (const ix of m.compiledInstructions) {
    const prog = keys[ix.programIdIndex]; const acc = (i: number) => keys[ix.accountKeyIndexes[i]]; const d = Buffer.from(ix.data);
    if (prog !== TOKEN_PROGRAM && prog !== TOKEN_2022) return { ok: false, reason: `unexpected program ${prog} in close tx` };
    const a = byAddr.get(acc(0));
    if (!a || a.program !== prog) return { ok: false, reason: 'instruction on an account that is not ours to close' };
    if (d[0] === 8) { if (d.length !== 9 || acc(1) !== mint || acc(2) !== owner || d.readBigUInt64LE(1) !== a.amount || a.amount <= 0n) return { ok: false, reason: 'burn of an unexpected amount or mint' }; }
    else if (d[0] === 9) { if (d.length !== 1 || acc(1) !== owner || acc(2) !== owner) return { ok: false, reason: 'CloseAccount pays someone else' }; closed.add(a.address); }
    else return { ok: false, reason: `token instruction ${d[0]} in close tx` };
  }
  if (closed.size !== accounts.length) return { ok: false, reason: 'close tx does not close every listed account' };
  return { ok: true };
}

export function jupiterClient(fetchImpl: typeof fetch = fetch, base = 'https://lite-api.jup.ag/swap/v1') {
  return {
    async build(p: { inputMint: string; outputMint: string; amount: bigint; user: string; slippageBps: number; maxPriorityLamports?: number }): Promise<SolSwap> {
      const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), slippageBps: String(p.slippageBps), restrictIntermediateTokens: 'true' });
      const r1 = await fetchImpl(`${base}/quote?${q}`, { signal: AbortSignal.timeout(8_000) });
      const quote: any = await r1.json().catch(() => ({}));
      if (!r1.ok || !quote?.outAmount) throw new Error(`jupiter quote: ${quote?.error ?? r1.status}`);
      const r2 = await fetchImpl(`${base}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: p.user, dynamicComputeUnitLimit: true, wrapAndUnwrapSol: true,
          prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: p.maxPriorityLamports ?? 1_000_000, priorityLevel: 'veryHigh' } } }) });
      const sw: any = await r2.json().catch(() => ({}));
      if (!r2.ok || !sw?.swapTransaction) throw new Error(`jupiter swap: ${sw?.error ?? r2.status}`);
      return { tx: VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, 'base64')), inAmount: BigInt(quote.inAmount), outAmount: BigInt(quote.outAmount),
        minOut: BigInt(quote.otherAmountThreshold ?? quote.outAmount), priceImpactPct: Number(quote.priceImpactPct) || undefined, lastValidBlockHeight: Number(sw.lastValidBlockHeight) || undefined };
    },
  };
}

/** A stuck lane must not freeze the monitor: every request to a Solana node has a 20 s timeout. */
const SOL_CONN = { commitment: 'confirmed' as const, fetch: ((u: any, o: any) => fetch(u, { ...o, signal: AbortSignal.timeout(20_000) })) as typeof fetch };

export class SolSender {
  private read: Connection; private lanes: Connection[];
  constructor(rpc: string, send: string[]) { this.read = new Connection(rpc, SOL_CONN); this.lanes = (send.length ? send : [rpc]).map(u => new Connection(u, SOL_CONN)); }

  /** Simulation: the signature is not checked, the node substitutes a fresh blockhash. */
  async simulate(tx: VersionedTransaction): Promise<{ ok: boolean; error?: string; logs?: string[] }> {
    const r = await this.read.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    return { ok: !r.value.err, error: r.value.err ? JSON.stringify(r.value.err) : undefined, logs: r.value.logs?.slice(-8) ?? undefined };
  }

  /**
   * Send: wait for confirmation or blockhash expiry (lastValidBlockHeight) — only then is it finally "did not go through".
   * Signing — after the check and simulation (the caller does them).
   */
  async send(tx: VersionedTransaction, signer: Keypair, lastValidBlockHeight?: number, hardTimeoutMs = 150_000): Promise<{ sig: string; ok: boolean; error?: string }> {
    tx.sign([signer]);
    const raw = tx.serialize();
    // The signature is known before sending: a lost node response never turns into "not sent" and a blind retry (like the hash in EVM)
    const sig = bs58.encode(tx.signatures[0]);
    const sigs = await Promise.allSettled(this.lanes.map(c => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 2 })));
    const accepted = sigs.some(s => s.status === 'fulfilled');
    if (!accepted) {
      const reasons = sigs.map(s => (s as PromiseRejectedResult).reason);
      // "Already processed" — the transaction was EXECUTED (like "already known" in EVM): this is acceptance, go wait for the status
      const processed = (r: any) => /already been processed|already processed/i.test(String(r?.message ?? ''));
      // A rejection is only a parsed node response (SendTransactionError: simulation, blockhash, invalid). HTTP 5xx/429 from the gateway,
      // timeout, disconnect — no response, the transaction may have gone out: wait for the status below
      const rejected = (r: any) => !processed(r) && (r?.name === 'SendTransactionError' || /simulation failed|blockhash not found|invalid transaction|insufficient (funds|lamports)/i.test(String(r?.message ?? '')));
      if (reasons.every(rejected)) return { sig, ok: false, error: `all send lanes rejected: ${String((reasons[0] as Error)?.message ?? reasons[0]).slice(0, 120)}` };
    }
    const deadline = Date.now() + hardTimeoutMs;
    while (Date.now() < deadline) {
      const st = (await this.read.getSignatureStatuses([sig]).catch(() => undefined))?.value?.[0];
      if (st?.err) return { sig, ok: false, error: JSON.stringify(st.err) };
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return { sig, ok: true };
      if (lastValidBlockHeight && (await this.read.getBlockHeight('confirmed').catch(() => 0)) > lastValidBlockHeight + 5) return { sig, ok: false, error: 'blockhash expired — not included' };
      await new Promise(s => setTimeout(s, 500));
    }
    return { sig, ok: false, error: 'not confirmed in time (may still land — check wallet)' };
  }

  /**
   * Full swap check before signing (review note: top-level System/Token could drain funds):
   * — addresses from lookup tables (LUT) are expanded;
   * — System: only a transfer from our address to our own WSOL account;
   * — Token: only SyncNative on our account and CloseAccount returning to us;
   * — ATA: account creation only for our wallet, we pay;
   * — in live — simulation reading the recipient account: no less than the minimum arrived.
   */
  async verifySwap(tx: VersionedTransaction, owner: string, inMint: string, outMint: string, minOut: bigint, simulateBalance: boolean): Promise<{ ok: boolean; reason?: string }> {
    const base = checkSolTx(tx, owner);
    if (!base.ok) return base;
    const m = tx.message;
    const luts = await Promise.all(m.addressTableLookups.map(l => this.read.getAddressLookupTable(l.accountKey).then(r => r.value)));
    if (luts.some(x => !x)) return { ok: false, reason: 'address lookup table not found' };
    const keys = m.getAccountKeys({ addressLookupTableAccounts: luts as any }).keySegments().flat().map(k => k.toBase58());
    const ownerPk = new PublicKey(owner);
    const own = new Set([owner]);
    for (const tp of [TOKEN_PROGRAM, TOKEN_2022])
      for (const mint of [inMint, outMint, SOL_MINT]) own.add(PublicKey.findProgramAddressSync([ownerPk.toBuffer(), new PublicKey(tp).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58());
    for (const ix of m.compiledInstructions) {
      const prog = keys[ix.programIdIndex];
      const acc = (i: number) => keys[ix.accountKeyIndexes[i]];
      const d = Buffer.from(ix.data);
      if (prog === SYSTEM_PROGRAM) {
        if (d.readUInt32LE(0) !== 2 || acc(0) !== owner || !own.has(acc(1)) || acc(1) === owner) return { ok: false, reason: 'system instruction other than a transfer to our own WSOL account' };
      } else if (prog === TOKEN_PROGRAM || prog === TOKEN_2022) {
        const t = d[0];
        if (t === 17) { if (!own.has(acc(0))) return { ok: false, reason: 'SyncNative on a foreign account' }; }
        else if (t === 9) { if (!own.has(acc(0)) || acc(1) !== owner || acc(2) !== owner) return { ok: false, reason: 'CloseAccount pays someone else' }; }
        else return { ok: false, reason: `token instruction ${t} at top level` };
      } else if (prog === ATA_PROGRAM) {
        if (acc(0) !== owner || acc(2) !== owner) return { ok: false, reason: 'ATA create for someone else' };
      }
    }
    if (!simulateBalance) return { ok: true };
    // Did at least the minimum arrive: read the recipient account after the simulation
    const outAcc = outMint === SOL_MINT ? owner : [...own].find(a => a !== owner && keys.includes(a) && PublicKey.findProgramAddressSync([ownerPk.toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(outMint).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58() === a)
      ?? [...own].find(a => a !== owner && keys.includes(a) && PublicKey.findProgramAddressSync([ownerPk.toBuffer(), new PublicKey(TOKEN_2022).toBuffer(), new PublicKey(outMint).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58() === a);
    if (!outAcc) return { ok: false, reason: 'swap output does not go to our account' };
    const pre = outMint === SOL_MINT ? BigInt(await this.read.getBalance(ownerPk)) : await this.read.getTokenAccountBalance(new PublicKey(outAcc)).then(r => BigInt(r.value.amount)).catch(() => 0n);
    const sim = await this.read.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [outAcc] } });
    if (sim.value.err) return { ok: false, reason: `simulation: ${JSON.stringify(sim.value.err)}` };
    const a = sim.value.accounts?.[0];
    if (!a) return { ok: false, reason: 'simulation returned no account' };
    const post = outMint === SOL_MINT ? BigInt(a.lamports) : Buffer.from(a.data[0], 'base64').readBigUInt64LE(64);
    const slack = outMint === SOL_MINT ? 5_000_000n : 0n; // fees and account rent in SOL
    if (post - pre + slack < minOut) return { ok: false, reason: `simulation: received ${post - pre}, minimum ${minOut}` };
    return { ok: true };
  }

  /** Transaction outcome by signature: wait up to timeoutMs. */
  async settle(sig: string, timeoutMs = 10 * 60_000): Promise<'ok' | 'failed' | 'unknown'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = (await this.read.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => undefined))?.value?.[0];
      if (st?.err) return 'failed';
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return 'ok';
      await new Promise(s => setTimeout(s, 3_000));
    }
    return 'unknown';
  }
  /** How much of token mint reached the account owner in the transaction (post − pre over their accounts). undefined — the transaction/meta is not yet visible to the node. */
  async receivedInTx(sig: string, owner: string, mint: string): Promise<bigint | undefined> {
    const tx = await this.read.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx?.meta) return undefined;
    const sum = (arr: any[] | null | undefined) => (arr ?? []).filter(b => b.owner === owner && b.mint === mint).reduce((a: bigint, b: any) => a + BigInt(b.uiTokenAmount.amount), 0n);
    return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  }

  /**
   * How many lamports left the owner wallet in the transaction: pre − post on its account (the swap itself, fee, rent of new token accounts).
   * undefined — the transaction/meta is not yet visible to the node or owner is not among the accounts; zero and negative numbers are not returned.
   */
  async spentLamportsInTx(sig: string, owner: string): Promise<bigint | undefined> {
    const tx = await this.read.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx?.meta) return undefined;
    const msg = tx.transaction.message as { staticAccountKeys?: { toBase58(): string }[]; accountKeys?: { toBase58(): string }[] };
    const i = (msg.staticAccountKeys ?? msg.accountKeys ?? []).findIndex(k => k.toBase58() === owner);
    const pre = tx.meta.preBalances?.[i], post = tx.meta.postBalances?.[i];
    if (i < 0 || typeof pre !== 'number' || typeof post !== 'number') return undefined;
    const spent = BigInt(pre) - BigInt(post);
    return spent > 0n ? spent : undefined;
  }

  /** Token accounts of mint held by owner: address, program (Token or Token-2022), balance and deposit in lamports. */
  async tokenAccounts(owner: string, mint: string): Promise<TokenAccountInfo[]> {
    const r = await this.read.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
    return r.value.map(x => ({ address: x.pubkey.toBase58(), program: x.account.owner.toBase58(), amount: BigInt(x.account.data.parsed?.info?.tokenAmount?.amount ?? '0'), lamports: BigInt(x.account.lamports) }));
  }

  /**
   * Close empty token accounts of mint and recover the deposit (#145). Called after a CONFIRMED full sale, as a separate transaction:
   * the sale does not depend on the close and cannot fail because of it.
   *  • empty account — CloseAccount;
   *  • dust on the account (at the sale price dustLamports(balance) is cheaper than DUST_SHARE_OF_RENT of the deposit) — Burn, then CloseAccount;
   *  • the balance is worth more or its price is unknown — the account is left alone: it is not dust, it must not be burned;
   *  • an account of a foreign program — skipped.
   * Before signing — the checkCloseTx check and simulation. Returns: how many accounts were closed and how many lamports came back net of
   * the fee. Does not throw on a network failure: the reason is in note, returns 0 (the account stays open until the next full sale).
   */
  async closeEmptyTokenAccounts(signer: Keypair, mint: string, o: { dustLamports?: (amountRaw: bigint) => bigint | undefined; hardTimeoutMs?: number } = {}): Promise<CloseResult> {
    const none = (note: string, extra: Partial<CloseResult> = {}): CloseResult => ({ closed: 0, burnedRaw: 0n, refundLamports: 0n, note, ...extra });
    const owner = signer.publicKey.toBase58();
    const all = await this.tokenAccounts(owner, mint);
    const todo: TokenAccountInfo[] = []; const kept: string[] = [];
    for (const a of all) {
      if (a.program !== TOKEN_PROGRAM && a.program !== TOKEN_2022) { kept.push('unknown token program'); continue; }
      if (a.amount > 0n) {
        const worth = o.dustLamports?.(a.amount);
        if (worth === undefined || worth < 0n || Number(worth) >= Number(a.lamports) * DUST_SHARE_OF_RENT) { kept.push(`${a.amount} raw left is not dust`); continue; }
      }
      todo.push(a);
    }
    if (!todo.length) return none(all.length ? `token account kept (${kept.join('; ')})` : 'no token account');
    const { blockhash, lastValidBlockHeight } = await this.read.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: closeInstructions(owner, mint, todo) }).compileToV0Message());
    const chk = checkCloseTx(tx, owner, mint, todo);
    if (!chk.ok) return none(`token account not closed: ${chk.reason}`);
    const sim = await this.simulate(tx);
    if (!sim.ok) return none(`token account not closed: simulation ${sim.error}`); // e.g. Token-2022 with a withheld fee
    const r = await this.send(tx, signer, lastValidBlockHeight, o.hardTimeoutMs ?? 45_000);
    if (!r.ok) return none(`token account not closed: ${r.error}`, { sig: r.sig });
    const total = todo.reduce((s, a) => s + a.lamports, 0n);
    const burned = todo.reduce((s, a) => s + a.amount, 0n);
    const refund = total > CLOSE_FEE_LAMPORTS ? total - CLOSE_FEE_LAMPORTS : 0n;
    return { closed: todo.length, burnedRaw: burned, refundLamports: refund, sig: r.sig,
      note: `token account closed, rent +${(Number(refund) / 1e9).toFixed(6)} SOL${burned > 0n ? `, ${burned} raw dust burned` : ''}` };
  }

  /** SPL token balance of owner (sum over all their accounts of this mint), in base units. */
  async tokenBalance(owner: string, mint: string): Promise<bigint> {
    const { PublicKey } = await import('@solana/web3.js');
    const r = await this.read.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
    return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed?.info?.tokenAmount?.amount ?? '0'), 0n);
  }
  async solBalance(owner: string): Promise<bigint> { const { PublicKey } = await import('@solana/web3.js'); return BigInt(await this.read.getBalance(new PublicKey(owner))); }
}
