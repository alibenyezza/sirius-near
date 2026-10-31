import assert from "node:assert/strict";
import { test } from "node:test";
import { EN_MESSAGES } from "../i18n/english";
import { categoryLabelKey, MARKETPLACE_CATEGORIES, normalizeCategory } from "./categories";
import {
  EMPTY_LOAN_STATS,
  filterAndSortListings,
  isOnlineDataset,
  MARKETPLACE_DATASET_SELECT,
  onlineDatasetWhere,
  paginate,
  searchableText,
  toPublicDetail,
  toPublicListing,
  UNKNOWN_COMPUTE_FEE,
  type ComputeFee,
  type ListingCandidate,
  type MarketplaceDatasetRow,
} from "./listing";
import { DEFAULT_MARKETPLACE_QUERY, type MarketplaceQuery } from "./query";
import { assertNoPrivateData, FIXTURE_NOW as NOW, PRIVATE_FIELDS, row } from "./test-fixtures";

const QUOTED: ComputeFee = { kind: "quoted", atomic: "3000000" };

test("en ligne : LISTED, clé active, annonce sans fin ou non expirée", () => {
  assert.equal(isOnlineDataset(row(), NOW), true);
  assert.equal(isOnlineDataset(row({ listingExpiresAt: new Date(NOW.getTime() + 1) }), NOW), true);
  // Expirée à l'instant même : plus en ligne (borne stricte, comme `gt` côté base).
  assert.equal(isOnlineDataset(row({ listingExpiresAt: NOW }), NOW), false);
  assert.equal(isOnlineDataset(row({ listingExpiresAt: new Date(NOW.getTime() - 1) }), NOW), false);
  assert.equal(isOnlineDataset(row({ listingExpiresAt: new Date(Number.NaN) }), NOW), false);
  for (const status of ["UNLISTED", "PRIVATE", "DRAFT", "LISTING", "SUSPENDED", "DELETED", "listed", ""]) {
    assert.equal(isOnlineDataset(row({ status }), NOW), false, status);
  }
  assert.equal(isOnlineDataset(row({ keyDestroyedAt: new Date("2026-10-02T00:00:00.000Z") }), NOW), false);
});

test("le filtre Prisma exprime la même règle que la vérification en mémoire, plus la clé et le titre présents", () => {
  assert.deepEqual(onlineDatasetWhere(NOW), {
    status: "LISTED",
    keyDestroyedAt: null,
    // Filtre seulement : ces deux colonnes ne sont jamais sélectionnées.
    wrappedKey: { not: null },
    evmDatasetId: { not: null },
    OR: [{ listingExpiresAt: null }, { listingExpiresAt: { gt: NOW } }],
  });
});

test("la liste blanche de colonnes ne contient aucun champ privé", () => {
  const keys = Object.keys(MARKETPLACE_DATASET_SELECT);
  for (const forbidden of ["wrappedKey", "trainingConsentAt", "trainingConsentVersion", "trainingConsentRevokedAt", "ipfsCid", "merkleRoot", "runnerReceipt", "evmDatasetId", "loans", "keyGrants", "accessLogs"]) {
    assert.ok(!keys.includes(forbidden), forbidden);
  }
  assert.ok(Object.values(MARKETPLACE_DATASET_SELECT).every((value) => value === true));
});

test("projection publique : champ par champ, même si la ligne contient des champs privés", () => {
  const hostile = { ...row(), ...PRIVATE_FIELDS } as MarketplaceDatasetRow;
  const listing = toPublicListing(hostile, { borrowCount: 4, settledCount: 3, refundedCount: 1 }, true, QUOTED);
  assert.deepEqual(Object.keys(listing).sort(), [
    "borrowCount", "category", "columnCount", "id", "listedAt", "modelId", "modelVersion", "name", "priceAtomic",
    "priceKind", "providerPriceAtomic", "rowCount", "sizeBytes", "verified",
  ]);
  assertNoPrivateData(listing);
  assert.equal(listing.rowCount, 480);
  assert.equal(listing.category, "mobility");
  assert.equal(listing.priceAtomic, "23000000");
  assert.equal(listing.priceKind, "borrowerPays");

  const detail = toPublicDetail(hostile, { borrowCount: 4, settledCount: 3, refundedCount: 1 }, false, QUOTED);
  assert.deepEqual(Object.keys(detail).sort(), [
    "borrowCount", "category", "challengeDays", "columnCount", "computeFee", "description", "id", "listedAt", "modelId",
    "modelVersion", "name", "priceAtomic", "priceKind", "provider", "providerPriceAtomic", "refundedCount", "rowCount",
    "settledCount", "sizeBytes", "successRate", "verified",
  ]);
  assertNoPrivateData(detail);
  assert.equal(detail.successRate, 0.75);
  assert.equal(detail.verified, false);
});

