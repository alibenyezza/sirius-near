#!/usr/bin/env node
// The counterparty check, read-only, no key.
//   node check.mjs 5                          one dataset NFT (the vault, holder, publisher, market, price, text)
//   node check.mjs sirius-ali-mallory.testnet any account an agent is about to pay or call
// Prints the verdict and every reason. `--agent <account>` sets who is about to pay (default: SIRIUS_AGENT_ACCOUNT,
// else the agent named in policy.json), for the prior-interactions signal.
import { decide, decideAccount, gatherAccountSignals, gatherSignals, loadPolicy } from './lib/guard.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--agent');
const agentArg = at >= 0 ? args.splice(at, 2)[1] : null;
const target = args[0];
if (!target || !/^(\d+|[a-z0-9._-]{2,64})$/.test(target)) {
  console.error('usage: node check.mjs <token id | account id> [--agent <account>]');
  process.exit(2);
}
const policy = loadPolicy();
const agent = agentArg ?? process.env.SIRIUS_AGENT_ACCOUNT ?? policy.agent;
const print = (title, { verdict, reasons }) => {
  console.log(`${title}: ${verdict.toUpperCase()}`);
  for (const r of reasons) console.log(`  ${r.level.padEnd(5)} ${r.check}: ${r.detail}`);
};
const ageLine = (a) => (a.known ? `at least ${a.days} days old, ${a.transactions} transaction(s) from its oldest key` : 'age unknown');

if (/^\d+$/.test(target)) {
  const signals = await gatherSignals(target, { agent });
  print(`NFT ${target} (agent ${agent})`, decide(signals, policy));
  for (const [who, c] of Object.entries(signals.counterparties ?? {})) console.log(`  ${who}: ${ageLine(c.age)}, ${c.reports.length} on-chain report(s)`);
} else {
  const s = await gatherAccountSignals(target, { agent });
  print(`${target} (agent ${agent})`, decideAccount(s, policy));
  if (s.exists) console.log(`  ${target}: ${s.code ? `contract, code ${s.code}` : 'no contract'}, ${s.keys.total} key(s) (${s.keys.fullAccess} full access), ${ageLine(s.age)}, ${s.reports.length} on-chain report(s)`);
}
