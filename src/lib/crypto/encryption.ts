import "server-only";
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync, timingSafeEqual } from "node:crypto";

/** Comparaison à temps constant de deux buffers (longueurs incluses → pas de fuite de timing). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const ALGO = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = Buffer.from("sirius-v1");

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** Clé AES-256 aléatoire (32 bytes) — master key de setup ou DEK de dataset. */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

// Master key amorçable : en dev elle vient de l'env ; en TEE (inc.3d) elle est dérivée
// DANS l'enclave (dstack getKey) et injectée ici via primeMasterKey → jamais côté host.
let primedMasterKey: Buffer | null = null;

/**
 * Scelle la master key active (appelé au boot en mode phala depuis l'enclave, cf tee/dstack).
 * Une fois amorcée, toute dérivation (modèle, condition escrow, HMAC, wrap DEK) en découle.
 */
export function primeMasterKey(key: Buffer): void {
  if (primedMasterKey) throw new Error("Master key déjà amorcée — ré-amorçage interdit");
  if (key.length !== KEY_LENGTH) throw new Error(`Master key invalide: ${key.length} != ${KEY_LENGTH}`);
  primedMasterKey = key;
}

/** Master key active : clé scellée enclave si amorcée, sinon SIRIUS_MASTER_KEY (dev). */
export function getMasterKey(): Buffer {
  if (primedMasterKey) return primedMasterKey;
  if (process.env.TEE_MODE === "phala") {
    throw new Error("Master key enclave non amorcée — initEnclave() doit précéder tout accès (inc.3d)");
  }
  const encoded = process.env.SIRIUS_MASTER_KEY;
  if (!encoded) throw new Error("SIRIUS_MASTER_KEY manquante (openssl rand -base64 32)");
  return decodeKey(encoded);
}

/** Dérive une clé par contexte (ex: `${loanId}:${borrower}`) via HKDF-SHA256 (RFC 5869). */
export function deriveKey(masterKey: Buffer, context: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, context, KEY_LENGTH));
}

export function encrypt(plaintext: Buffer, key: Buffer): EncryptedPayload {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH}, got ${key.length}`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decrypt(payload: EncryptedPayload, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH}, got ${key.length}`);
  }

  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  if (iv.length !== IV_LENGTH) throw new Error("Invalid IV length");
  if (tag.length !== TAG_LENGTH) throw new Error("Invalid auth tag length");

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Enveloppe (wrap) une clé au repos sous une KEK dérivée de la master key pour un
 * `context` donné (l'appelant construit le contexte, comme `deriveKey`). La clé
 * enveloppée est destructible unitairement → base du crypto-shredding (inc.3c).
 * En inc.3d, cette KEK master sera remplacée par un scellement enclave TEE.
 */
export function wrapKey(key: Buffer, context: string): string {
  return JSON.stringify(encrypt(key, deriveKey(getMasterKey(), context)));
}

/** Inverse de `wrapKey` : reconstitue la clé à partir de sa forme enveloppée. */
export function unwrapKey(wrapped: string, context: string): Buffer {
  return decrypt(JSON.parse(wrapped) as EncryptedPayload, deriveKey(getMasterKey(), context));
}

export function encodeKey(key: Buffer): string {
  return key.toString("base64");
}

export function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_LENGTH) throw new Error("Invalid encoded key");
  return key;
}
