import { describe, it, expect } from 'vitest';
import { checkRpcRequest, checkTransaction, checkSimulationDiff, SELECTORS, type FirewallContext } from '../src/safety/firewall.js';
import { diffFromLogs } from '../src/safety/simulate.js';

const SELF = '0x1111111111111111111111111111111111111111';
const TREAS = '0x2222222222222222222222222222222222222222';
const TARGET = '0xaaf5517aeda2edbd3c94bec84f553c7b19180954';
const TOKEN = '0x3333333333333333333333333333333333333333';
const ctx: FirewallContext = { self: SELF, treasury: TREAS, siteHost: 'app.swapnest.xyz', expectedTargets: [TARGET], expectedApprovals: { [TOKEN]: 1000n }, maxValueWei: 10n ** 16n };
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0');
const hex = (s: string) => '0x' + Buffer.from(s, 'utf8').toString('hex');

describe('signing firewall', () => {
  it('blocks eth_sign', () => { expect(checkRpcRequest('eth_sign', [SELF, '0x' + 'ab'.repeat(32)], ctx).allow).toBe(false); });
  it('allows SIWE for the same domain', () => {
    const msg = `app.swapnest.xyz wants you to sign in with your Ethereum account:\n${SELF}\n\nURI: https://app.swapnest.xyz\nNonce: 123`;
    expect(checkRpcRequest('personal_sign', [hex(msg), SELF], ctx).allow).toBe(true);
  });
  it('blocks SIWE for another domain (phishing)', () => {
    const msg = `swapnest-claim.xyz wants you to sign in with your Ethereum account:\n${SELF}`;
    expect(checkRpcRequest('personal_sign', [hex(msg), SELF], ctx).allow).toBe(false);
  });
  it('blocks personal_sign of a raw hash', () => { expect(checkRpcRequest('personal_sign', ['0x' + 'ab'.repeat(32), SELF], ctx).allow).toBe(false); });
  it('blocks Permit / Permit2 typed data', () => {
    for (const pt of ['Permit', 'PermitSingle', 'PermitBatch', 'PermitTransferFrom', 'OrderComponents'])
      expect(checkRpcRequest('eth_signTypedData_v4', [SELF, JSON.stringify({ primaryType: pt })], ctx).allow).toBe(false);
  });
  it('blocks EIP-7702', () => {
    expect(checkRpcRequest('wallet_signAuthorization', [{}], ctx).allow).toBe(false);
    expect(checkTransaction({ to: TARGET, data: '0x', type: 4 }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TARGET, data: '0x', authorizationList: [{}] }, ctx).allow).toBe(false);
  });
  it('blocks unlimited approve, allows exact approve to expected spender', () => {
    const max = SELECTORS.approve + pad(TARGET) + 'f'.repeat(64);
    expect(checkTransaction({ to: TOKEN, data: max }, ctx).allow).toBe(false);
    const exact = SELECTORS.approve + pad(TARGET) + pad('0x3e8');
    expect(checkTransaction({ to: TOKEN, data: exact }, ctx).allow).toBe(true);
    const tooMuch = SELECTORS.approve + pad(TARGET) + pad('0x3e9');
    expect(checkTransaction({ to: TOKEN, data: tooMuch }, ctx).allow).toBe(false);
    const otherSpender = SELECTORS.approve + pad('0x9999999999999999999999999999999999999999') + pad('0x1');
    expect(checkTransaction({ to: TOKEN, data: otherSpender }, ctx).allow).toBe(false);
  });
  it('blocks setApprovalForAll to unknown operator', () => {
    const d = SELECTORS.setApprovalForAll + pad('0x9999999999999999999999999999999999999999') + pad('0x1');
    expect(checkTransaction({ to: TOKEN, data: d }, ctx).allow).toBe(false);
  });
  it('blocks token transfer to a stranger, allows sweep to treasury', () => {
    expect(checkTransaction({ to: TOKEN, data: SELECTORS.transfer + pad('0x9999999999999999999999999999999999999999') + pad('0x1') }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TOKEN, data: SELECTORS.transfer + pad(TREAS) + pad('0x1') }, ctx).allow).toBe(true);
  });
  it('allows call on expected target, blocks unexpected contract and value above cap', () => {
    expect(checkTransaction({ to: TARGET, data: '0x3e1d7a52' + pad('0x0') }, ctx).allow).toBe(true);
    expect(checkTransaction({ to: '0x4444444444444444444444444444444444444444', data: '0x3e1d7a52' }, ctx).allow).toBe(false);
    expect(checkTransaction({ to: TARGET, data: '0x3e1d7a52', value: 10n ** 18n }, ctx).allow).toBe(false);
  });
});

describe('simulation diff', () => {
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const topic = (a: string) => '0x' + pad(a);
  it('mint that sends tokens to us passes', () => {
    const logs = [{ address: TOKEN, topics: [T, topic('0x0'), topic(SELF)], data: '0x' + pad('0x64') }];
    const diff = diffFromLogs(SELF, logs, 1000n);
    expect(checkSimulationDiff(diff, { maxNativeOutWei: 2000n, mustReceiveSomething: true }).allow).toBe(true);
  });
  it('drainer that pulls our token fails', () => {
    const logs = [{ address: TOKEN, topics: [T, topic(SELF), topic('0x9999999999999999999999999999999999999999')], data: '0x' + pad('0x64') }];
    expect(checkSimulationDiff(diffFromLogs(SELF, logs, 0n), { maxNativeOutWei: 0n, mustReceiveSomething: false }).allow).toBe(false);
  });
  it('native drain fails', () => {
    const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const logs = [{ address: NATIVE, topics: [T, topic(SELF), topic('0x9999999999999999999999999999999999999999')], data: '0x' + pad('0xde0b6b3a7640000') }];
    expect(checkSimulationDiff(diffFromLogs(SELF, logs, 0n), { maxNativeOutWei: 10n ** 15n, mustReceiveSomething: false }).allow).toBe(false);
  });
  it('nothing received fails when required', () => {
    expect(checkSimulationDiff(diffFromLogs(SELF, [], 10n), { maxNativeOutWei: 100n, mustReceiveSomething: true }).allow).toBe(false);
  });
});
