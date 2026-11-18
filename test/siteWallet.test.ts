// E-06 (#16), part 2: the session wallet — connecting a burner wallet and signing a message for verification.
// The owner's decision 2026-11-17 16:34 UTC; the HQ boundary: only a message; transactions and token permission signatures — refused.
import { describe, it, expect } from 'vitest';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { Keypair } from '@solana/web3.js';
import { SiteWallet, evmSigner, solSigner } from '../src/exec/siteWallet.js';
import { checkBurnerMessage } from '../src/safety/firewall.js';
import { runSiteSession, refuseAction, sessionSummary, walletStep, type Observation, type PageWallet, type SiteDriver, type SiteElement } from '../src/exec/siteSession.js';

const account = privateKeyToAccount(generatePrivateKey()); // a test key, created on the fly
const kp = Keypair.generate();
const SITE = 'tinmoths.xyz';
const FRAME = 'https://tinmoths.xyz/apply';
const wallet = () => new SiteWallet(SITE, { evm: evmSigner(account), sol: solSigner(kp) });
const evm = (w: SiteWallet, method: string, params: unknown[] = [], frameUrl = FRAME) => w.request({ kind: 'evm', method, params, frameUrl });
const sol = (w: SiteWallet, method: string, params: unknown[] = [], frameUrl = FRAME) => w.request({ kind: 'sol', method, params, frameUrl });
const hex = (t: string) => `0x${Buffer.from(t, 'utf8').toString('hex')}`;
const VERIFY = 'Sign this message to verify your wallet for Tin Moths.\nNonce: 8231';

describe('E-06 part 2: which message an empty burner wallet may sign', () => {
  const ctx = { siteHost: SITE, self: account.address, chain: 'evm' as const };
  it('a readable verification text — yes, even without the site name; an OpenSea-style text — yes', () => {
    expect(checkBurnerMessage(VERIFY, ctx).allow).toBe(true);
    expect(checkBurnerMessage(hex(VERIFY), ctx).allow).toBe(true);
    expect(checkBurnerMessage('Welcome! Click to sign in and accept the Terms of Service.\n\nThis request will not trigger a blockchain transaction or cost any gas fees.\n\nNonce: 5f3a', ctx).allow).toBe(true);
  });
  it('a hash, binary data, an encoded block, empty and too long — no (blind signing)', () => {
    for (const m of [`0x${'ab'.repeat(32)}`, 'ab'.repeat(32), `0x${'ff'.repeat(40)}`, hex('\u0001\u0002binary'), 'QUJD'.repeat(40), '', '   ', 'a'.repeat(4001)])
      expect([m.slice(0, 20), checkBurnerMessage(m, ctx).allow]).toEqual([m.slice(0, 20), false]);
  });
  it('a text about permissions, transfers, delegation, withdrawal and keys — no', () => {
    for (const m of ['I approve spending of my USDC', 'Permit2 allowance for router', 'I authorize to spend my tokens', 'Transfer 5 ETH to 0xabc', 'Delegate my votes and assets', 'Withdraw all funds', 'Confirm seed phrase export', 'setApprovalForAll true'])
      expect([m, checkBurnerMessage(m, ctx).allow]).toEqual([m, false]);
  });
  it('JSON with an amount, a recipient or a token — no (this is an application or an order, not a login)', () => {
    expect(checkBurnerMessage(JSON.stringify({ action: 'send', amount: '5', recipient: '0xabc' }), ctx).allow).toBe(false);
    expect(checkBurnerMessage('{"type":"order","price":1}', ctx).allow).toBe(false);
    expect(checkBurnerMessage('{broken json', ctx).allow).toBe(false);
    expect(checkBurnerMessage(JSON.stringify({ statement: 'login', issuedAt: '2026-11-17' }), ctx).allow).toBe(true);
  });
  it('a standard login (Ethereum / Solana): own domain and own address — yes; a foreign domain, a foreign address, a foreign URI, a custom format — no', () => {
    const siwe = (domain: string, addr: string, uri = `https://${domain}`) => `${domain} wants you to sign in with your Ethereum account:\n${addr}\n\nSign in to Tin Moths\n\nURI: ${uri}\nVersion: 1\nChain ID: 8453\nNonce: abc12345\nIssued At: 2026-11-17T09:30:00Z`;
    expect(checkBurnerMessage(siwe('tinmoths.xyz', account.address), ctx)).toMatchObject({ allow: true });
    expect(checkBurnerMessage(siwe('tinmoths.xyz', account.address), { ...ctx, siteHost: 'app.tinmoths.xyz' }).allow).toBe(true);
    expect(checkBurnerMessage(siwe('opensea.io', account.address), ctx)).toMatchObject({ allow: false, reason: 'sign-in domain opensea.io ≠ site tinmoths.xyz' });
    expect(checkBurnerMessage(siwe('tinmoths.xyz', '0x1111111111111111111111111111111111111111'), ctx)).toMatchObject({ allow: false, reason: 'sign-in message for a different address' });
    expect(checkBurnerMessage(siwe('tinmoths.xyz', account.address, 'https://evil.example/login'), ctx).allow).toBe(false);
    expect(checkBurnerMessage(`tinmoths.xyz wants you to sign in — click ok`, ctx)).toMatchObject({ allow: false, reason: 'sign-in message in a non-standard format' });
    const me = kp.publicKey.toBase58();
    const siws = `tinmoths.xyz wants you to sign in with your Solana account:\n${me}\n\nNonce: 1`;
    expect(checkBurnerMessage(siws, { siteHost: SITE, self: me, chain: 'solana' }).allow).toBe(true);
    expect(checkBurnerMessage(siws, { siteHost: SITE, self: Keypair.generate().publicKey.toBase58(), chain: 'solana' }).allow).toBe(false);
  });
});

