import { formatUnits } from "viem";
import { groupDigits } from "@/lib/copy/numbers";

/**
 * Montants en unités atomiques du jeton (6 décimales pour l'USDG, 18 sur le testnet).
 *
 * Tout le calcul se fait en `bigint`, sans jamais passer par un nombre à virgule : un
 * montant affiché est exactement le montant atomique reçu, jamais arrondi. Le total est
 * la somme exacte des deux lignes.
 */

export interface TokenInfo {
  /** Symbole affiché (« USDG »). Passé explicitement : le jeton change selon le réseau. */
  symbol: string;
  /** Décimales du jeton, lues sur le contrat. */
  decimals: number;
}

export type AtomicAmount = string | bigint;

/** Borne du contrat d'escrow : les montants du devis tiennent dans un uint96 (voir `quote.ts`). */
const MAX_ATOMIC = (BigInt(1) << BigInt(96)) - BigInt(1);
const MAX_DECIMALS = 36;
const MIN_FRACTION_DIGITS = 2;

/** Montant atomique valide en `bigint`, ou `null` (négatif, décimal, vide, trop grand, mal formé). */
export function parseAtomic(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= BigInt(0) && value <= MAX_ATOMIC ? value : null;
  // Sans zéro de tête, comme les montants du devis : « 0020 » n'est pas un montant canonique.
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,28})$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= MAX_ATOMIC ? amount : null;
}

export function isValidDecimals(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DECIMALS;
}

/**
 * Montant lisible, exact : jamais arrondi, au moins deux décimales (« 20.00 »), toutes les
 * décimales significatives sinon (« 0.001 », « 23.456789 »), milliers séparés par des virgules.
 * Renvoie `null` si le montant ou les décimales sont invalides.
 */
export function formatTokenAmount(atomic: unknown, decimals: unknown): string | null {
  const amount = parseAtomic(atomic);
  if (amount === null || !isValidDecimals(decimals)) return null;
  const [whole, fraction = ""] = formatUnits(amount, decimals).split(".");
  const padded = fraction.padEnd(Math.min(decimals, MIN_FRACTION_DIGITS), "0");
  return padded ? `${groupDigits(whole)}.${padded}` : groupDigits(whole);
}

/** Montant suivi du symbole (« 23.00 USDG »), ou `null` si invalide. */
export function formatTokenWithSymbol(atomic: unknown, token: TokenInfo): string | null {
  const amount = formatTokenAmount(atomic, token.decimals);
  return amount === null ? null : `${amount} ${token.symbol}`;
}

export type PriceBreakdownResult =
  | {
      ok: true;
      provider: bigint;
      compute: bigint;
      /** Somme exacte de la part du fournisseur et des frais de calcul. */
      total: bigint;
      /** Minimum applicable à la part du fournisseur, s'il est connu. */
      minimum: bigint | null;
      /** Vrai si la part du fournisseur est strictement sous le minimum. */
      belowMinimum: boolean;
    }
  | { ok: false; reason: "invalid-amount" | "invalid-decimals" | "invalid-minimum" | "total-too-large" };

export interface PriceBreakdownInput {
  providerAtomic: unknown;
  computeAtomic: unknown;
  decimals: unknown;
  minimumAtomic?: unknown;
}

export function computePriceBreakdown(input: PriceBreakdownInput): PriceBreakdownResult {
  if (!isValidDecimals(input.decimals)) return { ok: false, reason: "invalid-decimals" };
  const provider = parseAtomic(input.providerAtomic);
  const compute = parseAtomic(input.computeAtomic);
  if (provider === null || compute === null) return { ok: false, reason: "invalid-amount" };
  let minimum: bigint | null = null;
  if (input.minimumAtomic !== undefined && input.minimumAtomic !== null) {
    minimum = parseAtomic(input.minimumAtomic);
    if (minimum === null) return { ok: false, reason: "invalid-minimum" };
  }
  const total = provider + compute;
  if (total > MAX_ATOMIC) return { ok: false, reason: "total-too-large" };
  return { ok: true, provider, compute, total, minimum, belowMinimum: minimum !== null && provider < minimum };
}
