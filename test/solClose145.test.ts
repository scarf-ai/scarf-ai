// #145 (the owner's decision 2026-11-17: "Yes, we close empty accounts"): after a full token sale on Solana the token account is closed,
// the deposit (~0.00204 SOL) returns to cash. A partial sale does not touch the account; dust is burned; Token-2022 is handled.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction } from '@solana/web3.js';
import { SolSender, closeInstructions, checkCloseTx, CLOSE_FEE_LAMPORTS, type TokenAccountInfo } from '../src/live/jupiter.js';
import { LiveTrader } from '../src/live/trader.js';
import { Wallets, newKeyMaterial } from '../src/live/keystore.js';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const RENT = 2_039_280n;
const kp = Keypair.generate(); const OWNER = kp.publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const ACC = Keypair.generate().publicKey.toBase58(); const ACC2 = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

/** A sender with a fake node: token accounts, simulation and sending — from the test; signed transactions are collected in sent. */
function sender(accounts: { address: string; program: string; amount: bigint; lamports?: bigint }[], o: { sim?: { ok: boolean; error?: string }; send?: { ok: boolean; error?: string } } = {}) {
  const s = new SolSender('http://sol', []); const sent: VersionedTransaction[] = []; const simulated: VersionedTransaction[] = [];
  (s as any).read = {
    async getParsedTokenAccountsByOwner() { return { value: accounts.map(a => ({ pubkey: new PublicKey(a.address), account: { owner: new PublicKey(a.program), lamports: Number(a.lamports ?? RENT), data: { parsed: { info: { tokenAmount: { amount: a.amount.toString() } } } } } })) }; },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }; },
  };
  (s as any).simulate = async (tx: VersionedTransaction) => { simulated.push(tx); return o.sim ?? { ok: true }; };
  (s as any).send = async (tx: VersionedTransaction) => { sent.push(tx); return { sig: 'CLOSESIG', ...(o.send ?? { ok: true }) }; };
  return { s, sent, simulated };
}
/** Transaction instructions in readable form: program, the first data byte, accounts. */
const decode = (tx: VersionedTransaction) => {
  const keys = tx.message.staticAccountKeys.map(k => k.toBase58());
  return tx.message.compiledInstructions.map(ix => ({ program: keys[ix.programIdIndex], op: ix.data[0], data: Buffer.from(ix.data), accounts: ix.accountKeyIndexes.map(i => keys[i]) }));
};

