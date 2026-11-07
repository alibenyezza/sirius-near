#!/usr/bin/env node
// Runner bridge: finds the paid orders of the Sirius market on NEAR, trains the model, and delivers on-chain.
//
//   node runner-bridge.mjs --once            deliver every paid order once, then exit
//   node runner-bridge.mjs --order 7         deliver one order
//
// SIMULATED TEE: the bridge trains here (least squares, lib/train.mjs) and says so in the certificate (`tee: null`).
//
// The runner signs `deliver` with a function-call key (market only, `deliver` only), read from the near-cli keychain
// file in SIRIUS_RUNNER_CREDENTIALS. The model and its certificate are written to near/agent/out/ for the buyer.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, KeyPairSigner, actions, teraToGas } from 'near-api-js';
import { MARKET, EXPLORER, provider, view } from './lib/near.mjs';
import { sha256 } from './lib/nearai.mjs';
import { trainLinearRegression } from './lib/train.mjs';
import { isSealed, open, loadRunnerKey } from './lib/seal.mjs';
import { checkSampleProof, hashFromTranscript } from './lib/audit.mjs';
import { AUDITS_DIR } from './lib/guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', 'examples');
const OUT = join(HERE, 'out');

/** Canonical JSON (sorted keys) so a hash can be recomputed by anyone from the published file. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The dataset whose sha256 is recorded in its NFT. A `.sealed` file is opened with the runner key (lib/seal.mjs) and
 * its plaintext only lives in memory for the training; a plain `.csv` is the older, unsealed demo dataset (NFT 4).
 */
export function findDataset(cidHash, dir = EXAMPLES, runnerKey = null) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.csv') || f.endsWith('.sealed'))) {
    const bytes = readFileSync(join(dir, name));
    if (sha256(bytes) !== cidHash) continue;
    if (!isSealed(bytes)) return { name, csv: bytes, sealed: false };
    const key = runnerKey ?? loadRunnerKey();
    return { name, csv: open(bytes, key.secret), sealed: true, sealKey: key.publicKeyHex };
  }
  return null;
}

export const DEFAULT_EXCLUDE = ['patient_name', 'email', 'phone', 'postcode'];

/**
 * Ties the file the runner opened to the privacy audit in the NFT, and returns what goes into the certificate:
 *  - the public transcript must recompute the audit hash recorded on-chain (an audit without one is refused);
 *  - the plaintext must be the CSV the TEEs audited (`plaintextHash`, or the dataset hash for a plain CSV);
 *  - with the runner key, the sample the model TEE and the filter received must be the sample of this very file
 *    (the sealed per-message secrets re-encrypt it byte for byte);
 *  - the columns either detector flagged are left out of training.
 * Throws when the file is not the audited one. Without any audit, the default personal columns are left out.
 */
export function auditBinding(dataset, csv, transcript, runnerSecret = null) {
  if (!dataset.privacy_audit) return { audited: false, excluded: DEFAULT_EXCLUDE };
  if (!transcript) throw new Error('an audit hash is recorded but no public transcript proves it: not training');
  const hash = hashFromTranscript(transcript);
  if (hash !== dataset.privacy_audit.report_hash) throw new Error('the audit transcript does not match the hash recorded in the NFT');
  if (sha256(csv) !== (transcript.plaintextHash ?? transcript.datasetHash)) throw new Error('this file is not the CSV the privacy audit saw: not training');
  if (transcript.verdict?.model?.verdict === 'not_publishable') throw new Error('the privacy audit says this dataset is not publishable: not training');
  let sample = null;
  if (transcript.sampleProof && runnerSecret) {
    sample = checkSampleProof(transcript, csv.toString('utf8'), runnerSecret);
    if (!sample.model || sample.filter === false) throw new Error('the sample the TEEs audited is not the sample of this file: not training');
  }
  const excluded = [...new Set([...(transcript.verdict?.model?.pii_columns ?? []).map((c) => c.column), ...(transcript.filter?.flags ?? []).map((f) => f.column)])];
  return { audited: true, transcript: true, auditHash: hash, plaintextIsTheAuditedFile: true, sampleIsFromThisFile: sample ? true : null, excluded };
}

export function buildDelivery({ orderId, order, dataset, csv, runnerId, sealed = false, sealKey = null, audit = { audited: false, excluded: DEFAULT_EXCLUDE }, now = new Date() }) {
  if (order.profile !== 'linear_regression') throw new Error(`Profile ${order.profile} not supported by the local runner`);
  const model = trainLinearRegression(csv.toString('utf8'), { exclude: audit.excluded ?? DEFAULT_EXCLUDE });
  const modelHash = sha256(canonical(model));
  const certificate = {
    version: 'sirius-near-certificate-1',
    market: MARKET,
    orderId: String(orderId),
    tokenId: order.token_id,
    datasetCidHash: dataset.cid_hash,
    datasetSealed: sealed,
    ...(sealed ? { sealKey, sealFormat: 'SRSEAL01 X25519-HKDF-SHA256-XChaCha20Poly1305' } : {}),
    privacyAudit: audit,
    profile: order.profile,
    modelHash,
    metrics: model.metrics,
    runner: runnerId,
    mode: 'local-simulated',
    tee: null,
    note: 'Trained outside any enclave for the testnet demo.',
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
  const tfile = join(AUDITS_DIR, `${order.token_id}.json`);
  let audit;
  try {
    let runnerSecret = null;
    try { runnerSecret = loadRunnerKey().secret; } catch { /* no seal key on this machine: the sample proof is skipped */ }
    audit = auditBinding(dataset, local.csv, existsSync(tfile) ? JSON.parse(readFileSync(tfile, 'utf8')) : null, runnerSecret);
  } catch (e) {
    return console.log(`order ${orderId}: ${e.message}; the buyer gets a refund after the deadline`);
  }
  const d = buildDelivery({ orderId, order, dataset, csv: local.csv, runnerId: runner.accountId, sealed: local.sealed, sealKey: local.sealKey, audit });
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
  console.log(`order ${orderId}: ${local.sealed ? 'sealed dataset opened in memory, ' : ''}delivered, R²=${d.model.metrics.r2.toFixed(3)}, model ${d.modelHash.slice(0, 12)}…, tx ${EXPLORER}${tx}`);
}

async function main() {
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
