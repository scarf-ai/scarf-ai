// Regression tests for the findings of the independent code review (2026-10-22).
import { describe, it, expect } from 'vitest';
import { checkRpcRequest, checkTransaction, checkSimulationDiff, SELECTORS, type FirewallContext } from '../src/safety/firewall.js';
import { diffFromLogs } from '../src/safety/simulate.js';
import { DEFAULT_RISK } from '../src/config.js';
import { VirtualClock } from '../src/clock.js';
import { Store } from '../src/store/db.js';
import { parseTrustCsv, TrustTable } from '../src/trust/trust.js';
import { RiskState } from '../src/risk/risk.js';
import { Blacklist, decide } from '../src/decide/decide.js';
import { PaperExecutor } from '../src/exec/paper.js';
import { BudgetMeter, serialHandler, type PipelineDeps } from '../src/pipeline.js';
import { validateIntents } from '../src/extract/extract.js';
import { prefilter } from '../src/extract/prefilter.js';
import { autoDowngrade } from '../src/jobs.js';
import type { MarketClient } from '../src/checks/token.js';
import type { Intent, RawMessage, TrustResult } from '../src/types.js';

const SELF = '0x1111111111111111111111111111111111111111';
const TREAS = '0x2222222222222222222222222222222222222222';
const TARGET = '0xaaf5517aeda2edbd3c94bec84f553c7b19180954';
const TOKEN = '0x3333333333333333333333333333333333333333';
const ATTACKER = '0x9999999999999999999999999999999999999999';
const ctx: FirewallContext = { self: SELF, treasury: TREAS, siteHost: 'app.swapnest.xyz', chainId: 1, expectedTargets: [TARGET], expectedApprovals: { [TOKEN]: 1000n }, maxValueWei: 10n ** 16n };
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0');
const hex = (s: string) => '0x' + Buffer.from(s, 'utf8').toString('hex');