describe('#145: closing a token account — the transaction', () => {
  it('an empty account → one CloseAccount instruction, the deposit returns to our wallet; refund = deposit − fee', async () => {
    const { s, sent, simulated } = sender([{ address: ACC, program: TOKEN, amount: 0n }]);
    const r = await s.closeEmptyTokenAccounts(kp, MINT);
    expect(sent.length).toBe(1); expect(simulated.length).toBe(1); // first the simulation, then signing and sending
    expect(decode(sent[0])).toEqual([{ program: TOKEN, op: 9, data: Buffer.from([9]), accounts: [ACC, OWNER, OWNER] }]);
    expect(sent[0].message.staticAccountKeys[0].toBase58()).toBe(OWNER); // we pay and sign
    expect(r).toEqual({ closed: 1, burnedRaw: 0n, refundLamports: RENT - CLOSE_FEE_LAMPORTS, sig: 'CLOSESIG', note: 'token account closed, rent +0.002034 SOL' });
  });

  it('the account has dust (cheaper than 10 % of the deposit at the sale price) → Burn exactly the remainder, then CloseAccount', async () => {
    const { s, sent } = sender([{ address: ACC, program: TOKEN, amount: 37n }]);
    const r = await s.closeEmptyTokenAccounts(kp, MINT, { dustLamports: (left) => left * 100n }); // 37 × 100 = 3 700 lamports < 203 928
    const ix = decode(sent[0]);
    expect(ix.map(i => i.op)).toEqual([8, 9]);
    expect(ix[0].accounts).toEqual([ACC, MINT, OWNER]); expect(ix[0].data.readBigUInt64LE(1)).toBe(37n);
    expect(ix[1].accounts).toEqual([ACC, OWNER, OWNER]);
    expect(r.closed).toBe(1); expect(r.burnedRaw).toBe(37n); expect(r.note).toBe('token account closed, rent +0.002034 SOL, 37 raw dust burned');
  });

  it('the remainder is not dust (worth 10 % of the deposit or more) or its price is unknown → the account is not touched, nothing is burned or sent', async () => {
    for (const dust of [(left: bigint) => left * 10_000n, () => undefined, undefined]) {
      const { s, sent, simulated } = sender([{ address: ACC, program: TOKEN, amount: 37n }]);
      const r = await s.closeEmptyTokenAccounts(kp, MINT, dust ? { dustLamports: dust as any } : {});
      expect(sent.length + simulated.length).toBe(0);
      expect(r).toMatchObject({ closed: 0, refundLamports: 0n, note: 'token account kept (37 raw left is not dust)' });
    }
    // the boundary: exactly 10 % of the deposit — no longer dust
    const edge = sender([{ address: ACC, program: TOKEN, amount: 1n }]);
    expect((await edge.s.closeEmptyTokenAccounts(kp, MINT, { dustLamports: () => 203_928n })).closed).toBe(0);
    const below = sender([{ address: ACC, program: TOKEN, amount: 1n }]);
    expect((await below.s.closeEmptyTokenAccounts(kp, MINT, { dustLamports: () => 203_927n })).closed).toBe(1);
  });

  it('Token-2022: the instructions go to the Token-2022 program; the deposit of an account with extensions is larger — it is returned in full', async () => {
    const { s, sent } = sender([{ address: ACC, program: TOKEN22, amount: 0n, lamports: 2_157_600n }]);
    const r = await s.closeEmptyTokenAccounts(kp, MINT);
    expect(decode(sent[0])).toEqual([{ program: TOKEN22, op: 9, data: Buffer.from([9]), accounts: [ACC, OWNER, OWNER] }]);
    expect(r.refundLamports).toBe(2_157_600n - CLOSE_FEE_LAMPORTS);
  });

  it('two accounts of one token (Token and Token-2022) → both are closed in one transaction; an account of an unknown program is skipped', async () => {
    const foreign = Keypair.generate().publicKey.toBase58();
    const { s, sent } = sender([{ address: ACC, program: TOKEN, amount: 0n }, { address: ACC2, program: TOKEN22, amount: 0n }, { address: Keypair.generate().publicKey.toBase58(), program: foreign, amount: 0n }]);
    const r = await s.closeEmptyTokenAccounts(kp, MINT);
    expect(decode(sent[0]).map(i => [i.program, i.op, i.accounts[0]])).toEqual([[TOKEN, 9, ACC], [TOKEN22, 9, ACC2]]);
    expect(r.closed).toBe(2); expect(r.refundLamports).toBe(2n * RENT - CLOSE_FEE_LAMPORTS);
  });

  it('the simulation failed (e.g. Token-2022 with a withheld fee) → we do not sign or send; the send was not confirmed → refund 0, the signature in the answer', async () => {
    const a = sender([{ address: ACC, program: TOKEN22, amount: 0n }], { sim: { ok: false, error: '{"InstructionError":[0,{"Custom":11}]}' } });
    expect(await a.s.closeEmptyTokenAccounts(kp, MINT)).toMatchObject({ closed: 0, refundLamports: 0n, note: 'token account not closed: simulation {"InstructionError":[0,{"Custom":11}]}' });
    expect(a.sent.length).toBe(0);
    const b = sender([{ address: ACC, program: TOKEN, amount: 0n }], { send: { ok: false, error: 'not confirmed in time (may still land — check wallet)' } });
    expect(await b.s.closeEmptyTokenAccounts(kp, MINT)).toMatchObject({ closed: 0, refundLamports: 0n, sig: 'CLOSESIG', note: 'token account not closed: not confirmed in time (may still land — check wallet)' });
  });

  it('no token account → we do nothing', async () => {
    const { s, sent } = sender([]);
    expect(await s.closeEmptyTokenAccounts(kp, MINT)).toMatchObject({ closed: 0, note: 'no token account' });
    expect(sent.length).toBe(0);
  });
});

