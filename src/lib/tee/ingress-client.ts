import { isDemoDeployment } from "@/lib/deployment-mode";
import {
  DATASET_INGRESS_INFO_PREFIX,
  MAX_DATASET_BYTES,
  type DatasetIngressEnvelope,
  type DatasetIngressKey,
} from "./contract";

const encoder = new TextEncoder();
const BASE64_CHUNK_BYTES = 3 * 8192;

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    encoded += btoa(String.fromCharCode(...chunk));
  }
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyIngressKey(ingressKey: DatasetIngressKey): Promise<Uint8Array<ArrayBuffer>> {
  if (ingressKey.version !== 1) throw new Error("Version de clé d’ingestion incompatible");
  const expectedOrigin = process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN?.trim() || globalThis.location?.origin;
  if (expectedOrigin && ingressKey.origin !== expectedOrigin) {
    throw new Error("La clé d’ingestion n’est pas liée à cette origine");
  }

  const publicKey = decodeBase64Url(ingressKey.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("Clé d’ingestion invalide");

  const expectedFingerprint = process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256?.trim().toLowerCase();
  // L'épinglage authentifie un runner distant : il prouve que le navigateur chiffre
  // pour l'enclave attendue et non pour un intermédiaire. Sur une instance de
  // démonstration, le runner s'exécute dans le processus qui sert la page — la clé
  // vient de la même origine, et il n'y a aucun tiers à authentifier. Exiger
  // l'empreinte y interdisait tout dépôt sans rien protéger.
  //
  // `instrumentation-node.ts` retirait déjà cette variable des exigences en mode
  // démonstration ; ce contrôle-ci l'ignorait, et les deux se contredisaient.
  if (process.env.NODE_ENV === "production" && !expectedFingerprint && !isDemoDeployment()) {
    throw new Error("Empreinte de clé d’ingestion non configurée");
  }
  if (expectedFingerprint) {
    if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
      throw new Error("Empreinte de clé d’ingestion invalide");
    }
    const fingerprint = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)));
    if (fingerprint !== expectedFingerprint) throw new Error("Clé d’ingestion non authentifiée");
  }
  return publicKey;
}

export async function encryptDatasetForRunner(
  content: ArrayBuffer,
  datasetId: string,
  ingressKey: DatasetIngressKey,
): Promise<DatasetIngressEnvelope> {
  if (content.byteLength === 0 || content.byteLength > MAX_DATASET_BYTES) {
    throw new Error("Taille du dataset invalide");
  }
  const publicKey = await verifyIngressKey(ingressKey);

  const runnerPublicKey = await crypto.subtle.importKey(
    "raw",
    publicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeralKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: runnerPublicKey },
    ephemeralKey.privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(datasetId);
  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode(`${DATASET_INGRESS_INFO_PREFIX}${datasetId}`),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
    encryptionKey,
    content,
  );
  const ephemeralPublicKey = await crypto.subtle.exportKey("raw", ephemeralKey.publicKey);

  return {
    version: 1,
    ephemeralPublicKey: encodeBase64Url(new Uint8Array(ephemeralPublicKey)),
    salt: encodeBase64Url(salt),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}
