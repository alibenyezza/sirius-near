import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AppError } from "../app-error";
import * as errors from "../errors";
import * as body from "../http/body";
import * as rate from "../http/rate-limit";
import { translateEnglish } from "../i18n/english";
import { STATUS_KINDS } from "../../components/ui/status";
import * as manage from "./manage";
import {
  EDITABLE_STATUSES,
  EXTENSIBLE_STATUSES,
  LISTING_EXTENSION_DAYS,
  MAX_STATS_LOANS,
  STATS_WEEKS,
  aggregateLoanStats,
  applyDetails,
  applyExtension,
  applyVisibility,
  displayStatus,
  extendedListingExpiry,
  extensionRelists,
  formatUtcDate,
  formatUtcDateTime,
  isCountedBorrow,
  isListingExpired,
  loadOwnedDataset,
  parseConsentRequest,
  parseExtensionDays,
  parseListingRequest,
  providerShareAtomic,
  readDatasetStats,
  readOwnerView,
  revokeTrainingConsent,
  sortDatasets,
  validateDetailsPatch,
  visibilityTransition,
  type ManageDb,
} from "./manage";

const OWNER = `0x${"ab".repeat(20)}`;
const OWNER_MIXED = `0x${"AB".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

function rejectsWith(fn: () => unknown, status: number, message?: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError, `AppError attendue, reçu ${String(error)}`);
    assert.equal(error.status, status);
    if (message) assert.equal(error.message, message);
    // Chaque message exposé a sa traduction anglaise.
    assert.notEqual(translateEnglish(error.message), error.message, `traduction manquante : ${error.message}`);
    return true;
  });
}

async function rejectsAsync(promise: Promise<unknown>, status: number, message?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `AppError attendue, reçu ${String(error)}`);
    assert.equal(error.status, status);
    if (message) assert.equal(error.message, message);
    assert.notEqual(translateEnglish(error.message), error.message, `traduction manquante : ${error.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// État affiché

test("isListingExpired : absente n'expire jamais, atteinte ou illisible expire", () => {
  assert.equal(isListingExpired(null, NOW), false);
  assert.equal(isListingExpired(undefined, NOW), false);
  assert.equal(isListingExpired(new Date(NOW + 1), NOW), false);
  assert.equal(isListingExpired(new Date(NOW), NOW), true, "la borne est incluse");
  assert.equal(isListingExpired(new Date(NOW - 1).toISOString(), NOW), true);
  assert.equal(isListingExpired("pas une date", NOW), true);
  assert.equal(isListingExpired(new Date(Number.NaN), NOW), true);
});

test("displayStatus : table complète des statuts vers les pastilles partagées", () => {
  const future = new Date(NOW + DAY);
  const past = new Date(NOW - DAY);
  const cases: [Parameters<typeof displayStatus>[0], string][] = [
    [{ status: "DELETED", inFlightLoans: 3 }, "destroyed"],
    [{ status: "SUSPENDED", inFlightLoans: 3 }, "failed"],
    [{ status: "DRAFT" }, "pending"],
    [{ status: "LISTING" }, "pending"],
    [{ status: "LISTED", listingExpiresAt: future, inFlightLoans: 0 }, "online"],
    [{ status: "LISTED", listingExpiresAt: null, inFlightLoans: 0 }, "online"],
    [{ status: "LISTED", listingExpiresAt: past, inFlightLoans: 0 }, "expired"],
    [{ status: "LISTED", listingExpiresAt: past, inFlightLoans: 1 }, "borrowed"],
    [{ status: "LISTED", listingExpiresAt: future, inFlightLoans: null }, "online"],
    [{ status: "UNLISTED", listingExpiresAt: future }, "paused"],
    [{ status: "UNLISTED", listingExpiresAt: past }, "paused"],
    [{ status: "UNLISTED", inFlightLoans: 2 }, "borrowed"],
    [{ status: "PRIVATE" }, "paused"],
    [{ status: "PRIVATE", inFlightLoans: 1 }, "borrowed"],
    [{ status: "constructor" }, "pending"],
    [{ status: "" }, "pending"],
  ];
  for (const [input, expected] of cases) {
    const result = displayStatus(input, NOW);
    assert.equal(result, expected, JSON.stringify(input));
    assert.ok((STATUS_KINDS as readonly string[]).includes(result), "toujours un état connu de StatusPill");
  }
});

// ---------------------------------------------------------------------------
// Transitions

test("pause : LISTED → UNLISTED uniquement", () => {
  assert.deepEqual(visibilityTransition("pause", { status: "LISTED", listingExpiresAt: null }, NOW), { from: ["LISTED"], to: "UNLISTED" });
  // Une annonce expirée peut être mise en pause (elle reste hors marketplace).
  assert.equal(visibilityTransition("pause", { status: "LISTED", listingExpiresAt: new Date(NOW - DAY) }, NOW).to, "UNLISTED");
  for (const status of ["UNLISTED", "PRIVATE", "DRAFT", "LISTING", "SUSPENDED", "DELETED", "inconnu"]) {
    rejectsWith(() => visibilityTransition("pause", { status, listingExpiresAt: null }, NOW), 409, "Seul un dataset en ligne peut être mis en pause");
  }
});

test("remise en ligne : UNLISTED ou PRIVATE → LISTED, jamais détruit, suspendu, brouillon ni expiré", () => {
  const minted = { evmDatasetId: `0x${"01".repeat(32)}` };
  for (const status of ["UNLISTED", "PRIVATE"]) {
    assert.deepEqual(visibilityTransition("resume", { status, listingExpiresAt: null, ...minted }, NOW), { from: [status], to: "LISTED" });
    assert.equal(visibilityTransition("resume", { status, listingExpiresAt: new Date(NOW + 1), ...minted }, NOW).to, "LISTED");
    rejectsWith(() => visibilityTransition("resume", { status, listingExpiresAt: new Date(NOW), ...minted }, NOW), 409,
      "Annonce expirée : prolonge-la avant de la remettre en ligne");
    rejectsWith(() => visibilityTransition("resume", { status, listingExpiresAt: null, evmDatasetId: null }, NOW), 409,
      "Remise en ligne impossible pour ce dataset");
  }
  for (const status of ["LISTED", "DELETED", "SUSPENDED", "DRAFT", "LISTING", "__proto__"]) {
    rejectsWith(() => visibilityTransition("resume", { status, listingExpiresAt: null, ...minted }, NOW), 409, "Remise en ligne impossible pour ce dataset");
  }
  // En démo Phala (datasets créés PRIVATE), rien ne repasse en ligne.
  for (const status of ["UNLISTED", "PRIVATE"]) {
    rejectsWith(() => visibilityTransition("resume", { status, listingExpiresAt: null, ...minted }, NOW, { demoMode: true }), 409,
      "Remise en ligne impossible pour ce dataset");
  }
});

test("route de visibilité existante : mêmes règles, et pas de détour PRIVATE → UNLISTED → LISTED", () => {
  const minted = { evmDatasetId: `0x${"01".repeat(32)}` };
  const untitled = { status: "PRIVATE", listingExpiresAt: null, evmDatasetId: null };
  const titled = { status: "PRIVATE", listingExpiresAt: null, ...minted };
  rejectsWith(() => manage.assertVisibilityChange("UNLISTED", untitled, NOW), 409, "Visibilité impossible pour ce dataset");
  rejectsWith(() => manage.assertVisibilityChange("UNLISTED", titled, NOW, { demoMode: true }), 409, "Visibilité impossible pour ce dataset");
  rejectsWith(() => manage.assertVisibilityChange("LISTED", titled, NOW, { demoMode: true }), 409, "Remise en ligne impossible pour ce dataset");
  rejectsWith(() => manage.assertVisibilityChange("LISTED", untitled, NOW), 409, "Remise en ligne impossible pour ce dataset");
  // Hors démo, un privé titré a été publié à sa création (même sans listedAt, antérieur au 27 septembre).
  manage.assertVisibilityChange("UNLISTED", titled, NOW);
  manage.assertVisibilityChange("LISTED", titled, NOW);
  manage.assertVisibilityChange("PRIVATE", { status: "LISTED", listingExpiresAt: null, ...minted }, NOW, { demoMode: true });
  manage.assertVisibilityChange("UNLISTED", { status: "LISTED", listingExpiresAt: null, ...minted }, NOW, { demoMode: true });
  // LISTED → LISTED reste accepté comme avant la slice (rafraîchit listedAt), même expiré.
  manage.assertVisibilityChange("LISTED", { status: "LISTED", listingExpiresAt: new Date(NOW - DAY), ...minted }, NOW);
});

test("prolonger une annonce en ligne expirée la remet en ligne : signalé pour exiger le grant", () => {
  assert.equal(extensionRelists({ status: "LISTED", listingExpiresAt: new Date(NOW) }, NOW), true);
  assert.equal(extensionRelists({ status: "LISTED", listingExpiresAt: new Date(NOW + 1) }, NOW), false);
  assert.equal(extensionRelists({ status: "UNLISTED", listingExpiresAt: new Date(NOW - DAY) }, NOW), false);
  assert.equal(extensionRelists({ status: "PRIVATE", listingExpiresAt: new Date(NOW - DAY) }, NOW), false);
  assert.equal(extensionRelists({ status: "LISTED", listingExpiresAt: null }, NOW), false);
});

test("prolongation : 7, 30 ou 90 jours, depuis la fin actuelle ou maintenant, plafonnée à 365 jours", () => {
  for (const days of LISTING_EXTENSION_DAYS) assert.equal(parseExtensionDays(days), days);
  for (const value of [0, 1, 8, 31, 89, 91, 365, -7, 7.5, Number.NaN, "30", null, undefined, [30], { days: 30 }]) {
    rejectsWith(() => parseExtensionDays(value), 400, "Durée de prolongation invalide (7, 30 ou 90 jours)");
  }
  const future = new Date(NOW + 10 * DAY);
  assert.equal(extendedListingExpiry({ status: "LISTED", listingExpiresAt: future }, 30, NOW).getTime(), NOW + 40 * DAY);
  assert.equal(extendedListingExpiry({ status: "LISTED", listingExpiresAt: new Date(NOW - 5 * DAY) }, 7, NOW).getTime(), NOW + 7 * DAY,
    "une annonce expirée repart d'aujourd'hui, pas de sa date passée");
  assert.equal(extendedListingExpiry({ status: "LISTED", listingExpiresAt: new Date(NOW) }, 7, NOW).getTime(), NOW + 7 * DAY);
  assert.equal(extendedListingExpiry({ status: "UNLISTED", listingExpiresAt: future }, 90, NOW).getTime(), NOW + 100 * DAY);
  assert.equal(extendedListingExpiry({ status: "PRIVATE", listingExpiresAt: future }, 7, NOW).getTime(), NOW + 17 * DAY);
  // Horizon : 275 + 90 = 365 passe, 276 + 90 = 366 est refusé.
  assert.equal(extendedListingExpiry({ status: "LISTED", listingExpiresAt: new Date(NOW + 275 * DAY) }, 90, NOW).getTime(), NOW + 365 * DAY);
  rejectsWith(() => extendedListingExpiry({ status: "LISTED", listingExpiresAt: new Date(NOW + 276 * DAY) }, 90, NOW), 409,
    "Prolongation limitée à 365 jours à l'avance");
  rejectsWith(() => extendedListingExpiry({ status: "LISTED", listingExpiresAt: null }, 30, NOW), 409, "Cette annonce n'a pas de date d'expiration");
  for (const status of ["DRAFT", "LISTING", "SUSPENDED", "DELETED"]) {
    rejectsWith(() => extendedListingExpiry({ status, listingExpiresAt: future }, 30, NOW), 409, "Prolongation impossible pour ce dataset");
  }
  assert.deepEqual([...EXTENSIBLE_STATUSES], ["LISTED", "UNLISTED", "PRIVATE"]);
});

test("corps de publication et de consentement : validation stricte", () => {
  const authorization = { payload: {}, delegation: {}, signature: "x" };
  assert.deepEqual(parseListingRequest({ action: "pause", authorization }), { action: "pause", authorization });
  assert.deepEqual(parseListingRequest({ action: "resume", authorization }), { action: "resume", authorization });
  assert.deepEqual(parseListingRequest({ action: "extend", days: 30 }), { action: "extend", days: 30 });
  rejectsWith(() => parseListingRequest({ action: "pause" }), 400, "Confirmation wallet requise");
  rejectsWith(() => parseListingRequest({ action: "pause", authorization: "jeton" }), 400, "Confirmation wallet requise");
  rejectsWith(() => parseListingRequest({ action: "pause", authorization: [authorization] }), 400, "Confirmation wallet requise");
  rejectsWith(() => parseListingRequest({ action: "pause", authorization, status: "LISTED" }), 400, "Champ de réglage inconnu");
  rejectsWith(() => parseListingRequest({ action: "extend", days: 30, listingExpiresAt: "2099-01-01" }), 400, "Champ de réglage inconnu");
  assert.deepEqual(parseListingRequest({ action: "extend", days: 30, authorization }), { action: "extend", days: 30, authorization });
  rejectsWith(() => parseListingRequest({ action: "extend", days: 30, authorization: "x" }), 400, "Confirmation wallet requise");
  rejectsWith(() => parseListingRequest({ action: "extend", days: 30, authorization: null }), 400, "Confirmation wallet requise");
  rejectsWith(() => parseListingRequest(JSON.parse('{"action":"extend","days":30,"__proto__":{"x":1}}')), 400, "Champ de réglage inconnu");
  rejectsWith(() => parseListingRequest({ action: "extend" }), 400, "Durée de prolongation invalide (7, 30 ou 90 jours)");
  for (const action of ["delete", "LISTED", "", null, undefined, "constructor"]) {
    rejectsWith(() => parseListingRequest({ action }), 400, "Action de publication inconnue");
  }
  for (const value of [null, [], "pause", 1]) rejectsWith(() => parseListingRequest(value), 400, "JSON invalide");

  assert.deepEqual(parseConsentRequest({ action: "revoke" }), { action: "revoke" });
  rejectsWith(() => parseConsentRequest({ action: "grant" }), 400, "Action de consentement inconnue");
  rejectsWith(() => parseConsentRequest({}), 400, "Action de consentement inconnue");
  rejectsWith(() => parseConsentRequest({ action: "revoke", trainingConsentRevokedAt: null }), 400, "Champ de réglage inconnu");
  rejectsWith(() => parseConsentRequest([]), 400, "JSON invalide");
});

// ---------------------------------------------------------------------------
// Nom et description

test("validateDetailsPatch : nom, description, bornes exactes et refus du prix", () => {
  assert.deepEqual(validateDetailsPatch({ name: "  Ventes 2025  " }), { name: "Ventes 2025" });
  assert.deepEqual(validateDetailsPatch({ description: "  ligne 1\nligne 2\t!  " }), { description: "ligne 1\nligne 2\t!" });
  assert.deepEqual(validateDetailsPatch({ description: "   " }), { description: null }, "description vide effacée");
  assert.deepEqual(validateDetailsPatch({ description: null }), { description: null });
  assert.deepEqual(validateDetailsPatch({ name: "a".repeat(120), description: "d".repeat(2000) }), { name: "a".repeat(120), description: "d".repeat(2000) });
  assert.deepEqual(validateDetailsPatch({ name: "Données <b>&</b> \"x\"" }), { name: "Données <b>&</b> \"x\"" }, "le HTML est stocké tel quel, React l'échappe");

  rejectsWith(() => validateDetailsPatch({ name: "a".repeat(121) }), 400, "Nom trop long (120 caractères maximum)");
  rejectsWith(() => validateDetailsPatch({ description: "d".repeat(2001) }), 400, "Description trop longue (2 000 caractères maximum)");
  for (const name of ["", "   ", 12, null, ["x"]]) rejectsWith(() => validateDetailsPatch({ name }), 400, "Nom manquant");
  for (const name of ["a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u202Eb", "a\u2066b", "a\tb"]) {
    rejectsWith(() => validateDetailsPatch({ name }), 400, "Nom invalide : caractères invisibles ou de contrôle interdits");
  }
  for (const description of ["a\u0000b", "a\u001bb", "a\u202Db", "a\u2069b", "a\u009fb"]) {
    rejectsWith(() => validateDetailsPatch({ description }), 400, "Description invalide : caractères invisibles ou de contrôle interdits");
  }
  rejectsWith(() => validateDetailsPatch({ description: 3 }), 400, "Description invalide");
  for (const key of ["priceUsdcAtomic", "priceUsdc", "price"]) {
    rejectsWith(() => validateDetailsPatch({ name: "x", [key]: "1" }), 400, "Le prix n'est pas modifiable : il est inscrit dans le reçu signé par l'enclave");
  }
  for (const key of ["status", "provider", "listingExpiresAt", "trainingConsentRevokedAt", "wrappedKey", "id", "__proto__", "constructor"]) {
    rejectsWith(() => validateDetailsPatch(JSON.parse(`{"name":"x",${JSON.stringify(key)}:1}`)), 400, "Champ de dataset non modifiable");
  }
  rejectsWith(() => validateDetailsPatch({}), 400, "Aucune modification de dataset");
  for (const value of [null, [], "x", 1]) rejectsWith(() => validateDetailsPatch(value), 400, "JSON invalide");
  assert.deepEqual([...EDITABLE_STATUSES], ["DRAFT", "LISTING", "LISTED", "UNLISTED", "PRIVATE"]);
});

// ---------------------------------------------------------------------------
// Statistiques

function loan(status: string, createdAt: number, extra: Partial<manage.LoanForStats> = {}): manage.LoanForStats {
  return { status, createdAt: new Date(createdAt), amountUsdcAtomic: "23000000", datasetAmountUsdcAtomic: "20000000", cancelTxHash: null, ...extra };
}

test("emprunt compté : USDC parti du wallet (en cours, réglé, remboursé), jamais une simple réservation", () => {
  assert.equal(isCountedBorrow({ status: "PENDING" }), false);
  assert.equal(isCountedBorrow({ status: "CANCELLED", cancelTxHash: null }), false);
  assert.equal(isCountedBorrow({ status: "CANCELLED", cancelTxHash: "" }), false);
  assert.equal(isCountedBorrow({ status: "CANCELLED", cancelTxHash: "0xabc" }), true);
  for (const status of ["ESCROWED", "TRAINING", "SETTLING", "SETTLED"]) assert.equal(isCountedBorrow({ status }), true, status);
  assert.equal(isCountedBorrow({ status: "SUBMITTING" }), false, "blocage non confirmé : peut revenir à PENDING");
  assert.equal(isCountedBorrow({ status: "inconnu" }), false);
  assert.equal(providerShareAtomic({ amountUsdcAtomic: "23", datasetAmountUsdcAtomic: "20" }), BigInt(20), "prêt v7 : part du dataset seulement");
  assert.equal(providerShareAtomic({ amountUsdcAtomic: "23", datasetAmountUsdcAtomic: null }), BigInt(23), "prêt antérieur : montant total");
  for (const raw of ["-1", "1e6", "1.5", "", " 1", "01", "x"]) assert.equal(providerShareAtomic({ amountUsdcAtomic: raw }), null, raw);
});

test("aggregateLoanStats : totaux, revenus exacts, semaines glissantes et dernier emprunt", () => {
  const big = (BigInt(2) ** BigInt(80)).toString();
  const stats = aggregateLoanStats([
    loan("SETTLED", NOW - 1),
    loan("SETTLED", NOW - WEEK, { datasetAmountUsdcAtomic: big }),
    loan("SETTLED", NOW - 3 * WEEK, { datasetAmountUsdcAtomic: null, amountUsdcAtomic: "5" }),
    loan("ESCROWED", NOW - 2 * DAY),
    loan("TRAINING", NOW - 2 * DAY, { datasetAmountUsdcAtomic: "7" }),
    loan("CANCELLED", NOW - 4 * DAY, { cancelTxHash: "0xrefund" }),
    loan("CANCELLED", NOW - 4 * DAY),
    loan("PENDING", NOW - 1),
    loan("SETTLED", NOW - 9 * WEEK),
    loan("SETTLED", NOW - DAY, { datasetAmountUsdcAtomic: "abc" }),
  ], NOW);
  assert.equal(stats.borrowCount, 8);
  assert.equal(stats.inFlightCount, 2);
  assert.equal(stats.trainingsSucceeded, 5);
  assert.equal(stats.trainingsRefunded, 1);
  assert.equal(stats.unreadableAmounts, 1);
  assert.equal(stats.earnedAtomic, (BigInt(20000000) + BigInt(2) ** BigInt(80) + BigInt(5) + BigInt(20000000)).toString(), "somme exacte au-delà de 2^53");
  assert.equal(stats.inEscrowAtomic, (BigInt(20000000) + BigInt(7)).toString());
  assert.equal(stats.lastBorrowAt, new Date(NOW - 1).toISOString());
  assert.equal(stats.weekly.length, STATS_WEEKS);
  assert.equal(stats.weekly[STATS_WEEKS - 1].end, new Date(NOW).toISOString());
  assert.equal(stats.weekly[0].start, new Date(NOW - STATS_WEEKS * WEEK).toISOString());
  // Semaine courante : NOW-1, NOW-2j (×2), NOW-4j, NOW-1j ; NOW-WEEK tombe pile au début de la semaine courante.
  assert.equal(stats.weekly[STATS_WEEKS - 1].count, 6);
  // NOW-3 semaines ouvre pile la fenêtre [NOW-3s, NOW-2s), donc l'avant-avant-dernière.
  assert.equal(stats.weekly[STATS_WEEKS - 3].count, 1, "trois semaines plus tôt, borne de début incluse");
  assert.equal(stats.weekly[STATS_WEEKS - 4].count, 0);
  assert.equal(stats.weekly.reduce((sum, week) => sum + week.count, 0), 7, "le prêt de la 9e semaine est hors fenêtre");
  for (let index = 1; index < STATS_WEEKS; index++) assert.equal(stats.weekly[index].start, stats.weekly[index - 1].end, "fenêtres contiguës");
});

test("aggregateLoanStats : aucun prêt, dates futures ou illisibles", () => {
  const empty = aggregateLoanStats([], NOW);
  assert.equal(empty.borrowCount, 0);
  assert.equal(empty.earnedAtomic, "0");
  assert.equal(empty.lastBorrowAt, null);
  assert.ok(empty.weekly.every((week) => week.count === 0));
  const odd = aggregateLoanStats([loan("SETTLED", NOW + DAY), { ...loan("SETTLED", NOW), createdAt: "pas une date" }], NOW);
  assert.equal(odd.borrowCount, 2);
  assert.equal(odd.weekly.reduce((sum, week) => sum + week.count, 0), 0, "ni le futur ni l'illisible ne tombent dans une semaine");
  assert.equal(odd.lastBorrowAt, new Date(NOW + DAY).toISOString());
});

test("sortDatasets : revenus en bigint, inconnus en dernier, égalités par date puis identifiant", () => {
  const rows = [
    { id: "a", createdAt: new Date(NOW - 3 * DAY), earnedAtomic: "9007199254740993", borrowCount: 1 },
    { id: "b", createdAt: new Date(NOW - 1 * DAY), earnedAtomic: "9007199254740992", borrowCount: 5 },
    { id: "c", createdAt: new Date(NOW - 2 * DAY), earnedAtomic: null, borrowCount: null },
    { id: "d", createdAt: new Date(NOW - 2 * DAY), earnedAtomic: "0", borrowCount: 5 },
    { id: "e", createdAt: "illisible", earnedAtomic: "0", borrowCount: 0 },
  ];
  assert.deepEqual(sortDatasets(rows, "date").map((row) => row.id), ["b", "d", "c", "a", "e"]);
  assert.deepEqual(sortDatasets(rows, "revenue").map((row) => row.id), ["a", "b", "d", "e", "c"]);
  assert.deepEqual(sortDatasets(rows, "borrows").map((row) => row.id), ["b", "d", "a", "e", "c"]);
  assert.deepEqual(rows.map((row) => row.id), ["a", "b", "c", "d", "e"], "l'entrée n'est pas modifiée");
});

test("dates UTC identiques côté serveur et navigateur", () => {
  assert.equal(formatUtcDate("2026-10-04T23:59:59.000Z"), "2026-10-04");
  assert.equal(formatUtcDateTime(new Date(Date.UTC(2026, 0, 2, 3, 4))), "2026-01-02 03:04 UTC");
  assert.equal(formatUtcDate(null), "—");
  assert.equal(formatUtcDateTime("x"), "—");
});

// ---------------------------------------------------------------------------
// Base de données simulée

interface FakeDataset {
  id: string;
  provider: string;
  status: string;
  name: string;
  description: string | null;
  listingExpiresAt: Date | null;
  evmDatasetId: string | null;
  listedAt: Date | null;
  trainingConsentAt: Date | null;
  trainingConsentVersion: string | null;
  trainingConsentRevokedAt: Date | null;
  [key: string]: unknown;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Record<string, unknown>[]).some((branch) => matches(row, branch));
    if (key === "AND") return (condition as Record<string, unknown>[]).every((branch) => matches(row, branch));
    const value = row[key];
    if (condition === null) return value === null;
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (typeof condition === "object") {
      const c = condition as { in?: unknown[]; not?: unknown; gt?: Date };
      if (c.in) return c.in.includes(value);
      if ("not" in c) return c.not === null ? value !== null && value !== undefined : value !== c.not;
      if (c.gt) return value instanceof Date && value.getTime() > c.gt.getTime();
      throw new Error(`condition non simulée : ${key}`);
    }
    return value === condition;
  });
}

