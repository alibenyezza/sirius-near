#!/usr/bin/env node
// Creates an agent account whose only key is a function-call GAS KEY (NEP-611, nearcore 2.13): market only,
// `order_with_budget` only, with its own prepaid gas balance. The funder pays everything in one transaction, then
// gives the agent a budget in the market.
//
//   node gas-key-setup.mjs <new agent account> <funder account> <funder keychain file> <keychain dir for the new key>
//
// Why a gas key: a plain function-call key burns its gas allowance and, once it is spent, the agent is locked out
// (only a full-access key, which the agent must not have, could add a new one). A gas key holds a balance that anyone
// can top up from outside with `TransferToGasKey`, so the funder refills it without ever holding a key on the agent.
// It also has several nonce lanes, so the agent can send transactions in parallel.
//
// The new private key is written to the keychain file only; it is never printed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { MARKET, nearToYocto, provider } from './lib/near.mjs';

const [agentId, funderId, funderFile, keychainDir] = process.argv.slice(2);
if (!agentId || !funderId || !funderFile || !keychainDir) throw new Error('usage: gas-key-setup.mjs <agent> <funder> <funder keychain file> <keychain dir>');
if (!agentId.endsWith(`.${funderId}`)) throw new Error(`${agentId} must be a sub-account of ${funderId}`);

const ACCOUNT_BALANCE = process.env.AGENT_ACCOUNT_NEAR || '0.02'; // storage of the account and its key
const GAS_KEY_BALANCE = process.env.AGENT_GAS_NEAR || '0.2';      // prepaid gas, refillable
const BUDGET = process.env.AGENT_BUDGET_NEAR || '1';               // budget in the market
const MAX_PER_ORDER = process.env.AGENT_MAX_PER_ORDER_NEAR || '0.6';
const NONCE_LANES = Number(process.env.AGENT_NONCE_LANES || 4);

const { private_key: funderKey } = JSON.parse(readFileSync(funderFile, 'utf8'));
const funder = new Account(funderId, provider, KeyPairSigner.fromSecretKey(funderKey));

const key = KeyPair.fromRandom('ed25519');
const publicKey = key.getPublicKey();
mkdirSync(join(keychainDir, agentId), { recursive: true });
const keyFile = join(keychainDir, agentId, `${publicKey.toString().replace(':', '_')}.json`);
writeFileSync(keyFile, JSON.stringify({ account_id: agentId, public_key: publicKey.toString(), private_key: key.toString() }), { mode: 0o600 });
console.log(`gas key ${publicKey} written to ${keyFile}`);

const created = await funder.signAndSendTransaction({
  receiverId: agentId,
  actions: [
    actions.createAccount(),
    actions.transfer(BigInt(nearToYocto(ACCOUNT_BALANCE))),
    actions.addFunctionCallGasKey(publicKey, MARKET, ['order_with_budget'], NONCE_LANES),
    actions.transferToGasKey(publicKey, BigInt(nearToYocto(GAS_KEY_BALANCE))),
  ],
  waitUntil: 'FINAL',
});
console.log(`created ${agentId}: gas key with ${NONCE_LANES} nonce lanes and ${GAS_KEY_BALANCE} NEAR of gas, tx ${created.transaction.hash}`);

const funded = await funder.signAndSendTransaction({
  receiverId: MARKET,
  actions: [actions.functionCall('fund_agent', { agent_id: agentId, max_per_order: nearToYocto(MAX_PER_ORDER) }, 30_000_000_000_000n, BigInt(nearToYocto(BUDGET)))],
  waitUntil: 'FINAL',
});
console.log(`budget ${BUDGET} NEAR (max ${MAX_PER_ORDER} per order) in ${MARKET}, tx ${funded.transaction.hash}`);
console.log(`\nSet in .env:\n  SIRIUS_AGENT_ACCOUNT=${agentId}\n  SIRIUS_AGENT_CREDENTIALS=${keyFile}`);