describe('#145: checking the close transaction before signing', () => {
  const acc: TokenAccountInfo = { address: ACC, program: TOKEN, amount: 0n, lamports: RENT };
  const dusty: TokenAccountInfo = { ...acc, amount: 37n };
  const build = (ins: TransactionInstruction[], payer = kp.publicKey) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ins }).compileToV0Message());
  const k = (pubkey: string, isSigner = false) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable: !isSigner });
  const ix = (program: string, data: number[] | Buffer, keys: ReturnType<typeof k>[]) => new TransactionInstruction({ programId: new PublicKey(program), data: Buffer.from(data), keys });
  const THIEF = Keypair.generate().publicKey.toBase58();

  it('a transaction built by us passes', () => {
    expect(checkCloseTx(build(closeInstructions(OWNER, MINT, [acc])), OWNER, MINT, [acc])).toEqual({ ok: true });
    expect(checkCloseTx(build(closeInstructions(OWNER, MINT, [dusty])), OWNER, MINT, [dusty])).toEqual({ ok: true });
  });
  it('the deposit goes not to us, a foreign account is closed, a different amount or token is burned, an extra instruction, a foreign program — refused', () => {
    const burn = (amount: bigint, mint = MINT) => { const d = Buffer.alloc(9); d[0] = 8; d.writeBigUInt64LE(amount, 1); return ix(TOKEN, d, [k(ACC), k(mint), k(OWNER, true)]); };
    const close = (dest = OWNER, account = ACC) => ix(TOKEN, [9], [k(account), k(dest), k(OWNER, true)]);
    expect(checkCloseTx(build([close(THIEF)]), OWNER, MINT, [acc])).toMatchObject({ ok: false, reason: 'CloseAccount pays someone else' });
    expect(checkCloseTx(build([close(OWNER, ACC2)]), OWNER, MINT, [acc])).toMatchObject({ ok: false, reason: 'instruction on an account that is not ours to close' });
    expect(checkCloseTx(build([burn(38n), close()]), OWNER, MINT, [dusty])).toMatchObject({ ok: false, reason: 'burn of an unexpected amount or mint' });
    expect(checkCloseTx(build([burn(37n, Keypair.generate().publicKey.toBase58()), close()]), OWNER, MINT, [dusty])).toMatchObject({ ok: false });
    expect(checkCloseTx(build([burn(5n), close()]), OWNER, MINT, [acc])).toMatchObject({ ok: false }); // nothing to burn, but there is an instruction
    const transfer = Buffer.alloc(9); transfer[0] = 3; transfer.writeBigUInt64LE(1n, 1);
    expect(checkCloseTx(build([ix(TOKEN, transfer, [k(ACC), k(THIEF), k(OWNER, true)]), close()]), OWNER, MINT, [acc])).toMatchObject({ ok: false, reason: 'token instruction 3 in close tx' });
    const sys = Buffer.alloc(12); sys.writeUInt32LE(2, 0); sys.writeBigUInt64LE(1_000_000n, 4);
    expect(checkCloseTx(build([ix('11111111111111111111111111111111', sys, [k(OWNER, true), k(THIEF)]), close()]), OWNER, MINT, [acc]).ok).toBe(false);
    expect(checkCloseTx(build([close()], new PublicKey(THIEF)), OWNER, MINT, [acc]).ok).toBe(false);             // the payer is not our wallet
    expect(checkCloseTx(build([burn(37n)]), OWNER, MINT, [dusty])).toMatchObject({ ok: false, reason: 'close tx does not close every listed account' });
  });
});