describe('E-06 part 2: the session wallet — EVM', () => {
  it('connecting returns the burner wallet address; no accounts before connecting', async () => {
    const w = wallet();
    expect(await evm(w, 'eth_accounts')).toEqual({ result: [] });
    expect(await evm(w, 'eth_requestAccounts')).toEqual({ result: [account.address] });
    expect(await evm(w, 'eth_accounts')).toEqual({ result: [account.address] });
    expect(w.isConnected).toBe(true); expect(w.blocked).toBeUndefined();
    expect(await evm(w, 'eth_chainId')).toEqual({ result: '0x1' });
    expect(await evm(w, 'wallet_switchEthereumChain', [{ chainId: '0x2105' }])).toEqual({ result: null });
    expect(await evm(w, 'eth_chainId')).toEqual({ result: '0x2105' });
    expect(await evm(w, 'eth_getBalance', [account.address, 'latest'])).toEqual({ result: '0x0' });
  });

  it('personal_sign: the signature is real (verifies against the address), any parameter order, the message text — in the journal', async () => {
    const w = wallet(); await evm(w, 'eth_requestAccounts');
    for (const params of [[hex(VERIFY), account.address], [account.address, hex(VERIFY)], [VERIFY, account.address]]) {
      const r = await evm(w, 'personal_sign', params) as { result: `0x${string}` };
      expect(await verifyMessage({ address: account.address, message: VERIFY, signature: r.result })).toBe(true);
    }
    expect(w.signed.map(e => [e.chain, e.method, e.message])).toEqual([['evm', 'personal_sign', VERIFY], ['evm', 'personal_sign', VERIFY], ['evm', 'personal_sign', VERIFY]]);
    expect(w.blocked).toBeUndefined();
  });

  it('a transaction, typed data (permit, order), eth_sign, batch calls — refused, no signature, the session is marked to stop', async () => {
    for (const [method, params] of [
      ['eth_sendTransaction', [{ from: account.address, to: '0x1111111111111111111111111111111111111111', value: '0x1' }]],
      ['eth_signTransaction', [{ to: '0x1111111111111111111111111111111111111111' }]],
      ['eth_signTypedData_v4', [account.address, JSON.stringify({ primaryType: 'Permit', domain: {}, message: { spender: '0x1', value: '1', deadline: '9' } })]],
      ['eth_signTypedData_v4', [account.address, JSON.stringify({ primaryType: 'Login', domain: {}, message: { text: 'hi' } })]], // any typed data — no
      ['eth_sign', [account.address, `0x${'ab'.repeat(32)}`]],
      ['wallet_sendCalls', [{ calls: [] }]],
    ] as const) {
      const w = wallet(); await evm(w, 'eth_requestAccounts');
      expect(await evm(w, method, [...params] as unknown[])).toEqual({ error: { code: 4001, message: 'User rejected the request.' } });
      expect(w.blocked).toMatch(new RegExp(`^the site asked the wallet for ${method} — transactions, typed-data signatures and blind signing are not allowed`));
      expect(w.signed).toEqual([]);
    }
  });

  it('personal_sign of a hash or a transfer text — a user refusal, the refusal text in the journal; the session does not stop by itself', async () => {
    const w = wallet(); await evm(w, 'eth_requestAccounts');
    expect(await evm(w, 'personal_sign', [`0x${'ab'.repeat(32)}`, account.address])).toEqual({ error: { code: 4001, message: 'User rejected the request.' } });
    expect(await evm(w, 'personal_sign', [hex('I approve transfer of all my tokens'), account.address])).toMatchObject({ error: { code: 4001 } });
    expect(w.signed).toEqual([]); expect(w.blocked).toBeUndefined();
    expect(w.events.filter(e => !e.allowed).map(e => e.reason)).toEqual(['message is binary, not text — blind signing is forbidden', 'message mentions approvals, transfers, delegation, withdrawals or keys']);
    expect(w.events.at(-1)!.message).toBe('I approve transfer of all my tokens');
  });

  it('a foreign frame (not the task site) gets neither the address nor a signature; a signature before connecting and for a foreign address — refused', async () => {
    const w = wallet();
    expect(await evm(w, 'eth_requestAccounts', [], 'https://ads.example/frame')).toEqual({ error: { code: 4100, message: 'unauthorized' } });
    expect(await evm(w, 'eth_requestAccounts', [], 'about:blank')).toMatchObject({ error: { code: 4100 } });
    expect(w.isConnected).toBe(false);
    expect(await evm(w, 'personal_sign', [hex(VERIFY), account.address])).toMatchObject({ error: { code: 4100 } }); // not connected
    await evm(w, 'eth_requestAccounts');
    expect(await evm(w, 'personal_sign', [hex(VERIFY), '0x1111111111111111111111111111111111111111'])).toMatchObject({ error: { code: 4100 } });
    expect(await evm(w, 'personal_sign', [hex(VERIFY), account.address], 'https://ads.example/frame')).toMatchObject({ error: { code: 4100 } });
    expect(w.signed).toEqual([]);
  });

  it('no more than three signatures per session; an unknown method — "not supported", without a stop; garbage does not crash the wallet', async () => {
    const w = wallet(); await evm(w, 'eth_requestAccounts');
    for (let i = 0; i < 3; i++) expect(await evm(w, 'personal_sign', [hex(`${VERIFY} ${i}`), account.address])).toHaveProperty('result');
    expect(await evm(w, 'personal_sign', [hex(`${VERIFY} 4`), account.address])).toMatchObject({ error: { code: 4001 } });
    expect(w.signed.length).toBe(3);
    expect(await evm(w, 'eth_call', [{}])).toMatchObject({ error: { code: 4200 } });
    expect(w.blocked).toBeUndefined();
    expect(await w.request({ kind: 'evm', method: 123 as any, params: [], frameUrl: FRAME })).toMatchObject({ error: { code: -32600 } });
    expect(await w.request(undefined as any)).toMatchObject({ error: { code: -32600 } });
  });
});