describe('firewall regressions', () => {
  it('#1 known selectors on an unexpected address are blocked', () => {
    expect(checkTransaction({ to: ATTACKER, value: 10n ** 16n, data: SELECTORS.transferFrom + pad(ATTACKER) + pad(ATTACKER) + pad('0x1') }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: ATTACKER, data: SELECTORS.setApprovalForAll + pad(ATTACKER) + pad('0x0') }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: ATTACKER, data: SELECTORS.transfer + pad(TREAS) + pad('0x0') }, ctx).allow).toBe(false);
  });
  it('#1 value to a token contract is blocked', () => {
    expect(checkTransaction({ to: TOKEN, value: 1n, data: SELECTORS.approve + pad(TARGET) + pad('0x1') }, ctx).allow).toBe(false);
  });
  it('#2 ERC-1155 / 777 / transferAndCall to a stranger are blocked, even on the target', () => {
    expect(checkTransaction({ to: TARGET, data: SELECTORS.erc1155SafeTransferFrom + pad(SELF) + pad(ATTACKER) + pad('0x1') + pad('0x1') + pad('0xa0') + pad('0x0') }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TARGET, data: SELECTORS.erc1155SafeBatchTransferFrom + pad(SELF) + pad(ATTACKER) + pad('0xa0') + pad('0xc0') + pad('0xe0') }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TOKEN, data: SELECTORS.transferAndCall + pad(ATTACKER) + pad('0x1') + pad('0x60') + pad('0x0') }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TOKEN, data: SELECTORS.erc777Send + pad(ATTACKER) + pad('0x1') + pad('0x60') + pad('0x0') }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TOKEN, data: SELECTORS.approveAndCall + pad(TARGET) + pad('0x1') }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TOKEN, data: SELECTORS.increaseApproval + pad(ATTACKER) + pad('0x1') }, ctx).allow).toBe(false);
  });
  it('#2 ERC-1155 TransferSingle out of wallet fails simulation', () => {
    const TS = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
    const t = (a: string) => '0x' + pad(a);
    const diff = diffFromLogs(SELF, [{ address: TARGET, topics: [TS, t(ATTACKER), t(SELF), t(ATTACKER)], data: '0x' + pad('0x1') + pad('0x1') }], 0n);
    expect(checkSimulationDiff(diff, { maxNativeOutWei: 0n, mustReceiveSomething: false }).allow).toBe(false);
  });
  it('#7 input field cannot smuggle calldata', () => {
    expect(checkTransaction({ to: TOKEN, data: '0x', input: SELECTORS.approve + pad(ATTACKER) + 'f'.repeat(64) }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TOKEN, input: SELECTORS.approve + pad(ATTACKER) + 'f'.repeat(64) }, ctx).allow).toBe(false);
  });
  it('#8 plain login for another site and malformed SIWE are blocked', () => {
    expect(checkRpcRequest('personal_sign', [hex('Welcome to OpenSea! Click to sign in'), SELF], ctx).allow).toBe(false);
    expect(checkRpcRequest('personal_sign', [hex(`app.swapnest.xyz  wants you to sign in with your Ethereum account:\n${SELF}\n`), SELF], ctx).allow).toBe(false);
    expect(checkRpcRequest('personal_sign', [hex('Welcome to Swapnest! Sign in to swapnest.xyz. Nonce 42'), SELF], ctx).allow).toBe(true);
  });
  it('#9 SIWE with bare TLD as domain is blocked', () => {
    const c2 = { ...ctx, siteHost: 'evil.xyz' };
    expect(checkRpcRequest('personal_sign', [hex(`xyz wants you to sign in with your Ethereum account:\n${SELF}\n`), SELF], c2).allow).toBe(false);
  });
  it('#10 chain switching only to the expected chain; adding chains forbidden', () => {
    expect(checkRpcRequest('wallet_switchEthereumChain', [{ chainId: '0x89' }], ctx).allow).toBe(false);
    expect(checkRpcRequest('wallet_switchEthereumChain', [{ chainId: '0x1' }], ctx).allow).toBe(true);
    expect(checkRpcRequest('wallet_addEthereumChain', [{ chainId: '0x89' }], ctx).allow).toBe(false);
  });
  it('#11 eth_getEncryptionPublicKey is not read-only', () => { expect(checkRpcRequest('eth_getEncryptionPublicKey', [SELF], ctx).allow).toBe(false); });
  it('#12 short calldata and fractional value are denied, not thrown', () => {
    expect(checkTransaction({ to: TOKEN, data: SELECTORS.approve + pad(TARGET) + 'ff' }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TARGET, data: '0x', value: 1.5 as any }, ctx).allow).toBe(false);
  });
  it('#13 simulation approval to stranger blocked; allowlisted marketplace approval-for-all allowed', () => {
    const base = { native: 0n, erc20: {}, nftOut: {}, codeDelegated: false };
    expect(checkSimulationDiff({ ...base, newApprovals: [{ token: TOKEN, spender: ATTACKER, amount: 10n ** 29n }] }, { maxNativeOutWei: 0n, mustReceiveSomething: false }).allow).toBe(false);
    expect(checkSimulationDiff({ ...base, newApprovals: [{ token: TOKEN, spender: ATTACKER, amount: 'all' }] }, { maxNativeOutWei: 0n, mustReceiveSomething: false, approvalOperatorsAllowlist: [ATTACKER] }).allow).toBe(true);
  });
  it('#14 minReceive: dust of another token does not count', () => {
    const diff = { native: 0n, erc20: { ['0x4444444444444444444444444444444444444444']: 1n }, nftOut: {}, newApprovals: [], codeDelegated: false };
    expect(checkSimulationDiff(diff, { maxNativeOutWei: 0n, mustReceiveSomething: true, minReceive: { [TOKEN]: 100n } }).allow).toBe(false);
  });
});

describe('trust regressions', () => {
  it('#20 channel downgrade is applied before the > 6 threshold', () => {
    const t = new TrustTable(parseTrustCsv('level,server,channel,author,score\nchannel,ServerC,alpha,,8\n').rows);
    t.downgrade('channel:serverc|alpha', 3);
    expect(t.resolve('ServerC', 'alpha', 'nobody').score).toBe(0);
  });
  it('#21 semicolon CSV from Russian Excel with decimal comma', () => {
    const { rows, errors } = parseTrustCsv('level;server;channel;author;score;note\nchannel;ServerC;alpha;;6,5;calls\n');
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ server: 'serverc', channel: 'alpha', score: 7 });
  });
});

