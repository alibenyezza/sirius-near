import assert from "node:assert/strict";
import { test } from "node:test";
import { EN_MESSAGES, translateEnglish as t } from "@/lib/i18n/english";
import {
  DATASET_CATEGORIES,
  DATASET_CATEGORY_LABEL_KEYS,
  DEFAULT_LISTING_DURATION_DAYS,
  ESCROW_CHALLENGE_DAYS,
  LISTING_DURATIONS_DAYS,
  TRAINING_CONSENT_TEXT_KEY,
  TRAINING_CONSENT_VERSION,
  listingExpiryFrom,
  parseDatasetCategory,
  parseListingDurationDays,
  parseTrainingConsent,
  rebasedListingExpiry,
} from "./publication";

const DAY_MS = 86_400_000;

test("la liste fixe des catégories est celle du cahier des charges, avec ses libellés anglais", () => {
  assert.deepEqual([...DATASET_CATEGORIES], ["Finance", "Health", "Commerce", "Industry", "Mobility", "Energy", "Marketing", "Other"]);
  for (const category of DATASET_CATEGORIES) {
    const key = DATASET_CATEGORY_LABEL_KEYS[category];
    assert.ok(Object.hasOwn(EN_MESSAGES, key), `libellé non traduit : ${key}`);
    assert.equal(t(key), category, "le libellé anglais est l'identifiant stocké");
  }
});

test("une catégorie n'est acceptée qu'en correspondance exacte", () => {
  for (const category of DATASET_CATEGORIES) assert.equal(parseDatasetCategory(category), category);
  for (const value of ["finance", " Finance", "Finance ", "Santé", "", null, undefined, 1, ["Finance"], { toString: () => "Finance" }, "constructor", "__proto__"]) {
    assert.equal(parseDatasetCategory(value), null, JSON.stringify(value));
  }
});

test("la durée de publication est un entier strict parmi 7, 30 et 90 ; 30 par défaut", () => {
  assert.deepEqual([...LISTING_DURATIONS_DAYS], [7, 30, 90]);
  assert.equal(DEFAULT_LISTING_DURATION_DAYS, 30);
  for (const days of LISTING_DURATIONS_DAYS) assert.equal(parseListingDurationDays(days), days);
  for (const value of ["30", 30.5, 0, 1, 31, 89, 91, -30, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true, [30], 2 ** 53]) {
    assert.equal(parseListingDurationDays(value), null, JSON.stringify(value));
  }
});

test("l'échéance est posée à now + durée, en millisecondes exactes", () => {
  const now = new Date("2026-10-04T10:00:00.000Z");
  assert.equal(listingExpiryFrom(now, 7).toISOString(), "2026-10-11T10:00:00.000Z");
  assert.equal(listingExpiryFrom(now, 30).toISOString(), "2026-11-03T10:00:00.000Z");
  assert.equal(listingExpiryFrom(now, 90).toISOString(), "2027-01-02T10:00:00.000Z");
});

test("le délai de sécurité de l'escrow vaut 3 jours, dans la plage acceptée par le contrat et le runner (1 à 30)", () => {
  assert.equal(ESCROW_CHALLENGE_DAYS, 3);
  assert.ok(ESCROW_CHALLENGE_DAYS >= 1 && ESCROW_CHALLENGE_DAYS <= 30);
});

test("le consentement est strictement booléen, absent = refus, jamais interprété", () => {
  assert.equal(parseTrainingConsent(true), true);
  assert.equal(parseTrainingConsent(false), false);
  assert.equal(parseTrainingConsent(undefined), false);
  for (const value of ["true", "false", "", 1, 0, null, [], {}, "yes", "on"]) {
    assert.equal(parseTrainingConsent(value), null, JSON.stringify(value));
  }
});

test("le texte du consentement est celui du cahier, traduit mot pour mot, et versionné", () => {
  assert.equal(
    t(TRAINING_CONSENT_TEXT_KEY),
    "Allow Sirius to use this dataset, inside the enclave only, to evaluate and develop new models. You can withdraw this consent at any time for future use.",
  );
  assert.match(TRAINING_CONSENT_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test("la mise en ligne rebase l'échéance sur la durée choisie, depuis la date de publication", () => {
  const createdAt = new Date("2026-10-01T08:00:00.000Z");
  const listedAt = new Date("2026-10-05T12:34:56.000Z");
  for (const days of LISTING_DURATIONS_DAYS) {
    const listingExpiresAt = new Date(createdAt.getTime() + days * DAY_MS);
    assert.equal(
      rebasedListingExpiry({ createdAt, listingExpiresAt }, listedAt)?.toISOString(),
      new Date(listedAt.getTime() + days * DAY_MS).toISOString(),
      `${days} jours`,
    );
  }
  // Décalage de quelques secondes entre l'horloge de la base et celle du serveur : toléré.
  const skewed = new Date(createdAt.getTime() + 30 * DAY_MS + 15_000);
  assert.equal(rebasedListingExpiry({ createdAt, listingExpiresAt: skewed }, listedAt)?.toISOString(), new Date(listedAt.getTime() + 30 * DAY_MS).toISOString());
});

test("une échéance qui ne correspond à aucune durée proposée est laissée telle quelle", () => {
  const createdAt = new Date("2026-10-01T08:00:00.000Z");
  const listedAt = new Date("2026-10-05T12:00:00.000Z");
  assert.equal(rebasedListingExpiry({ createdAt, listingExpiresAt: null }, listedAt), null);
  for (const offset of [0, 1 * DAY_MS, 15 * DAY_MS, 30 * DAY_MS + 2 * 60_000, 29 * DAY_MS, 365 * DAY_MS, -7 * DAY_MS]) {
    assert.equal(rebasedListingExpiry({ createdAt, listingExpiresAt: new Date(createdAt.getTime() + offset) }, listedAt), null, `${offset}`);
  }
});
