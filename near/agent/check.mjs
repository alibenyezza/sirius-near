#!/usr/bin/env node
// The counterparty check on one dataset NFT, read-only, no key: `node check.mjs 5`.
// Prints the verdict, every reason, the on-chain reports and the age and activity of the holder and publisher.
import { decide, gatherSignals, loadPolicy } from './lib/guard.mjs';

const tokenId = process.argv[2];
if (!/^\d+$/.test(tokenId ?? '')) {
  console.error('usage: node check.mjs <token id>');
  process.exit(2);
}
const signals = await gatherSignals(tokenId);
const { verdict, reasons } = decide(signals, loadPolicy());
console.log(`NFT ${tokenId}: ${verdict.toUpperCase()}`);
for (const r of reasons) console.log(`  ${r.level.padEnd(5)} ${r.check}: ${r.detail}`);
for (const [who, c] of Object.entries(signals.counterparties ?? {})) {
  const a = c.age.known ? `at least ${c.age.days} days old, ${c.age.transactions} transaction(s) from its oldest key` : 'age unknown';
  console.log(`  ${who}: ${a}, ${c.reports.length} on-chain report(s)`);
}