describe('#145: a Solana sale — the account is closed only after a full confirmed sale', () => {
  const SOL_USD = 150; const BAL = 123_000n; const OUT = 10_000_000n; // the sale gives 0.01 SOL = $1.50
  function trader(o: { close?: () => Promise<any>; send?: any } = {}) {
    const t = new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: {}, solRpc: { rpc: 'http://sol', send: [] }, nativeUsd: async () => SOL_USD, slippageBps: 500 });
    const sol: any = (t as any).sol; const calls: any[] = []; const order: string[] = [];
    sol.tokenBalance = async () => BAL; sol.verifySwap = async () => ({ ok: true }); sol.simulate = async () => ({ ok: true });
    sol.send = async () => { order.push('sell'); return o.send ?? { sig: 'SELLSIG', ok: true }; };
    sol.closeEmptyTokenAccounts = async (_kp: unknown, mint: string, opts: any) => { order.push('close'); calls.push({ mint, opts });
      return o.close ? o.close() : { closed: 1, burnedRaw: 0n, refundLamports: RENT - CLOSE_FEE_LAMPORTS, sig: 'CLOSESIG', note: 'token account closed, rent +0.002034 SOL' }; };
    (t as any).jup = { build: async (q: any) => ({ tx: {}, inAmount: q.amount, outAmount: OUT, minOut: 9_000_000n }) };
    return { t, calls, order };
  }
  const sell = (t: LiveTrader, share: number, mode: 'live' | 'shadow' = 'live') => t.sellToken({ chain: 'solana', token: MINT, share, amountRaw: BAL }, mode);

  it('a full sale → the account is closed AFTER the sale, proceeds = swap + the returned deposit (cash matches the wallet)', async () => {
    const { t, calls, order } = trader();
    const r = await sell(t, 1);
    expect(order).toEqual(['sell', 'close']);
    expect(calls[0].mint).toBe(MINT);
    expect(r.ok).toBe(true); expect(r.tx).toBe('SELLSIG'); expect(r.soldRaw).toBe(BAL);
    expect(r.proceedsUsd).toBeCloseTo(1.5 + (Number(RENT - CLOSE_FEE_LAMPORTS) / 1e9) * SOL_USD, 9); // 1,50 + 0,3051
    expect(r.note).toBe('jupiter sell; token account closed, rent +0.002034 SOL');
    // the dust price — at the rate of the sale itself: 123 000 raw gave 10 000 000 lamports
    expect(calls[0].opts.dustLamports(123n)).toBe(10_000n);
  });

  it('a partial sale (a ladder step, a tail remains) → the account is not touched, proceeds — the swap only', async () => {
    const { t, calls } = trader();
    const r = await sell(t, 0.5);
    expect(calls.length).toBe(0);
    expect(r.ok).toBe(true); expect(r.proceedsUsd).toBeCloseTo(1.5, 9); expect(r.note).toBe('jupiter sell');
  });

  it('the sale was not confirmed ("in flight") or did not go through → no close', async () => {
    const pending = trader({ send: { sig: 'SELLSIG', ok: false, error: 'not confirmed in time (may still land — check wallet)' } });
    const r1 = await sell(pending.t, 1);
    expect(r1.ok).toBe(false); expect(r1.pending).toBe(true); expect(pending.calls.length).toBe(0);
    const failed = trader({ send: { sig: 'SELLSIG', ok: false, error: '{"InstructionError":[3,{"Custom":6001}]}' } });
    expect((await sell(failed.t, 1)).ok).toBe(false); expect(failed.calls.length).toBe(0);
  });

  it('the close failed or threw → the sale is still counted, proceeds without the deposit, the reason in note', async () => {
    const kept = trader({ close: async () => ({ closed: 0, burnedRaw: 0n, refundLamports: 0n, note: 'token account kept (500 raw left is not dust)' }) });
    const r1 = await sell(kept.t, 1);
    expect(r1.ok).toBe(true); expect(r1.proceedsUsd).toBeCloseTo(1.5, 9); expect(r1.note).toBe('jupiter sell; token account kept (500 raw left is not dust)');
    const boom = trader({ close: async () => { throw new Error('rpc down'); } });
    const r2 = await sell(boom.t, 1);
    expect(r2.ok).toBe(true); expect(r2.proceedsUsd).toBeCloseTo(1.5, 9); expect(r2.note).toMatch(/^jupiter sell; token account not closed: .*rpc down/);
  });

  it('shadow: nothing is sent or closed', async () => {
    const { t, calls, order } = trader();
    const r = await sell(t, 1, 'shadow');
    expect(r.ok).toBe(true); expect(order).toEqual([]); expect(calls.length).toBe(0);
  });
});

// End to end: a real LiveTrader (fake node and Jupiter) inside the executor — the deposit arrives in ledger cash together with the proceeds
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { RiskState } from '../src/risk/risk.js';
import { PaperExecutor } from '../src/exec/paper.js';
import type { Decision, RawMessage } from '../src/types.js';
import type { MarketClient } from '../src/checks/token.js';

