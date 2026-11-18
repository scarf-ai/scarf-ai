// Pre-start self-check: keys in place, the trust table reads, risk settings.
import { loadConfig } from '../config.js';
import { TrustTable, parseTrustCsv } from '../trust/trust.js';
import { readFileSync, existsSync } from 'node:fs';
import { loadGateConfig } from '../gate/triggers.js';
const cfg = loadConfig();
const ok = (b: unknown) => (b ? 'OK' : 'NO');
console.log(`Mode: ${cfg.mode}`);
console.log(`DISCORD_BOT_TOKEN: ${ok(cfg.discord.token)} · DISCORD_GUILD_ID: ${ok(cfg.discord.guildId)}`);
console.log(`TELEGRAM_BOT_TOKEN: ${ok(cfg.telegram.botToken)} · TELEGRAM_CHAT_ID: ${ok(cfg.telegram.chatId)}`);
console.log(`ANTHROPIC_API_KEY: ${ok(cfg.anthropic.apiKey)} · extraction model: ${cfg.anthropic.extractModel}`);
const { table, errors } = TrustTable.fromFile(cfg.trustCsvPath);
console.log(`Trust table: ${cfg.trustCsvPath}`);
console.log(errors.length ? `  errors: ${errors.join('; ')}` : '  no errors');
// All channels from the table: mode (opus / chat / ignore) and the score of an author without a score
const gate = loadGateConfig(cfg.intel.gatePath);
const channels = existsSync(cfg.trustCsvPath) ? parseTrustCsv(readFileSync(cfg.trustCsvPath, 'utf8')).rows.filter(r => r.level === 'channel') : [];
for (const r of channels) {
  const res = table.resolve(r.server, r.channel, '__nobody__');
  const model = table.channelMode(r.server, r.channel) === 'opus' ? (gate.channelModels[`${r.server}/${r.channel}`] ?? 'claude-opus-5-5').replace('claude-', '') : '';
  console.log(`  ${r.server} / #${r.channel}: mode ${table.channelMode(r.server, r.channel)}${model ? ` (${model})` : ''}, an author without a score gets ${res.score}`);
}
console.log(`Analyst: ${cfg.intel.enabled ? 'on' : 'off'} · limits per UTC day: Opus $${cfg.intel.opusDailyUsd}, Sonnet $${cfg.intel.sonnetDailyUsd}, gatekeeper $${cfg.intel.gateDailyUsd} · own finds: ${cfg.intel.ownPicks}`);
console.log(`OPENSEA_API_KEY: ${ok(cfg.intel.openseaApiKey)} · TWITTERAPI_IO_KEY: ${ok(cfg.intel.twitterApiKey)} · brief: ${ok(existsSync(cfg.intel.briefPath))}`);
console.log(`NFT mints: gas ${cfg.risk.mintCapExcludesGas ? 'is NOT included' : 'is included'} in the tier cap`);
console.log(`Capital: $${cfg.risk.initialCapitalUsd} · per action: 10 → ${cfg.risk.perActionShareByTier.follow * 100}%, 7–9 → ${cfg.risk.perActionShareByTier.fast * 100}%, 4–6 → ${cfg.risk.perActionShareByTier.full * 100}%`);