// ---------- decide / pipeline ----------
const MINT = '2qw313mavnLCGnz9L2GAsDvEvwJdWCuLyxv3vtM7pump';
function env(csv = 'level,server,channel,author,score\nchannel,P,calls,,8\nchannel,P,chat,,3\n') {
  const clock = new VirtualClock(Date.UTC(2026, 9, 22, 8));
  const store = new Store(':memory:');
  const trust = new TrustTable(parseTrustCsv(csv).rows);
  const risk = new RiskState(DEFAULT_RISK, clock);
  const market: MarketClient = {
    async market() { await new Promise(r => setTimeout(r, 5)); return { chain: 'solana', priceUsd: 0.001, liquidityUsd: 50_000, fdvUsd: 1e6, pairAgeMinutes: 60, buys24h: 500, sells24h: 400 }; },
    async rug() { return { risk: 'low', freezeOrMintAuthority: false, reasons: [] }; },
  };
  const sent: string[] = [];
  const paper = new PaperExecutor(DEFAULT_RISK, risk, store, { async send(t) { sent.push(t); } }, clock);
  const blacklist = new Blacklist();
  const dd = { cfg: DEFAULT_RISK, risk, market, clock, blacklist, ethUsd: () => 2500 };
  return { clock, store, trust, risk, market, paper, blacklist, dd, sent };
}
const tr = (score: number, tier: TrustResult['tier']): TrustResult => ({ score, tier, basis: 'author', notes: [] });
const intent = (o: Partial<Intent>): Intent => ({ kind: 'token_call', chain: 'solana', urls: [], summary: 's', stance: 'buy', confidence: 0.9, ...o });

