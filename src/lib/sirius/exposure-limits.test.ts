import assert from "node:assert/strict";
import { test } from "node:test";
import { admissionsClosed, assertAdmissionsOpen, assertExposureWithinCap, assertLoanWithinCap, exposureLimits } from "./exposure-limits";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";

const usdc = (value: string) => priceUsdcToAtomic(value) as string;

test("sur mainnet, les deux plafonds sont obligatoires", () => {
  assert.throws(() => exposureLimits({ EVM_NETWORK: "mainnet" }), /Plafonds de prêt non configurés/);
  assert.throws(() => exposureLimits({ EVM_NETWORK: "mainnet", SIRIUS_MAX_LOAN_USDC: "50" }), /Plafonds de prêt non configurés/);
});

test("sur testnet, les plafonds sont facultatifs mais vont par deux", () => {
  assert.equal(exposureLimits({ EVM_NETWORK: "testnet" }), null);
  assert.equal(exposureLimits({}), null);
  assert.throws(() => exposureLimits({ SIRIUS_MAX_EXPOSURE_USDC: "500" }), /ensemble/);
});

test("une valeur invalide ou incohérente est refusée", () => {
  assert.throws(() => exposureLimits({ SIRIUS_MAX_LOAN_USDC: "-1", SIRIUS_MAX_EXPOSURE_USDC: "500" }), /SIRIUS_MAX_LOAN_USDC invalide/);
  assert.throws(() => exposureLimits({ SIRIUS_MAX_LOAN_USDC: "abc", SIRIUS_MAX_EXPOSURE_USDC: "500" }), /invalide/);
  assert.throws(() => exposureLimits({ SIRIUS_MAX_LOAN_USDC: "600", SIRIUS_MAX_EXPOSURE_USDC: "500" }), /supérieur/);
});

test("un prêt au-delà du plafond par prêt est refusé, le plafond exact passe", () => {
  const limits = exposureLimits({ SIRIUS_MAX_LOAN_USDC: "50", SIRIUS_MAX_EXPOSURE_USDC: "500" });
  assertLoanWithinCap(usdc("50"), limits);
  assert.throws(() => assertLoanWithinCap(usdc("50.000001"), limits), /plafond par prêt/);
  assertLoanWithinCap(usdc("1000000"), null);
});

test("l'exposition totale compte les prêts en cours plus le nouveau", () => {
  const limits = exposureLimits({ SIRIUS_MAX_LOAN_USDC: "50", SIRIUS_MAX_EXPOSURE_USDC: "100" });
  assertExposureWithinCap([usdc("40"), usdc("10")], usdc("50"), limits);
  assert.throws(() => assertExposureWithinCap([usdc("40"), usdc("20")], usdc("50"), limits), /exposition totale/);
  assertExposureWithinCap([usdc("999")], usdc("50"), null);
});

test("le coupe-circuit des admissions ferme les prêts sans dépendre des plafonds (A-17)", () => {
  assert.equal(admissionsClosed({}), false);
  assert.equal(admissionsClosed({ SIRIUS_ADMISSIONS_CLOSED: "false" }), false);
  assert.equal(admissionsClosed({ SIRIUS_ADMISSIONS_CLOSED: " " }), false);
  assertAdmissionsOpen({});
  for (const value of ["true", "TRUE", "1", "yes", "ture"]) {
    assert.equal(admissionsClosed({ SIRIUS_ADMISSIONS_CLOSED: value }), true, value);
    assert.throws(() => assertAdmissionsOpen({ SIRIUS_ADMISSIONS_CLOSED: value }), /Admissions de prêts fermées/);
  }
  // Fermer les admissions ne touche pas aux plafonds : la configuration reste valide au démarrage.
  const env = { EVM_NETWORK: "mainnet", SIRIUS_MAX_LOAN_USDC: "50", SIRIUS_MAX_EXPOSURE_USDC: "500", SIRIUS_ADMISSIONS_CLOSED: "true" };
  assert.deepEqual(exposureLimits(env), { maxLoanAtomic: BigInt(usdc("50")), maxExposureAtomic: BigInt(usdc("500")) });
});
