import "server-only";
import { getAddress } from "viem";
import { AppError } from "@/lib/errors";
import { buildSignedBuyUrl } from "@/lib/moonpay/url";
import type { EvmNetwork } from "@/lib/evm/networks";
import { MAINNET_STABLECOIN_ADDRESS } from "@/lib/evm/stablecoin";

/**
 * Ajout de fonds sur Robinhood Chain mainnet (4663), côté serveur.
 *
 * Deux chemins payants, vérifiés le 4 octobre 2026 :
 * - carte : MoonPay vend `usdg_robinhood` (minimum 5 USD) et `eth_robinhood`, livrés
 *   directement sur Robinhood Chain. Ces deux actifs n'ont pas de mode test : seule une
 *   clé live a un sens sur mainnet.
 * - pont : Relay, depuis l'USDC de Base (8453), par un lien profond pré-rempli.
 *
 * L'adresse de destination est toujours celle de la session : ce module ne la reçoit que
 * d'un appelant qui l'a lue dans le cookie signé, jamais du corps de la requête. Sinon un
 * lien produit par Sirius pourrait envoyer l'argent d'un utilisateur à quelqu'un d'autre.
 */

export type OnrampMethod = "card" | "bridge";
export type OnrampAsset = "USDG" | "ETH";

export interface OnrampOptions {
  network: EvmNetwork;
  faucet: boolean;
  card: boolean;
  transfer: boolean;
  bridge: boolean;
  minCardUsd: number;
}

export const CARD_MIN_USD = 5;
export const CARD_MAX_USD = 10_000;
export const BRIDGE_MIN = 1;
export const BRIDGE_MAX = 100_000;

const MOONPAY_CURRENCY: Record<OnrampAsset, string> = {
  USDG: "usdg_robinhood",
  ETH: "eth_robinhood",
};

const RELAY_BASE = "https://relay.link/bridge/robinhood";
const BASE_CHAIN_ID = 8453;
/** USDC natif sur Base, monnaie de départ du pont. */
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RELAY_TOKEN: Record<OnrampAsset, string> = {
  // Dérivée de stablecoin.ts (forme à somme de contrôle) : une seule source pour l'adresse.
  USDG: getAddress(MAINNET_STABLECOIN_ADDRESS),
  ETH: "0x0000000000000000000000000000000000000000",
};

type Env = Record<string, string | undefined>;

/**
 * Achat par carte possible : mainnet, deux clés MoonPay présentes, clé publique live.
 * Une clé sandbox sur mainnet ouvrirait un widget de test qui ne livre rien sur 4663.
 */
export function cardAvailable(network: EvmNetwork, env: Env = process.env): boolean {
  if (network !== "mainnet") return false;
  const publishable = env.NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY?.trim();
  const secret = env.MOONPAY_SECRET_KEY?.trim();
  return Boolean(publishable && secret && publishable.startsWith("pk_live_"));
}

/** Ce que l'écran « Add funds » peut proposer sur ce réseau. Public : aucune donnée de compte. */
export function onrampOptions(network: EvmNetwork, env: Env = process.env): OnrampOptions {
  if (network !== "mainnet") {
    return { network, faucet: true, card: false, transfer: false, bridge: false, minCardUsd: CARD_MIN_USD };
  }
  // Pont retiré de la fenêtre le 4 octobre : deux choix seulement, carte et autre wallet.
  return { network, faucet: false, card: cardAvailable(network, env), transfer: true, bridge: false, minCardUsd: CARD_MIN_USD };
}

export interface OnrampRequest {
  method: OnrampMethod;
  asset: OnrampAsset;
  amount: number;
}

/**
 * Valide le corps reçu. Seuls `method`, `asset` et `amount` sont lus : tout autre champ,
 * `walletAddress` compris, est ignoré.
 */
export function parseOnrampRequest(body: Record<string, unknown>): OnrampRequest {
  const { method, asset, amount } = body;
  if (method !== "card" && method !== "bridge") throw new AppError("Méthode d'ajout de fonds invalide", 400);
  if (asset !== "USDG" && asset !== "ETH") throw new AppError("Jeton d'ajout de fonds invalide", 400);
  if (typeof amount !== "number" || !Number.isFinite(amount)) throw new AppError("Montant invalide", 400);
  if (method === "card" && (amount < CARD_MIN_USD || amount > CARD_MAX_USD)) {
    throw new AppError("Montant par carte invalide : entre 5 et 10 000 USD", 400);
  }
  if (method === "bridge" && (amount < BRIDGE_MIN || amount > BRIDGE_MAX)) {
    throw new AppError("Montant du pont invalide : entre 1 et 100 000 USDC", 400);
  }
  return { method, asset, amount };
}

/** Lien Relay pré-rempli : USDC de Base vers le jeton choisi sur Robinhood Chain. */
export function buildRelayUrl(address: string, asset: OnrampAsset, amount: number): string {
  const url = new URL(RELAY_BASE);
  url.searchParams.set("fromChainId", String(BASE_CHAIN_ID));
  url.searchParams.set("fromCurrency", BASE_USDC);
  url.searchParams.set("toCurrency", RELAY_TOKEN[asset]);
  // Unités lisibles de l'USDC sur Base, pas d'unités atomiques.
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("tradeType", "EXACT_INPUT");
  url.searchParams.set("toAddress", address);
  return url.toString();
}

/**
 * URL d'ajout de fonds pour l'adresse de la session. `sessionAddress` vient du cookie
 * signé ; aucun champ du corps ne peut la remplacer.
 */
export function onrampUrl(network: EvmNetwork, sessionAddress: string, request: OnrampRequest): string {
  if (request.method === "card") {
    if (!cardAvailable(network)) throw new AppError("Achat par carte indisponible", 503);
    return buildSignedBuyUrl({
      walletAddress: sessionAddress,
      currencyCode: MOONPAY_CURRENCY[request.asset],
      baseCurrencyAmount: request.amount,
    });
  }
  if (network !== "mainnet") throw new AppError("Pont indisponible sur ce réseau", 503);
  return buildRelayUrl(sessionAddress, request.asset, request.amount);
}
