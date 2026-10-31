"use client";

import { useEffect } from "react";
import { clearWalletDisconnected, walletDisconnectedByUser } from "@/lib/wallet/intent";
import { invalidateWalletSession } from "@/lib/auth/client";
import { hasRunnerDelegation } from "@/lib/runner/authorization-client";
import { tryNormalizeAddress } from "@/lib/evm/address";
import { EVM_CHAIN_IDS, resolveClientNetwork, type EvmNetwork } from "@/lib/evm/networks";
import { connectExternalWallet, getExternalWallet } from "@/lib/wallet/manager";
import { EMBEDDED_RDNS, embeddedSelected, selectWallet, subscribeWalletChanges } from "@/lib/wallet/discovery";
import { useWalletStore } from "@/stores/wallet";

function networkForChain(chainId: unknown): string {
  if (typeof chainId !== "string") return "unknown";
  const parsed = Number.parseInt(chainId, 16);
  return (Object.entries(EVM_CHAIN_IDS).find(([, id]) => id === parsed)?.[0] as EvmNetwork | undefined) ?? chainId;
}

/**
 * Aligne l'état du navigateur sur la session que le serveur reconnaît.
 *
 * Le store wallet ne persiste pas — c'est délibéré, il doit refléter le provider
 * vivant — mais le cookie de session, lui, dure sept jours. Au montage, le
 * store est donc vide face à une session encore ouverte, et la divergence ressemblait
 * à s'y méprendre à un changement de compte : on détruisait la session à chaque
 * navigation. L'utilisateur signait, changeait de page, et se retrouvait déconnecté
 * sans qu'aucun message ne l'explique.
 *
 * C'est le serveur qui tranche, puisque c'est lui qui détient le cookie. Trois cas :
 * une session pour cette adresse, on se déclare authentifié ; une session pour une
 * autre adresse, vestige d'un compte précédent, on la ferme ; aucune session, il n'y
 * a rien à faire et l'utilisateur signera.
 */
async function synchroniserSession(address: string, current: () => boolean): Promise<void> {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) return;
    const { authenticated, address: sessionAddress } = (await response.json()) as {
      authenticated?: unknown;
      address?: unknown;
    };
    if (!current() || authenticated !== true) return;

    if (tryNormalizeAddress(sessionAddress) !== address) {
      void invalidateWalletSession();
      return;
    }
    const delegationReady = await hasRunnerDelegation(address, useWalletStore.getState().network);
    // Le compte a pu changer pendant l'aller-retour réseau.
    if (current() && useWalletStore.getState().address === address) {
      useWalletStore.getState().setAuthenticated(delegationReady);
    }
  } catch {
    // Serveur injoignable : on reste non authentifié plutôt que de l'affirmer à tort.
    // L'utilisateur peut toujours signer, ce qui rétablira l'état.
  }
}

/** Résout après la reprise éventuelle d'une session serveur déjà ouverte pour ce compte. */
export async function connectWallet(): Promise<void> {
  // Clic explicite sur « Connecter » : on lève l'intention de déconnexion, sinon la
  // synchronisation continuerait de refuser le compte que l'utilisateur vient de
  // rouvrir, et le bouton semblerait ne rien faire.
  clearWalletDisconnected();
  const wallet = getExternalWallet();
  if (!wallet) throw new Error("Aucun wallet détecté");
  const { address, chainId } = await connectExternalWallet(wallet);
  if (getExternalWallet() !== wallet || walletDisconnectedByUser()) return;
  const normalized = tryNormalizeAddress(address);
  if (!normalized) throw new Error("Adresse EVM invalide.");
  useWalletStore.getState().setConnected(normalized, networkForChain(chainId), "external");
  await synchroniserSession(normalized, () => getExternalWallet() === wallet && useWalletStore.getState().address === normalized && useWalletStore.getState().network === networkForChain(chainId));
}

export function openWalletModal(): void {
  void connectWallet().catch((error) => console.error("Connexion wallet EVM échouée", error));
}

/**
 * Ouvre la connexion sociale et adopte le compte obtenu.
 *
 * Le SDK n'est chargé qu'ici, à l'instant du clic : il pèse plusieurs centaines de
 * kilo-octets, et l'immense majorité des visiteurs d'une page publique ne s'en servira
 * jamais. Un import statique l'aurait mis dans le bundle de chaque page.
 *
 * Le choix n'est mémorisé qu'après une connexion réussie. Une fenêtre Google refermée sans
 * rien valider ne doit pas laisser l'application convaincue qu'un portefeuille embarqué est
 * sélectionné — elle refuserait alors l'extension que l'utilisateur voulait peut-être.
 *
 * Côté serveur, la source reste « external » : c'est une EOA qui a signé, et rien dans
 * Sirius n'a besoin de savoir d'où venait sa clé.
 */
