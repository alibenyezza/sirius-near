import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsdcAtomic, USDC_DECIMALS } from "@/lib/evm/usdc";
import { computePriceBreakdown, formatTokenAmount, formatTokenWithSymbol, isValidDecimals, parseAtomic } from "./price";

const MAX_UINT96 = ((BigInt(1) << BigInt(96)) - BigInt(1)).toString();

test("montants exacts à 6 décimales (USDG) : exemple du cahier des charges, 20 + 3 = 23", () => {
  const breakdown = computePriceBreakdown({ providerAtomic: "20000000", computeAtomic: "3000000", decimals: 6 });
  assert.ok(breakdown.ok);
  assert.equal(breakdown.total, BigInt(23_000_000));
  assert.equal(formatTokenAmount(breakdown.provider, 6), "20.00");
  assert.equal(formatTokenAmount(breakdown.compute, 6), "3.00");
  assert.equal(formatTokenAmount(breakdown.total, 6), "23.00");
  assert.equal(formatTokenWithSymbol("23000000", { symbol: "USDG", decimals: 6 }), "23.00 USDG");
});

test("aucun arrondi : toutes les décimales significatives sont conservées", () => {
  assert.equal(formatTokenAmount("1", 6), "0.000001");
  assert.equal(formatTokenAmount("1000", 6), "0.001");
  assert.equal(formatTokenAmount("1234567", 6), "1.234567");
  assert.equal(formatTokenAmount("999999", 6), "0.999999");
  assert.equal(formatTokenAmount("1500000", 6), "1.50");
  assert.equal(formatTokenAmount("1230000", 6), "1.23");
  assert.equal(formatTokenAmount("1234560", 6), "1.23456");
  // 18 décimales (testnet) : la plus petite unité reste lisible.
  assert.equal(formatTokenAmount("1", 18), "0.000000000000000001");
  assert.equal(formatTokenAmount("1000000000000000000", 18), "1.00");
  assert.equal(formatTokenAmount("20000000000000000000", 18), "20.00");
});

test("zéro, milliers et petites précisions", () => {
  assert.equal(formatTokenAmount("0", 6), "0.00");
  assert.equal(formatTokenAmount("1000000000000", 6), "1,000,000.00");
  assert.equal(formatTokenAmount("1234567890123", 6), "1,234,567.890123");
  assert.equal(formatTokenAmount("5", 0), "5");
  assert.equal(formatTokenAmount("1234567", 0), "1,234,567");
  assert.equal(formatTokenAmount("5", 1), "0.5");
  assert.equal(formatTokenAmount("50", 1), "5.0");
  assert.equal(formatTokenAmount("5", 2), "0.05");
});

test("les plus grands montants admis restent exacts (uint96, au-delà de Number.MAX_SAFE_INTEGER)", () => {
  assert.equal(formatTokenAmount(MAX_UINT96, 6), "79,228,162,514,264,337,593,543.950335");
  assert.equal(formatTokenAmount(BigInt(MAX_UINT96), 6), "79,228,162,514,264,337,593,543.950335");
  const result = computePriceBreakdown({ providerAtomic: "9007199254740993", computeAtomic: "1", decimals: 6 });
  assert.ok(result.ok);
  assert.equal(result.total, BigInt("9007199254740994"), "somme exacte au-delà de 2^53");
});

test("borne du total : égal au maximum uint96 accepté, un de plus refusé", () => {
  const almost = (BigInt(MAX_UINT96) - BigInt(1)).toString();
  const atMax = computePriceBreakdown({ providerAtomic: almost, computeAtomic: "1", decimals: 6 });
  assert.ok(atMax.ok);
  assert.equal(atMax.total, BigInt(MAX_UINT96));
  assert.deepEqual(computePriceBreakdown({ providerAtomic: almost, computeAtomic: "2", decimals: 6 }), { ok: false, reason: "total-too-large" });
  const single = computePriceBreakdown({ providerAtomic: MAX_UINT96, computeAtomic: "0", decimals: 6 });
  assert.ok(single.ok, "un montant seul égal au maximum est accepté");
});

test("le total est la somme exacte, sans jamais passer par un nombre à virgule", () => {
  for (const [provider, compute] of [["1", "2"], ["999999", "1"], ["123456789", "987654321"], ["0", "0"]]) {
    const breakdown = computePriceBreakdown({ providerAtomic: provider, computeAtomic: compute, decimals: 6 });
    assert.ok(breakdown.ok);
    assert.equal(breakdown.total, BigInt(provider) + BigInt(compute));
  }
  // 0.1 + 0.2 en flottant donnerait 0.30000000000000004.
  const sum = computePriceBreakdown({ providerAtomic: "100000", computeAtomic: "200000", decimals: 6 });
  assert.ok(sum.ok);
  assert.equal(formatTokenAmount(sum.total, 6), "0.30");
});

test("accord avec le formateur existant formatUsdcAtomic sur la précision du réseau", () => {
  for (const atomic of ["0", "1", "999999", "1000000", "20000000", "123456789012345678", "7922816251426433759354395033"]) {
    const ours = formatTokenAmount(atomic, USDC_DECIMALS)!;
    const reference = formatUsdcAtomic(atomic);
    const normalize = (value: string) => {
      const [whole, fraction = ""] = value.replaceAll(",", "").split(".");
      return `${whole}.${fraction.replace(/0+$/, "")}`.replace(/\.$/, "");
    };
    assert.equal(normalize(ours), normalize(reference), atomic);
  }
});

