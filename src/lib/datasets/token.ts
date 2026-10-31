import type { EvmNetwork } from "@/lib/evm/networks";
import { USDC_DECIMALS } from "@/lib/evm/usdc";
import type { TokenInfo } from "@/components/datasets/price";

/**
 * Jeton de règlement affiché par l'upload, selon le réseau : USDG (Paxos) sur mainnet
 * (01-decisions-avant-samedi.md §1), USDC de test sur le testnet Robinhood.
 *
 * Les décimales sont `USDC_DECIMALS`, la même valeur que celle avec laquelle la route de
 * création convertit le prix (`priceUsdcToAtomic`) : le formulaire et le serveur calculent
 * ainsi le même montant atomique, sans seconde résolution de l'environnement.
 * `contracts/scripts/deploy.ts` vérifie cette précision on-chain au déploiement.
 *
 * Il n'existe pas encore de fabrique centrale du jeton (audit A2 §8) : celle-ci ne sert
 * que l'upload et pourra être remplacée par la fabrique de la slice USDG.
 */
export function settlementToken(network: EvmNetwork): TokenInfo {
  return { symbol: network === "mainnet" ? "USDG" : "USDC", decimals: USDC_DECIMALS };
}