export function openEmbeddedWallet(): Promise<void> {
  clearWalletDisconnected();
  return (async () => {
    const { connectEmbedded } = await import("@/lib/wallet/embedded");
    const { address, chainId } = await connectEmbedded();
    if (walletDisconnectedByUser()) return;
    const normalized = tryNormalizeAddress(address);
    if (!normalized) throw new Error("Adresse EVM invalide.");
    selectWallet(EMBEDDED_RDNS);
    useWalletStore.getState().setConnected(normalized, networkForChain(chainId), "external");
    void synchroniserSession(normalized, () =>
      useWalletStore.getState().address === normalized &&
      useWalletStore.getState().network === networkForChain(chainId),
    );
  })().catch((error) => {
    // Journalisé *et* relancé : la console sert au diagnostic, mais l'utilisateur qui vient
    // de cliquer doit voir qu'il s'est passé quelque chose. Un bouton silencieux se lit
    // comme un bouton cassé, et c'est exactement ce qu'on a vécu en recette.
    console.error("Connexion Google échouée", error);
    throw error;
  });
}

export function WalletConnector() {
  const setConnected = useWalletStore((state) => state.setConnected);
  const setDisconnected = useWalletStore((state) => state.setDisconnected);
  const setNetwork = useWalletStore((state) => state.setNetwork);

  useEffect(() => {
    let wallet: ReturnType<typeof getExternalWallet>;
    let detach = () => {};
    const bind = () => {
      const next = getExternalWallet();
      if (wallet === next) return;
      detach();
      if (wallet) setDisconnected();
      wallet = next;
      if (!next) return;
      const provider = next;
      let active = true;
      let generation = 0;
      const current = (version: number) => active && generation === version && getExternalWallet() === provider && !walletDisconnectedByUser();
      const sync = async () => {
        // L'utilisateur s'est déconnecté : le portefeuille reste peut-être autorisé,
        // mais le reconnecter d'office annulerait son geste sous ses yeux.
        if (walletDisconnectedByUser()) return;
        const version = ++generation;
        const [accounts, chainId] = await Promise.all([
          provider.request({ method: "eth_accounts" }),
          provider.request({ method: "eth_chainId" }),
        ]);
        if (!current(version) || useWalletStore.getState().connected || !Array.isArray(accounts) || typeof accounts[0] !== "string") return;
        const address = tryNormalizeAddress(accounts[0]);
        if (!address) return;
        setConnected(address, networkForChain(chainId), "external");
        void synchroniserSession(address, () => current(version));
      };
      const onAccountsChanged = (accounts: unknown) => {
        if (!active || getExternalWallet() !== provider) return;
        const version = ++generation;
        // Un changement de compte est un geste délibéré : il vaut demande de connexion.
        clearWalletDisconnected();
        const address = tryNormalizeAddress(Array.isArray(accounts) ? accounts[0] : undefined);
        if (!address) {
          void invalidateWalletSession();
          setDisconnected();
          return;
        }
        setConnected(address, useWalletStore.getState().network ?? "unknown", "external");
        void provider.request({ method: "eth_chainId" }).then((chainId) => {
          if (!current(version)) return;
          setNetwork(networkForChain(chainId));
          void synchroniserSession(address, () => current(version));
        }).catch(() => {});
      };
      const onChainChanged = (chainId: unknown) => {
        if (!active || getExternalWallet() !== provider) return;
        generation += 1;
        void invalidateWalletSession();
        setNetwork(networkForChain(chainId));
      };
      provider.on?.("accountsChanged", onAccountsChanged);
      provider.on?.("chainChanged", onChainChanged);
      void sync().catch(() => {});
      detach = () => {
        active = false;
        provider.removeListener?.("accountsChanged", onAccountsChanged);
        provider.removeListener?.("chainChanged", onChainChanged);
      };
    };
    // Une extension s'annonce d'elle-même ; une session sociale, non. Si c'est elle que
    // l'utilisateur avait choisie, il faut la rouvrir pour qu'un provider existe — le SDK
    // garde sa session dans le stockage du navigateur alors que le store, lui, ne persiste
    // pas. La reprise signale ensuite le changement, ce qui relance `bind`.
    if (embeddedSelected()) {
      void import("@/lib/wallet/embedded")
        .then(({ restoreEmbedded }) => restoreEmbedded())
        .catch(() => {});
    }
    const unsubscribe = subscribeWalletChanges(bind);
    bind();
    return () => {
      unsubscribe();
      detach();
    };
  }, [setConnected, setDisconnected, setNetwork]);

  return null;
}

export const EXPECTED_EVM_NETWORK = resolveClientNetwork();
