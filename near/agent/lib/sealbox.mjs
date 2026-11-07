// The sealing itself, pure functions only (no disk): see seal.mjs for the format and the runner key file.
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 as sha256Bytes } from '@noble/hashes/sha256';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

export const MAGIC = Buffer.from('SRSEAL01');
const INFO = 'sirius-dataset-seal-v1';
const HEADER = MAGIC.length + 32 + 24;

/** Seals `plain` (Buffer or string) to the runner's X25519 public key (hex). */
export function seal(plain, runnerPubHex) {
  const ephemeral = x25519.utils.randomPrivateKey();
  const key = hkdf(sha256Bytes, x25519.getSharedSecret(ephemeral, Buffer.from(runnerPubHex, 'hex')), undefined, INFO, 32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(Buffer.from(plain));
  return Buffer.concat([MAGIC, x25519.getPublicKey(ephemeral), nonce, ct]);
}

export const isSealed = (buf) => buf.length > HEADER && buf.subarray(0, MAGIC.length).equals(MAGIC);

/** Opens a sealed file with the runner's X25519 secret (Uint8Array). Throws if the key or the bytes are wrong. */
export function open(sealed, runnerSecret) {
  if (!isSealed(sealed)) throw new Error('not a Sirius sealed file');
  const eph = sealed.subarray(MAGIC.length, MAGIC.length + 32);
  const nonce = sealed.subarray(MAGIC.length + 32, HEADER);
  const key = hkdf(sha256Bytes, x25519.getSharedSecret(runnerSecret, eph), undefined, INFO, 32);
  return Buffer.from(xchacha20poly1305(key, nonce).decrypt(sealed.subarray(HEADER)));
}

export function newKeyPair() {
  const secret = x25519.utils.randomPrivateKey();
  return { secret, publicKeyHex: Buffer.from(x25519.getPublicKey(secret)).toString('hex') };
}
