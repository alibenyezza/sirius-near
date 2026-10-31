import type { EvmNetwork } from "@/lib/evm/networks";

/**
 * Parcours d'ajout de fonds selon le réseau (docs/passage-mainnet/05-wallet.md).
 *
 * - testnet : le parcours actuel, le faucet de démonstration (`/api/faucet`).
 * - mainnet : carte (MoonPay, si clés live) et réception par transfert ; le pont a été retiré
 *   de la fenêtre le 4 octobre. Avant : le pont existant (`/api/onramp`, kind « bridge »), et la réception
 *   d'USDG par simple transfert vers l'adresse du compte (adresse + QR code). Le faucet
 *   n'existe pas sur mainnet : le serveur le refuse hors instance de démonstration.
 *
 * Le bouton historique de la page Wallet appelle `addFunds()` dans les deux cas ; ce choix
 * ne décide que de ce qui est affiché autour.
 */
export interface AddFundsOptions {
  /** Distribution de fonds de test : testnet uniquement. */
  faucet: boolean;
  /** Pont vers Robinhood Chain : seul chemin existant sur mainnet. */
  bridge: boolean;
  /** Réception par transfert : adresse et QR code. Mainnet uniquement. */
  transfer: boolean;
}

export function addFundsOptions(network: EvmNetwork): AddFundsOptions {
  return network === "mainnet"
    ? { faucet: false, bridge: false, transfer: true }
    : { faucet: true, bridge: false, transfer: false };
}
