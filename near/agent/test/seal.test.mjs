// Offline tests: sealed datasets, the E2EE wire format, RTMR3 replay and the sealed runner path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { seal, open, isSealed, newKeyPair } from '../lib/seal.mjs';
import { e2eeEncrypt, e2eeDecrypt, e2eeClientKeys, replayRtmr3, sha256 } from '../lib/nearai.mjs';
import { findDataset } from '../runner-bridge.mjs';

const CSV = readFileSync(new URL('../../examples/hospital-stays-fictional.csv', import.meta.url));

test('a sealed dataset opens with the runner key and with no other key', () => {
  const runner = newKeyPair();
  const sealed = seal(CSV, runner.publicKeyHex);
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes(Buffer.from('patient_name')), 'no plaintext column name in the sealed bytes');
  assert.deepEqual(open(sealed, runner.secret), CSV);
  assert.throws(() => open(sealed, newKeyPair().secret));
});

test('sealing twice gives different bytes (fresh ephemeral key and nonce), so the hash is per sealed file', () => {
  const runner = newKeyPair();
  assert.notEqual(sha256(seal(CSV, runner.publicKeyHex)), sha256(seal(CSV, runner.publicKeyHex)));
});

test('a flipped byte in the ciphertext is rejected by the AEAD tag', () => {
  const runner = newKeyPair();
  const sealed = seal(CSV, runner.publicKeyHex);
  sealed[sealed.length - 5] ^= 1;
  assert.throws(() => open(sealed, runner.secret));
});

test('the runner finds a sealed dataset by the hash in its NFT and opens it in memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sirius-seal-'));
  const runner = newKeyPair();
  const sealed = seal(CSV, runner.publicKeyHex);
  writeFileSync(join(dir, 'd.csv.sealed'), sealed);
  const found = findDataset(sha256(sealed), dir, runner);
  assert.equal(found.sealed, true);
  assert.equal(found.sealKey, runner.publicKeyHex);
  assert.deepEqual(found.csv, CSV);
  assert.equal(findDataset(sha256(CSV), dir, runner), null, 'the plaintext hash does not match the sealed file');
});

test('E2EE v2: a message encrypted to a model Ed25519 key opens only with that key', () => {
  const modelSecret = ed25519.utils.randomPrivateKey();
  const modelPub = Buffer.from(ed25519.getPublicKey(modelSecret)).toString('hex');
  const wire = e2eeEncrypt('CSV sample: alice@example.com', modelPub);
  assert.match(wire, /^[0-9a-f]+$/);
  assert.equal(Buffer.from(wire, 'hex').length, 32 + 24 + 'CSV sample: alice@example.com'.length + 16);
  assert.equal(e2eeDecrypt(wire, edwardsToMontgomeryPriv(modelSecret)), 'CSV sample: alice@example.com');
  assert.throws(() => e2eeDecrypt(wire, e2eeClientKeys().x25519Secret));
});

test('RTMR3 replay: SHA-384 chain over imr-3 events, digests recomputed and checked', () => {
  const ev = { imr: 3, event_type: 134217729, event: 'compose-hash', event_payload: 'ab'.repeat(32) };
  const type = Buffer.alloc(4); type.writeUInt32LE(ev.event_type);
  const digest = createHash('sha384').update(Buffer.concat([type, Buffer.from(':compose-hash:'), Buffer.from(ev.event_payload, 'hex')])).digest();
  const expected = createHash('sha384').update(Buffer.concat([Buffer.alloc(48), digest])).digest('hex');
  assert.equal(replayRtmr3([{ imr: 0, event_type: 1, event: 'boot', event_payload: '' }, ev]), expected);
  assert.equal(replayRtmr3(JSON.stringify([ev])), expected, 'the gateway sends the log as a JSON string');
  assert.throws(() => replayRtmr3([{ ...ev, digest: '00'.repeat(48) }]), /digest mismatch/);
});
