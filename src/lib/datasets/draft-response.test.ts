import assert from "node:assert/strict";
import { test } from "node:test";
import { EN_MESSAGES } from "@/lib/i18n/english";
import { checkDraftResponse, type ExpectedDraft } from "./draft-response";

const expected: ExpectedDraft = {
  priceUsdcAtomic: "20000000",
  sizeBytes: 15_000,
  modelId: "linear_regression",
  category: "Finance",
  listingDays: 30,
  trainingConsent: false,
};

const response = {
  datasetId: "cmg1abcdefghijklmnop",
  ingressKey: { version: 1, publicKey: "BAAA", origin: "https://sirius.example" },
  priceUsdcAtomic: "20000000",
  challengeDays: 3,
  sizeBytes: 15_000,
  model: { modelId: "linear_regression", modelVersion: "1.0.0" },
  category: "Finance",
  listingDays: 30,
  listingExpiresAt: "2026-11-03T10:00:00.000Z",
  trainingConsentAt: null,
  trainingConsentVersion: null,
};

function rejected(body: unknown, message: string, scope: ExpectedDraft = expected) {
  assert.throws(() => checkDraftResponse(body, scope), { message });
  assert.ok(Object.hasOwn(EN_MESSAGES, message), `message non traduit : ${message}`);
}

test("une réponse conforme est relue et ne garde que les champs attendus", () => {
  const draft = checkDraftResponse({ ...response, extra: "ignored", ingressKey: { ...response.ingressKey, extra: 1 } }, expected);
  assert.deepEqual(draft, {
    datasetId: response.datasetId,
    ingressKey: { version: 1, publicKey: "BAAA", origin: "https://sirius.example" },
    priceUsdcAtomic: "20000000",
    challengeDays: 3,
    sizeBytes: 15_000,
    model: { modelId: "linear_regression", modelVersion: "1.0.0" },
    category: "Finance",
    listingDays: 30,
    trainingConsentAt: null,
  });
  const consented = checkDraftResponse({ ...response, trainingConsentAt: "2026-10-04T10:00:00.000Z" }, { ...expected, trainingConsent: true });
  assert.equal(consented.trainingConsentAt, "2026-10-04T10:00:00.000Z");
});

test("le délai de sécurité renvoyé doit être la constante de Sirius, jamais une autre valeur", () => {
  for (const challengeDays of [7, 1, 30, "3", undefined, null, 3.5]) {
    rejected({ ...response, challengeDays }, "Délai de sécurité incohérent");
  }
});

test("les termes signés doivent être ceux du formulaire", () => {
  rejected({ ...response, priceUsdcAtomic: "20000001" }, "Le serveur a renvoyé un autre prix");
  rejected({ ...response, priceUsdcAtomic: 20000000 }, "Le serveur a renvoyé un autre prix");
  rejected({ ...response, sizeBytes: 15_001 }, "Le serveur a renvoyé une autre taille de fichier");
  rejected({ ...response, model: { modelId: "logistic_regression", modelVersion: "1.0.0" } }, "Le serveur a renvoyé un autre profil d’entraînement");
  rejected({ ...response, model: { modelId: "linear_regression", modelVersion: "9.9.9" } }, "Le serveur a renvoyé un autre profil d’entraînement");
  rejected({ ...response, model: undefined }, "Le serveur a renvoyé un autre profil d’entraînement");
  rejected({ ...response, category: "Health" }, "Le serveur a renvoyé d’autres termes de publication");
  rejected({ ...response, listingDays: 7 }, "Le serveur a renvoyé d’autres termes de publication");
  rejected({ ...response, trainingConsentAt: "2026-10-04T10:00:00.000Z" }, "Le serveur a renvoyé d’autres termes de publication");
  rejected({ ...response, trainingConsentAt: 1 }, "Le serveur a renvoyé d’autres termes de publication");
  rejected(response, "Le serveur a renvoyé d’autres termes de publication", { ...expected, trainingConsent: true });
});

test("une réponse malformée est refusée avant tout chiffrement", () => {
  for (const body of [undefined, null, "x", [], {}, { ...response, datasetId: "" }, { ...response, datasetId: "../x" }, { ...response, datasetId: "a".repeat(9) }, { ...response, datasetId: "a".repeat(65) }]) {
    rejected(body, "Échec de la préparation du dépôt");
  }
  for (const ingressKey of [undefined, null, {}, { version: 2, publicKey: "BAAA", origin: "o" }, { version: 1, publicKey: 1, origin: "o" }, { version: 1, publicKey: "BAAA" }]) {
    rejected({ ...response, ingressKey }, "Échec de la préparation du dépôt");
  }
});
