import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "@/lib/app-error";
import {
  addressesEqual,
  displayAddress,
  isZeroAddress,
  normalizeAddress,
  tryNormalizeAddress,
  ZERO_ADDRESS,
} from "./address";

// Adresse de test avec une somme de contrôle EIP-55 valide (casse mixte).
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const LOWERCASE = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

test("toute adresse est ramenée en minuscules avant persistance ou comparaison", () => {
  assert.equal(normalizeAddress(CHECKSUMMED), LOWERCASE);
  assert.equal(normalizeAddress(LOWERCASE), LOWERCASE);
  assert.equal(normalizeAddress(CHECKSUMMED.toUpperCase().replace("0X", "0x")), LOWERCASE);
  assert.equal(normalizeAddress(`  ${CHECKSUMMED}  `), LOWERCASE);
});

test("une adresse invalide lève une 400 plutôt que de traverser silencieusement", () => {
  for (const invalid of [
    "",
    "0x",
    LOWERCASE.slice(0, -1), // 19 octets
    `${LOWERCASE}00`, // 21 octets
    LOWERCASE.replace("0x", ""), // sans préfixe
    "0xZZaeb6053f3e94c9b9a09f33669435e7ef1beaed", // caractère non hexadécimal
    "not-an-evm-address",
  ]) {
    assert.throws(
      () => normalizeAddress(invalid),
      (error: unknown) => error instanceof AppError && error.status === 400,
      `attendu une AppError 400 pour ${JSON.stringify(invalid)}`,
    );
    assert.equal(tryNormalizeAddress(invalid), null);
  }
  assert.throws(() => normalizeAddress(undefined), AppError);
  assert.throws(() => normalizeAddress(42), AppError);
});

test("la comparaison d'adresses ignore la casse — le contrôle d'accès en dépend", () => {
  // Le scénario redouté : le wallet renvoie la forme EIP-55, la base stocke
  // en minuscules. Un `===` naïf refuserait le propriétaire légitime.
  assert.equal(addressesEqual(CHECKSUMMED, LOWERCASE), true);
  assert.equal(addressesEqual(LOWERCASE, LOWERCASE), true);

  // La raison d'être de cette fonction : les deux écritures désignent le même
  // compte mais sont deux chaînes distinctes. On passe par des `string` élargis,
  // sinon TypeScript compare des types littéraux et refuse l'expression.
  const strict: (a: string, b: string) => boolean = (a, b) => a === b;
  assert.equal(strict(CHECKSUMMED, LOWERCASE), false);

  const other = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaee";
  assert.equal(addressesEqual(CHECKSUMMED, other), false);

  // Une entrée invalide ne doit jamais être considérée comme égale, même à elle-même.
  assert.equal(addressesEqual("pas-une-adresse", "pas-une-adresse"), false);
  assert.equal(addressesEqual(null, null), false);
  assert.equal(addressesEqual(undefined, LOWERCASE), false);
});

test("la forme EIP-55 reste réservée à l'affichage", () => {
  assert.equal(displayAddress(LOWERCASE), CHECKSUMMED);
  assert.equal(displayAddress(CHECKSUMMED), CHECKSUMMED);
});

test("l'adresse nulle est reconnue quelle que soit sa casse", () => {
  assert.equal(isZeroAddress(ZERO_ADDRESS), true);
  assert.equal(isZeroAddress("0x0000000000000000000000000000000000000000"), true);
  assert.equal(isZeroAddress(LOWERCASE), false);
  assert.equal(isZeroAddress("0x0"), false);
});
