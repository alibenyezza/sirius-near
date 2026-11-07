import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditBinding, buildDelivery, canonical, findDataset } from '../runner-bridge.mjs';
import { trainLinearRegression } from '../lib/train.mjs';
import { sha256 } from '../lib/nearai.mjs';

const csv = readFileSync(new URL('../../examples/hospital-stays-fictional.csv', import.meta.url));

test('the model never uses personal columns as features', () => {
  const m = trainLinearRegression(csv.toString(), { exclude: ['patient_name', 'email', 'phone', 'postcode'] });
  assert.deepEqual(m.features, ['age', 'bmi', 'smoker', 'prior_visits']);
  assert.equal(m.target, 'length_of_stay_days');
  assert.ok(m.metrics.r2 > 0.8, `R² ${m.metrics.r2}`);
});

test('recovers the generating coefficients of the fictional data', () => {
  const m = trainLinearRegression(csv.toString(), { exclude: ['patient_name', 'email', 'phone', 'postcode'] });
  const [, age, bmi, smoker, visits] = m.coefficients;
  assert.ok(Math.abs(age - 0.04) < 0.01 && Math.abs(bmi - 0.12) < 0.03 && Math.abs(smoker - 1.5) < 0.3 && Math.abs(visits - 0.3) < 0.05);
});

test('canonical JSON does not depend on key order', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test('finds the local dataset from the hash in the NFT', () => {
  assert.equal(findDataset(sha256(csv)).name, 'hospital-stays-fictional.csv');
  assert.equal(findDataset('0'.repeat(64)), null);
});

test('the certificate declares the simulated TEE and hashes the model', () => {
  const order = { token_id: '4', profile: 'linear_regression' };
  const d = buildDelivery({ orderId: 9, order, dataset: { cid_hash: sha256(csv) }, csv, runnerId: 'runner.testnet', now: new Date(0) });
  assert.equal(d.certificate.mode, 'local-simulated');
  assert.equal(d.certificate.tee, null);
  assert.equal(d.modelHash, sha256(canonical(d.model)));
  assert.equal(d.certificateHash, sha256(canonical(d.certificate)));
  assert.match(d.modelHash, /^[0-9a-f]{64}$/);
});

test('refuses profiles the local runner cannot train', () => {
  assert.throws(() => buildDelivery({ orderId: 1, order: { profile: 'logistic_regression' }, dataset: {}, csv, runnerId: 'r' }), /not supported/);
});

test('the runner trains only the file the privacy audit saw, as the public transcript proves', () => {
  const t = JSON.parse(readFileSync(new URL('../../audits/6.json', import.meta.url), 'utf8'));
  const nft6 = { cid_hash: t.datasetHash, privacy_audit: { report_hash: t.hash } };
  assert.deepEqual(auditBinding(nft6, csv, t), { audited: true, transcript: true, auditHash: t.hash, plaintextIsTheAuditedFile: true });
  assert.throws(() => auditBinding(nft6, Buffer.from(['patient_name,age', 'someone else,40', ''].join('\n')), t), /not the CSV the privacy audit saw/);
  assert.throws(() => auditBinding({ ...nft6, privacy_audit: { report_hash: 'ab' } }, csv, t), /does not match the hash recorded/);
  assert.deepEqual(auditBinding({ cid_hash: 'x' }, csv, null), { audited: false });
});