describe('E-06 part 2: the session wallet — Solana', () => {
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(kp.publicKey.toBytes())]), format: 'der', type: 'spki' });
  it('connect returns the address; signMessage — a real ed25519 signature of this key; the text in the journal', async () => {
    const w = wallet();
    expect(await sol(w, 'signMessage', [Array.from(Buffer.from(VERIFY))])).toMatchObject({ error: { code: 4100 } }); // before connecting
    expect(await sol(w, 'connect')).toEqual({ result: { publicKey: kp.publicKey.toBase58() } });
    const r = await sol(w, 'signMessage', [Array.from(Buffer.from(VERIFY))]) as { result: { signature: number[]; publicKey: string } };
    expect(r.result.signature.length).toBe(64);
    expect(edVerify(null, Buffer.from(VERIFY), pub, Buffer.from(r.result.signature))).toBe(true);
    expect(w.signed.map(e => [e.chain, e.message])).toEqual([['solana', VERIFY]]);
  });
  it('signTransaction, signAllTransactions, signAndSendTransaction — refused and stopped; a binary "message" (a transaction disguised as text) — refused', async () => {
    for (const m of ['signTransaction', 'signAllTransactions', 'signAndSendTransaction']) {
      const w = wallet(); await sol(w, 'connect');
      expect(await sol(w, m, [])).toMatchObject({ error: { code: 4001 } });
      expect(w.blocked).toBe(`the site asked the wallet for ${m} — transactions are not allowed in a site session (E-13)`);
    }
    const w = wallet(); await sol(w, 'connect');
    expect(await sol(w, 'signMessage', [[1, 0, 1, 3, 255, 254, 0, 0, 7]])).toMatchObject({ error: { code: 4001 } });
    expect(await sol(w, 'signMessage', ['text'])).toMatchObject({ error: { code: -32602 } });
    expect(w.signed).toEqual([]);
  });
});

