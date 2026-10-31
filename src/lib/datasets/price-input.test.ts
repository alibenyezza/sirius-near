import assert from "node:assert/strict";
import { test } from "node:test";
import { priceUsdcToAtomic, USDC_DECIMALS } from "@/lib/evm/usdc";
import { MIN_PRICE_USDC_ATOMIC } from "@/lib/evm/usdc";
import { minimumProviderPriceAtomic, parseProviderPrice } from "./price-input";

test("le plancher connu localement est celui de la route, pour la précision du réseau", () => {
  assert.equal(minimumProviderPriceAtomic(USDC_DECIMALS), MIN_PRICE_USDC_ATOMIC);
  assert.equal(minimumProviderPriceAtomic(6), BigInt(1000));
  assert.equal(minimumProviderPriceAtomic(18), BigInt("1000000000000000"));
  assert.equal(minimumProviderPriceAtomic(2), null);
  assert.equal(minimumProviderPriceAtomic("6"), null);
  assert.equal(parseProviderPrice("0.001", 6), minimumProviderPriceAtomic(6));
});

test("la saisie du formulaire se convertit exactement comme la route serveur", () => {
  const samples = [
    "0.001", "0.0010", "0.00100", "1", "10", "20", "20.5", "20.50", "0.5", "999999.999", "1000000", "1000000.000",
    "7", " 7 ", "0", "0.0001", "0.0009", "1000000.001", "1000001", "-1", "+1", "1e3", "01", "00.5", ".5", "5.", "20,5",
    "", " ", "abc", "0x10", "Infinity", "NaN", "1 000", "1_000", "١٠",
    `0.${"1".repeat(USDC_DECIMALS)}`, `0.${"1".repeat(USDC_DECIMALS + 1)}`, "9999999", "10000000",
  ];
  for (const sample of samples) {
    const expected = priceUsdcToAtomic(sample);
    const actual = parseProviderPrice(sample, USDC_DECIMALS);
    assert.equal(actual === null ? null : actual.toString(), expected, JSON.stringify(sample));
  }
});

test("la précision est celle passée en paramètre, pas une lecture d'environnement", () => {
  assert.equal(parseProviderPrice("20", 6)?.toString(), "20000000");
  assert.equal(parseProviderPrice("20", 18)?.toString(), "20000000000000000000");
  assert.equal(parseProviderPrice("0.001", 6)?.toString(), "1000");
  assert.equal(parseProviderPrice("0.001", 3)?.toString(), "1");
  assert.equal(parseProviderPrice("0.0001", 6), null, "sous le plancher de 0,001");
  assert.equal(parseProviderPrice("0.1234567", 6), null, "plus de décimales que le jeton");
  assert.equal(parseProviderPrice("0.123456", 6)?.toString(), "123456");
  for (const decimals of [2, -1, 1.5, 37, "6", null, undefined, Number.NaN]) {
    assert.equal(parseProviderPrice("20", decimals), null, `décimales ${String(decimals)}`);
  }
  for (const value of [20, null, undefined, {}, ["20"], BigInt(20)]) {
    assert.equal(parseProviderPrice(value, 6), null, `valeur ${String(value)}`);
  }
});
