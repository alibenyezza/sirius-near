#!/usr/bin/env node
// For the human only: approve one purchase the guard warned about. Shows the verdict and asks for "yes" on the
// terminal; an agent has no terminal to answer from. The approval covers one order, on one NFT, up to one price.
//
//   node --env-file=.env approve.mjs <tokenId> <maxOfferNear>
import { createInterface } from 'node:readline/promises';
import { addApproval, decide, gatherSignals, loadBlocklist, loadPolicy } from './lib/guard.mjs';
import { nearToYocto } from './lib/near.mjs';

const [tokenId, maxOfferNear] = process.argv.slice(2);
if (!/^\d+$/.test(tokenId ?? '') || !maxOfferNear) throw new Error('usage: approve.mjs <tokenId> <maxOfferNear>');
if (!process.stdin.isTTY) throw new Error('approve.mjs needs a human at a terminal');
const { verdict, reasons } = decide(await gatherSignals(tokenId), loadPolicy(), loadBlocklist(), nearToYocto(maxOfferNear));
console.log(`NFT ${tokenId}, offer up to ${maxOfferNear} NEAR: ${verdict}`);
for (const r of reasons) console.log(`  ${r.level.padEnd(5)} ${r.check}: ${r.detail}`);
if (verdict === 'block') throw new Error('blocked: an approval cannot override a block, change the policy instead');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('Approve this one purchase? Type yes: ');
rl.close();
if (answer.trim() !== 'yes') { console.log('not approved'); process.exit(1); }
addApproval(tokenId, maxOfferNear, process.env.USER || process.env.USERNAME || 'human');
console.log('approved once');
