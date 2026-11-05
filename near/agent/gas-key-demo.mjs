#!/usr/bin/env node
// Gas key demo on testnet: an agent whose only key is a function-call gas key (NEP-611).
//
//   node --env-file=.env gas-key-demo.mjs <funder keychain file> <attacker account>
//
// Uses SIRIUS_AGENT_ACCOUNT / SIRIUS_AGENT_CREDENTIALS (the account made by gas-key-setup.mjs) and its funder
// (the parent account). Shows: the key on chain, a paid order whose gas comes from the key's own balance (the
// account balance does not move), four transactions sent at once on four nonce lanes, the same protocol refusals as
// a plain function-call key, and the funder refilling the key from outside. Log: near/scripts/gas-key-demo.log.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Account, KeyPairSigner, PublicKey, actions, teraToGas } from 'near-api-js';
import { getDataset, loadAgent, MARKET, nearToYocto, orderWithBudget, provider, view, yoctoToNear } from './lib/near.mjs';
import { decide, gatherSignals, loadBlocklist, loadPolicy } from './lib/guard.mjs';

const [funderFile, attacker] = process.argv.slice(2);
if (!funderFile || !attacker) throw new Error('usage: gas-key-demo.mjs <funder keychain file> <attacker account>');
const LOG = fileURLToPath(new URL('../scripts/gas-key-demo.log', import.meta.url));
const say = (s = '') => { console.log(s); appendFileSync(LOG, s + '\n'); };

const agent = loadAgent();
const funderId = agent.accountId.split('.').slice(1).join('.');
const funder = new Account(funderId, provider, KeyPairSigner.fromSecretKey(JSON.parse(readFileSync(funderFile, 'utf8')).private_key));
const publicKey = (await agent.getSigner().getPublicKey()).toString();
writeFileSync(LOG, `# gas key demo ${new Date().toISOString()} on ${MARKET}, agent ${agent.accountId}, funder ${funderId}\n`);

const gasKey = async () => {
  const k = await provider.viewAccessKey({ accountId: agent.accountId, publicKey, finalityQuery: { finality: 'final' } });
  return k.permission.GasKeyFunctionCall;
};
const accountNear = async () => yoctoToNear((await provider.viewAccount({ accountId: agent.accountId, finalityQuery: { finality: 'final' } })).amount);
// The key prepays the gas attached to a transaction and gets back what was not burnt a few blocks later (the refund
// receipt), so balances are read once they stop moving.
const settled = async (read) => {
  let last = await read();
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await read();
    if (now === last) return now;
    last = now;
  }
  return last;
};
const keyBalance = () => settled(async () => (await gasKey()).balance);
const lanes = async () => (await provider.viewGasKeyNonces({ accountId: agent.accountId, publicKey, finalityQuery: { finality: 'final' } })).nonces.map(String);
const raw = async (receiverId, action) => {
  try {
    const r = await agent.signAndSendTransaction({ receiverId, actions: [action], waitUntil: 'FINAL', throwOnFailure: false });
    const failure = r.status?.Failure;
    return failure ? `refused by the contract: ${JSON.stringify(failure).match(/panicked: ([^"\\]*)/)?.[1] ?? JSON.stringify(failure).slice(0, 160)}` : `SENT ${r.transaction?.hash}`;
  } catch (e) {
    return `refused by the protocol: ${(e.type ?? e.name ?? 'error')} ${String(e.message).split('\n')[0].slice(0, 160)}`;
  }
};

say(`1. The agent's only key, read from the chain`);
const k0 = await gasKey();
say(`   ${publicKey}: GasKeyFunctionCall, receiver ${k0.receiver_id}, methods ${JSON.stringify(k0.method_names)}, allowance ${k0.allowance}, ${k0.num_nonces} nonce lanes`);
say(`   gas key balance ${yoctoToNear(k0.balance)} NEAR, account balance ${await accountNear()} NEAR`);

say(`\n2. It pays a training run on NFT 4 (offer 0.6 NEAR) after the counterparty check`);
const check = decide(await gatherSignals('4'), loadPolicy(), loadBlocklist(), nearToYocto('0.6'));
say(`   check: ${check.verdict.toUpperCase()}${check.reasons.length ? ` (${check.reasons.map((r) => r.check).join(', ')})` : ''}`);
const before = { key: await keyBalance(), account: await accountNear() };
const d = await getDataset('4');
const paid = await orderWithBudget(agent, { tokenId: '4', profile: d.profile, maxPriceNear: '0.6' });
say(`   ${paid.ok ? `PAID order ${paid.orderId}` : `refused: ${paid.error}`}  tx ${paid.txHash}`);
const after = await keyBalance();
say(`   gas key ${yoctoToNear(before.key)} -> ${yoctoToNear(after)} NEAR (gas burnt ${yoctoToNear(BigInt(before.key) - BigInt(after))} NEAR), account ${before.account} -> ${await accountNear()} NEAR (unchanged)`);

say(`\n3. Four transactions at once, one per nonce lane (offers of 0.1 NEAR, which the contract refuses)`);
const lanesBefore = await lanes();
const burst = await Promise.all([0, 1, 2, 3].map(() => orderWithBudget(agent, { tokenId: '4', profile: d.profile, maxPriceNear: '0.1' })));
for (const r of burst) say(`   ${r.ok ? `PAID ${r.orderId}` : `refused by the contract: "${r.error}"`}  tx ${r.txHash}`);
say(`   lanes before ${JSON.stringify(lanesBefore)}`);
say(`   lanes after  ${JSON.stringify(await lanes())}`);

say(`\n4. The same key tries what a hijacked agent would try`);
say(`   send 0.01 NEAR to ${attacker}: ${await raw(attacker, actions.transfer(BigInt(nearToYocto('0.01'))))}`);
say(`   call a contract of ${attacker}: ${await raw(attacker, actions.functionCall('claim', {}, teraToGas('30'), 0n))}`);
say(`   attach 0.01 NEAR to order on the market: ${await raw(MARKET, actions.functionCall('order', { token_id: '4', profile: d.profile, deadline_minutes: 60 }, teraToGas('30'), BigInt(nearToYocto('0.01'))))}`);
say(`   call close_agent_budget on the market: ${await raw(MARKET, actions.functionCall('close_agent_budget', { agent_id: agent.accountId }, teraToGas('30'), 0n))}`);
say(`   drain its own gas key: ${await raw(agent.accountId, actions.withdrawFromGasKey(PublicKey.fromString(publicKey), BigInt(nearToYocto('0.01'))))}`);

say(`\n5. ${funderId} refills the gas key from outside (TransferToGasKey), holding no key on the agent`);
const kBefore = await keyBalance();
const refill = await funder.signAndSendTransaction({ receiverId: agent.accountId, actions: [actions.transferToGasKey(PublicKey.fromString(publicKey), BigInt(nearToYocto('0.05')))], waitUntil: 'FINAL' });
say(`   gas key ${yoctoToNear(kBefore)} -> ${yoctoToNear(await keyBalance())} NEAR  tx ${refill.transaction.hash}`);

const b = await view('get_agent_budget', { agent_id: agent.accountId });
say(`\nBudget: ${yoctoToNear(b.balance)} NEAR left, ${yoctoToNear(b.spent)} NEAR spent. Order ${paid.orderId ?? '-'} goes to the vault of NFT 4 on delivery, or back to the budget after its deadline.`);