// ── A session with a wallet: a fake site ──────────────────────────────────────────────────────────────────────────────────
const el = (id: string, kind: SiteElement['kind'], label: string, o: Partial<SiteElement> = {}): SiteElement => ({ id, kind, label, ...o });
/** A site: Connect Wallet → a picker (MetaMask / WalletConnect) → Sign message → "Wallet verified". onSign — what the site asks to sign. */
function walletSite(onSign: (w: PageWallet) => Promise<unknown>, extra: SiteElement[] = []) {
  const st = { stage: 0, w: undefined as PageWallet | undefined, clicks: [] as string[] };
  const driver: SiteDriver = {
    async open() {}, async close() {}, async fill() {},
    attachWallet(w) { st.w = w; },
    async observe(): Promise<Observation> {
      const url = FRAME;
      if (st.stage === 0) return { url, text: 'Join the whitelist', elements: [el('c', 'button', 'Connect Wallet'), ...extra] };
      if (st.stage === 1) return { url, text: 'Choose a wallet', elements: [el('wc', 'button', 'WalletConnect'), el('mm', 'button', 'MetaMask')] };
      if (st.stage === 2) return { url, text: 'Connected 0x…', elements: [el('s', 'button', 'Sign message'), ...extra] };
      return { url, text: st.stage === 3 ? 'Wallet verified. Thank you!' : 'Something went wrong', elements: [] };
    },
    async click(id) {
      st.clicks.push(id);
      if (id === 'c') st.stage = 1;
      else if (id === 'mm') { await st.w!.request({ kind: 'evm', method: 'eth_requestAccounts', params: [], frameUrl: FRAME }); st.stage = 2; }
      else if (id === 's') { const r = await onSign(st.w!) as { result?: unknown }; st.stage = r?.result ? 3 : 4; }
    },
  };
  return { driver, st };
}

