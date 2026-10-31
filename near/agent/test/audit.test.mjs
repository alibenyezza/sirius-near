import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditHash, parseAudit, runAudit, sampleOf } from '../lib/audit.mjs';
import { fetchAttestation, generateNonce, privateModels, verifyTee, DEFAULT_MODEL } from '../lib/nearai.mjs';

test('the sample keeps the header and the first rows only', () => {
  const csv = 'a,b\n1,2\n3,4\n5,6\n';
  assert.equal(sampleOf(csv, 2), 'a,b\n1,2\n3,4');
});

test('parses a fenced JSON answer and rejects anything else', () => {
  const audit = parseAudit('```json\n{"pii_columns":[{"column":"email","kind":"email","why":"addresses"}],"safe_columns":["age"],"verdict":"publishable_after_removing_pii","public_card":{"title":"t","summary":"s","columns":[]}}\n```');
  assert.equal(audit.pii_columns[0].column, 'email');
  assert.throws(() => parseAudit('I cannot do that'), /did not return JSON/);
  assert.throws(() => parseAudit('{"hello":1}'), /Unexpected audit shape/);
});

test('the audit hash changes with the nonce and the dataset', () => {
  const base = { datasetHash: 'a', attestation: { model: 'm', nonce: 'n1', reportHash: 'r' }, chat: null };
  assert.equal(auditHash(base), auditHash({ ...base }));
  assert.notEqual(auditHash(base), auditHash({ ...base, attestation: { ...base.attestation, nonce: 'n2' } }));
  assert.notEqual(auditHash(base), auditHash({ ...base, datasetHash: 'b' }));
});

test('without an API key nothing is sent and no audit is made up', async () => {
  const r = await runAudit({ csvText: 'a,b\n1,2\n', apiKey: '' });
  assert.equal(r.audit, null);
  assert.equal(r.chat, null);
  assert.equal(r.verified, false);
  assert.match(r.reason, /NEARAI_CLOUD_API_KEY not set/);
});

test('live: the default model is a private model served by NEAR AI Cloud', async () => {
  assert.ok((await privateModels()).includes(DEFAULT_MODEL));
});

test('live: a replayed report (other nonce) fails the binding checks', async () => {
  const nonce = generateNonce();
  const report = await fetchAttestation(DEFAULT_MODEL, nonce);
  const checks = await verifyTee(report.model_attestations[0], generateNonce(), 'model');
  const byName = Object.fromEntries(checks.map((c) => [c.name, c.pass]));
  assert.equal(byName['nonce echoed'], false);
  assert.equal(byName['signing key and nonce bound in TDX report data'], false);
  assert.equal(byName['Intel TDX quote signed by Intel, TCB up to date'], true);
});
