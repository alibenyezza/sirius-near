import { signOut } from "@/lib/auth/client";
import { disconnectWallet } from "@/lib/wallet/manager";
import { markWalletDisconnected } from "@/lib/wallet/intent";
import { useWalletStore } from "@/stores/wallet";

/**
 * Déconnexion complète, partagée par le menu du bouton de connexion et par le bouton profil.
 *
 * L'intention est posée avant toute chose : si la révocation ou la fermeture de session
 * échoue, le geste de l'utilisateur doit tout de même être respecté. Le store est vidé
 * quoi qu'il arrive, dans le `finally`.
 */
export async function logoutCurrentWallet(): Promise<void> {
  try {
    markWalletDisconnected();
    await signOut();
    await disconnectWallet();
  } finally {
    useWalletStore.getState().setDisconnected();
  }
}
