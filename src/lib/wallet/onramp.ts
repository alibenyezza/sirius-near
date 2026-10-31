"use client";

import { resolveClientNetwork } from "@/lib/evm/networks";

/**
 * Approvisionnement du compte connecté.
 *
 * Sur une instance de démonstration, « ajouter des fonds » veut dire frapper des
 * jetons de test : le réseau est un testnet et le jeton a une frappe ouverte. Aucun
 * service d'achat par carte ne vend cette monnaie-là, et il serait absurde d'en
 * chercher un.
 *
 * Sur une instance réelle, la même intention passe par MoonPay, d'où le repli. La
 * fenêtre y est ouverte après l'appel réseau, ce qui peut la faire bloquer sur Safari
 * — compromis assumé : le chemin de démonstration est celui qui sert aujourd'hui, et
 * il ne doit pas ouvrir de fenêtre parasite à chaque clic.
 */

export interface FondsAjoutes {
  usdc: string;
  eth: string | null;
  usdcTxHash: string;
}

export async function addFunds(): Promise<FondsAjoutes> {
  // Sur mainnet, le faucet n'existe pas : on va directement au pont, sans aller-retour
  // inutile qui retarderait l'ouverture de la fenêtre après le clic.
  const mainnet = resolveClientNetwork() === "mainnet";
  const response = mainnet ? null : await fetch("/api/faucet", { method: "POST" });
  const body = response ? await response.json().catch(() => ({})) : {};

  if (response?.ok) return body as FondsAjoutes;

  // 503 : pas une instance de démonstration. On tente l'achat réel.
  if (!response || response.status === 503) {
    const onramp = await fetch("/api/onramp");
    const urlBody = await onramp.json().catch(() => ({}));
    if (onramp.ok && typeof urlBody.url === "string") {
      // `noopener` : la page ouverte ne peut pas manipuler l'onglet Sirius en retour.
      if (urlBody.kind === "bridge") {
        window.open(urlBody.url, "_blank", "noopener,noreferrer");
        throw new Error("Pont ouvert : envoie de l’USDC ou de l’USDG vers Robinhood Chain depuis un autre réseau, il arrive en USDG");
      }
      window.open(urlBody.url, "moonpay", "popup,width=460,height=720,noopener");
      throw new Error("Fenêtre d'achat ouverte");
    }
  }

  throw new Error(typeof body.error === "string" ? body.error : "Ajout de fonds indisponible");
}

/**
 * Approvisionne un compte qui n'a jamais rien eu, sans en faire une étape.
 *
 * Un visiteur qui arrive par une connexion sociale reçoit une adresse neuve : zéro ETH,
 * zéro USDC, et un catalogue qu'il peut lire sans rien pouvoir en faire. Le bouton
 * « Ajouter des fonds » existe, mais il suppose de comprendre qu'il faut cliquer dessus
 * avant d'essayer quoi que ce soit — exactement la marche que la connexion Google
 * cherchait à supprimer.
 *
 * Trois précautions, qui sont tout l'intérêt de ne pas réutiliser `addFunds` :
 *
 * 1. Seulement à solde nul. Le faucet frappe l'USDC sans condition ; l'appeler à chaque
 *    connexion distribuerait mille jetons de plus à qui en a déjà. Un solde natif à zéro
 *    est la marque d'un compte qui n'a jamais servi.
 * 2. Aucune fenêtre. `addFunds` ouvre MoonPay quand le faucet répond 503 ; une fenêtre
 *    que personne n'a demandée serait au mieux surprenante, au pire bloquée par le
 *    navigateur puisqu'aucun clic ne la précède.
 * 3. Un plafond de patience. Le faucet attend deux reçus ; si la chaîne traîne, la
 *    connexion ne doit pas rester suspendue pour autant.
 *
 * Ne lève jamais. L'utilisateur est connecté, c'est ce qu'il demandait ; s'il manque de
 * fonds, le bouton reste là pour les réclamer.
 */
export async function ensureStarterFunds(address: string): Promise<void> {
  const { useWalletStore } = await import("@/stores/wallet");
  const marquer = useWalletStore.getState().setStarterFunds;
  marquer("pending");
  try {
    const { fetchGasBalance } = await import("@/lib/evm/balance");
    const { wei } = await fetchGasBalance(address);
    if (wei !== "0") {
      marquer("skipped");
      return;
    }

    const abandon = AbortSignal.timeout(20_000);
    const response = await fetch("/api/faucet", { method: "POST", signal: abandon });
    if (response.ok) {
      marquer("funded");
      return;
    }
    // Le motif du refus est celui du serveur — rationnement, réserve à sec, instance sans
    // faucet — et il est sûr à afficher : ce sont des AppError. On ne l'invente pas.
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    marquer({ failed: typeof body?.error === "string" ? body.error : "Ajout de fonds indisponible" });
  } catch {
    // Ne lève jamais : l'utilisateur est connecté, c'est ce qu'il demandait. Mais l'écran
    // doit savoir que rien n'est arrivé, sinon il attend des fonds qui ne viendront pas.
    marquer({ failed: "Ajout de fonds indisponible" });
  }
}
