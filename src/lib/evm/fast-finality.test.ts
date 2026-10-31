import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enclaveFinalityTier,
  fastFinalityConfig,
  FastFinalityConfigError,
  finalityTierFor,
  parseFinalityTier,
  usdcAmountToAtomic,
} from "./fast-finality";

const DECIMALS = 6;
const usdc = (value: string) => usdcAmountToAtomic(value, DECIMALS)!;
const enabled = () => fastFinalityConfig({ SIRIUS_FAST_FINALITY: "true" }, DECIMALS);

test("coupe-circuit : absent ou false, la politique est désactivée avec ses défauts lus quand même", () => {
  for (const env of [{}, { SIRIUS_FAST_FINALITY: "false" }, { SIRIUS_FAST_FINALITY: " FALSE " }, { SIRIUS_FAST_FINALITY: "" }]) {
    const config = fastFinalityConfig(env, DECIMALS);
    assert.equal(config.enabled, false, JSON.stringify(env));
    assert.equal(finalityTierFor({ amountAtomic: usdc("1"), inFlightFastAtomic: BigInt(0), config }), "FULL");
  }
  const config = enabled();
  assert.deepEqual(config, { enabled: true, maxLoanAtomic: usdc("25"), totalInFlightAtomic: usdc("100"), confirmations: 30 });
});

test("bornes : valeurs invalides refusées, jamais dégradées", () => {
  const invalid: Record<string, string>[] = [
    { SIRIUS_FAST_FINALITY: "yes" },
    { SIRIUS_FAST_FINALITY: "1" },
    { SIRIUS_FAST_FINALITY_MAX_USDC: "0" },
    { SIRIUS_FAST_FINALITY_MAX_USDC: "-5" },
    { SIRIUS_FAST_FINALITY_MAX_USDC: "25,5" },
    { SIRIUS_FAST_FINALITY_MAX_USDC: "1.1234567" },
    { SIRIUS_FAST_FINALITY_TOTAL_USDC: "abc" },
    { SIRIUS_FAST_FINALITY_MAX_USDC: "200" },
    { SIRIUS_FAST_FINALITY_MAX_USDC: "100.000001", SIRIUS_FAST_FINALITY_TOTAL_USDC: "100" },
    { SIRIUS_FAST_FINALITY_CONFIRMATIONS: "0" },
    { SIRIUS_FAST_FINALITY_CONFIRMATIONS: "101" },
    { SIRIUS_FAST_FINALITY_CONFIRMATIONS: "30.5" },
    { SIRIUS_FAST_FINALITY_CONFIRMATIONS: "-1" },
    { SIRIUS_FAST_FINALITY_CONFIRMATIONS: "trente" },
  ];
  for (const env of invalid) {
    assert.throws(() => fastFinalityConfig({ SIRIUS_FAST_FINALITY: "true", ...env }, DECIMALS), FastFinalityConfigError, JSON.stringify(env));
    // Même désactivée, une valeur illisible est refusée : la configuration doit être saine avant tout démarrage.
    assert.throws(() => fastFinalityConfig(env, DECIMALS), FastFinalityConfigError, `désactivée ${JSON.stringify(env)}`);
  }
  for (const [value, expected] of [["1", 1], ["100", 100], [" 42 ", 42]] as const) {
    assert.equal(fastFinalityConfig({ SIRIUS_FAST_FINALITY_CONFIRMATIONS: value }, DECIMALS).confirmations, expected);
  }
  assert.equal(fastFinalityConfig({ SIRIUS_FAST_FINALITY_MAX_USDC: "100", SIRIUS_FAST_FINALITY_TOTAL_USDC: "100" }, DECIMALS).maxLoanAtomic, usdc("100"));
  // Les décimales suivent le jeton : 18 sur le testnet, 6 sur l'USDG mainnet.
  assert.equal(fastFinalityConfig({}, 18).maxLoanAtomic, BigInt(25) * BigInt(10) ** BigInt(18));
  assert.equal(usdcAmountToAtomic("0.5", 6), BigInt(500_000));
  assert.equal(usdcAmountToAtomic("0", 6), null);
  assert.equal(usdcAmountToAtomic(undefined, 6), null);
});

test("seuil par prêt : inclusif, le moindre atome au-dessus garde la finalité complète", () => {
  const config = enabled();
  assert.equal(finalityTierFor({ amountAtomic: usdc("25"), inFlightFastAtomic: BigInt(0), config }), "FAST");
  assert.equal(finalityTierFor({ amountAtomic: usdc("25") + BigInt(1), inFlightFastAtomic: BigInt(0), config }), "FULL");
  assert.equal(finalityTierFor({ amountAtomic: usdc("0.001"), inFlightFastAtomic: BigInt(0), config }), "FAST");
  assert.equal(finalityTierFor({ amountAtomic: BigInt(0), inFlightFastAtomic: BigInt(0), config }), "FULL", "montant nul : jamais rapide");
  assert.equal(finalityTierFor({ amountAtomic: BigInt(-1), inFlightFastAtomic: BigInt(0), config }), "FULL");
});

test("plafond global : la somme en cours plus ce prêt doit rester sous le plafond, bornes incluses", () => {
  const config = enabled();
  assert.equal(finalityTierFor({ amountAtomic: usdc("25"), inFlightFastAtomic: usdc("75"), config }), "FAST", "exactement 100");
  assert.equal(finalityTierFor({ amountAtomic: usdc("25"), inFlightFastAtomic: usdc("75") + BigInt(1), config }), "FULL", "100 + 1 atome");
  assert.equal(finalityTierFor({ amountAtomic: usdc("10"), inFlightFastAtomic: usdc("100"), config }), "FULL", "plafond déjà atteint");
  assert.equal(finalityTierFor({ amountAtomic: usdc("10"), inFlightFastAtomic: BigInt(-1), config }), "FULL", "somme incohérente : prudence");
  // Sans connaissance de la somme (enclave), seul le seuil par prêt décide.
  assert.equal(finalityTierFor({ amountAtomic: usdc("25"), inFlightFastAtomic: null, config }), "FAST");
  assert.equal(finalityTierFor({ amountAtomic: usdc("26"), inFlightFastAtomic: null, config }), "FULL");
});

test("l'enclave n'accorde la profondeur rapide que si Next la demande ET que sa propre politique l'admet", () => {
  const config = enabled();
  assert.equal(enclaveFinalityTier(undefined, usdc("5"), config), "FULL", "rien demandé : finalité complète, comme avant");
  assert.equal(enclaveFinalityTier("FULL", usdc("5"), config), "FULL");
  assert.equal(enclaveFinalityTier("FAST", usdc("25"), config), "FAST");
  assert.equal(enclaveFinalityTier("FAST", usdc("25") + BigInt(1), config), null, "au-dessus du seuil : refus, même demandé");
  assert.equal(enclaveFinalityTier("FAST", usdc("5"), fastFinalityConfig({}, DECIMALS)), null, "coupe-circuit de l'enclave : refus");
  assert.equal(enclaveFinalityTier("fast", usdc("5"), config), null, "palier illisible : refus");
  assert.equal(enclaveFinalityTier(42, usdc("5"), config), null);
  assert.equal(parseFinalityTier(null), "FULL");
  assert.equal(parseFinalityTier("FAST"), "FAST");
  assert.equal(parseFinalityTier({}), null);
});
