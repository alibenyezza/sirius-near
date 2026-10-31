import { isValidDecimals } from "@/components/datasets/price";

/**
 * Saisie du gain du fournisseur (« what I want to earn per loan »), convertie en unités
 * atomiques avec la précision du jeton fournie par le serveur.
 *
 * Mêmes règles que `priceUsdcToAtomic` (src/lib/evm/usdc.ts), qui tranche côté serveur :
 * partie entière de sept chiffres au plus sans zéro de tête, au plus `decimals` décimales,
 * jamais d'arrondi, plancher 0,001 et plafond 1 000 000. `price-input.test.ts` vérifie
 * l'accord des deux fonctions ; la précision est passée en paramètre pour que le formulaire
 * utilise celle du serveur et non une lecture d'environnement du bundle.
 */
export const MIN_PROVIDER_PRICE_UNITS = 1_000; // millièmes : 0,001 jeton
export const MAX_PROVIDER_PRICE_WHOLE = 1_000_000;

/** Plancher de la part du fournisseur (0,001 jeton) pour une précision donnée, ou `null` si invalide. */
export function minimumProviderPriceAtomic(decimals: unknown): bigint | null {
  if (!isValidDecimals(decimals) || decimals < 3) return null;
  return (BigInt(10) ** BigInt(decimals)) / BigInt(MIN_PROVIDER_PRICE_UNITS);
}

export function parseProviderPrice(value: unknown, decimals: unknown): bigint | null {
  if (typeof value !== "string" || !isValidDecimals(decimals) || decimals < 3) return null;
  const match = new RegExp(`^(0|[1-9][0-9]{0,6})(?:\\.([0-9]{1,${decimals}}))?$`).exec(value.trim());
  if (!match) return null;
  const scale = BigInt(10) ** BigInt(decimals);
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  const amount = BigInt(match[1]) * scale + BigInt(fraction || "0");
  const minimum = scale / BigInt(MIN_PROVIDER_PRICE_UNITS);
  const maximum = scale * BigInt(MAX_PROVIDER_PRICE_WHOLE);
  return amount < minimum || amount > maximum ? null : amount;
}