test("prix affiché : total si les frais sont connus (v6 : zéro), sinon le gain du fournisseur", () => {
  assert.deepEqual(
    [toPublicListing(row(), EMPTY_LOAN_STATS, null, { kind: "none", atomic: "0" })].map((l) => [l.priceAtomic, l.priceKind]),
    [["20000000", "borrowerPays"]],
  );
  const unknown = toPublicListing(row(), EMPTY_LOAN_STATS, null, UNKNOWN_COMPUTE_FEE);
  assert.deepEqual([unknown.priceAtomic, unknown.priceKind], ["20000000", "providerReceives"]);
  // Au-delà de 2^53 : addition exacte en bigint.
  const big = toPublicListing(row({ priceUsdcAtomic: "1000000000000000000000000" }), EMPTY_LOAN_STATS, null, { kind: "quoted", atomic: "1" });
  assert.equal(big.priceAtomic, "1000000000000000000000001");
  // Prix stocké illisible : jamais d'addition, jamais de montant inventé.
  const broken = toPublicListing(row({ priceUsdcAtomic: "12.5" }), EMPTY_LOAN_STATS, null, QUOTED);
  assert.deepEqual([broken.providerPriceAtomic, broken.priceAtomic, broken.priceKind], ["", "", "providerReceives"]);
});

test("valeurs stockées douteuses : profil inconnu, métriques et tailles invalides, statut de vérification non booléen", () => {
  const listing = toPublicListing(
    row({ modelId: "random_forest", modelVersion: "9", metrics: { rowCount: -1, columnCount: 2 }, sizeBytes: -5, category: "<img src=x>", listedAt: new Date(Number.NaN) }),
    { borrowCount: Number.NaN, settledCount: -1, refundedCount: 1.5 },
    "yes" as unknown as boolean,
    QUOTED,
  );
  assert.equal(listing.modelId, null);
  assert.equal(listing.modelVersion, null);
  assert.equal(listing.rowCount, null);
  assert.equal(listing.sizeBytes, null);
  assert.equal(listing.category, null);
  assert.equal(listing.listedAt, null);
  assert.equal(listing.borrowCount, 0);
  assert.equal(listing.verified, null);
  const detail = toPublicDetail(row(), EMPTY_LOAN_STATS, null, QUOTED);
  assert.equal(detail.successRate, null);
});

test("catégories : identifiants, libellés français ou anglais, sans casse ni accents ; le reste est ignoré", () => {
  assert.equal(normalizeCategory("health"), "health");
  assert.equal(normalizeCategory("Santé"), "health");
  assert.equal(normalizeCategory("SANTE"), "health");
  assert.equal(normalizeCategory(" Énergie "), "energy");
  assert.equal(normalizeCategory("Energy"), "energy");
  assert.equal(normalizeCategory("Autre"), "other");
  for (const value of [null, undefined, "", "Crypto", "constructor", "__proto__", "x".repeat(65), 42]) {
    assert.equal(normalizeCategory(value), null, String(value));
  }
  for (const category of MARKETPLACE_CATEGORIES) {
    const label = categoryLabelKey(category.id);
    assert.ok(Object.hasOwn(EN_MESSAGES, label), label);
    assert.doesNotMatch(EN_MESSAGES[label], /[éèàçù]/);
  }
});

