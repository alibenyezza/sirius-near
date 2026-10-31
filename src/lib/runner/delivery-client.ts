"use client";

import type {
  RunnerDeliveryEnvelope,
  RunnerReleaseEnvelope,
  RunnerReleaseKind,
} from "@/lib/tee/contract";

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Fa-f0-9]{2})+$/.test(value)) throw new Error("Préimage EVM invalide");
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function concat(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

async function decryptEnvelope(
  privateKey: CryptoKey,
  envelope: RunnerDeliveryEnvelope,
  context: string,
  infoPrefix: string,
  releaseSecret?: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const runnerPublicKey = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(envelope.ephemeralPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: runnerPublicKey },
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  const salt = decodeBase64Url(envelope.salt);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: releaseSecret ? concat(salt, releaseSecret) : salt,
      info: encoder.encode(`${infoPrefix}${context}`),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64Url(envelope.iv),
      additionalData: encoder.encode(context),
      tagLength: 128,
    },
    key,
    decodeBase64Url(envelope.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function createRunnerDelivery(context: string): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
  decrypt: (envelope: RunnerDeliveryEnvelope) => Promise<string>;
}> {
  const keypair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey)));

  return {
    publicKey,
    privateKey: keypair.privateKey,
    decrypt: async (envelope) => {
      if (envelope.version !== 1) throw new Error("Enveloppe de livraison incompatible");
      return decryptEnvelope(keypair.privateKey, envelope, context, "sirius-runner-delivery-v1:");
    },
  };
}

export async function decryptSavedRunnerDelivery(privateKey: CryptoKey, envelope: RunnerDeliveryEnvelope, context: string): Promise<string> {
  if (envelope.version !== 1) throw new Error("Enveloppe de livraison incompatible");
  return decryptEnvelope(privateKey, envelope, context, "sirius-runner-delivery-v1:");
}

export async function createRunnerReleaseDelivery(context: string): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
  decrypt: (envelope: RunnerReleaseEnvelope, fulfillmentHex: string) => Promise<string>;
}> {
  const keypair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey)));
  return {
    publicKey,
    privateKey: keypair.privateKey,
    decrypt: (envelope, fulfillmentHex) =>
      decryptRunnerRelease(keypair.privateKey, envelope, context, fulfillmentHex),
  };
}

/**
 * Le préfixe d'`info` HKDF lie la capsule au protocole de release EVM. Le champ
 * `release` ne porte aucune autorité cryptographique.
 */
const RELEASE_INFO_PREFIX: Record<RunnerReleaseKind, string> = {
  "evm-preimage": "sirius-runner-release-v2:",
};

const EVM_PREIMAGE_BYTES = 32;

/**
 * Ouvre une capsule avec le secret devenu public au règlement.
 *
 * @param secretHex Préimage EVM lu dans le contrat. Le préfixe `0x` est toléré.
 */
export async function decryptRunnerRelease(
  privateKey: CryptoKey,
  envelope: RunnerReleaseEnvelope,
  context: string,
  secretHex: string,
): Promise<string> {
  const prefix = RELEASE_INFO_PREFIX[envelope.release];
  if (envelope.version !== 1 || !prefix) {
    throw new Error("Capsule de release incompatible");
  }
  const secret = decodeHex(secretHex.replace(/^0x/i, ""));
  if (envelope.release === "evm-preimage" && secret.length !== EVM_PREIMAGE_BYTES) {
    throw new Error("Préimage de release invalide");
  }
  return decryptEnvelope(privateKey, envelope, context, prefix, secret);
}
