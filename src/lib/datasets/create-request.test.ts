import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";
import { EN_MESSAGES } from "@/lib/i18n/english";
import { parseCreateDatasetRequest } from "./create-request";
import { ESCROW_CHALLENGE_DAYS, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from "./publication";

const valid = {
  name: " Mobilité urbaine ",
  description: " Trajets agrégés ",
  sizeBytes: 15_000,
  priceUsdc: "20",
  category: "Mobility",
  listingDays: 30,
  trainingConsent: false,
  modelId: "linear_regression",
};

function parsed(body: unknown) {
  const result = parseCreateDatasetRequest(body);
  assert.ok(result.ok, `attendu valide : ${JSON.stringify(body)} → ${result.ok ? "" : result.error}`);
  return result.value;
}

function refused(body: unknown, error: string, status = 400) {
  const result = parseCreateDatasetRequest(body);
  assert.ok(!result.ok, `attendu refusé : ${JSON.stringify(body)}`);
  assert.equal(result.error, error);
  assert.equal(result.status, status);
  assert.ok(Object.hasOwn(EN_MESSAGES, result.error), `erreur non traduite : ${result.error}`);
}

test("un corps valide est normalisé et le délai de sécurité forcé à 3 jours", () => {
  const value = parsed(valid);
  assert.deepEqual(value, {
    name: "Mobilité urbaine",
    description: "Trajets agrégés",
    sizeBytes: 15_000,
    priceUsdcAtomic: priceUsdcToAtomic("20"),
    category: "Mobility",
    listingDays: 30,
    trainingConsent: false,
    model: { modelId: "linear_regression", modelVersion: "1.0.0" },
    challengeDays: ESCROW_CHALLENGE_DAYS,
  });
  assert.equal(value.challengeDays, 3);
});

test("challengeDays envoyé par le client est ignoré, quelle que soit sa valeur", () => {
  for (const challengeDays of [1, 7, 30, 0, -3, 365, "3", "7", null, true, {}, [], Number.NaN]) {
    assert.equal(parsed({ ...valid, challengeDays }).challengeDays, 3, JSON.stringify(challengeDays));
  }
});

test("la catégorie est obligatoire et prise dans la liste fixe", () => {
  for (const category of ["Finance", "Health", "Commerce", "Industry", "Mobility", "Energy", "Marketing", "Other"]) {
    assert.equal(parsed({ ...valid, category }).category, category);
  }
  for (const category of [undefined, null, "", "finance", "Santé", "Mobility ", "Autre", 1, ["Finance"], "constructor"]) {
    refused({ ...valid, category }, "Catégorie obligatoire");
  }
});

test("la durée de publication vaut 7, 30 ou 90 jours, en nombre", () => {
  for (const listingDays of [7, 30, 90]) assert.equal(parsed({ ...valid, listingDays }).listingDays, listingDays);
  for (const listingDays of [undefined, null, "30", 0, 1, 31, 89, 91, -7, 30.5, Number.NaN, true, [30]]) {
    refused({ ...valid, listingDays }, "Durée de publication invalide (7, 30 ou 90 jours)");
  }
});

test("le consentement est strictement booléen ; absent vaut non", () => {
  assert.equal(parsed({ ...valid, trainingConsent: true }).trainingConsent, true);
  assert.equal(parsed({ ...valid, trainingConsent: false }).trainingConsent, false);
  const { trainingConsent: _omitted, ...withoutConsent } = valid;
  void _omitted;
  assert.equal(parsed(withoutConsent).trainingConsent, false);
  for (const trainingConsent of ["true", "false", 1, 0, null, "", "on", [], {}]) {
    refused({ ...valid, trainingConsent }, "Consentement invalide");
  }
});

test("nom, description, taille, prix et profil gardent leurs bornes", () => {
  refused({ ...valid, name: undefined }, "Nom manquant");
  refused({ ...valid, name: "   " }, "Nom manquant");
  refused({ ...valid, name: "a".repeat(MAX_NAME_LENGTH + 1) }, "Nom manquant");
  assert.equal(parsed({ ...valid, name: "a".repeat(MAX_NAME_LENGTH) }).name.length, MAX_NAME_LENGTH);
  refused({ ...valid, description: 12 }, "Description invalide");
  refused({ ...valid, description: "d".repeat(MAX_DESCRIPTION_LENGTH + 1) }, "Description invalide");
  assert.equal(parsed({ ...valid, description: undefined }).description, undefined);
  assert.equal(parsed({ ...valid, description: "   " }).description, undefined);
  for (const sizeBytes of [0, -1, 1.5, MAX_DATASET_BYTES + 1, "15000", null, undefined]) {
    refused({ ...valid, sizeBytes }, "Fichier vide ou trop volumineux (max 3 Mo)", 413);
  }
  assert.equal(parsed({ ...valid, sizeBytes: MAX_DATASET_BYTES }).sizeBytes, MAX_DATASET_BYTES);
  for (const priceUsdc of [undefined, 20, "0", "0.0001", "1000001", "-1", "1e3", "", "20,5", "0x10"]) {
    refused({ ...valid, priceUsdc }, "Prix invalide (0.001 à 1 000 000 par emprunt)");
  }
  assert.equal(parsed({ ...valid, priceUsdc: "0.001" }).priceUsdcAtomic, priceUsdcToAtomic("0.001"));
  assert.equal(parsed({ ...valid, priceUsdc: "1000000" }).priceUsdcAtomic, priceUsdcToAtomic("1000000"));
  for (const modelId of [undefined, null, "", "linear", "LINEAR_REGRESSION", "constructor", "__proto__", 1]) {
    refused({ ...valid, modelId }, "Profil d’entraînement obligatoire");
  }
  assert.deepEqual(parsed({ ...valid, modelId: "logistic_regression" }).model, { modelId: "logistic_regression", modelVersion: "1.0.0" });
});

test("les champs sont vérifiés dans un ordre fixe : la première erreur est signalée", () => {
  refused({}, "Nom manquant");
  refused({ name: "x" }, "Fichier vide ou trop volumineux (max 3 Mo)", 413);
  refused({ name: "x", sizeBytes: 1 }, "Prix invalide (0.001 à 1 000 000 par emprunt)");
  refused({ name: "x", sizeBytes: 1, priceUsdc: "1" }, "Catégorie obligatoire");
  refused({ name: "x", sizeBytes: 1, priceUsdc: "1", category: "Other" }, "Durée de publication invalide (7, 30 ou 90 jours)");
  refused({ name: "x", sizeBytes: 1, priceUsdc: "1", category: "Other", listingDays: 7, trainingConsent: "yes" }, "Consentement invalide");
  refused({ name: "x", sizeBytes: 1, priceUsdc: "1", category: "Other", listingDays: 7 }, "Profil d’entraînement obligatoire");
});

test("un corps qui n'est pas un objet est refusé sans exception", () => {
  for (const body of [null, undefined, "x", 1, [], true]) refused(body, "JSON invalide");
});
