// Agent wallets (server only). Keys are created here and encrypted at once; only addresses go to the screen.
//   npm run wallets -- init 10     create the store: a treasury wallet + 10 burners (EVM and Solana)
//   npm run wallets -- add 5       add burners
//   npm run wallets -- list        addresses and balances
// Password: AGENT_KEYSTORE_PASS (from systemd-creds, see the live deployment guide).
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Wallets, keystorePassword, keystorePath, loadKeystore, newKeyMaterial, saveKeystore } from '../live/keystore.js';
import { chainConfigs, EvmSender } from '../live/evm.js';
import { SolSender } from '../live/jupiter.js';
import { generatePrivateKey } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const cfg = loadConfig();
const [cmd, arg] = process.argv.slice(2);
const pass = keystorePassword();
if (!pass) { console.log('No store password (AGENT_KEYSTORE_PASS). See the live deployment guide, step "Store password".'); process.exit(1); }
const path = keystorePath(cfg.dataDir);

if (cmd === 'init') {
  if (existsSync(path)) { console.log(`The store already exists: ${path}. Not creating a new one (otherwise the old keys would be lost).`); process.exit(1); }
  const n = Math.max(0, Math.min(50, Number(arg ?? 10)));
  saveKeystore(cfg.dataDir, newKeyMaterial(n), pass);
  console.log(`Created: ${path} (a treasury wallet + ${n} burners on each chain).`);
  print(new Wallets(loadKeystore(cfg.dataDir, pass)));
} else if (cmd === 'add') {
  const km = loadKeystore(cfg.dataDir, pass);
  const n = Math.max(1, Math.min(50, Number(arg ?? 1)));
  for (let i = 0; i < n; i++) { km.evm.burners.push(generatePrivateKey()); km.solana.burners.push(bs58.encode(Keypair.generate().secretKey)); }
  saveKeystore(cfg.dataDir, km, pass);
  console.log(`Added ${n}. Total burners: ${km.evm.burners.length}.`);
} else if (cmd === 'list') {
  const w = new Wallets(loadKeystore(cfg.dataDir, pass));
  print(w);
  const chains = chainConfigs(process.env, cfg.rpc);
  for (const [c, cc] of Object.entries(chains)) {
    if (!cc) continue;
    const bal = await new EvmSender(cc).balance(w.evmTreasury.address).catch(() => undefined);
    console.log(`  ${c}: ${bal === undefined ? 'RPC unavailable' : `${Number(bal) / 1e18} ${cc.native}`}`);
  }
  if (process.env.RPC_SOLANA) {
    const sol = await new SolSender(process.env.RPC_SOLANA, []).solBalance(w.solTreasury.publicKey.toBase58()).catch(() => undefined);
    console.log(`  solana: ${sol === undefined ? 'RPC unavailable' : `${Number(sol) / 1e9} SOL`}`);
  }
} else {
  console.log('Commands: init [N] · add [N] · list');
}

function print(w: Wallets) {
  const a = w.addresses();
  console.log(`EVM treasury (deposit ETH/BNB here): ${a.evm.treasury}`);
  console.log(`Solana treasury (deposit SOL here):  ${a.solana.treasury}`);
  console.log(`Burners: ${a.evm.burners.length} EVM, ${a.solana.burners.length} Solana (addresses: npm run wallets -- list)`);
}
