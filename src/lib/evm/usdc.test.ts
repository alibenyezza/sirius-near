import assert from "node:assert/strict";
import { test } from "node:test";
import { USDC_DECIMALS_BY_NETWORK } from "./networks";
import {
  formatUsdcAtomic,
  isValidUsdcAtomicAmount,
  MAX_PRICE_USDC_ATOMIC,
  MIN_PRICE_USDC_ATOMIC,
  priceUsdcToAtomic,
  USDC_DECIMALS,
} from "./usdc";

// Ces tests fixent le contrat de conversion des montants. Le module est consommé
// par les écrans, les routes et le runner : une erreur d'un facteur de puissance
// de dix n'y lève aucune exception, elle rend simplement les prêts gratuits.
//
// Les attentes se dérivent de la précision configurée plutôt que d'être écrites
// en dur, pour rester vraies sur les deux réseaux. Un test dédié épingle en
// revanche la valeur du testnet, afin qu'un retour silencieux à 6 décimales soit
// signalé ici et non découvert en production.

const ONE = BigInt(10) ** BigInt(USDC_DECIMALS);

test("le testnet règle avec le contrat USDC à 18 décimales", () => {
  // Choix documenté : 0xbf4479C0…275F, seul contrat USDC vérifié de la chaîne.
  assert.equal(USDC_DECIMALS_BY_NETWORK.testnet, 18);
  assert.equal(USDC_DECIMALS, USDC_DECIMALS_BY_NETWORK.testnet);
});

test("une unité entière vaut le facteur atomique complet", () => {
  assert.equal(priceUsdcToAtomic("1"), ONE.toString());
  assert.equal(priceUsdcToAtomic("2"), (ONE * BigInt(2)).toString());
});

test("la partie décimale est complétée à droite, pas à gauche", () => {
  // « 1.5 » vaut un et demi, pas un plus cinq unités atomiques.
  assert.equal(priceUsdcToAtomic("1.5"), (ONE + ONE / BigInt(2)).toString());
  assert.equal(priceUsdcToAtomic("0.5"), (ONE / BigInt(2)).toString());
  assert.equal(priceUsdcToAtomic("1.05"), (ONE + ONE / BigInt(20)).toString());
});

test("la précision maximale acceptée est exactement celle du jeton", () => {
  const dernierChiffre = `1.${"0".repeat(USDC_DECIMALS - 1)}1`;
  assert.equal(priceUsdcToAtomic(dernierChiffre), (ONE + BigInt(1)).toString());

  // Un chiffre de plus n'est pas arrondi : il est refusé.
  const unDeTrop = `1.${"0".repeat(USDC_DECIMALS)}1`;
  assert.equal(priceUsdcToAtomic(unDeTrop), null);
});

test("les bornes sont inclusives et rien ne passe en dessous", () => {
  assert.equal(priceUsdcToAtomic("0.001"), MIN_PRICE_USDC_ATOMIC.toString());
  assert.equal(priceUsdcToAtomic("0.0001"), null);
  assert.equal(priceUsdcToAtomic("1000000"), MAX_PRICE_USDC_ATOMIC.toString());
  assert.equal(priceUsdcToAtomic("1000001"), null);
  assert.equal(priceUsdcToAtomic("0"), null);
});

test("les saisies malformées sont refusées plutôt que réparées", () => {
  for (const invalide of ["", " ", "01", "1.", ".5", "-1", "1e6", "1,5", "abc", "1.2.3"]) {
    assert.equal(priceUsdcToAtomic(invalide), null, `« ${invalide} » aurait dû être refusé`);
  }
});

test("seules les chaînes sont acceptées, jamais un nombre flottant", () => {
  // Un float perdrait de la précision avant même d'atteindre la conversion.
  for (const invalide of [1, 1.5, null, undefined, {}, [], true, BigInt(1)]) {
    assert.equal(priceUsdcToAtomic(invalide), null);
  }
});

test("les espaces autour de la saisie sont tolérés", () => {
  assert.equal(priceUsdcToAtomic("  1.5  "), (ONE + ONE / BigInt(2)).toString());
});

test("le formatage est l'inverse exact de la conversion", () => {
  for (const saisie of ["1", "1.5", "0.001", "1.000001", "1000000", "12.34"]) {
    const atomique = priceUsdcToAtomic(saisie);
    assert.notEqual(atomique, null, `« ${saisie} » aurait dû être accepté`);
    assert.equal(formatUsdcAtomic(atomique as string), saisie);
  }
});

test("le formatage ne laisse jamais de zéros décoratifs", () => {
  assert.equal(formatUsdcAtomic(ONE.toString()), "1");
  assert.equal(formatUsdcAtomic((ONE + ONE / BigInt(2)).toString()), "1.5");
  assert.equal(formatUsdcAtomic(MIN_PRICE_USDC_ATOMIC.toString()), "0.001");
  assert.equal(formatUsdcAtomic("0"), "0");
});

test("la validation atomique applique les mêmes bornes que la saisie", () => {
  assert.equal(isValidUsdcAtomicAmount(MIN_PRICE_USDC_ATOMIC.toString()), true);
  assert.equal(isValidUsdcAtomicAmount(MAX_PRICE_USDC_ATOMIC.toString()), true);
  assert.equal(isValidUsdcAtomicAmount((MIN_PRICE_USDC_ATOMIC - BigInt(1)).toString()), false);
  assert.equal(isValidUsdcAtomicAmount((MAX_PRICE_USDC_ATOMIC + BigInt(1)).toString()), false);
});

test("la validation atomique refuse tout ce qui n'est pas une suite de chiffres", () => {
  for (const invalide of ["", "1.0", "-1000", "1e6", " 1000", "0x3e8", 1000, null, undefined]) {
    assert.equal(isValidUsdcAtomicAmount(invalide), false);
  }
});

test("les bornes restent cohérentes entre elles et avec le plafond du contrat", () => {
  assert.ok(MIN_PRICE_USDC_ATOMIC > BigInt(0));
  assert.ok(MIN_PRICE_USDC_ATOMIC < MAX_PRICE_USDC_ATOMIC);

  // SiriusEscrow borne un prêt à uint96. Un plafond applicatif supérieur ferait
  // échouer le verrouillage on-chain après coup, au lieu d'être refusé à la saisie.
  const UINT96_MAX = BigInt(2) ** BigInt(96) - BigInt(1);
  assert.ok(MAX_PRICE_USDC_ATOMIC <= UINT96_MAX);
});
