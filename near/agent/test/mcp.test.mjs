// MCP server against the live testnet contract (read-only tools) and with a stubbed agent for the paying tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../mcp-server.mjs';

async function connect(options) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

const result = (r) => r.structuredContent.result;

test('lists the NEAR tools with the base project names', async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['buy_training_run', 'get_budget', 'get_dataset', 'get_receipt', 'search_datasets', 'verify_private_ai']);
  const buy = (await client.listTools()).tools.find((t) => t.name === 'buy_training_run');
  assert.equal(buy.annotations.readOnlyHint, false);
});

test('search_datasets reads the dataset NFTs on testnet', async () => {
  const client = await connect();
  const list = result(await client.callTool({ name: 'search_datasets', arguments: { profile: 'linear_regression' } }));
  assert.ok(list.length >= 1);
  assert.match(list[0].vault, /^ds-\d+\.sirius-ali-market\.testnet$/);
});

test('get_dataset returns the holders in order', async () => {
  const client = await connect();
  const d = result(await client.callTool({ name: 'get_dataset', arguments: { tokenId: '3' } }));
  assert.equal(d.found, true);
  assert.deepEqual(d.holders.slice(0, 2), ['sirius-ali-alice.testnet', 'sirius-ali-bob.testnet']);
});

test('buy_training_run rejects malformed prices before signing', async () => {
  let signed = false;
  const client = await connect({ agentLoader: () => { signed = true; throw new Error('should not sign'); } });
  const r = await client.callTool({ name: 'buy_training_run', arguments: { tokenId: '3', maxPriceNear: 'all of it' } });
  assert.equal(r.isError, true);
  assert.equal(signed, false);
});
