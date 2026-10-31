import assert from "node:assert/strict";
import type { MarketplaceDatasetRow } from "./listing";

/**
 * Jeux d'essai partagés par les tests de la marketplace (`*.test.ts`). Jamais importé par
 * l'application : il dépend de `node:assert`.
 */

export const FIXTURE_NOW = new Date("2026-10-04T12:00:00.000Z");
export const FIXTURE_PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";

export function row(overrides: Partial<MarketplaceDatasetRow> = {}): MarketplaceDatasetRow {
  return {
    id: "ds-1",
    name: "Mobilité urbaine",
    description: "Trajets agrégés par zone",
    category: "Mobilité",
    provider: FIXTURE_PROVIDER,
    modelId: "linear_regression",
    modelVersion: "1.0.0",
    metrics: { rowCount: 480, columnCount: 7 },
    sizeBytes: 13_517,
    priceUsdcAtomic: "20000000",
    challengeDays: 3,
    status: "LISTED",
    listedAt: new Date("2026-10-01T00:00:00.000Z"),
    listingExpiresAt: null,
    keyDestroyedAt: null,
    createdAt: new Date("2026-09-30T00:00:00.000Z"),
    ...overrides,
  };
}

/** Colonnes et valeurs qui ne doivent jamais sortir d'une réponse publique. */
export const PRIVATE_FIELDS = {
  wrappedKey: "SECRET-WRAPPED-KEY",
  trainingConsentAt: new Date("2026-10-02T00:00:00.000Z"),
  trainingConsentVersion: "SECRET-CONSENT-VERSION",
  trainingConsentRevokedAt: new Date("2026-10-03T00:00:00.000Z"),
  ipfsCid: "SECRET-CID",
  merkleRoot: "SECRET-MERKLE",
  runnerReceipt: "SECRET-RECEIPT",
  runnerDeploymentId: "SECRET-DEPLOYMENT",
  evmDatasetId: "SECRET-EVM-ID",
  evmMintTxHash: "SECRET-MINT",
  deletionReconciledAt: new Date("2020-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-03T08:09:10.000Z"),
  // Champs de prêt ou de profil qu'une jointure future pourrait ramener.
  borrower: "0xSECRETBORROWER",
  billingQuote: "SECRET-QUOTE",
  blockedReason: "SECRET-BLOCKED",
  kybStatus: "SECRET-KYB-CACHE",
  // Statistiques détaillées des anciens datasets : seuls les deux volumes sont publiables.
  metrics: { rowCount: 480, columnCount: 7, mean: { SECRET_COLUMN: 1 }, columns: ["SECRET_COLUMN"] },
};

const FORBIDDEN_KEYS = [
  "wrappedKey", "trainingConsentAt", "trainingConsentVersion", "trainingConsentRevokedAt", "ipfsCid", "merkleRoot",
  "runnerReceipt", "runnerDeploymentId", "evmDatasetId", "evmMintTxHash", "billingQuote", "borrower", "updatedAt",
  "createdAt", "listingExpiresAt", "keyDestroyedAt", "deletionReconciledAt", "status", "metrics", "blockedReason", "kybStatus",
];

function deepKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => deepKeys(item, keys));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      deepKeys(child, keys);
    }
  }
  return keys;
}

/** Aucune valeur marquée SECRET et aucune clé privée, à quelque profondeur que ce soit. */
export function assertNoPrivateData(value: unknown) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /SECRET/, json);
  const keys = deepKeys(JSON.parse(json));
  for (const key of FORBIDDEN_KEYS) assert.ok(!keys.has(key), `${key} présent dans ${json}`);
}
