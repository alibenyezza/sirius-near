import { create } from "zustand";

export type WalletRole = "provider" | "borrower" | null;
export type WalletSource = "external" | null;
/**
 * Issue de l'approvisionnement automatique d'un compte neuf. Un échec y reste lisible :
 * sans cela, un faucet à sec ou rationné laissait l'utilisateur devant un solde nul sans
 * qu'aucun écran ne dise pourquoi — l'appel était avalé en silence.
 */
export type StarterFundsState = "idle" | "pending" | "funded" | "skipped" | { failed: string };

interface WalletState {
  revision: number;
  address: string | null;
  network: string | null;
  connected: boolean;
  connecting: boolean;
  role: WalletRole;
  // Origine de la connexion active : wallet EIP-1193 injecté.
  source: WalletSource;
  // Session serveur active (cookie signé) : le wallet a prouvé sa possession par signature.
  authenticated: boolean;
  // Réservé à une future connexion embarquée ; toujours faux pour les wallets externes.
  mfaEnabled: boolean;
  starterFunds: StarterFundsState;
  setStarterFunds: (starterFunds: StarterFundsState) => void;
  setConnected: (address: string, network: string, source: Exclude<WalletSource, null>) => void;
  setDisconnected: () => void;
  setConnecting: (connecting: boolean) => void;
  setNetwork: (network: string) => void;
  setRole: (role: WalletRole) => void;
  setAuthenticated: (authenticated: boolean) => void;
  setMfaEnabled: (mfaEnabled: boolean) => void;
}

// Pas de persistance : l'état reflète le provider EIP-1193 live.
export const useWalletStore = create<WalletState>((set) => ({
  revision: 0,
  address: null,
  network: null,
  connected: false,
  connecting: false,
  role: null,
  source: null,
  authenticated: false,
  mfaEnabled: false,
  starterFunds: "idle",
  setStarterFunds: (starterFunds) => set({ starterFunds }),
  setConnected: (address, network, source) =>
    // Un nouveau wallet invalide toute session précédente → on repart non authentifié / non sécurisé.
    set((state) => ({ revision: state.revision + 1, address, network, source, connected: true, connecting: false, authenticated: false, mfaEnabled: false, starterFunds: "idle" })),
  setDisconnected: () =>
    set((state) => ({
      revision: state.revision + 1,
      address: null,
      network: null,
      connected: false,
      connecting: false,
      role: null,
      source: null,
      authenticated: false,
      mfaEnabled: false,
      starterFunds: "idle",
    })),
  setConnecting: (connecting) => set({ connecting }),
  setNetwork: (network) => set((state) => state.network === network ? state : { network, revision: state.revision + 1, authenticated: false }),
  setRole: (role) => set({ role }),
  setAuthenticated: (authenticated) => set({ authenticated }),
  setMfaEnabled: (mfaEnabled) => set({ mfaEnabled }),
}));
