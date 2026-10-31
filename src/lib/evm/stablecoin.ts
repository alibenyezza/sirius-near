import type { EvmNetwork } from "./networks";

/**
 * Jeton de règlement de chaque réseau.
 *
 * Mainnet : **USDG**, le « Global Dollar » émis par Paxos. Adresse prise dans la
 * documentation Paxos (« USDG on Main Networks », réseau Robinhood) et vérifiée
 * sur le RPC public de Robinhood Chain (4663) le 4 octobre 2026 :
 * `name()` = « Global Dollar », `symbol()` = « USDG », `decimals()` = 6,
 * `paused()` = false. Le contrat est un proxy ERC-1967 (170 octets de code,
 * keccak256 `0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6`)
 * dont l'implémentation (`0x68184c449e1a8f34fa18d289737129fd27b66f8f` ce jour-là)
 * peut être remplacée par Paxos : le code hash contrôlé au déploiement reste
 * donc stable même quand la logique du jeton change. Voir docs/MAINNET-RUNBOOKS.md.
 *
 * Testnet : le jeton d'essai « USDC » du testnet Robinhood, 18 décimales, sans
 * valeur (voir `USDC_DECIMALS_BY_NETWORK` dans networks.ts).
 *
 * Les variables d'environnement et les identifiants internes gardent leur nom
 * historique (`SIRIUS_USDC_ADDRESS`, `usdc`, `formatUsdcAtomic`…) : seul le
 * libellé affiché et le jeton imposé sur mainnet changent.
 */

/** Adresse USDG sur Robinhood Chain mainnet, en minuscules pour les comparaisons. */
export const MAINNET_STABLECOIN_ADDRESS = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const MAINNET_STABLECOIN_SYMBOL = "USDG";
export const MAINNET_STABLECOIN_NAME = "Global Dollar";
/** Confirmé on-chain : identique à `USDC_DECIMALS_BY_NETWORK.mainnet`, que `deploy.ts` revérifie. */
export const MAINNET_STABLECOIN_DECIMALS = 6;

/** Libellé du jeton d'essai : clé de traduction existante, « test USDC » dans les deux langues. */
export const TESTNET_STABLECOIN_LABEL = "test USDC";

const SYMBOL_BY_NETWORK: Record<EvmNetwork, string> = {
  mainnet: MAINNET_STABLECOIN_SYMBOL,
  testnet: TESTNET_STABLECOIN_LABEL,
};

/**
 * Libellé du jeton à afficher à côté d'un montant. « USDG » est un symbole : il
 * s'affiche tel quel, sans traduction. « test USDC » est la clé de traduction que
 * les pages passent à `t()`. Un réseau inconnu lève une erreur plutôt que
 * d'afficher un libellé faux à côté d'un solde.
 */
/**
 * Ticker court pour les libellés techniques (« Lock USDG », crédits à retirer) : USDG sur
 * mainnet, USDC sur testnet, jamais traduit.
 */
export function stablecoinTicker(network: EvmNetwork): "USDG" | "USDC" {
  return network === "mainnet" ? MAINNET_STABLECOIN_SYMBOL : "USDC";
}

export function stablecoinSymbol(network: EvmNetwork): string {
  const symbol = SYMBOL_BY_NETWORK[network];
  if (!symbol) throw new Error(`Réseau inconnu pour le jeton de règlement : ${String(network)}`);
  return symbol;
}
