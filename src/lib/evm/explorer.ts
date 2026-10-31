import { EVM_CHAINS, type EvmNetwork } from "./networks";

/**
 * Liens vers l'explorateur Blockscout de Robinhood Chain.
 * Liens d'exploration EVM, consommés par la page `/audit`.
 */

function explorerBase(network: EvmNetwork): string {
  const url = EVM_CHAINS[network].blockExplorers?.default.url;
  if (!url) throw new Error(`Aucun explorateur configuré pour le réseau ${network}`);
  return url;
}

export function transactionExplorerUrl(network: EvmNetwork, txHash: string): string {
  return `${explorerBase(network)}/tx/${encodeURIComponent(txHash)}`;
}

export function addressExplorerUrl(network: EvmNetwork, address: string): string {
  return `${explorerBase(network)}/address/${encodeURIComponent(address)}`;
}

/** Lien vers un titre de dataset (ERC-721 soulbound) dans le registre. */
export function tokenExplorerUrl(network: EvmNetwork, contract: string, tokenId: string): string {
  return `${explorerBase(network)}/token/${encodeURIComponent(contract)}/instance/${encodeURIComponent(tokenId)}`;
}