describe('E-06 part 2: a session with a wallet', () => {
  it('connects the wallet (picks MetaMask, not WalletConnect), signs a message, the site confirms; the signature text — in the result and the journal', async () => {
    const w = wallet();
    const { driver, st } = walletSite(x => x.request({ kind: 'evm', method: 'personal_sign', params: [hex(VERIFY), account.address], frameUrl: FRAME }));
    const r = await runSiteSession({ url: FRAME, driver, values: {}, wallet: w });
    expect([r.status, r.reason]).toEqual(['done', undefined]);
    expect(st.clicks).toEqual(['c', 'mm', 's']);
    expect(r.wallet!.connected).toBe(true);
    expect(r.wallet!.events.filter(e => e.message).map(e => e.message)).toEqual([VERIFY]);
    const s = sessionSummary(r, FRAME);
    expect(s).toMatch(/Wallet: a burner wallet is connected to the site\./);
    expect(s).toMatch(/Signed a message \(evm\): .Sign this message to verify your wallet for Tin Moths\. Nonce: 8231./);
  });

  it('the site asks for a transaction instead of a message → the wallet refuses, the session stops with a reason; no signatures', async () => {
    const w = wallet();
    const { driver } = walletSite(x => x.request({ kind: 'evm', method: 'eth_sendTransaction', params: [{ to: '0x1111111111111111111111111111111111111111', value: '0xde0b6b3a7640000' }], frameUrl: FRAME }));
    const r = await runSiteSession({ url: FRAME, driver, values: {}, wallet: w });
    expect(r.status).toBe('stopped');
    expect(r.reason).toMatch(/^the site asked the wallet for eth_sendTransaction — transactions, typed-data signatures and blind signing are not allowed/);
    expect(w.signed).toEqual([]);
    expect(sessionSummary(r, FRAME)).toMatch(/Wallet refused the site: eth_sendTransaction/);
  });

  it('the site asks to sign a permit (typed data) → refused and stopped', async () => {
    const w = wallet();
    const { driver } = walletSite(x => x.request({ kind: 'evm', method: 'eth_signTypedData_v4', params: [account.address, '{"primaryType":"Permit"}'], frameUrl: FRAME }));
    const r = await runSiteSession({ url: FRAME, driver, values: {}, wallet: w });
    expect(r.status).toBe('stopped'); expect(r.reason).toMatch(/eth_signTypedData_v4/);
  });

  it('money buttons are not pressed even with a wallet: Claim, Mint, Approve, Deposit, Connect wallet to claim; WalletConnect and other wallets — neither', () => {
    const o = (label: string): Observation => ({ url: FRAME, text: '', elements: [el('b', 'button', label)] });
    for (const label of ['Claim', 'Mint now', 'Approve USDC', 'Deposit', 'Buy', 'Swap', 'Bridge', 'Stake', 'Connect wallet to claim', 'WalletConnect', 'Coinbase Wallet'])
      expect([label, !!refuseAction({ kind: 'click', el: 'b' }, o(label), SITE, {}, true)]).toEqual([label, true]);
    for (const label of ['Connect Wallet', 'Connect your wallet', 'MetaMask', 'Phantom', 'Browser Wallet', 'Sign message', 'Sign in with Ethereum', 'Verify wallet', 'Sign'])
      expect([label, refuseAction({ kind: 'click', el: 'b' }, o(label), SITE, {}, true)]).toEqual([label, undefined]);
    expect(walletStep('Sign up')).toBe(false);
  });

  it('without a wallet (part 1) and with a driver without attachWallet the behaviour is as before: "Connect Wallet" is not pressed', async () => {
    const { driver, st } = walletSite(async () => ({}));
    const r1 = await runSiteSession({ url: FRAME, driver, values: {} });
    expect(r1.status).toBe('stopped'); expect(r1.reason).toMatch(/"Connect Wallet" — needs a wallet, a signature or money \(E-13\)/); expect(st.clicks).toEqual([]);
    const plain = walletSite(async () => ({})); delete (plain.driver as any).attachWallet;
    const r2 = await runSiteSession({ url: FRAME, driver: plain.driver, values: {}, wallet: wallet() });
    expect(r2.status).toBe('stopped'); expect(plain.st.clicks).toEqual([]); expect(r2.wallet).toBeUndefined();
  });

  it('the site refused after the signature or showed nothing — no endless presses: each wallet button no more than twice', async () => {
    const w = wallet(); let n = 0;
    const driver: SiteDriver = { async open() {}, async close() {}, async fill() {}, attachWallet() {}, async click() { n++; },
      async observe() { return { url: FRAME, text: 'Join', elements: [el('c', 'button', 'Connect Wallet')] }; } };
    const r = await runSiteSession({ url: FRAME, driver, values: {}, wallet: w });
    expect(n).toBe(2); expect(r.status).toBe('stopped');
  });
});