describe('decide / pipeline regressions', () => {
  it('#3 mint is skipped during hard stop', async () => {
    const e = env(); e.risk.recordPnl(-6);
    const pre = prefilter('mint on https://basescan.org/address/0xAaF5517Aeda2edbD3c94BEC84F553c7b19180954');
    const d = await decide(intent({ kind: 'contract_call', chain: 'base', contractAddress: '0xAaF5517Aeda2edbD3c94BEC84F553c7b19180954' }), tr(8, 'fast'), pre, e.dd);
    expect(d.action).toBe('skip');
    expect(d.reasons.join(' ')).toMatch(/hard stop/);
  });
  it('#4 two simultaneous calls of the same token open one position', async () => {
    const e = env();
    const deps: PipelineDeps = { mode: 'paper', store: e.store, trust: e.trust, executor: e.paper, budget: new BudgetMeter(8, () => e.clock.utcDay()),
      extract: { callModel: async () => ({ intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }] }) },
      decide: e.dd };
    const h = serialHandler(deps);
    const m = (id: string): RawMessage => ({ id, sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '2026-10-22T08:00:00.000Z', text: `aping ${MINT}` });
    await Promise.all([h(m('a')), h(m('b'))]);
    expect(e.risk.positions.length).toBe(1);
  });
  it('#5 risk state and positions survive restart', async () => {
    const e = env();
    e.risk.onChange = (s) => e.store.saveRiskState(s, e.clock.iso());
    e.risk.recordPnl(-6); // hard stop
    const r2 = new RiskState(DEFAULT_RISK, e.clock); r2.restore(e.store.loadRiskState());
    expect(r2.hardStopped).toBe(true);
    expect(r2.equityUsd).toBeCloseTo(4, 5);
  });
  it('#6 auto-downgrade works with mixed-case names and does not repeat on old signals', () => {
    const e = env('level,server,channel,author,score\nauthor,ServerC,,Bob,9\n');
    for (let i = 0; i < 6; i++) {
      const id = Number(e.store.db.prepare(`INSERT INTO decisions(message_id, ts_utc, server, channel, author, kind, chain, token, action, size_usd, trust_score, tier, price_at_decision, reasons, intent, mode)
        VALUES (?,?,?,?,?,'token_call','solana',?, 'journal_only',0,9,'fast',1,'[]','{}','paper')`).run(String(i), '2026-10-21T10:00:00.000Z', 'ServerC', 'calls', 'Bob', 'tok' + i).lastInsertRowid);
      e.store.saveMarkout(id, '24h', 0.8, '2026-10-22T10:00:00.000Z');
    }
    const ch1 = autoDowngrade(e.store, e.trust, e.clock);
    expect(ch1.length).toBe(1);
    expect(e.trust.resolve('ServerC', 'calls', 'Bob').score).toBe(8);
    e.clock.advance(86400_000);
    expect(autoDowngrade(e.store, e.trust, e.clock).length).toBe(0);
  });
  it('#23 scam warning from score 0 does not blacklist; common domains never blacklisted', async () => {
    const e = env();
    const pre = prefilter('scam!! https://dexscreener.com/solana/xyz https://evil-claim.xyz');
    await decide(intent({ kind: 'warning' }), tr(0, 'journal'), pre, e.dd);
    expect(e.blacklist.entries()).toEqual([]);
    await decide(intent({ kind: 'warning' }), tr(8, 'fast'), pre, e.dd);
    expect(e.blacklist.entries()).toEqual(['evil-claim.xyz']);
  });
  it('#24 blacklist checks every link in the text, not only model urls', async () => {
    const e = env(); e.blacklist.add('evil-claim.xyz');
    const pre = prefilter(`buy ${MINT} https://evil-claim.xyz/claim`);
    const d = await decide(intent({ tokenAddress: MINT, urls: [] }), tr(10, 'follow'), pre, e.dd);
    expect(d.action).toBe('skip');
  });
  it('#25/#28 gas and chain come from the text, not the model', async () => {
    const e = env();
    const text = 'mint https://etherscan.io/address/0xAaF5517Aeda2edbD3c94BEC84F553c7b19180954 price 0.5 ETH';
    const pre = prefilter(text);
    const d = await decide(intent({ kind: 'contract_call', chain: 'robinhood', contractAddress: '0xAaF5517Aeda2edbD3c94BEC84F553c7b19180954', gasHintEth: { min: 0, max: 0 }, valueEth: 0 }), tr(10, 'follow'), pre, e.dd);
    expect(d.chain).toBe('ethereum');
    expect(d.action).toBe('skip'); // Ethereum gas for $10 + a price of 0.5 ETH
  });
  it('#26 low model confidence → journal only', async () => {
    const e = env();
    const d = await decide(intent({ tokenAddress: MINT, confidence: 0.2 }), tr(10, 'follow'), prefilter(`buy ${MINT}`), e.dd);
    expect(d.action).toBe('journal_only');
  });
  it('#27 partial or case-changed addresses from the model are dropped', () => {
    const msg: RawMessage = { id: '1', sourceServer: 'P', channel: 'c', author: 'a', tsUtc: '', text: `buy ${MINT} and 0xAaF5517Aeda2edbD3c94BEC84F553c7b19180954` };
    const pre = prefilter(msg.text);
    const r = validateIntents({ intents: [
      { kind: 'token_call', chain: 'solana', tokenAddress: MINT.toLowerCase(), urls: [], summary: 's', stance: 'buy', confidence: 0.9 },
      { kind: 'contract_call', chain: 'ethereum', contractAddress: '0xd651', urls: [], summary: 's', stance: 'neutral', confidence: 0.9 },
      { kind: 'contract_call', chain: 'ethereum', contractAddress: '0xAAF5517AEDA2EDBD3C94BEC84F553C7B19180954', urls: [], summary: 's', stance: 'neutral', confidence: 0.9 },
    ] }, msg, pre);
    expect(r.intents[0].tokenAddress).toBeUndefined();
    expect(r.intents[1].contractAddress).toBeUndefined();
    expect(r.intents[2].contractAddress).toBeDefined(); // EVM — case does not matter
  });
  it('#31 address only in the quoted message is not acted on', async () => {
    const e = env();
    const pre = prefilter(`lol no\n${MINT}`);
    const d = await decide(intent({ tokenAddress: MINT }), tr(10, 'follow'), pre, e.dd, { mainTextAddresses: new Set() });
    expect(d.action).toBe('journal_only');
  });
  it('#32 too long summary / too many intents are clamped, not rejected', () => {
    const msg: RawMessage = { id: '1', sourceServer: 'P', channel: 'c', author: 'a', tsUtc: '', text: `buy ${MINT}` };
    const many = Array.from({ length: 7 }, () => ({ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'x'.repeat(500), stance: 'buy', confidence: 0.9 }));
    const r = validateIntents({ intents: many }, msg, prefilter(msg.text));
    expect(r.intents.length).toBe(5);
  });
  it('#33 blocked execution updates the journal to skip', async () => {
    const e = env();
    e.risk.cashUsd = 0.1; // no money — assertWithinLimits will throw
    const deps: PipelineDeps = { mode: 'paper', store: e.store, trust: e.trust, executor: e.paper, budget: new BudgetMeter(8, () => e.clock.utcDay()),
      extract: { callModel: async () => ({ intents: [{ kind: 'token_call', chain: 'solana', tokenAddress: MINT, urls: [], summary: 'buy', stance: 'buy', confidence: 0.9 }] }) },
      decide: { ...e.dd } };
    // bypassing sizeAction: substituting cash after the decision via the monitor will not work — we check via a direct executor error
    const exec = { async execute() { throw new Error('risk: not enough cash'); } };
    const r = await serialHandler({ ...deps, executor: exec })({ id: 'z', sourceServer: 'P', channel: 'calls', author: 'x', tsUtc: '', text: `buy ${MINT}` });
    const row = e.store.db.prepare('SELECT action FROM decisions ORDER BY id DESC LIMIT 1').get() as any;
    expect(r.decisions[0].action).toBe('skip');
    expect(row.action).toBe('skip');
  });
});
