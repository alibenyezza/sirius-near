#!/usr/bin/env node
// Runner bridge: finds the paid orders of the Sirius market on NEAR, trains the model, and delivers on-chain.
//
//   node runner-bridge.mjs --once            deliver every paid order once, then exit
//   node runner-bridge.mjs --order 7         deliver one order
//
// Modes (SIRIUS_RUNNER_MODE):
//   local  (default) SIMULATED TEE. Trains here, with the same least-squares method as the base project's runner,
//          and says so in the certificate (`tee: null`). Used by the testnet demo.
//   phala  the TDX runner of the base project (src/runner). Not wired to NEAR yet: the bridge refuses to run.
//
// The runner signs `deliver` with a function-call key (market only, `deliver` only), read from the near-cli keychain
// file in SIRIUS_RUNNER_CREDENTIALS. The model and its certificate are written to near/agent/out/ for the buyer.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, KeyPairSigner, actions, teraToGas } from 'near-api-js';
import { MARKET, EXPLORER, provider, view } from './lib/near.mjs';
import { sha256 } from './lib/nearai.mjs';
import { trainLinearRegression } from './lib/train.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', 'examples');
const OUT = join(HERE, 'out');
const MODE = process.env.SIRIUS_RUNNER_MODE || 'local';

/** Canonical JSON (sorted keys) so a hash can be recomputed by anyone from the published file. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The local copy of a dataset, found by the sha256 recorded in its NFT. */
export function findDataset(cidHash, dir = EXAMPLES) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.csv'))) {
    const csv = readFileSync(join(dir, name));
    if (sha256(csv) === cidHash) return { name, csv };
  }
  return null;
}

export function buildDelivery({ orderId, order, dataset, csv, runnerId, now = new Date() }) {
  if (order.profile !== 'linear_regression') throw new Error(`Profile ${order.profile} not supported by the local runner`);
  const model = trainLinearRegression(csv.toString('utf8'), { exclude: ['patient_name', 'email', 'phone', 'postcode'] });
  const modelHash = sha256(canonical(model));
  const certificate = {
    version: 'sirius-near-certificate-1',
    market: MARKET,
    orderId: String(orderId),
    tokenId: order.token_id,
    datasetCidHash: dataset.cid_hash,
    profile: order.profile,
    modelHash,
    metrics: model.metrics,
    runner: runnerId,
    mode: 'local-simulated',
    tee: null,
    note: 'Trained outside any enclave for the testnet demo. The TDX runner of the base project is not wired to NEAR yet.',
    trainedAt: now.toISOString(),
  };
  return { model, modelHash, certificate, certificateHash: sha256(canonical(certificate)) };
}

function loadRunner() {
  const id = process.env.SIRIUS_RUNNER_ACCOUNT || 'sirius-ali-runner.testnet';
  const file = process.env.SIRIUS_RUNNER_CREDENTIALS;
  if (!file) throw new Error('Set SIRIUS_RUNNER_CREDENTIALS (near-cli keychain file of the deliver-only key)');
  return new Account(id, provider, KeyPairSigner.fromSecretKey(JSON.parse(readFileSync(file, 'utf8')).private_key));
}

async function paidOrders() {
  const out = [];
  for (let id = 1, misses = 0; misses < 3; id++) {
    const order = await view('get_order', { order_id: String(id) });
    if (!order) { misses++; continue; }
    misses = 0;
    if (order.status === 'Paid' && Number(order.deadline_ms) > Date.now()) out.push([id, order]);
  }
  return out;
}

async function deliver(runner, orderId, order) {
  const dataset = await view('get_dataset', { token_id: order.token_id });
  const local = findDataset(dataset.cid_hash);
  if (!local) return console.log(`order ${orderId}: no local copy of dataset ${order.token_id}, skipped`);
  const d = buildDelivery({ orderId, order, dataset, csv: local.csv, runnerId: runner.accountId });
  const result = await runner.signAndSendTransaction({
    receiverId: MARKET,
    actions: [actions.functionCall('deliver', { order_id: String(orderId), model_hash: d.modelHash, certificate_hash: d.certificateHash }, teraToGas('30'), 0n)],
    waitUntil: 'FINAL',
    throwOnFailure: false,
  });
  const tx = result.transaction?.hash;
  if (result.status?.Failure) return console.log(`order ${orderId}: refused ${JSON.stringify(result.status.Failure).slice(0, 200)} (tx ${tx})`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `order-${orderId}.json`), JSON.stringify({ model: d.model, certificate: d.certificate, deliverTx: tx }, null, 2));
  console.log(`order ${orderId}: delivered, R²=${d.model.metrics.r2.toFixed(3)}, model ${d.modelHash.slice(0, 12)}…, tx ${EXPLORER}${tx}`);
}

async function main() {
  if (MODE !== 'local') throw new Error(`Runner mode "${MODE}" is not wired to NEAR yet; use SIRIUS_RUNNER_MODE=local (simulated TEE)`);
  const runner = loadRunner();
  const arg = process.argv.indexOf('--order');
  if (arg > 0) {
    const id = process.argv[arg + 1];
    const order = await view('get_order', { order_id: id });
    if (!order) throw new Error(`Order ${id} not found`);
    return deliver(runner, id, order);
  }
  const orders = await paidOrders();
  if (!orders.length) console.log('no paid order waiting for delivery');
  for (const [id, order] of orders) await deliver(runner, id, order);
}

if (process.argv[1]?.endsWith('runner-bridge.mjs')) await main();