function candidate(overrides: Partial<MarketplaceDatasetRow>, extra: { borrowCount?: number; verified?: boolean | null; fee?: ComputeFee } = {}): ListingCandidate {
  const r = row(overrides);
  return {
    listing: toPublicListing(r, { ...EMPTY_LOAN_STATS, borrowCount: extra.borrowCount ?? 0 }, extra.verified ?? null, extra.fee ?? QUOTED),
    text: searchableText(r),
    publishedAt: (r.listedAt ?? r.createdAt).getTime(),
  };
}

const q = (overrides: Partial<MarketplaceQuery>): MarketplaceQuery => ({ ...DEFAULT_MARKETPLACE_QUERY, ...overrides });
const ids = (list: ListingCandidate[]) => list.map((c) => c.listing.id);

const CATALOGUE = [
  candidate({ id: "a", name: "Crédit PME", description: "Défauts de paiement", category: "finance", modelId: "logistic_regression", priceUsdcAtomic: "5000000", metrics: { rowCount: 100, columnCount: 3 }, listedAt: new Date("2026-10-03T00:00:00Z") }, { borrowCount: 2, verified: true }),
  candidate({ id: "b", name: "Énergie Europe", description: "Consommation horaire", category: "Énergie", priceUsdcAtomic: "1000000", metrics: { rowCount: 20_000, columnCount: 9 }, listedAt: new Date("2026-10-02T00:00:00Z") }, { borrowCount: 9, verified: false }),
  candidate({ id: "c", name: "Mobilité", description: "50% des trajets", category: null, priceUsdcAtomic: "3000000", metrics: null, listedAt: new Date("2026-10-01T00:00:00Z") }, { borrowCount: 2, verified: null }),
];

test("filtres : catégorie, modèle, vérifié KYB, lignes, prix et recherche", () => {
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ category: "finance" }))), ["a"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ category: "energy" }))), ["b"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ model: "linear_regression" }))), ["b", "c"]);
  // Un statut de vérification illisible (`null`) n'est jamais compté comme vérifié.
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ verifiedOnly: true }))), ["a"]);
  // Sans nombre de lignes connu, un dataset ne passe aucun filtre de taille.
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ minRows: 0 }))), ["a", "b"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ minRows: 100, maxRows: 100 }))), ["a"]);
  // Prix total affiché (gain + 3 de calcul) : a = 8, b = 4, c = 6.
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ minPriceAtomic: BigInt(4_000_000), maxPriceAtomic: BigInt(6_000_000) }))), ["b", "c"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ terms: ["energie"] }))), ["b"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ terms: ["paiement", "pme"] }))), ["a"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ terms: ["50%"] }))), ["c"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ terms: [".*"] }))), []);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ terms: ["pme", "energie"] }))), []);
});

test("tris : récents, plus empruntés (égalité départagée par la date), prix croissant", () => {
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ sort: "recent" }))), ["a", "b", "c"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ sort: "borrowed" }))), ["b", "a", "c"]);
  assert.deepEqual(ids(filterAndSortListings(CATALOGUE, q({ sort: "price" }))), ["b", "c", "a"]);
  const broken = candidate({ id: "z", priceUsdcAtomic: "abc", listedAt: new Date("2026-10-04T00:00:00Z") });
  assert.deepEqual(ids(filterAndSortListings([broken, ...CATALOGUE], q({ sort: "price" }))), ["b", "c", "a", "z"]);
  // L'entrée n'est pas modifiée.
  assert.deepEqual(ids(CATALOGUE), ["a", "b", "c"]);
});

test("pagination : pages bornées, page au-delà de la fin ramenée à la dernière", () => {
  const many = Array.from({ length: 50 }, (_, i) => candidate({ id: `d${String(i).padStart(2, "0")}` }));
  const first = paginate(many, 1, 24);
  assert.equal(first.items.length, 24);
  assert.equal(first.pageCount, 3);
  assert.equal(first.total, 50);
  assert.equal(paginate(many, 3, 24).items.length, 2);
  // Au-delà de la fin : la dernière page, jamais une page vide qui ferait croire à un catalogue vide.
  const beyond = paginate(many, 4, 24);
  assert.equal(beyond.page, 3);
  assert.equal(beyond.items.length, 2);
  assert.equal(paginate([], 5, 24).page, 1);
  assert.equal(paginate([], 1, 24).pageCount, 1);
});
