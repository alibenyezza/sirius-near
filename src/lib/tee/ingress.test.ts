import assert from "node:assert/strict";
import { before, test } from "node:test";
import { encryptDatasetForRunner } from "./ingress-client";
import { datasetIngressPublicKey, decryptDatasetIngress } from "./ingress";
import { sealDatasetEnvelope } from "./core";
import { MAX_DATASET_BYTES } from "./contract";

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
});

test("le dataset est chiffré dans le navigateur et ouvert uniquement par le runner", async () => {
  const plaintext = Buffer.from("feature,target\n1,2\n2,4\n");
  const envelope = await encryptDatasetForRunner(
    plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength),
    "dataset-1",
    datasetIngressPublicKey(),
  );

  assert.equal(envelope.ciphertext.includes(plaintext.toString()), false);
  assert.deepEqual(decryptDatasetIngress("dataset-1", envelope), plaintext);
});

test("l’enveloppe est liée à l’identifiant du dataset", async () => {
  const content = new TextEncoder().encode("a,b\n1,2\n").buffer;
  const envelope = await encryptDatasetForRunner(content, "dataset-1", datasetIngressPublicKey());

  assert.throws(() => decryptDatasetIngress("dataset-2", envelope), /Enveloppe dataset invalide/);
});

test("toute altération du ciphertext est rejetée", async () => {
  const content = new TextEncoder().encode("a,b\n1,2\n").buffer;
  const envelope = await encryptDatasetForRunner(content, "dataset-1", datasetIngressPublicKey());
  const last = envelope.ciphertext.at(-1);
  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${last === "A" ? "B" : "A"}` };

  assert.throws(() => decryptDatasetIngress("dataset-1", tampered), /Enveloppe dataset invalide/);
});

test("refuse une taille déclarée différente avant tout upload IPFS", async () => {
  const content = new TextEncoder().encode("a,b\n1,2\n");
  const envelope = await encryptDatasetForRunner(content.buffer, "dataset-1", datasetIngressPublicKey());
  await assert.rejects(
    () => sealDatasetEnvelope("dataset-1", envelope, content.byteLength + 1, { modelId: "linear_regression", modelVersion: "1.0.0" }),
    /taille du fichier ne correspond pas/,
  );
});

test("une clé d’ingestion qui ne correspond pas à l’empreinte épinglée est rejetée", async () => {
  process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256 = "00".repeat(32);
  try {
    await assert.rejects(
      () => encryptDatasetForRunner(new TextEncoder().encode("a,b\n1,2\n").buffer, "dataset-1", datasetIngressPublicKey()),
      /Clé d’ingestion non authentifiée/,
    );
  } finally {
    delete process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256;
  }
});

test("un dataset à la limite reste sous 4,5 MB après chiffrement et encodage JSON", async () => {
  const content = new ArrayBuffer(MAX_DATASET_BYTES);
  const envelope = await encryptDatasetForRunner(content, "dataset-max", datasetIngressPublicKey());
  const body = JSON.stringify({ envelope, sizeBytes: MAX_DATASET_BYTES, name: "x".repeat(160),
    modelId: "logistic_regression", modelVersion: "1.0.0", visibility: "PRIVATE" });
  assert.ok(Buffer.byteLength(body) < 4_500_000);
  assert.equal(decryptDatasetIngress("dataset-max", envelope).length, MAX_DATASET_BYTES);
  await assert.rejects(() => encryptDatasetForRunner(new ArrayBuffer(MAX_DATASET_BYTES + 1), "dataset-max", datasetIngressPublicKey()), /Taille/);
});

test("un alias utilise la clé du domaine canonique de son build, jamais celle de l'autre branche", async () => {
  const previousOrigin = process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN = "https://sirius-data.tech";
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://sirius-evm.vercel.app" } });
  const content = new TextEncoder().encode("a,b\n1,2\n").buffer;
  const key = { ...datasetIngressPublicKey(), origin: "https://sirius-data.tech" };

  try {
    const envelope = await encryptDatasetForRunner(content, "dataset-alias", key);
    assert.deepEqual(decryptDatasetIngress("dataset-alias", envelope), Buffer.from(content));
    await assert.rejects(
      encryptDatasetForRunner(content, "dataset-alias", { ...key, origin: "https://sirius-evm-staging.vercel.app" }),
      /liée à cette origine/,
    );

    delete process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN;
    await assert.rejects(encryptDatasetForRunner(content, "dataset-local", key), /liée à cette origine/);
    await encryptDatasetForRunner(content, "dataset-local", { ...key, origin: "https://sirius-evm.vercel.app" });
  } finally {
    if (previousOrigin === undefined) delete process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN;
    else process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN = previousOrigin;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
