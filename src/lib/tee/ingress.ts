import "server-only";
import { createDecipheriv, createECDH, createHash, hkdfSync } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { deriveKey, getMasterKey } from "@/lib/crypto/encryption";
import {
  DATASET_INGRESS_INFO_PREFIX,
  MAX_DATASET_BYTES,
  type DatasetIngressEnvelope,
  type DatasetIngressKey,
} from "./contract";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const ONE = BigInt(1);
const AUTH_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = MAX_DATASET_BYTES + AUTH_TAG_BYTES;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function ingressEcdh() {
  const seed = deriveKey(getMasterKey(), "dataset-ingress:ecdh-p256:v1");
  const scalar = (BigInt(`0x${seed.toString("hex")}`) % (P256_ORDER - ONE)) + ONE;
  const privateKey = Buffer.from(scalar.toString(16).padStart(64, "0"), "hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  return ecdh;
}

function decodeField(value: unknown, name: string, maxBytes: number, exactBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 4 ||
    !BASE64URL_RE.test(value)
  ) {
    throw new AppError(`${name} invalide`, 400);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > maxBytes || (exactBytes !== undefined && decoded.length !== exactBytes)) {
    throw new AppError(`${name} invalide`, 400);
  }
  return decoded;
}

export function datasetIngressPublicKey(): DatasetIngressKey {
  const origin = process.env.SIRIUS_APP_ORIGIN?.trim();
  if (process.env.NODE_ENV === "production" && !origin) {
    throw new Error("SIRIUS_APP_ORIGIN obligatoire en production");
  }
  return {
    version: 1,
    publicKey: ingressEcdh().getPublicKey(undefined, "uncompressed").toString("base64url"),
    origin: origin ?? "http://localhost:3000",
  };
}

export function datasetIngressKeyFingerprint(): string {
  const publicKey = Buffer.from(datasetIngressPublicKey().publicKey, "base64url");
  return createHash("sha256").update(publicKey).digest("hex");
}

export function decryptDatasetIngress(datasetId: string, envelope: DatasetIngressEnvelope): Buffer {
  if (!envelope || envelope.version !== 1) throw new AppError("Enveloppe dataset incompatible", 400);

  const ephemeralPublicKey = decodeField(envelope.ephemeralPublicKey, "Clé éphémère", 65, 65);
  const salt = decodeField(envelope.salt, "Sel", 16, 16);
  const iv = decodeField(envelope.iv, "IV", 12, 12);
  const sealed = decodeField(envelope.ciphertext, "Dataset chiffré", MAX_CIPHERTEXT_BYTES);
  if (sealed.length <= AUTH_TAG_BYTES) throw new AppError("Dataset chiffré vide", 400);

  try {
    const sharedSecret = ingressEcdh().computeSecret(ephemeralPublicKey);
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        sharedSecret,
        salt,
        Buffer.from(`${DATASET_INGRESS_INFO_PREFIX}${datasetId}`),
        32,
      ),
    );
    const ciphertext = sealed.subarray(0, -AUTH_TAG_BYTES);
    const tag = sealed.subarray(-AUTH_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(Buffer.from(datasetId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new AppError("Enveloppe dataset invalide", 400);
  }
}
