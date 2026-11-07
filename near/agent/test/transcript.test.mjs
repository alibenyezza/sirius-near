// The public audit transcripts: they recompute to their hash, and carry nothing of the data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSampleProof, hashFromTranscript, parseAudit, sampleCells } from '../lib/audit.mjs';
import { e2eeDecrypt, sha256 } from '../lib/nearai.mjs';

const CSV = readFileSync(new URL('../../examples/hospital-stays-fictional.csv', import.meta.url), 'utf8');
const load = (id) => JSON.parse(readFileSync(new URL(`../../audits/${id}.json`, import.meta.url), 'utf8'));

test('each published transcript recomputes to the audit hash it claims, offline', () => {
  for (const id of ['4', '6']) {
    const t = load(id);
    assert.equal(hashFromTranscript(t), t.hash, `NFT ${id}`);
    assert.equal(sha256(t.chat.requestBody), t.chat.requestHash);
    assert.equal(sha256(t.chat.responseBody), t.chat.responseHash);
  }
  // NFT 6 records the sealed file; the CSV that was audited is bound by its own hash
  const t6 = load('6');
  assert.equal(t6.plaintextHash, sha256(CSV));
  assert.equal(load('4').datasetHash, sha256(CSV));
});

test('a transcript changed after the audit no longer matches its hash', () => {
  const t = load('6');
  assert.notEqual(hashFromTranscript({ ...t, plaintextHash: sha256('another file') }), t.hash);
  assert.notEqual(hashFromTranscript({ ...t, chat: { ...t.chat, responseHash: sha256('another reply') } }), t.hash);
});

test('a transcript holds no value of the sample, and the model reply opens with its one-time key', () => {
  const [header, ...rows] = CSV.trim().split(/\r?\n/).slice(0, 21).map((l) => l.split(','));
  const personal = ['patient_name', 'email', 'phone', 'postcode'].map((c) => header.indexOf(c));
  for (const id of ['4', '6']) {
    const text = readFileSync(new URL(`../../audits/${id}.json`, import.meta.url), 'utf8');
    for (const r of rows) for (const i of personal) assert.ok(!text.includes(r[i]), `NFT ${id} transcript contains a sample value`);
    const t = JSON.parse(text);
    const message = JSON.parse(t.chat.responseBody).choices[0].message;
    const secret = Buffer.from(t.chat.oneTimeSecretHex, 'hex');
    assert.deepEqual(parseAudit(e2eeDecrypt(message.content, secret)).pii_columns, t.verdict.model.pii_columns);
    // everything the published one-time key opens, not only the verdict: no chain of thought, no sample value
    assert.equal(message.reasoning_content, undefined, `NFT ${id}: the reply carries no reasoning`);
    const opened = Object.values(message).filter((v) => typeof v === 'string' && /^[0-9a-f]+$/i.test(v) && v.length > 112).map((v) => e2eeDecrypt(v, secret)).join(' | ');
    assert.deepEqual(sampleCells(CSV).filter((c) => opened.includes(c)), [], `NFT ${id}: the opened reply quotes the sample`);
  }
});

test('the filter request is rebuilt from the CSV, so anyone can check which sample the filter saw', () => {
  for (const id of ['4', '6']) {
    const t = load(id);
    assert.equal(checkSampleProof({ ...t, sampleProof: null }, CSV, null).filter, true);
    assert.equal(checkSampleProof({ ...t, sampleProof: null }, CSV.replace('Jade', 'Jane'), null).filter, false);
    assert.ok(t.sampleProof?.sealedSecretsHex, `NFT ${id}: the model sample proof is sealed to the runner`);
  }
});
