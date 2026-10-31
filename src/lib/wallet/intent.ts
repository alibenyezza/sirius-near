"use client";

/**
 * Mémorise le fait que l'utilisateur a demandé à se déconnecter.
 *
 * Sans cette mémoire, la déconnexion ne tient pas : `wallet_revokePermissions` est
 * une méthode que tous les portefeuilles n'implémentent pas — Phantom notamment la
 * refuse — et l'échec est silencieux. Le portefeuille reste donc autorisé, la
 * synchronisation au montage retrouve le compte via `eth_accounts`, et l'utilisateur
 * se voit reconnecté puis renvoyé sur son tableau de bord.
 *
 * On ne peut pas forcer un portefeuille à oublier une autorisation. En revanche on
 * peut refuser de s'en servir tant que l'utilisateur n'a pas explicitement redemandé
 * à se connecter, ce qui est exactement ce qu'il attend d'un bouton « Déconnecter ».
 *
 * Le choix vit dans `localStorage` : un rechargement de page ne doit pas le perdre,
 * sinon la déconnexion ne durerait que jusqu'à la prochaine navigation.
 */

const CLE = "sirius.wallet.disconnected";

export function markWalletDisconnected(): void {
  try {
    window.localStorage.setItem(CLE, "1");
  } catch {
    // Stockage indisponible (navigation privée verrouillée, cookies bloqués) : la
    // déconnexion ne survivra pas au rechargement, mais elle vaut mieux que rien et
    // ne doit surtout pas faire échouer le clic.
  }
}

export function clearWalletDisconnected(): void {
  try {
    window.localStorage.removeItem(CLE);
  } catch {
    // Voir ci-dessus.
  }
}

export function walletDisconnectedByUser(): boolean {
  try {
    return window.localStorage.getItem(CLE) === "1";
  } catch {
    return false;
  }
}
