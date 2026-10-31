import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BillingPolicy } from "@/lib/billing/config";
import { legacyTariff, providerPriceBreakdown, tariffFromPolicy, type PublishedTariff } from "./tariff";

const USDC = "0x5555555555555555555555555555555555555555";

function policy(overrides: Partial<BillingPolicy> = {}): BillingPolicy {
  return {
    version: 1,
    tariffVersion: "tarif-test-2026-10",
    costReference: "docs/OPERATIONS-ACCOUNTING.md",
    validUntil: Date.now() + 3_600_000,
    chainId: 46630,
    usdc: USDC,
    usdcDecimals: 6,
    computeRecipient: "0xb6acf8a998bb8efa34a954cd6334ccc15da7f919",
    minimumComputeAmount: "2000000",
    profiles: {
      linear_regression: { computeAmount: "3000000", maxFailureFee: "1000000", executionRateAtomicPerMs: "100", maxExecutionMs: 15000 },
      logistic_regression: { computeAmount: "1500000", maxFailureFee: "1000000", executionRateAtomicPerMs: "100", maxExecutionMs: 15000 },
    },
    ...overrides,
  };
}

const scope = { chainId: 46630, usdc: USDC, decimals: 6, minimumProviderAtomic: "1000" };

test("les frais de calcul affichés sont ceux du devis : montant du profil relevé au minimum de la politique", () => {
  const tariff = tariffFromPolicy(policy(), scope);
  assert.ok(tariff);
  assert.equal(tariff.version, "tarif-test-2026-10");
  assert.equal(tariff.computeFeeAtomic.linear_regression, "3000000", "profil au-dessus du minimum : montant du profil");
  assert.equal(tariff.computeFeeAtomic.logistic_regression, "2000000", "profil sous le minimum : minimum de la politique");
  assert.equal(tariff.minimumProviderAtomic, "1000");
  assert.equal(tariff.decimals, 6);
});

test("une politique d'un autre réseau, d'un autre jeton ou d'une autre précision n'est pas affichée", () => {
  assert.equal(tariffFromPolicy(policy({ chainId: 1 }), scope), null);
  assert.equal(tariffFromPolicy(policy({ usdc: "0x6666666666666666666666666666666666666666" }), scope), null);
  assert.equal(tariffFromPolicy(policy({ usdcDecimals: 18 }), scope), null);
  assert.equal(tariffFromPolicy(policy(), { ...scope, usdc: USDC.toUpperCase() }), null, "comparaison en minuscules strictes");
  assert.equal(tariffFromPolicy(policy(), { ...scope, minimumProviderAtomic: "-1" }), null);
});

test("sans facturation v7, les frais de calcul sont nuls : l'emprunteur paie exactement la part du fournisseur", () => {
  const tariff = legacyTariff(18, "1000000000000000");
  assert.ok(tariff);
  assert.equal(tariff.version, "legacy-v6");
  assert.deepEqual(tariff.computeFeeAtomic, { linear_regression: "0", logistic_regression: "0" });
  const breakdown = providerPriceBreakdown(tariff, "linear_regression", "20000000000000000000");
  assert.ok(breakdown.ok);
  assert.equal(breakdown.total, BigInt("20000000000000000000"));
  assert.equal(legacyTariff(6, "x"), null);
});

test("la décomposition affichée est la somme exacte et signale la part sous le minimum", () => {
  const tariff = tariffFromPolicy(policy(), scope) as PublishedTariff;
  const ok = providerPriceBreakdown(tariff, "linear_regression", "20000000");
  assert.ok(ok.ok);
  assert.equal(ok.provider, BigInt(20_000_000));
  assert.equal(ok.compute, BigInt(3_000_000));
  assert.equal(ok.total, BigInt(23_000_000));
  assert.equal(ok.belowMinimum, false);
  const atMinimum = providerPriceBreakdown(tariff, "logistic_regression", "1000");
  assert.ok(atMinimum.ok && !atMinimum.belowMinimum);
  const below = providerPriceBreakdown(tariff, "logistic_regression", "999");
  assert.ok(below.ok && below.belowMinimum);
  assert.equal(providerPriceBreakdown(tariff, "linear_regression", "12.5").ok, false);
  assert.equal(providerPriceBreakdown(tariff, "linear_regression", "").ok, false);
});

test("le tarif serveur suit la politique de facturation du runner, ou annonce son indisponibilité", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sirius-tariff-"));
  const file = join(directory, "billing-policy.json");
  const saved = { ...process.env };
  try {
    process.env.EVM_NETWORK = "testnet";
    process.env.SIRIUS_USDC_ADDRESS = USDC;
    process.env.RUNNER_BILLING_POLICY_FILE = file;
    const { publishedTariff: read } = await import("./tariff-server");
    // Lecture mémoïsée quelques secondes : chaque relecture avance l'horloge passée en paramètre.
    let clock = Date.now();
    const publishedTariff = () => read((clock += 10_000));

    process.env.SIRIUS_BILLING_VERSION = "7";
    writeFileSync(file, JSON.stringify(policy({ usdcDecimals: 18 })));
    const live = publishedTariff();
    assert.ok(live, "politique valide sur la bonne chaîne et le bon jeton");
    assert.equal(live.version, "tarif-test-2026-10");
    assert.equal(live.decimals, 18);
    assert.equal(live.computeFeeAtomic.linear_regression, "3000000");
    assert.equal(live.minimumProviderAtomic, "1000000000000000", "0,001 jeton à 18 décimales");

    writeFileSync(file, JSON.stringify(policy({ usdcDecimals: 18, chainId: 1 })));
    assert.equal(read(clock + 1_000)?.version, "tarif-test-2026-10", "relecture dans la fenêtre : valeur mémoïsée");
    assert.equal(publishedTariff(), null, "autre chaîne");
    writeFileSync(file, JSON.stringify(policy({ usdcDecimals: 18, validUntil: Date.now() - 1 })));
    assert.equal(publishedTariff(), null, "politique périmée");
    writeFileSync(file, "{not json");
    assert.equal(publishedTariff(), null, "fichier illisible");
    delete process.env.RUNNER_BILLING_POLICY_FILE;
    assert.equal(publishedTariff(), null, "fichier absent");

    process.env.SIRIUS_BILLING_VERSION = "6";
    const legacy = publishedTariff();
    assert.ok(legacy);
    assert.equal(legacy.version, "legacy-v6");
    assert.equal(legacy.computeFeeAtomic.logistic_regression, "0");
    process.env.SIRIUS_BILLING_VERSION = "9";
    assert.equal(publishedTariff(), null, "version de facturation inconnue");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
});
