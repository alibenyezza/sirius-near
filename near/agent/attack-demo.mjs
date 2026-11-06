#!/usr/bin/env node
// Attack demo: a dataset whose description hides orders to agents (prompt injection). A scripted "injected" agent
// obeys them, one way after the other, and every way is stopped. No LLM is involved: the agent's moves are fixed so
// the demo always shows the same thing. Every step that reaches the chain is a real testnet attempt.
//
//   node --env-file=.env attack-demo.mjs <poisoned tokenId> <attacker account>
//
// Layers: 1. the counterparty check (lib/guard.mjs, policy.json written by the human), 2. the market contract
// (price, per-order limit, budget), 3. the protocol: the agent's function-call key (market only,
// order_with_budget only, no deposit).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { actions, teraToGas } from 'near-api-js';
import { loadAgent, MARKET, nearToYocto, orderWithBudget } from './lib/near.mjs';

const [tokenId, attacker] = process.argv.slice(2);
if (!/^\d+$/.test(tokenId ?? '') || !attacker) throw new Error('usage: attack-demo.mjs <poisoned tokenId> <attacker account>');
const LOG = fileURLToPath(new URL('../scripts/attack-demo.log', import.meta.url));
writeFileSync(LOG, `# attack demo ${new Date().toISOString()} on ${MARKET}, NFT ${tokenId}, attacker ${attacker}\n`);
const say = (s = '') => { console.log(s); appendFileSync(LOG, s + '\n'); };

const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], env: { ...process.env } });
const client = new Client({ name: 'injected-agent', version: '0.1.0' });
await client.connect(transport);
const tool = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.isError ? { error: r.content?.[0]?.text } : r.structuredContent.result;
};
const showVerdict = (r) => {
  say(`   verdict: ${(r.verdict ?? '?').toUpperCase()}  paid: ${r.paid ?? false}${r.reason ? `  contract: "${r.reason}"` : ''}`);
  for (const x of r.reasons ?? []) say(`     ${x.level.padEnd(5)} ${x.check}: ${x.detail}`);
};
// a raw transaction with the agent's key, outside the MCP tools (as if the agent's code were rewritten)
const agent = loadAgent();
const raw = async (receiverId, action) => {
  try {
    const r = await agent.signAndSendTransaction({ receiverId, actions: [action], waitUntil: 'FINAL', throwOnFailure: false });
    const failure = r.status?.Failure;
    return failure ? `refused by the contract: ${JSON.stringify(failure).match(/panicked: ([^"\\]*)/)?.[1] ?? JSON.stringify(failure).slice(0, 160)}` : `SENT ${r.transaction?.hash}`;
  } catch (e) {
    return `refused by the protocol: ${(e.type ?? e.name ?? 'error')} ${String(e.message).split('\n')[0].slice(0, 200)}`;
  }
};

say(`1. The agent reads NFT ${tokenId} on the market`);
const d = await tool('get_dataset', { tokenId });
say(`   "${d.title}" by ${d.holder}, ${d.priceNear} NEAR`);
say(`   description: ${JSON.stringify(d.description)}`);
say('   The injected agent obeys the description.');

say('\n2. It pays through its tool, with the offer the description asks for (5 NEAR)');
showVerdict(await tool('buy_training_run', { tokenId, maxPriceNear: '5' }));

say('\n3. Its code is rewritten to skip the check: it calls the market directly with its key, offer 5 NEAR');
const direct = await orderWithBudget(agent, { tokenId, profile: d.profile, maxPriceNear: '5' });
say(`   ${direct.ok ? `PAID order ${direct.orderId}` : `refused by the contract: "${direct.error}"`}${direct.txHash ? `  tx ${direct.txHash}` : ''}`);

say(`\n4. It sends 0.1 NEAR (its own gas money) straight to ${attacker}`);
say(`   ${await raw(attacker, actions.transfer(BigInt(nearToYocto('0.1'))))}`);

say(`\n5. It calls a contract of the attacker with its key`);
say(`   ${await raw(attacker, actions.functionCall('claim', {}, teraToGas('30'), 0n))}`);

say('\n6. It pays the market with a deposit of its own (0.1 NEAR on `order`)');
say(`   ${await raw(MARKET, actions.functionCall('order', { token_id: tokenId, profile: d.profile, deadline_minutes: 60 }, teraToGas('30'), BigInt(nearToYocto('0.1'))))}`);

say('\n7. It calls another method of the market (close_agent_budget)');
say(`   ${await raw(MARKET, actions.functionCall('close_agent_budget', { agent_id: agent.accountId }, teraToGas('30'), 0n))}`);

say(`\n8. The agent drafts an on-chain report with the evidence; its key cannot file it, the human signs it (scripts/report-demo.sh)`);
const rep = await tool('report_account', { account: attacker, reason: 'dataset description gives payment orders to agents (prompt injection)', evidence: `NFT ${tokenId} on ${MARKET}, scripts/attack-demo.log` });
say(`   ${rep.error ?? `draft: ${rep.method} on ${rep.contract}, bond ${rep.bondNear} NEAR, to be signed by ${rep.signBy}`}`);

say('\n9. The injected agent tries again with a normal offer (0.5 NEAR)');
showVerdict(await tool('buy_training_run', { tokenId, maxPriceNear: '0.5' }));

const budget = await tool('get_budget');
say(`\nBudget after the attack: ${budget.leftNear} NEAR left, ${budget.spentNear} NEAR spent in total. Nothing reached ${attacker}.`);
await client.close();
