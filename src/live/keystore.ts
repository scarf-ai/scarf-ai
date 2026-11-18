// The agent's keys — only on the server (the owner's rule). Created on the server, stored encrypted
// (scrypt + AES-256-GCM) in data/keystore.json. Password — from a systemd credential (only root can read
// the encrypted file; the service receives it at start) or from the AGENT_KEYSTORE_PASS variable for a manual run.
// Nothing but addresses goes out (to the journal, to Telegram, to the model).
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** Contents after decryption. treasury — the main wallet (the deposit arrives here), burners — single-use ones for mints/sites. */
export interface KeyMaterial { version: 1; evm: { treasury: `0x${string}`; burners: `0x${string}`[] }; solana: { treasury: string; burners: string[] } }

interface Envelope { version: 1; kdf: { n: number; r: number; p: number; salt: string }; iv: string; tag: string; data: string }

const KDF = { n: 1 << 17, r: 8, p: 1 };

export function encrypt(km: KeyMaterial, pass: string): Envelope {
  if (pass.length < 16) throw new Error('keystore password must be at least 16 characters');
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32, { N: KDF.n, r: KDF.r, p: KDF.p, maxmem: 512 * 1024 * 1024 });
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(km), 'utf8'), c.final()]);
  return { version: 1, kdf: { ...KDF, salt: salt.toString('hex') }, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('base64') };
}

export function decrypt(env: Envelope, pass: string): KeyMaterial {
  const key = scryptSync(pass, Buffer.from(env.kdf.salt, 'hex'), 32, { N: env.kdf.n, r: env.kdf.r, p: env.kdf.p, maxmem: 512 * 1024 * 1024 });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
  d.setAuthTag(Buffer.from(env.tag, 'hex'));
  try { return JSON.parse(Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8')); }
  catch { throw new Error('keystore: wrong password or damaged file'); }
}

export const keystorePath = (dataDir: string) => join(dataDir, 'keystore.json');

/** Password: systemd LoadCredentialEncrypted (file $CREDENTIALS_DIRECTORY/keystore-pass) or AGENT_KEYSTORE_PASS. */
export function keystorePassword(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.CREDENTIALS_DIRECTORY;
  const fromEnv = env.AGENT_KEYSTORE_PASS || undefined;
  // The password does not stay in the process environment: child processes (the browser etc.) will not inherit it
  delete env.AGENT_KEYSTORE_PASS;
  if (dir && existsSync(join(dir, 'keystore-pass'))) return readFileSync(join(dir, 'keystore-pass'), 'utf8').trim();
  return fromEnv;
}

export function newKeyMaterial(burners: number): KeyMaterial {
  return {
    version: 1,
    evm: { treasury: generatePrivateKey(), burners: Array.from({ length: burners }, () => generatePrivateKey()) },
    solana: { treasury: bs58.encode(Keypair.generate().secretKey), burners: Array.from({ length: burners }, () => bs58.encode(Keypair.generate().secretKey)) },
  };
}

export function saveKeystore(dataDir: string, km: KeyMaterial, pass: string) {
  const p = keystorePath(dataDir);
  writeFileSync(`${p}.tmp`, JSON.stringify(encrypt(km, pass)), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}
export function loadKeystore(dataDir: string, pass: string): KeyMaterial {
  return decrypt(JSON.parse(readFileSync(keystorePath(dataDir), 'utf8')), pass);
}

/** Wallets in memory: viem accounts and Solana Keypair. Private keys are never handed out. */
export class Wallets {
  readonly evmTreasury: PrivateKeyAccount;
  readonly evmBurners: PrivateKeyAccount[];
  readonly solTreasury: Keypair;
  readonly solBurners: Keypair[];
  constructor(km: KeyMaterial) {
    this.evmTreasury = privateKeyToAccount(km.evm.treasury);
    this.evmBurners = km.evm.burners.map(k => privateKeyToAccount(k));
    this.solTreasury = Keypair.fromSecretKey(bs58.decode(km.solana.treasury));
    this.solBurners = km.solana.burners.map(k => Keypair.fromSecretKey(bs58.decode(k)));
  }
  addresses() {
    return { evm: { treasury: this.evmTreasury.address, burners: this.evmBurners.map(a => a.address) },
      solana: { treasury: this.solTreasury.publicKey.toBase58(), burners: this.solBurners.map(k => k.publicKey.toBase58()) } };
  }
  /** Keys cannot be accidentally written to the journal: neither via JSON nor via console.log / util.inspect. */
  toJSON() { return this.addresses(); }
  [inspect.custom]() { return `Wallets ${JSON.stringify(this.addresses())}`; }
}
