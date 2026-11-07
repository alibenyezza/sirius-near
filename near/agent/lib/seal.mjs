// Datasets at rest: the provider seals the CSV to the runner's X25519 key, and the NFT records sha256(sealed file).
// Anyone can hold or mirror the sealed file; only the holder of the runner key can open it.
//
//   wire format  "SRSEAL01" (8) || ephemeral X25519 public key (32) || nonce (24) || XChaCha20-Poly1305 ciphertext+tag
//   key          HKDF-SHA256(X25519(ephemeral, runner), info "sirius-dataset-seal-v1"), 32 bytes
//
// SIMULATED TEE: on testnet the runner key is generated on the runner's machine, not inside an enclave. In a TEE
// runner the key would be generated in the enclave and bound to its quote, the way NEAR AI Cloud binds its E2EE key.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { newKeyPair } from './sealbox.mjs';

export { MAGIC, seal, isSealed, open, newKeyPair } from './sealbox.mjs';

/** The runner's key file: outside the repository, never printed. */
export const RUNNER_KEY_FILE = process.env.SIRIUS_RUNNER_SEAL_KEY || join(homedir(), '.sirius', 'runner-seal.json');

export function loadRunnerKey(file = RUNNER_KEY_FILE) {
  const { secret_hex, public_key } = JSON.parse(readFileSync(file, 'utf8'));
  return { secret: Uint8Array.from(Buffer.from(secret_hex, 'hex')), publicKeyHex: public_key };
}

/** Creates the runner key file if it does not exist yet; returns only the public key. */
export function ensureRunnerKey(file = RUNNER_KEY_FILE) {
  if (!existsSync(file)) {
    const kp = newKeyPair();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ secret_hex: Buffer.from(kp.secret).toString('hex'), public_key: kp.publicKeyHex }), { mode: 0o600 });
  }
  return loadRunnerKey(file).publicKeyHex;
}
