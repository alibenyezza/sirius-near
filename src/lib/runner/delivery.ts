import "server-only";
import { createCipheriv, createECDH, createHash, ECDH, hkdfSync, randomBytes } from "node:crypto";
import { AppError } from "@/lib/app-error";
import type {
  RunnerDeliveryEnvelope,
  RunnerReleaseEnvelope,
  RunnerReleaseKind,
} from "@/lib/tee/contract";
import { serializeRunnerReleaseEnvelope } from "./release-envelope";

const AUTH_TAG_BYTES = 16;
const DELIVERY_INFO_PREFIX = "sirius-runner-delivery-v1:";

/**
 * Une capsule est verrouillée par deux facteurs : la clé ECDH du navigateur, et le
 * préimage de 32 octets que la chaîne publiera au règlement. Le préfixe HKDF lie
 * explicitement cette capsule au protocole de release EVM.
 */
const RELEASE_INFO_PREFIX: Record<RunnerReleaseKind, string> = {
  "evm-preimage": "sirius-runner-release-v2:",
};

/** Le préimage EVM fait exactement 32 octets. */
const EVM_PREIMAGE_BYTES = 32;

function decodePublicKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(value)) throw new AppError("Clé de livraison invalide", 400);
  const key = Buffer.from(value, "base64url");
  if (key.length !== 65) throw new AppError("Clé de livraison invalide", 400);
  return key;
}

export function validateDeliveryPublicKey(value: string): void {
  try { ECDH.convertKey(decodePublicKey(value), "prime256v1", undefined, undefined, "uncompressed"); }
  catch { throw new AppError("Clé de livraison invalide", 400); }
}

export function encryptRunnerDelivery(
  plaintext: string,
  clientPublicKey: string,
  context: string,
): RunnerDeliveryEnvelope {
  try {
    const ephemeral = createECDH("prime256v1");
    ephemeral.generateKeys();
    const sharedSecret = ephemeral.computeSecret(decodePublicKey(clientPublicKey));
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = Buffer.from(
      hkdfSync("sha256", sharedSecret, salt, Buffer.from(`${DELIVERY_INFO_PREFIX}${context}`), 32),
    );
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return {
      version: 1,
      ephemeralPublicKey: ephemeral.getPublicKey(undefined, "uncompressed").toString("base64url"),
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("Clé de livraison invalide", 400);
  }
}

/**
 * Verrouille une capsule sous la clé ECDH du navigateur **et** le secret que la chaîne
 * publiera au règlement. Le borrower détient la capsule avant tout paiement, sans
 * pouvoir l'ouvrir : c'est le règlement lui-même qui livre le second facteur.
 *
 * @param secretHex Le préimage EVM de 32 octets, avec ou sans préfixe `0x`.
 * @param kind      Version du protocole de release.
 */
export function encryptRunnerRelease(
  plaintext: string,
  clientPublicKey: string,
  context: string,
  secretHex: string,
  kind: RunnerReleaseKind,
): RunnerReleaseEnvelope {
  // Le préfixe `0x` est toléré : c'est la forme que rendent `escrowLock` et viem.
  const normalized = secretHex.replace(/^0x/i, "");
  if (!/^(?:[A-Fa-f0-9]{2})+$/.test(normalized)) {
    throw new AppError("Secret de release invalide", 500);
  }
  const secret = Buffer.from(normalized, "hex");
  // La longueur fixe du préimage EVM ferme l'ambiguïté de concaténation `salt || secret` :
  // le sel faisant 16 octets et le secret 32, aucun autre découpage n'est possible.
  if (kind === "evm-preimage" && secret.length !== EVM_PREIMAGE_BYTES) {
    throw new AppError("Préimage de release invalide", 500);
  }
  try {
    const ephemeral = createECDH("prime256v1");
    ephemeral.generateKeys();
    const sharedSecret = ephemeral.computeSecret(decodePublicKey(clientPublicKey));
    const salt = randomBytes(16);
    const releaseSalt = Buffer.concat([salt, secret]);
    const iv = randomBytes(12);
    const key = Buffer.from(
      hkdfSync("sha256", sharedSecret, releaseSalt, Buffer.from(`${RELEASE_INFO_PREFIX[kind]}${context}`), 32),
    );
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return {
      version: 1,
      release: kind,
      ephemeralPublicKey: ephemeral.getPublicKey(undefined, "uncompressed").toString("base64url"),
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("Clé de livraison invalide", 400);
  }
}

export function hashRunnerReleaseEnvelope(envelope: RunnerReleaseEnvelope): string {
  return createHash("sha256").update(serializeRunnerReleaseEnvelope(envelope)).digest("hex");
}

export function deferredLoanDeliveryCommitment(loanKey: string, modelCid: string, clientPublicKey: string): string {
  decodePublicKey(clientPublicKey);
  if (!/^0x[0-9a-f]{64}$/.test(loanKey) || !modelCid) throw new AppError("Accusé de capsule invalide", 400);
  return createHash("sha256").update(JSON.stringify(["sirius-v7-deferred-delivery", loanKey, modelCid, clientPublicKey])).digest("hex");
}