function fakeDb(rows: Partial<FakeDataset>[], loans: Record<string, unknown>[] = []) {
  const datasets = new Map<string, FakeDataset>();
  for (const row of rows) {
    const full: FakeDataset = {
      id: "ds1", provider: OWNER, status: "LISTED", name: "Ventes", description: null, listingExpiresAt: null,
      evmDatasetId: `0x${"01".repeat(32)}`, listedAt: null, trainingConsentAt: null, trainingConsentVersion: null,
      trainingConsentRevokedAt: null, wrappedKey: "SECRET-KEY", runnerReceipt: "RECEIPT", metrics: { rowCount: 120, columnCount: 4, columns: ["secret"] },
      category: null, modelId: "linear_regression", modelVersion: "1.0.0", sizeBytes: 1000, priceUsdcAtomic: "20000000",
      ipfsCid: "bafy", merkleRoot: "0xroot", evmMintTxHash: "0xmint", evmDestroyTxHash: null, deletionReconciledAt: null,
      keyDestroyedAt: null, createdAt: new Date(NOW - 10 * DAY), updatedAt: new Date(NOW - DAY),
      ...row,
    };
    datasets.set(full.id, full);
  }
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const db = {
    dataset: {
      async findFirst(args: { where: Record<string, unknown>; select?: Record<string, boolean>; omit?: Record<string, boolean> }) {
        calls.push({ op: "dataset.findFirst", args });
        const row = [...datasets.values()].find((candidate) => matches(candidate, args.where));
        if (!row) return null;
        // Comportement du client réel : `omit` global sur wrappedKey et le consentement.
        const globallyOmitted = ["wrappedKey", "trainingConsentAt", "trainingConsentVersion", "trainingConsentRevokedAt"]
          .filter((key) => args.omit?.[key] !== false);
        if (args.select) return Object.fromEntries(Object.keys(args.select).map((key) => [key, row[key]]));
        return Object.fromEntries(Object.entries(row).filter(([key]) => !globallyOmitted.includes(key)));
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        calls.push({ op: "dataset.updateMany", args });
        let count = 0;
        for (const row of datasets.values()) {
          if (!matches(row, args.where)) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
    },
    loan: {
      async findMany(args: { where: Record<string, unknown>; take?: number }) {
        calls.push({ op: "loan.findMany", args });
        return loans.filter((row) => matches(row, args.where)).slice(0, args.take);
      },
      async count(args: { where: Record<string, unknown> }) {
        calls.push({ op: "loan.count", args });
        return loans.filter((row) => matches(row, args.where)).length;
      },
    },
  };
  return { db: db as unknown as ManageDb, datasets, calls };
}

test("propriété : absent, autre wallet ou identifiant hors format donnent le même 404", async () => {
  const store = fakeDb([{ id: "ds1" }]);
  assert.equal((await loadOwnedDataset(store.db, "ds1", OWNER_MIXED)).id, "ds1", "casse EIP-55 de la session acceptée");
  await rejectsAsync(loadOwnedDataset(store.db, "ds1", OTHER), 404, "Dataset introuvable");
  await rejectsAsync(loadOwnedDataset(store.db, "absent", OWNER), 404, "Dataset introuvable");
  const before = store.calls.length;
  for (const id of ["", "a/b", "x".repeat(65), "ds1;drop", 42, null]) await rejectsAsync(loadOwnedDataset(store.db, id, OWNER), 404, "Dataset introuvable");
  assert.equal(store.calls.length, before, "un identifiant hors format n'atteint pas la base");
});

test("pause et remise en ligne : écriture conditionnelle rejouée par la base", async () => {
  const store = fakeDb([{ id: "ds1", status: "LISTED", listingExpiresAt: new Date(NOW + DAY) }]);
  const row = await loadOwnedDataset(store.db, "ds1", OWNER);
  await applyVisibility(store.db, row, visibilityTransition("pause", row, NOW), NOW);
  assert.equal(store.datasets.get("ds1")!.status, "UNLISTED");
  const pause = store.calls.at(-1)!.args as { where: Record<string, unknown>; data: Record<string, unknown> };
  assert.deepEqual(pause.where, { id: "ds1", provider: OWNER, status: { in: ["LISTED"] } });
  assert.deepEqual(pause.data, { status: "UNLISTED" });

  // La lecture périmée (encore LISTED) ne permet pas une seconde pause : 409.
  await rejectsAsync(applyVisibility(store.db, row, visibilityTransition("pause", row, NOW), NOW), 409, "Dataset modifié entre-temps : recharge la page");

  const paused = await loadOwnedDataset(store.db, "ds1", OWNER);
  await applyVisibility(store.db, paused, visibilityTransition("resume", paused, NOW), NOW);
  assert.equal(store.datasets.get("ds1")!.status, "LISTED");
  assert.equal(store.datasets.get("ds1")!.listedAt?.getTime(), NOW);

  // L'annonce expire entre la lecture et l'écriture : la base refuse la remise en ligne.
  const racing = fakeDb([{ id: "ds2", status: "UNLISTED", listingExpiresAt: new Date(NOW + 1000) }]);
  const stale = await loadOwnedDataset(racing.db, "ds2", OWNER);
  const transition = visibilityTransition("resume", stale, NOW);
  await rejectsAsync(applyVisibility(racing.db, stale, transition, NOW + 2000), 409);
  assert.equal(racing.datasets.get("ds2")!.status, "UNLISTED");

  // Le dataset a été détruit entre-temps : rien n'est écrit.
  const destroyed = fakeDb([{ id: "ds3", status: "UNLISTED" }]);
  const before = await loadOwnedDataset(destroyed.db, "ds3", OWNER);
  destroyed.datasets.get("ds3")!.status = "DELETED";
  await rejectsAsync(applyVisibility(destroyed.db, before, visibilityTransition("resume", before, NOW), NOW), 409);
  assert.equal(destroyed.datasets.get("ds3")!.status, "DELETED");
});

test("prolongation : égalité stricte sur la date lue, deux prolongations simultanées ne s'additionnent pas", async () => {
  const end = new Date(NOW + 5 * DAY);
  const store = fakeDb([{ id: "ds1", status: "UNLISTED", listingExpiresAt: end }]);
  const first = await loadOwnedDataset(store.db, "ds1", OWNER);
  const second = await loadOwnedDataset(store.db, "ds1", OWNER);
  const next = await applyExtension(store.db, first, 30, NOW);
  assert.equal(next.getTime(), NOW + 35 * DAY);
  assert.equal(store.datasets.get("ds1")!.listingExpiresAt?.getTime(), NOW + 35 * DAY);
  await rejectsAsync(applyExtension(store.db, second, 30, NOW), 409, "Dataset modifié entre-temps : recharge la page");
  assert.equal(store.datasets.get("ds1")!.listingExpiresAt?.getTime(), NOW + 35 * DAY);
  const where = (store.calls.find((call) => call.op === "dataset.updateMany")!.args as { where: Record<string, unknown> }).where;
  assert.deepEqual(where, { id: "ds1", provider: OWNER, status: "UNLISTED", listingExpiresAt: end });
});

test("nom et description : statuts modifiables seulement, propriétaire dans le where", async () => {
  const store = fakeDb([{ id: "ds1", status: "PRIVATE" }, { id: "ds2", status: "DELETED" }, { id: "ds3", status: "SUSPENDED" }]);
  await applyDetails(store.db, await loadOwnedDataset(store.db, "ds1", OWNER), { name: "Nouveau", description: null });
  assert.equal(store.datasets.get("ds1")!.name, "Nouveau");
  for (const id of ["ds2", "ds3"]) {
    await rejectsAsync(applyDetails(store.db, await loadOwnedDataset(store.db, id, OWNER), { name: "x" }), 409, "Ce dataset n'est plus modifiable");
    assert.equal(store.datasets.get(id)!.name, "Ventes");
  }
  const update = store.calls.find((call) => call.op === "dataset.updateMany")!.args as { where: Record<string, unknown>; data: Record<string, unknown> };
  assert.equal(update.where.provider, OWNER);
  assert.deepEqual(update.data, { name: "Nouveau", description: null }, "seuls le nom et la description sont écrits");
});

test("retrait du consentement : une seule fois, la trace initiale est conservée", async () => {
  const given = new Date(NOW - 30 * DAY);
  const store = fakeDb([
    { id: "ds1", trainingConsentAt: given, trainingConsentVersion: "v1" },
    { id: "ds2" },
    { id: "ds3", status: "DELETED", trainingConsentAt: given, trainingConsentVersion: "v1" },
  ]);
  const revokedAt = await revokeTrainingConsent(store.db, await loadOwnedDataset(store.db, "ds1", OWNER), NOW);
  assert.equal(revokedAt.getTime(), NOW);
  const row = store.datasets.get("ds1")!;
  assert.equal(row.trainingConsentAt, given, "la date initiale n'est pas effacée");
  assert.equal(row.trainingConsentVersion, "v1");
  assert.equal(row.trainingConsentRevokedAt?.getTime(), NOW);
  await rejectsAsync(revokeTrainingConsent(store.db, await loadOwnedDataset(store.db, "ds1", OWNER), NOW + 1), 409, "Aucun consentement actif à retirer");
  assert.equal(store.datasets.get("ds1")!.trainingConsentRevokedAt?.getTime(), NOW, "la date de retrait ne bouge plus");
  await rejectsAsync(revokeTrainingConsent(store.db, await loadOwnedDataset(store.db, "ds2", OWNER), NOW), 409, "Aucun consentement actif à retirer");
  await revokeTrainingConsent(store.db, await loadOwnedDataset(store.db, "ds3", OWNER), NOW);
  assert.equal(store.datasets.get("ds3")!.trainingConsentRevokedAt?.getTime(), NOW, "possible même après destruction");
});

test("vue du propriétaire : champ par champ, consentement ré-inclus, aucun secret", async () => {
  const store = fakeDb([{ id: "ds1", trainingConsentAt: new Date(NOW - DAY), trainingConsentVersion: "v1", listingExpiresAt: new Date(NOW - 1) }],
    [{ datasetId: "ds1", status: "ESCROWED" }, { datasetId: "ds1", status: "SETTLED" }, { datasetId: "other", status: "ESCROWED" }]);
  const view = await readOwnerView(store.db, "ds1", OWNER, NOW);
  assert.deepEqual(Object.keys(view).sort(), [
    "canRelist", "category", "columnCount", "consent", "createdAt", "deletionPending", "description", "displayStatus", "evmDatasetId", "evmMintTxHash",
    "id", "ipfsCid", "keyDestroyedAt", "listedAt", "listingExpired", "listingExpiresAt", "merkleRoot", "modelId", "modelVersion", "name",
    "priceUsdcAtomic", "rowCount", "sizeBytes", "status", "updatedAt",
  ]);
  const serialized = JSON.stringify(view);
  for (const secret of ["SECRET-KEY", "RECEIPT", OWNER, "secret"]) assert.ok(!serialized.includes(secret), `fuite : ${secret}`);
  assert.deepEqual(view.consent, { givenAt: new Date(NOW - DAY).toISOString(), version: "v1", revokedAt: null, active: true });
  assert.equal(view.displayStatus, "borrowed");
  assert.equal(view.listingExpired, true);
  assert.equal(view.rowCount, 120);
  const read = store.calls.find((call) => call.op === "dataset.findFirst")!.args as { omit?: Record<string, boolean> };
  assert.deepEqual(read.omit, { trainingConsentAt: false, trainingConsentVersion: false, trainingConsentRevokedAt: false }, "wrappedKey reste omis");
  await rejectsAsync(readOwnerView(store.db, "ds1", OTHER, NOW), 404, "Dataset introuvable");
  assert.equal(store.calls.filter((call) => call.op === "loan.count").length, 1, "aucune lecture de prêt pour un autre wallet");
});

test("statistiques : propriété vérifiée avant toute lecture de prêts, plafond signalé", async () => {
  const loans = Array.from({ length: MAX_STATS_LOANS + 3 }, (_, index) => ({
    datasetId: "ds1", status: "SETTLED", createdAt: new Date(NOW - index), amountUsdcAtomic: "2", datasetAmountUsdcAtomic: "1", cancelTxHash: null,
  }));
  const store = fakeDb([{ id: "ds1" }], loans);
  await rejectsAsync(readDatasetStats(store.db, "ds1", OTHER, NOW), 404, "Dataset introuvable");
  assert.equal(store.calls.filter((call) => call.op.startsWith("loan.")).length, 0);
  const stats = await readDatasetStats(store.db, "ds1", OWNER, NOW);
  assert.equal(stats.truncated, true);
  assert.equal(stats.borrowCount, MAX_STATS_LOANS);
  assert.equal(stats.earnedAtomic, String(MAX_STATS_LOANS));
  const query = store.calls.find((call) => call.op === "loan.findMany")!.args as { where: unknown; select: Record<string, boolean> };
  assert.deepEqual(query.where, { datasetId: "ds1" });
  assert.deepEqual(Object.keys(query.select).sort(), ["amountUsdcAtomic", "cancelTxHash", "createdAt", "datasetAmountUsdcAtomic", "status"],
    "ni l'emprunteur ni les preuves ne sont lus");
});

test("nom et description : caractères invisibles, bidi, substituts isolés, NFC, au moins un caractère visible", () => {
  for (const name of ["a\u200Fb", "a\u061Cb", "a\u2028b", "\u200B\u200B", "a\u3164b", "a\u00ADb", "a\u180Eb", "a\uFEFFb", "a\u{E0041}b", "x\uD800", "\uDC00x", "a\u2060b"]) {
    rejectsWith(() => validateDetailsPatch({ name }), 400, "Nom invalide : caractères invisibles ou de contrôle interdits");
  }
  for (const name of ["---", "!!!", "\u00A0.\u00A0"]) rejectsWith(() => validateDetailsPatch({ name }), 400, "Nom invalide : au moins une lettre ou un chiffre");
  for (const description of ["a\u200Eb", "a\u{E007F}b", "x\uDBFF", "a\u2029b", "a\u202Eb"]) {
    rejectsWith(() => validateDetailsPatch({ description }), 400, "Description invalide : caractères invisibles ou de contrôle interdits");
  }
  assert.deepEqual(validateDetailsPatch({ name: "Cafe\u0301 \u{1F600} 2025" }), { name: "Café \u{1F600} 2025" }, "NFC, emoji bien formé accepté");
  assert.deepEqual(validateDetailsPatch({ description: "Cafe\u0301" }), { description: "Café" }, "description normalisée en NFC");
  assert.deepEqual(validateDetailsPatch({ name: "日本語のデータ" }), { name: "日本語のデータ" });
  // ZWNJ et ZWJ sont nécessaires au persan, aux langues indiennes et aux emojis composés.
  const persian = "می\u200Cخواهم";
  const family = "Data \u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const hindi = "क\u094D\u200Dष";
  for (const value of [persian, family, hindi]) {
    assert.deepEqual(validateDetailsPatch({ name: value, description: value }), { name: value, description: value });
  }
  for (const name of ["a\u2800b", "a\u034Fb", "a\u17B4b"]) {
    rejectsWith(() => validateDetailsPatch({ name }), 400, "Nom invalide : caractères invisibles ou de contrôle interdits");
  }
  rejectsWith(() => validateDetailsPatch({ description: "a\u034Fb" }), 400, "Description invalide : caractères invisibles ou de contrôle interdits");
  assert.deepEqual(validateDetailsPatch({ description: "\u2801\u2800\u2803" }), { description: "\u2801\u2800\u2803" }, "braille admis en description");
  // Césure conditionnelle et séparateur mongol admis dans une description, pas dans un nom.
  assert.deepEqual(validateDetailsPatch({ description: "Donau\u00ADdampf ᠠ\u180Eᠡ" }), { description: "Donau\u00ADdampf ᠠ\u180Eᠡ" });
});

test("lecture de la fiche : le propriétaire est dans la requête", async () => {
  const store = fakeDb([{ id: "ds1" }]);
  await readOwnerView(store.db, "ds1", OWNER_MIXED, NOW);
  const read = store.calls.find((call) => call.op === "dataset.findFirst")!.args as { where: Record<string, unknown> };
  assert.deepEqual(read.where, { id: "ds1", provider: OWNER });
});

test("prolongation sans grant : la base refuse si l'annonce en ligne a expiré entre la décision et l'écriture", async () => {
  const end = new Date(NOW + 1000);
  const store = fakeDb([{ id: "ds1", status: "LISTED", listingExpiresAt: end }]);
  const row = await loadOwnedDataset(store.db, "ds1", OWNER);
  await rejectsAsync(applyExtension(store.db, row, 7, NOW + 2000), 409);
  assert.equal(store.datasets.get("ds1")!.listingExpiresAt!.getTime(), end.getTime());
  await applyExtension(store.db, row, 7, NOW + 2000, { grantChecked: true });
  assert.equal(store.datasets.get("ds1")!.listingExpiresAt!.getTime(), NOW + 2000 + 7 * DAY);
  const unlisted = fakeDb([{ id: "ds2", status: "UNLISTED", listingExpiresAt: end }]);
  await applyExtension(unlisted.db, await loadOwnedDataset(unlisted.db, "ds2", OWNER), 7, NOW + 2000);
  assert.equal(unlisted.datasets.get("ds2")!.listingExpiresAt!.getTime(), NOW + 2000 + 7 * DAY, "en pause, prolonger ne remet rien en ligne");
});

test("retrait du consentement : le propriétaire est dans le where", async () => {
  const store = fakeDb([{ id: "ds1", trainingConsentAt: new Date(NOW), trainingConsentVersion: "v1" }]);
  await revokeTrainingConsent(store.db, await loadOwnedDataset(store.db, "ds1", OWNER), NOW);
  const where = (store.calls.find((call) => call.op === "dataset.updateMany")!.args as { where: Record<string, unknown> }).where;
  assert.deepEqual(where, { id: "ds1", provider: OWNER, trainingConsentAt: { not: null }, trainingConsentRevokedAt: null });
  const read = store.calls.find((call) => call.op === "dataset.findFirst")!.args as { where: Record<string, unknown> };
  assert.deepEqual(read.where, { id: "ds1", provider: OWNER }, "la lecture de propriété filtre déjà sur le wallet");
});

test("remise en ligne : titre EVM rejoué par la base", async () => {
  const store = fakeDb([{ id: "ds1", status: "UNLISTED" }]);
  const row = await loadOwnedDataset(store.db, "ds1", OWNER);
  store.datasets.get("ds1")!.evmDatasetId = null;
  await rejectsAsync(applyVisibility(store.db, row, visibilityTransition("resume", row, NOW), NOW), 409);
  assert.equal(store.datasets.get("ds1")!.status, "UNLISTED");

  // Un privé d'avant la migration de listedAt (colonne nulle) repasse en ligne.
  const privateStore = fakeDb([{ id: "ds2", status: "PRIVATE", listedAt: null }]);
  const privateRow = await loadOwnedDataset(privateStore.db, "ds2", OWNER);
  await applyVisibility(privateStore.db, privateRow, visibilityTransition("resume", privateRow, NOW), NOW);
  assert.equal(privateStore.datasets.get("ds2")!.status, "LISTED");
});

test("prolongation : un statut changé entre la lecture et l'écriture donne 409", async () => {
  const store = fakeDb([{ id: "ds1", status: "UNLISTED", listingExpiresAt: new Date(NOW - DAY) }]);
  const row = await loadOwnedDataset(store.db, "ds1", OWNER);
  store.datasets.get("ds1")!.status = "LISTED";
  await rejectsAsync(applyExtension(store.db, row, 30, NOW), 409, "Dataset modifié entre-temps : recharge la page");
  assert.equal(store.datasets.get("ds1")!.listingExpiresAt!.getTime(), NOW - DAY, "rien n'est remis en ligne sans grant");
});

test("semaines : la borne de début de la plus ancienne fenêtre est incluse", () => {
  const oldest = aggregateLoanStats([loan("SETTLED", NOW - STATS_WEEKS * WEEK), loan("SETTLED", NOW - STATS_WEEKS * WEEK - 1)], NOW);
  assert.equal(oldest.weekly[0].count, 1);
  assert.equal(oldest.weekly.reduce((sum, week) => sum + week.count, 0), 1);
});

test("vue du propriétaire : seuls les prêts en cours rendent la pastille « empruntée », destruction en attente exacte", async () => {
  const store = fakeDb([
    { id: "ds1", listingExpiresAt: null },
    { id: "ds2", status: "DELETED", evmDatasetId: null },
    { id: "ds3", status: "DELETED" },
    { id: "ds4", status: "DELETED", evmDestroyTxHash: "0xdead" },
  ], [
    { datasetId: "ds1", status: "SETTLED" }, { datasetId: "ds1", status: "PENDING" }, { datasetId: "ds1", status: "SUBMITTING" },
    { datasetId: "ds1", status: "CANCELLED" },
  ]);
  assert.equal((await readOwnerView(store.db, "ds1", OWNER, NOW)).displayStatus, "online");
  assert.equal((await readOwnerView(store.db, "ds2", OWNER, NOW)).deletionPending, false, "sans titre EVM, rien à finaliser");
  assert.equal((await readOwnerView(store.db, "ds3", OWNER, NOW)).deletionPending, true);
  assert.equal((await readOwnerView(store.db, "ds4", OWNER, NOW)).deletionPending, false);
});

// ---------------------------------------------------------------------------
// Routes chargées avec leurs dépendances simulées (motif de audit-regressions.test.ts)

function load<T>(file: string, dependencies: Record<string, unknown>, env: Record<string, string> = {}): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, Buffer, Date, Map, Set, console, process: { env }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

function routeDeps(store: ReturnType<typeof fakeDb>, session: { current: { address: string } | null }, grants: unknown[][] = []) {
  return {
    "next/server": { NextResponse },
    "@/lib/db": { prisma: store.db },
    "@/lib/errors": errors,
    "@/lib/http/body": body,
    "@/lib/http/rate-limit": rate,
    "@/lib/datasets/manage": manage,
    "@/lib/evm/usdc": { USDC_DECIMALS: 6 },
    "@/lib/auth/require-auth": { requireAuth: () => { if (!session.current) throw new AppError("Authentification requise", 401); return session.current; } },
    "@/lib/auth/mutation-grant": {
      requireMutationGrant: async (...args: unknown[]) => {
        grants.push(args);
        const grant = args[1] as { valid?: boolean };
        if (!grant.valid) throw new AppError("Autorisation runner invalide", 401);
      },
    },
  };
}

function jsonRequest(url: string, method: string, payload: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test("routes /settings : session obligatoire, 404 pour un autre wallet, prix refusé, pas de cache", async () => {
  const store = fakeDb([{ id: "ds1", trainingConsentAt: new Date(NOW), trainingConsentVersion: "v1" }]);
  const session = { current: { address: OWNER } as { address: string } | null };
  const route = load<typeof import("../../app/api/datasets/[id]/settings/route")>("src/app/api/datasets/[id]/settings/route.ts", routeDeps(store, session));
  const url = "https://test.invalid/api/datasets/ds1/settings";

  let response = await route.GET(new Request(url), ctx("ds1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const view = await response.json();
  assert.equal(view.consent.version, "v1");
  assert.equal(view.canRelist, true);
  const demoRoute = load<typeof import("../../app/api/datasets/[id]/settings/route")>("src/app/api/datasets/[id]/settings/route.ts", routeDeps(store, session), { SIRIUS_PHALA_DEMO: "true" });
  assert.equal((await (await demoRoute.GET(new Request(url), ctx("ds1"))).json()).canRelist, false, "en démo, la fiche sait que rien ne repasse en ligne");
  assert.ok(!JSON.stringify(view).includes("SECRET-KEY"));

  session.current = { address: OTHER };
  response = await route.GET(new Request(url), ctx("ds1"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Dataset introuvable" });
  response = await route.PATCH(jsonRequest(url, "PATCH", { name: "Volé" }), ctx("ds1"));
  assert.equal(response.status, 404);
  assert.equal(store.datasets.get("ds1")!.name, "Ventes");

  session.current = null;
  assert.equal((await route.GET(new Request(url), ctx("ds1"))).status, 401);

  session.current = { address: OWNER };
  response = await route.PATCH(jsonRequest(url, "PATCH", { priceUsdcAtomic: "1" }), ctx("ds1"));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Le prix n'est pas modifiable : il est inscrit dans le reçu signé par l'enclave");
  assert.equal(store.datasets.get("ds1")!.priceUsdcAtomic, "20000000");
  response = await route.PATCH(jsonRequest(url, "PATCH", { name: " Renommé ", description: "Ma description" }), ctx("ds1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, "Renommé");
  assert.equal(store.datasets.get("ds1")!.description, "Ma description");
  response = await route.PATCH(jsonRequest(url, "PATCH", "{nope"), ctx("ds1"));
  assert.equal(response.status, 400);
  response = await route.PATCH(new Request(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "x".repeat(20_000) }) }), ctx("ds1"));
  assert.equal(response.status, 413, "corps trop gros refusé avant lecture complète");
});

test("route /settings/listing : grant exigé pour pause et reprise, lié au statut visé ; transitions refusées avant le grant", async () => {
  const store = fakeDb([
    { id: "ds1", status: "LISTED", listingExpiresAt: new Date(Date.now() + 10 * DAY) },
    { id: "ds2", status: "DELETED" },
    { id: "ds3", status: "SUSPENDED" },
  ]);
  const session = { current: { address: OWNER } as { address: string } | null };
  const grants: unknown[][] = [];
  const route = load<typeof import("../../app/api/datasets/[id]/settings/listing/route")>("src/app/api/datasets/[id]/settings/listing/route.ts", routeDeps(store, session, grants));
  const post = (id: string, payload: unknown) => route.POST(jsonRequest(`https://test.invalid/api/datasets/${id}/settings/listing`, "POST", payload), ctx(id));

  let response = await post("ds1", { action: "pause", authorization: { valid: false } });
  assert.equal(response.status, 401);
  assert.equal(store.datasets.get("ds1")!.status, "LISTED", "grant invalide : rien n'est écrit");

  response = await post("ds1", { action: "pause", authorization: { valid: true } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "UNLISTED");
  const [grantSession, , expected] = grants.at(-1)!;
  // Objets créés dans le contexte VM : comparés par leur JSON, leurs prototypes viennent d'un autre royaume.
  assert.equal(JSON.stringify(grantSession), JSON.stringify({ address: OWNER }));
  assert.equal(JSON.stringify(expected), JSON.stringify({ operation: "set-dataset-visibility", datasetId: "ds1", intentParts: ["ds1", "UNLISTED"] }));

  response = await post("ds1", { action: "resume", authorization: { valid: true } });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify((grants.at(-1)![2] as { intentParts: string[] }).intentParts), JSON.stringify(["ds1", "LISTED"]));

  const before = grants.length;
  for (const id of ["ds2", "ds3"]) {
    response = await post(id, { action: "resume", authorization: { valid: true } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "Remise en ligne impossible pour ce dataset");
  }
  assert.equal(grants.length, before, "une transition invalide ne consomme aucun grant");

  session.current = { address: OTHER };
  response = await post("ds1", { action: "pause", authorization: { valid: true } });
  assert.equal(response.status, 404);
  response = await post("ds1", { action: "extend", days: 30 });
  assert.equal(response.status, 404);
  assert.equal(grants.length, before, "un autre wallet n'atteint jamais le grant");
  assert.equal(store.datasets.get("ds1")!.status, "LISTED");

  session.current = { address: OWNER };
  const end = store.datasets.get("ds1")!.listingExpiresAt!.getTime();
  response = await post("ds1", { action: "extend", days: 7 });
  assert.equal(response.status, 200);
  assert.equal(store.datasets.get("ds1")!.listingExpiresAt!.getTime(), end + 7 * DAY);
  response = await post("ds1", { action: "extend", days: 8 });
  assert.equal(response.status, 400);

  // Annonce en ligne expirée : la prolonger la remet sur la marketplace, grant exigé.
  store.datasets.get("ds1")!.listingExpiresAt = new Date(Date.now() - DAY);
  const beforeRelist = grants.length;
  response = await post("ds1", { action: "extend", days: 7 });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Confirmation wallet requise");
  response = await post("ds1", { action: "extend", days: 7, authorization: { valid: false } });
  assert.equal(response.status, 401);
  assert.ok(store.datasets.get("ds1")!.listingExpiresAt!.getTime() < Date.now(), "grant refusé : rien n'est prolongé");
  response = await post("ds1", { action: "extend", days: 7, authorization: { valid: true } });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify((grants.at(-1)![2] as { intentParts: string[] }).intentParts), JSON.stringify(["ds1", "LISTED"]));
  assert.equal(grants.length, beforeRelist + 2);
  // Annonce en ligne non expirée : la prolongation ne demande ni ne consomme de grant, et une
  // prolongation au-delà de l'horizon est refusée.
  const beforeImpossible = grants.length;
  store.datasets.get("ds1")!.listingExpiresAt = new Date(Date.now() + 300 * DAY);
  response = await post("ds1", { action: "extend", days: 90, authorization: { valid: true } });
  assert.equal(response.status, 409);
  assert.equal(grants.length, beforeImpossible);
});

test("route /settings/listing : limite de débit par wallet", async () => {
  const store = fakeDb([{ id: "ds1", status: "LISTED", listingExpiresAt: null }]);
  const session = { current: { address: OWNER } as { address: string } | null };
  const route = load<typeof import("../../app/api/datasets/[id]/settings/listing/route")>("src/app/api/datasets/[id]/settings/listing/route.ts", routeDeps(store, session));
  const statuses: number[] = [];
  for (let index = 0; index < 21; index++) {
    statuses.push((await route.POST(jsonRequest("https://test.invalid/api/datasets/ds1/settings/listing", "POST", { action: "extend", days: 7 }), ctx("ds1"))).status);
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(409), "sans date de fin : 409, mais chaque appel compte");
  assert.equal(statuses[20], 429);
  session.current = { address: OTHER };
  assert.equal((await route.POST(jsonRequest("https://test.invalid/api/datasets/ds1/settings/listing", "POST", { action: "extend", days: 7 }), ctx("ds1"))).status, 404,
    "le quota est propre à chaque wallet");
});

test("routes /settings/consent et /stats : propriétaire seulement", async () => {
  const store = fakeDb([{ id: "ds1", trainingConsentAt: new Date(NOW), trainingConsentVersion: "v1" }],
    [{ datasetId: "ds1", status: "SETTLED", createdAt: new Date(), amountUsdcAtomic: "23", datasetAmountUsdcAtomic: "20", cancelTxHash: null }]);
  const session = { current: { address: OTHER } as { address: string } | null };
  const consent = load<typeof import("../../app/api/datasets/[id]/settings/consent/route")>("src/app/api/datasets/[id]/settings/consent/route.ts", routeDeps(store, session));
  const stats = load<typeof import("../../app/api/datasets/[id]/stats/route")>("src/app/api/datasets/[id]/stats/route.ts", routeDeps(store, session));
  const consentUrl = "https://test.invalid/api/datasets/ds1/settings/consent";
  const statsUrl = "https://test.invalid/api/datasets/ds1/stats";

  assert.equal((await consent.POST(jsonRequest(consentUrl, "POST", { action: "revoke" }), ctx("ds1"))).status, 404);
  assert.equal(store.datasets.get("ds1")!.trainingConsentRevokedAt, null);
  assert.equal((await stats.GET(new Request(statsUrl), ctx("ds1"))).status, 404);

  session.current = { address: OWNER };
  let response = await consent.POST(jsonRequest(consentUrl, "POST", { action: "revoke" }), ctx("ds1"));
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.consent.active, false);
  assert.equal(view.consent.givenAt, new Date(NOW).toISOString());
  response = await consent.POST(jsonRequest(consentUrl, "POST", { action: "revoke" }), ctx("ds1"));
  assert.equal(response.status, 409);

  response = await stats.GET(new Request(statsUrl), ctx("ds1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const json = await response.json();
  assert.equal(json.borrowCount, 1);
  assert.equal(json.earnedAtomic, "20");
  assert.equal(json.tokenDecimals, 6);
});

test("route /settings/listing en démo Phala : rien n'est remis en ligne, ni par reprise ni par prolongation", async () => {
  const store = fakeDb([{ id: "ds1", status: "PRIVATE" }, { id: "ds2", status: "LISTED", listingExpiresAt: new Date(Date.now() - DAY) }]);
  const session = { current: { address: OWNER } as { address: string } | null };
  const grants: unknown[][] = [];
  const url = "https://test.invalid/api/datasets/ds1/settings/listing";
  const demo = load<typeof import("../../app/api/datasets/[id]/settings/listing/route")>("src/app/api/datasets/[id]/settings/listing/route.ts",
    routeDeps(store, session, grants), { SIRIUS_PHALA_DEMO: "true" });
  let response = await demo.POST(jsonRequest(url, "POST", { action: "resume", authorization: { valid: true } }), ctx("ds1"));
  assert.equal(response.status, 409);
  assert.equal(grants.length, 0);
  assert.equal(store.datasets.get("ds1")!.status, "PRIVATE");
  response = await demo.POST(jsonRequest("https://test.invalid/api/datasets/ds2/settings/listing", "POST", { action: "extend", days: 7, authorization: { valid: true } }), ctx("ds2"));
  assert.equal(response.status, 409);
  assert.equal(grants.length, 0);
  assert.ok(store.datasets.get("ds2")!.listingExpiresAt!.getTime() < Date.now(), "l'annonce expirée n'est pas prolongée en démo");
  const normal = load<typeof import("../../app/api/datasets/[id]/settings/listing/route")>("src/app/api/datasets/[id]/settings/listing/route.ts",
    routeDeps(store, session, grants), { SIRIUS_PHALA_DEMO: "false" });
  response = await normal.POST(jsonRequest(url, "POST", { action: "resume", authorization: { valid: true } }), ctx("ds1"));
  assert.equal(response.status, 200);
  assert.equal(store.datasets.get("ds1")!.status, "LISTED");
});

function legacyRoute(store: ReturnType<typeof fakeDb>, env: Record<string, string> = {}) {
  const visibility: unknown[][] = [];
  const grants: unknown[][] = [];
  const session = { current: { address: OWNER } };
  const route = load<typeof import("../../app/api/datasets/[id]/route")>("src/app/api/datasets/[id]/route.ts", {
    "next/server": { NextResponse },
    "@/lib/db": { prisma: store.db },
    "@/lib/sirius/provider": {
      setDatasetVisibility: async (...args: unknown[]) => { visibility.push(args); return { id: args[0], status: args[2], metrics: null }; },
      deleteDataset: async () => { throw new Error("non attendu"); },
      prepareDatasetDestruction: async () => { throw new Error("non attendu"); },
    },
    "@/lib/auth/require-auth": { requireAuth: () => session.current, assertOwner: () => { throw new Error("non attendu"); } },
    "@/lib/auth/session": { readSession: () => null },
    "@/lib/errors": errors,
    "@/lib/http/body": body,
    "@/lib/sirius/dataset-response": { datasetResponse: (row: unknown) => row },
    "@/lib/auth/mutation-grant": { requireMutationGrant: async (...args: unknown[]) => { grants.push(args); } },
    "@/lib/datasets/manage": manage,
  }, env);
  const patch = (id: string, visibilityValue: string) =>
    route.PATCH(jsonRequest(`https://test.invalid/api/datasets/${id}`, "PATCH", { visibility: visibilityValue, authorization: {} }), ctx(id));
  return { patch, visibility, grants, session };
}

test("route PATCH /api/datasets/[id] existante : mêmes règles de passage à Public que la fiche, 404 uniforme", async () => {
  const store = fakeDb([
    { id: "ds1", status: "UNLISTED", listingExpiresAt: new Date(Date.now() - DAY) },
    { id: "ds2", status: "UNLISTED", listingExpiresAt: null },
    { id: "ds3", status: "PRIVATE", evmDatasetId: null },
    { id: "ds4", status: "PRIVATE", listedAt: null },
    { id: "ds5", status: "DELETED" },
    { id: "ds6", provider: OTHER, status: "UNLISTED" },
    { id: "ds7", status: "LISTED", listingExpiresAt: null },
  ]);
  const legacy = legacyRoute(store);
  let response = await legacy.patch("ds1", "LISTED");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "Annonce expirée : prolonge-la avant de la remettre en ligne");
  for (const id of ["ds3", "ds5"]) {
    response = await legacy.patch(id, "LISTED");
    assert.equal(response.status, 409, id);
  }
  assert.equal(legacy.grants.length, 0, "une transition refusée ne consomme pas de grant");
  assert.equal(legacy.visibility.length, 0);
  assert.equal((await legacy.patch("ds1", "PRIVATE")).status, 200, "les autres visibilités restent possibles");
  assert.equal((await legacy.patch("ds2", "LISTED")).status, 200, "sans date de fin");
  assert.equal((await legacy.patch("ds4", "LISTED")).status, 200, "privé titré, même sans listedAt");
  for (const id of ["ds6", "absent"]) {
    response = await legacy.patch(id, "UNLISTED");
    assert.equal(response.status, 404, id);
    assert.deepEqual(JSON.parse(JSON.stringify(await response.json())), { error: "Dataset introuvable" });
  }
  response = await legacy.patch("ds3", "UNLISTED");
  assert.equal(response.status, 409, "pas de Semi-privé pour un privé sans titre EVM");
  assert.equal((await response.json()).error, "Visibilité impossible pour ce dataset");
  assert.equal((await legacy.patch("ds7", "LISTED")).status, 200, "LISTED → LISTED inchangé");
  const demo = legacyRoute(store, { SIRIUS_PHALA_DEMO: "true" });
  assert.equal((await demo.patch("ds4", "LISTED")).status, 409, "en démo, rien ne repasse Public");
  assert.equal((await demo.patch("ds4", "UNLISTED")).status, 409, "ni Semi-privé depuis Privé");
});
