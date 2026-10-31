#!/usr/bin/env node
// An agent that buys a training run through the Sirius MCP server, as any MCP client would:
//   1. search the dataset NFTs, 2. check the TEE proof of NEAR AI Cloud, 3. read its budget,
//   4. try to pay below the price (the contract refuses, nothing is spent), 5. pay at its planned price, 6. receipt.
//
//   node --env-file=.env agent-demo.mjs [tokenId] [plannedPriceNear]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const [tokenArg, planned = '0.6'] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))],
  env: { ...process.env },
});
const client = new Client({ name: 'sirius-demo-agent', version: '0.1.0' });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent.result;
};

const datasets = await call('search_datasets', { profile: 'linear_regression' });
const target = tokenArg ? datasets.find((d) => d.tokenId === tokenArg) : datasets.at(-1);
if (!target) throw new Error('no dataset to buy');
console.log(`1. found dataset ${target.tokenId} "${target.title}" held by ${target.holder}, price ${target.priceNear} NEAR, vault ${target.vault}`);

const proof = await call('verify_private_ai');
console.log(`2. NEAR AI Cloud ${proof.model}: ${proof.checks.filter((c) => c.pass).length}/${proof.checks.length} checks passed, verified=${proof.verified}`);

const budget = await call('get_budget');
console.log(`3. budget from ${budget.funder}: ${budget.leftNear} NEAR left, at most ${budget.maxPerOrderNear} per order`);

const lowball = (Number(target.priceNear) / 2).toString();
const refused = await call('buy_training_run', { tokenId: target.tokenId, maxPriceNear: lowball });
console.log(`4. offer ${lowball} NEAR: paid=${refused.paid}, reason "${refused.reason}"`);

if (Number(target.priceNear) > Number(planned)) {
  console.log(`5. price ${target.priceNear} above the planned ${planned} NEAR: the agent walks away`);
} else {
  const bought = await call('buy_training_run', { tokenId: target.tokenId, maxPriceNear: planned });
  console.log(`5. offer ${planned} NEAR: paid=${bought.paid}`);
  console.log('6. receipt', JSON.stringify(bought.receipt, null, 2));
  const after = await call('get_budget');
  console.log(`   budget left ${after.leftNear} NEAR, spent ${after.spentNear}`);
}
await client.close();
