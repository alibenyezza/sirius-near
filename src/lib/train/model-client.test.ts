import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { encrypt } from "@/lib/crypto/encryption";
import { parseDeliveredModel, parseDownloadedModel } from "@/lib/models/registry";
import { decryptModelPayload } from "./model-client";

const model = {
  algo: "linear_regression" as const,
  version: "1.0.0" as const,
  target: "price",
  features: ["surface", "rooms"],
  coefficients: [12.5, 1.75, -3],
  metrics: { r2: 0.97, rmse: 1234.5, mae: 950.25, n: 140 },
};

const historicalModel = {
  algo: model.algo,
  target: model.target,
  features: model.features,
  coefficients: model.coefficients,
  metrics: { r2: model.metrics.r2, rmse: model.metrics.rmse, n: model.metrics.n },
};

test("déchiffre le modèle livré et conserve ses métriques", async () => {
  const key = randomBytes(32);
  const payload = encrypt(Buffer.from(JSON.stringify(model)), key);

  assert.deepEqual(await decryptModelPayload(payload, key.toString("base64")), model);
});

test("déchiffre un modèle logistique avec ses métriques binaires", async () => {
  const key = randomBytes(32);
  const logistic = {
    algo: "logistic_regression" as const,
    version: "1.0.0" as const,
    target: "defaulted",
    features: ["income"],
    coefficients: [-2, 0.4],
    metrics: { accuracy: 0.91, precision: 0.88, recall: 0.83, f1: 0.85, n: 140 },
  };
  const payload = encrypt(Buffer.from(JSON.stringify(logistic)), key);

  assert.deepEqual(await decryptModelPayload(payload, key.toString("base64")), logistic);
});

test("refuse une clé de livraison qui ne correspond pas au modèle", async () => {
  const key = randomBytes(32);
  const payload = encrypt(Buffer.from(JSON.stringify(model)), key);

  await assert.rejects(
    decryptModelPayload(payload, randomBytes(32).toString("base64")),
    /Déchiffrement du modèle impossible/,
  );
});

test("ouvre le format historique sans lui attribuer une version ou une MAE", async () => {
  const key = randomBytes(32);
  const payload = encrypt(Buffer.from(JSON.stringify(historicalModel)), key);
  const decrypted = await decryptModelPayload(payload, key.toString("base64"));
  assert.deepEqual(decrypted, historicalModel);
  assert.equal(Object.hasOwn(decrypted, "version"), false);
  assert.equal(Object.hasOwn(decrypted.metrics, "mae"), false);
  assert.throws(() => parseDeliveredModel(historicalModel), /Modèle déchiffré invalide/);
});

test("refuse les formats historiques altérés et les modèles versionnés incomplets", () => {
  for (const invalid of [
    { ...historicalModel, version: "1.0.0" },
    { ...historicalModel, version: null },
    { ...historicalModel, version: "2.0.0" },
    { ...historicalModel, algo: "logistic_regression" },
    { ...historicalModel, metrics: model.metrics },
    { ...historicalModel, extra: true },
    { ...historicalModel, coefficients: [1, 2] },
    { ...historicalModel, coefficients: [1, Infinity, 3] },
    { ...historicalModel, features: ["surface", "surface"] },
    { ...historicalModel, features: Array.from({ length: 32 }, (_, i) => `f${i}`), coefficients: Array(33).fill(1) },
    { ...historicalModel, metrics: { ...historicalModel.metrics, rmse: -1 } },
    { ...historicalModel, metrics: { ...historicalModel.metrics, r2: NaN } },
    { ...historicalModel, metrics: { ...historicalModel.metrics, n: 0 } },
    { ...historicalModel, metrics: { ...historicalModel.metrics, n: 2.5 } },
    { ...historicalModel, metrics: { ...historicalModel.metrics, extra: 1 } },
  ]) assert.throws(() => parseDownloadedModel(invalid), /Modèle déchiffré invalide/);
});

test("distingue un contenu déchiffré invalide d'une erreur de clé", async () => {
  const key = randomBytes(32);
  for (const plaintext of ["not JSON", JSON.stringify({ ...historicalModel, version: "1.0.0" })]) {
    await assert.rejects(
      decryptModelPayload(encrypt(Buffer.from(plaintext), key), key.toString("base64")),
      /Modèle déchiffré invalide/,
    );
  }
});
