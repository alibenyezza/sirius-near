import type { TokenInfo } from "@/components/datasets/price";
import type { EvmNetwork } from "@/lib/evm/networks";
import { USDC_DECIMALS_BY_NETWORK } from "@/lib/evm/networks";

/**
 * Jeton de règlement affiché par la marketplace, choisi par le serveur et renvoyé dans chaque
 * réponse : le navigateur n'a pas à deviner le réseau.
 *
 * Mainnet : USDG (décision 1 de docs/passage-mainnet/01-decisions-avant-samedi.md), 6 décimales
 * annoncées, la même table de précision que les règlements (`USDC_DECIMALS_BY_NETWORK`).
 * Testnet : l'USDC du testnet Robinhood, 18 décimales.
 */
export function marketplaceToken(network: EvmNetwork): TokenInfo {
  return { symbol: network === "mainnet" ? "USDG" : "USDC", decimals: USDC_DECIMALS_BY_NETWORK[network] };
}