describe('#145: the executor — after a full sale ledger cash gets both the proceeds and the deposit', () => {
  const SOL_USD = 150; const RAW = 2_000_000_000n; // 2000 tokens, 6 decimals
  const MSG: RawMessage = { id: 'm1', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-11-17T08:00:00.000Z', text: 'ape' };
  const buy = (): Decision => ({ action: 'buy_token', sizeUsd: 2, chain: 'solana', reasons: [], trust: { score: 10, tier: 'follow', basis: 'author', notes: [] }, estGasUsd: 0.02,
    intent: { kind: 'token_call', chain: 'solana', urls: [], summary: 's', stance: 'buy', confidence: 0.9, tokenAddress: MINT, ticker: 'TKN' },
    check: { ok: true, chain: 'solana', address: MINT, priceUsd: 0.001, reasons: [] },
    exitPlan: { stopPrice: 0.00065, tp1Price: 0.002, tp1Share: 0.5, trailingPct: 30, timeStopAtUtc: '2026-11-30T08:00:00.000Z' } } as any);

  function setup(sellOut: bigint) {
    const clock = new VirtualClock(Date.UTC(2026, 10, 17, 8));
    const risk = new RiskState(DEFAULT_RISK, clock); const sent: string[] = [];
    const paper = new PaperExecutor(DEFAULT_RISK, risk, new Store(':memory:'), { async send(t) { sent.push(t); } }, clock);
    paper.liveMode = 'live';
    const t = new LiveTrader({ wallets: new Wallets(newKeyMaterial(0)), chains: {}, solRpc: { rpc: 'http://sol', send: [] }, nativeUsd: async () => SOL_USD, slippageBps: 500 });
    const sol: any = (t as any).sol; const closes: string[] = [];
    let bal = 0n;
    sol.tokenBalance = async () => bal; sol.verifySwap = async () => ({ ok: true }); sol.simulate = async () => ({ ok: true });
    sol.spentLamportsInTx = async () => 13_333_333n + RENT + 105_000n; // $2 swap + the account deposit + fees
    (t as any).solDecimals = async () => 6;
    let side: 'buy' | 'sell' = 'buy';
    sol.send = async () => { if (side === 'buy') bal = RAW; else bal = 0n; return { sig: side === 'buy' ? 'BUYSIG' : 'SELLSIG', ok: true }; };
    sol.closeEmptyTokenAccounts = async (_k: unknown, mint: string) => { closes.push(mint); return { closed: 1, burnedRaw: 0n, refundLamports: RENT - CLOSE_FEE_LAMPORTS, sig: 'CLOSESIG', note: 'token account closed, rent +0.002034 SOL' }; };
    (t as any).jup = { build: async (q: any) => (q.outputMint === MINT ? { tx: {}, inAmount: q.amount, outAmount: RAW, minOut: RAW } : { tx: {}, inAmount: q.amount, outAmount: sellOut, minOut: sellOut }) };
    paper.trader = t as any;
    let px = 0.001;
    const market: MarketClient = { async market() { return { chain: 'solana', priceUsd: px }; }, async rug() { return undefined; } };
    return { clock, risk, paper, sent, closes, market, setPrice: (p: number) => { px = p; }, sell: () => { side = 'sell'; } };
  }

  it('the buy took the deposit from cash; a full stop sale returned it: cash = start − buy spend + swap + deposit', async () => {
    const e = setup(8_000_000n); // the sale gives 0.008 SOL = $1.20
    const cash0 = e.risk.cashUsd;
    await e.paper.execute(MSG, buy(), 1);
    const spent = (Number(13_333_333n + RENT + 105_000n) / 1e9) * SOL_USD; // $2.3216: the $0.3059 deposit is already inside
    expect(cash0 - e.risk.cashUsd).toBeCloseTo(spent, 6);
    e.sell(); e.setPrice(0.0005); e.clock.advance(60_000);
    await e.paper.monitor(e.market, { tokensOnly: true }); // stop → a full sale
    expect(e.paper.open.size).toBe(0);
    expect(e.closes).toEqual([MINT]);
    const refund = (Number(RENT - CLOSE_FEE_LAMPORTS) / 1e9) * SOL_USD; // $0,3051
    expect(e.risk.cashUsd).toBeCloseTo(cash0 - spent + 1.2 + refund, 6);
    expect(e.risk.todayPnl()).toBeCloseTo(1.2 + refund - spent, 6);       // the deposit is not lost in the trade result
  });
});
