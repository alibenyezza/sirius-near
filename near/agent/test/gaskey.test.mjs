// The gas-key agent on testnet (made by gas-key-setup.mjs): its only key is a function-call gas key (NEP-611).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKET, provider } from '../lib/near.mjs';

const AGENT = 'gk-agent.sirius-ali-carol.testnet';

test('live: the gas-key agent holds one key, a function-call gas key for order_with_budget on the market', async () => {
  const { keys } = await provider.viewAccessKeyList({ accountId: AGENT });
  assert.equal(keys.length, 1);
  const p = keys[0].access_key.permission;
  assert.ok(p.GasKeyFunctionCall, `expected a GasKeyFunctionCall key, got ${JSON.stringify(p)}`);
  assert.equal(p.GasKeyFunctionCall.receiver_id, MARKET);
  assert.deepEqual(p.GasKeyFunctionCall.method_names, ['order_with_budget']);
  assert.equal(p.GasKeyFunctionCall.allowance, null);
  assert.ok(p.GasKeyFunctionCall.num_nonces >= 2, 'several nonce lanes');
  assert.ok(BigInt(p.GasKeyFunctionCall.balance) > 0n, 'the key holds prepaid gas');
  const { nonces } = await provider.viewGasKeyNonces({ accountId: AGENT, publicKey: keys[0].public_key });
  assert.equal(nonces.length, p.GasKeyFunctionCall.num_nonces);
});
