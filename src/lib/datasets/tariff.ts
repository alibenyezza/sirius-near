import type { BillingPolicy } from "@/lib/billing/config";
import { MODEL_REGISTRY, type ModelId } from "@/lib/models/registry";
import { computePriceBreakdown, parseAtomic, type PriceBreakdownResult } from "@/components/datasets/price";

/**
 * Tarif en vigueur tel que l'upload l'affiche (07-upload.md, étape 2) : les frais de calcul
 * par profil d'entraînement et le minimum imposé à la part du fournisseur.
 *
 * Module pur, partagé par la page serveur (qui le construit depuis la politique de
 * facturation) et le formulaire (qui l'affiche). Les montants sont des chaînes d'unités
 * atomiques, comme dans le devis ; aucun nombre à virgule n'intervient.
 */
export interface PublishedTariff {
  /** `tariffVersion` de la politique, ou `legacy-v6` quand la facturation v7 n'est pas active. */
  version: string;
  /** Frais de calcul par profil : ce que le devis annoncera à l'emprunteur en plus de la part du fournisseur. */
  computeFeeAtomic: Record<ModelId, string>;
  /** Plancher de la part du fournisseur (`MIN_PRICE_USDC_ATOMIC`), refusé en dessous par la route. */
  minimumProviderAtomic: string;
  /** Décimales du jeton de règlement, pour affichage. */
  decimals: number;
}

export interface ExpectedTariffScope {
  chainId: number;
  /** Adresse du jeton de règlement, en minuscules. */
  usdc: string;
  decimals: number;
  minimumProviderAtomic: string;
}

const MODEL_IDS = Object.keys(MODEL_REGISTRY) as ModelId[];

/**
 * Frais de calcul d'un profil, exactement comme `prepareComputeQuote` (src/lib/billing/runner.ts)
 * les met dans le devis : le montant du profil, relevé au minimum de la politique.
 */
function computeFee(policy: BillingPolicy, modelId: ModelId): string {
  const configured = BigInt(policy.profiles[modelId].computeAmount);
  const minimum = BigInt(policy.minimumComputeAmount);
  return (configured > minimum ? configured : minimum).toString();
}

/**
 * Tarif affiché à partir d'une politique de facturation déjà validée (`validateBillingPolicy`).
 * Renvoie `null` si la politique ne vise pas la chaîne, le jeton ou la précision du serveur :
 * mieux vaut annoncer « tarif indisponible » qu'un montant d'un autre réseau.
 */
export function tariffFromPolicy(policy: BillingPolicy, expected: ExpectedTariffScope): PublishedTariff | null {
  if (policy.chainId !== expected.chainId || policy.usdc !== expected.usdc || policy.usdcDecimals !== expected.decimals) {
    return null;
  }
  if (parseAtomic(expected.minimumProviderAtomic) === null) return null;
  return {
    version: policy.tariffVersion,
    computeFeeAtomic: Object.fromEntries(MODEL_IDS.map((id) => [id, computeFee(policy, id)])) as Record<ModelId, string>,
    minimumProviderAtomic: expected.minimumProviderAtomic,
    decimals: expected.decimals,
  };
}

/** Sans facturation v7, l'escrow bloque le seul prix du dataset : les frais de calcul sont nuls. */
export function legacyTariff(decimals: number, minimumProviderAtomic: string): PublishedTariff | null {
  if (parseAtomic(minimumProviderAtomic) === null) return null;
  return {
    version: "legacy-v6",
    computeFeeAtomic: Object.fromEntries(MODEL_IDS.map((id) => [id, "0"])) as Record<ModelId, string>,
    minimumProviderAtomic,
    decimals,
  };
}

/** Décomposition affichée pour une part de fournisseur donnée (unités atomiques) et un profil. */
export function providerPriceBreakdown(
  tariff: PublishedTariff,
  modelId: ModelId,
  providerAtomic: string,
): PriceBreakdownResult {
  return computePriceBreakdown({
    providerAtomic,
    computeAtomic: tariff.computeFeeAtomic[modelId],
    decimals: tariff.decimals,
    minimumAtomic: tariff.minimumProviderAtomic,
  });
}