test("minimum : comparé à la part du fournisseur, égalité acceptée", () => {
  const base = { computeAtomic: "3000000", decimals: 6, minimumAtomic: "1000" };
  const below = computePriceBreakdown({ ...base, providerAtomic: "999" });
  assert.ok(below.ok && below.belowMinimum && below.minimum === BigInt(1000));
  const equal = computePriceBreakdown({ ...base, providerAtomic: "1000" });
  assert.ok(equal.ok && !equal.belowMinimum);
  const above = computePriceBreakdown({ ...base, providerAtomic: "1001" });
  assert.ok(above.ok && !above.belowMinimum);
  const none = computePriceBreakdown({ providerAtomic: "1", computeAtomic: "1", decimals: 6 });
  assert.ok(none.ok && none.minimum === null && !none.belowMinimum);
  const nullMinimum = computePriceBreakdown({ providerAtomic: "1", computeAtomic: "1", decimals: 6, minimumAtomic: null });
  assert.ok(nullMinimum.ok && nullMinimum.minimum === null);
});

test("minimum nul : accepté, jamais confondu avec « pas de minimum »", () => {
  for (const zero of ["0", BigInt(0)]) {
    const result = computePriceBreakdown({ providerAtomic: "0", computeAtomic: "1", decimals: 6, minimumAtomic: zero });
    assert.ok(result.ok);
    assert.equal(result.minimum, BigInt(0));
    assert.equal(result.belowMinimum, false);
  }
});

test("entrées invalides : refus explicite, jamais un montant approximatif", () => {
  const invalidAmounts: unknown[] = [
    "", " 1", "1 ", "-1", "+1", "1.5", "1e6", "0x10", "007", "00", "abc", "１２", "١٢", "Infinity", "NaN",
    1, 1.5, NaN, null, undefined, {}, [], BigInt(-1), "1".repeat(30), (BigInt(1) << BigInt(96)).toString(), "1\n", "\n1", "1\r", "1\u0000",
  ];
  for (const value of invalidAmounts) {
    assert.equal(parseAtomic(value), null, String(value));
    assert.equal(formatTokenAmount(value, 6), null, String(value));
    const result = computePriceBreakdown({ providerAtomic: value, computeAtomic: "1", decimals: 6 });
    assert.deepEqual(result, { ok: false, reason: "invalid-amount" }, String(value));
    // Même refus quand c'est la part du fournisseur qui est valide et les frais de calcul qui ne le sont pas.
    assert.deepEqual(
      computePriceBreakdown({ providerAtomic: "1", computeAtomic: value, decimals: 6 }),
      { ok: false, reason: "invalid-amount" },
      `frais de calcul : ${String(value)}`,
    );
    assert.deepEqual(
      computePriceBreakdown({ providerAtomic: "1", computeAtomic: "1", decimals: 6, minimumAtomic: value }),
      value === undefined || value === null ? computePriceBreakdown({ providerAtomic: "1", computeAtomic: "1", decimals: 6 }) : { ok: false, reason: "invalid-minimum" },
      `minimum : ${String(value)}`,
    );
  }
  const tooBig = [BigInt(1) << BigInt(96), BigInt(1) << BigInt(200)];
  for (const value of tooBig) {
    assert.equal(parseAtomic(value), null);
    assert.equal(formatTokenAmount(value, 6), null);
  }
  assert.equal(parseAtomic((BigInt(1) << BigInt(96)) - BigInt(1)), BigInt(MAX_UINT96));
  assert.equal(isValidDecimals(36), true);
  assert.equal(isValidDecimals(37), false);
  assert.equal(isValidDecimals(0), true);
  for (const decimals of [-1, 1.5, 37, 1000, NaN, Infinity, "6", null, undefined]) {
    assert.equal(isValidDecimals(decimals), false, String(decimals));
    assert.equal(formatTokenAmount("1", decimals), null);
    assert.deepEqual(computePriceBreakdown({ providerAtomic: "1", computeAtomic: "1", decimals }), { ok: false, reason: "invalid-decimals" });
  }
  assert.deepEqual(
    computePriceBreakdown({ providerAtomic: "1", computeAtomic: "1", decimals: 6, minimumAtomic: "-5" }),
    { ok: false, reason: "invalid-minimum" },
  );
  assert.deepEqual(
    computePriceBreakdown({ providerAtomic: MAX_UINT96, computeAtomic: "1", decimals: 6 }),
    { ok: false, reason: "total-too-large" },
  );
  assert.equal(formatTokenWithSymbol("abc", { symbol: "USDG", decimals: 6 }), null);
});

test("bigint accepté comme chaîne, le même montant donne le même texte", () => {
  assert.equal(formatTokenAmount(BigInt("23000000"), 6), formatTokenAmount("23000000", 6));
  assert.equal(parseAtomic(BigInt(0)), BigInt(0));
  assert.equal(parseAtomic("0"), BigInt(0));
});
