// Reads the Sirius market on NEAR and signs as the agent with its function-call key.
//
// The agent's key is read from the near-cli legacy keychain file given in SIRIUS_AGENT_CREDENTIALS
// (~/.near-credentials/testnet/<account>/ed25519_<key>.json). It is never copied, logged or returned.
import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from 'near-api-js';

export const NETWORK = process.env.NEAR_NETWORK || 'testnet';
if (NETWORK !== 'testnet') throw new Error('Sirius on NEAR runs on testnet only for now');
export const RPC_URL = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
export const MARKET = process.env.SIRIUS_MARKET || 'sirius-ali-market.testnet';
export const EXPLORER = 'https://testnet.nearblocks.io/txns/';

export const provider = new JsonRpcProvider({ url: RPC_URL });

export async function view(method, args = {}, contractId = MARKET) {
  return provider.callFunction({ contractId, method, args });
}

export const yoctoToNear = (yocto) => {
  const s = BigInt(yocto).toString().padStart(25, '0');
  const whole = s.slice(0, -24);
  const frac = s.slice(-24).replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
};

export const nearToYocto = (near) => {
  const [whole, frac = ''] = String(near).split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > 24) throw new Error(`Invalid NEAR amount: ${near}`);
  return (BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, '0'))).toString();
};

/** A dataset as an agent sees it: NFT, holder, price, vault and privacy audit. */
export async function getDataset(tokenId) {
  const [token, dataset] = await Promise.all([view('nft_token', { token_id: tokenId }), view('get_dataset', { token_id: tokenId })]);
  if (!token || !dataset) return null;
  return {
    tokenId,
    title: token.metadata?.title,
    description: token.metadata?.description,
    holder: token.owner_id,
    profile: dataset.profile,
    priceNear: yoctoToNear(dataset.price),
    priceYocto: dataset.price,
    vault: dataset.vault,
    earnedNear: yoctoToNear(dataset.earned),
    privacyAudit: dataset.privacy_audit,
  };
}

export async function listDatasets(limit = 50) {
  const tokens = await view('nft_tokens', { from_index: '0', limit });
  return (await Promise.all(tokens.map((t) => getDataset(t.token_id)))).filter(Boolean);
}

/** Every order of the market, read one by one (the contract has no list view); stops after 3 missing ids. */
export async function allOrders() {
  const out = [];
  for (let id = 1, misses = 0; misses < 3; id++) {
    const order = await view('get_order', { order_id: String(id) });
    if (!order) { misses++; continue; }
    misses = 0;
    out.push({ id: String(id), ...order });
  }
  return out;
}

export function loadAgent() {
  const accountId = process.env.SIRIUS_AGENT_ACCOUNT;
  const file = process.env.SIRIUS_AGENT_CREDENTIALS;
  if (!accountId || !file) throw new Error('Set SIRIUS_AGENT_ACCOUNT and SIRIUS_AGENT_CREDENTIALS (near-cli keychain file of the function-call key)');
  const { private_key: key } = JSON.parse(readFileSync(file, 'utf8'));
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(key));
}

/**
 * Pays a training run from the agent's budget. The function-call key can only call `order_with_budget` on the
 * market and cannot attach a deposit; the contract checks the price against `maxPriceNear`, the per-order limit and
 * what is left of the budget.
 */
export async function orderWithBudget(agent, { tokenId, profile, maxPriceNear, deadlineMinutes = 60 }) {
  const result = await agent.signAndSendTransaction({
    receiverId: MARKET,
    actions: [actions.functionCall('order_with_budget', {
      token_id: tokenId,
      profile,
      deadline_minutes: deadlineMinutes,
      max_price: nearToYocto(maxPriceNear),
    }, teraToGas('30'), 0n)],
    waitUntil: 'FINAL',
    throwOnFailure: false,
  });
  const txHash = result.transaction?.hash ?? result.transaction_outcome?.id;
  const failure = result.status?.Failure;
  if (failure) {
    const panic = JSON.stringify(failure).match(/Smart contract panicked: ([^"\\]*)/)?.[1];
    return { ok: false, txHash, error: panic ?? JSON.stringify(failure).slice(0, 300) };
  }
  const value = result.status?.SuccessValue ? JSON.parse(Buffer.from(result.status.SuccessValue, 'base64').toString()) : null;
  return { ok: true, txHash, orderId: value };
}

/** Receipt of an order: what was bought, from whom, at what price, and what the runner delivered. */
export async function receipt(orderId, txHash) {
  const order = await view('get_order', { order_id: String(orderId) });
  if (!order) return null;
  const dataset = await getDataset(order.token_id);
  const delivered = typeof order.status === 'object' ? order.status.Delivered : null;
  return {
    orderId: String(orderId),
    buyer: order.buyer,
    dataset: { tokenId: order.token_id, title: dataset?.title, holderAtReceipt: dataset?.holder, vault: dataset?.vault },
    profile: order.profile,
    priceNear: yoctoToNear(order.amount),
    status: delivered ? 'Delivered' : order.status,
    deadline: new Date(Number(order.deadline_ms)).toISOString(),
    delivery: delivered ? { runner: delivered.runner, modelHash: delivered.model_hash, certificateHash: delivered.certificate_hash } : null,
    ...(txHash ? { paymentTx: txHash, explorer: EXPLORER + txHash } : {}),
  };
}