import { burnerHasNoMoney } from '../src/exec/siteWallet.js';
describe('E-06 part 2: "a wallet without money" — a balance check before the session', () => {
  const node = (answers: Record<string, unknown>) => (async (url: any, init: any) => {
    const q = JSON.parse(init.body); const a = answers[`${url}|${q.method}`];
    if (a === 'http500') return { ok: false, status: 500, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => (a === undefined ? { error: { message: 'boom' } } : { result: a }) } as any;
  }) as unknown as typeof fetch;
  it('EVM: zero on all nodes — empty; even one wei on any — not empty', async () => {
    const empty = burnerHasNoMoney({ evmRpcs: ['a', 'b'], fetchImpl: node({ 'a|eth_getBalance': '0x0', 'b|eth_getBalance': '0x0' }) });
    expect(await empty('evm', account.address)).toBe(true);
    const funded = burnerHasNoMoney({ evmRpcs: ['a', 'b'], fetchImpl: node({ 'a|eth_getBalance': '0x0', 'b|eth_getBalance': '0x1' }) });
    expect(await funded('evm', account.address)).toBe(false);
  });
  it('Solana: 0 lamports — empty; more — not', async () => {
    expect(await burnerHasNoMoney({ evmRpcs: [], solRpc: 's', fetchImpl: node({ 's|getBalance': { value: 0 } }) })('sol', 'x')).toBe(true);
    expect(await burnerHasNoMoney({ evmRpcs: [], solRpc: 's', fetchImpl: node({ 's|getBalance': { value: 2039280 } }) })('sol', 'x')).toBe(false);
  });
  it('a node did not answer, answered with an error or garbage, no nodes — an exception (the wallet is not given), not "empty"', async () => {
    await expect(burnerHasNoMoney({ evmRpcs: ['a'], fetchImpl: node({}) })('evm', account.address)).rejects.toThrow(/eth_getBalance: boom/);
    await expect(burnerHasNoMoney({ evmRpcs: ['a'], fetchImpl: node({ 'a|eth_getBalance': 'http500' }) })('evm', account.address)).rejects.toThrow(/http 500/);
    await expect(burnerHasNoMoney({ evmRpcs: ['a'], fetchImpl: node({ 'a|eth_getBalance': 'zero' }) })('evm', account.address)).rejects.toThrow(/bad answer/);
    await expect(burnerHasNoMoney({ evmRpcs: [] })('evm', account.address)).rejects.toThrow(/no EVM node/);
    await expect(burnerHasNoMoney({ evmRpcs: ['a'] })('sol', 'x')).rejects.toThrow(/no Solana node/);
    await expect(burnerHasNoMoney({ evmRpcs: [], solRpc: 's', fetchImpl: node({ 's|getBalance': { value: '0' } }) })('sol', 'x')).rejects.toThrow(/bad answer/);
  });
});
