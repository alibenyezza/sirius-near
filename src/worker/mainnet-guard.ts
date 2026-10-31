/**
 * Refuse de démarrer le reaper mainnet sur une configuration de démonstration.
 *
 * Le Compose du VPS garde des valeurs par défaut historiques (`TEE_MODE=stub`, facturation
 * v6, Phala non exigé) pour les instances testnet. Sur mainnet, l'une d'elles oubliée ferait
 * échouer silencieusement chaque prêt v7 dans la boucle du reaper : remboursements et
 * règlements ne seraient plus réconciliés, sans alerte (audit M9). On s'arrête au démarrage.
 */
import { fastFinalityConfig } from "@/lib/evm/fast-finality";
import { MAINNET_STABLECOIN_DECIMALS } from "@/lib/evm/stablecoin";

type Env = Record<string, string | undefined>;

const REQUIRED = [
  "EVM_RPC_URL", "RUNNER_URL", "RUNNER_TRANSPORT_SECRET", "SIRIUS_LOCK_AUTHORIZER",
  "SIRIUS_USDC_ADDRESS", "SIRIUS_KYB_ADDRESS", "SIRIUS_EXPECTED_MRTD",
  "SIRIUS_EXPECTED_COMPOSE_HASH", "SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256", "NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256",
] as const;

export function reaperMainnetIssues(env: Env = process.env): string[] {
  if (env.EVM_NETWORK?.trim() !== "mainnet") return [];
  const issues: string[] = [];
  if (env.TEE_MODE !== "phala") issues.push("TEE_MODE=phala");
  if (env.SIRIUS_REQUIRE_PHALA !== "true") issues.push("SIRIUS_REQUIRE_PHALA=true");
  if (env.SIRIUS_BILLING_VERSION !== "7") issues.push("SIRIUS_BILLING_VERSION=7");
  if (env.SIRIUS_EVM_FINALITY && env.SIRIUS_EVM_FINALITY !== "finalized") issues.push("SIRIUS_EVM_FINALITY=finalized");
  // Finalité rapide facultative (fast-finality.ts) : `finalized` reste la base, les bornes doivent
  // être lisibles ; une valeur invalide bloque le démarrage plutôt que d'être devinée.
  try {
    fastFinalityConfig(env, MAINNET_STABLECOIN_DECIMALS);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "SIRIUS_FAST_FINALITY");
  }
  for (const name of REQUIRED) if (!env[name]?.trim()) issues.push(name);
  // Aucun escrow historique sur mainnet : une liste héritée du testnet serait « approuvée » à tort.
  if (env.SIRIUS_LEGACY_ESCROW_ADDRESSES?.trim()) issues.push("SIRIUS_LEGACY_ESCROW_ADDRESSES vide");
  return issues;
}

export function assertReaperMainnetConfiguration(env: Env = process.env): void {
  const issues = reaperMainnetIssues(env);
  if (issues.length) throw new Error(`Reaper mainnet refusé, configuration attendue : ${issues.join(", ")}`);
}
