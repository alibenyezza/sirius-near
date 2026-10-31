import { addFundsOptions } from "@/components/wallet/add-funds";
import type { EvmNetwork } from "@/lib/evm/networks";

/**
 * Client des routes d'ajout de fonds (contrat d'API de la slice F1, côté serveur).
 *
 * - `GET /api/onramp/options` : quels chemins sont ouverts sur cette instance.
 * - `POST /api/onramp` : URL d'achat par carte (MoonPay) ou de pont, liée au compte connecté.
 *
 * Le corps envoyé ne contient jamais d'adresse : le serveur prend celle de la session. Un
 * client qui choisirait l'adresse de livraison pourrait faire livrer des fonds payés par
 * l'utilisateur sur un autre compte ; la seule source admise est donc la session.
 *
 * `fetch` est injectable pour les tests ; par défaut, celui du navigateur.
 */

export type OnrampMethod = "card" | "bridge";
export type OnrampAsset = "USDG" | "ETH";

export interface OnrampOptions {
  network: EvmNetwork;
  faucet: boolean;
  card: boolean;
  transfer: boolean;
  bridge: boolean;
  /** Montant minimum d'un achat par carte, en dollars. */
  minCardUsd: number;
}

export interface OnrampRequest {
  method: OnrampMethod;
  asset: OnrampAsset;
  amount: number;
}

/** Choix proposés dans la fenêtre « Ajouter des fonds », dans l'ordre d'affichage. */
export type FundingChoice = "card" | "transfer" | "bridge";

/** Minimum affiché tant que le serveur n'en donne pas : la carte est alors fermée de toute façon. */
export const DEFAULT_MIN_CARD_USD = 5;

/** Plafond de saisie : au-delà, c'est une faute de frappe, pas un achat. Le serveur reste juge. */
export const MAX_AMOUNT = 1_000_000;

type Fetch = typeof fetch;

/** Options de repli : celles du réseau, sans la carte, tant que la route n'existe pas ou échoue. */
export function fallbackOnrampOptions(network: EvmNetwork): OnrampOptions {
  return { network, ...addFundsOptions(network), card: false, minCardUsd: DEFAULT_MIN_CARD_USD };
}

function isOptions(value: unknown): value is OnrampOptions {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (body.network === "mainnet" || body.network === "testnet")
    && ["faucet", "card", "transfer", "bridge"].every((key) => typeof body[key] === "boolean")
    && typeof body.minCardUsd === "number" && Number.isFinite(body.minCardUsd) && body.minCardUsd >= 0;
}

/**
 * Lit les options du serveur. Toute panne (route absente, 401, JSON illisible, forme
 * inattendue, réseau différent de celui du build) retombe sur `fallbackOnrampOptions` :
 * le transfert et le pont restent proposés, la carte non.
 */
export async function fetchOnrampOptions(network: EvmNetwork, fetchImpl: Fetch = fetch): Promise<OnrampOptions> {
  try {
    const response = await fetchImpl("/api/onramp/options", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return fallbackOnrampOptions(network);
    const body: unknown = await response.json();
    if (!isOptions(body) || body.network !== network) return fallbackOnrampOptions(network);
    return {
      network: body.network,
      faucet: body.faucet,
      card: body.card,
      transfer: body.transfer,
      bridge: body.bridge,
      minCardUsd: body.minCardUsd,
    };
  } catch {
    return fallbackOnrampOptions(network);
  }
}

/**
 * Choix à afficher. Le faucet n'en fait jamais partie : il garde son bouton direct sur
 * testnet. Sur testnet, la fenêtre n'est pas utilisée du tout.
 */
export function fundingChoices(options: OnrampOptions): FundingChoice[] {
  const choices: FundingChoice[] = [];
  if (options.card) choices.push("card");
  if (options.transfer) choices.push("transfer");
  if (options.bridge) choices.push("bridge");
  return choices;
}

/**
 * Décimales admises dans la saisie. Le montant est toujours ce que l'utilisateur paie : des
 * dollars pour la carte, de l'USDC de Base pour le pont, y compris quand il reçoit de l'ETH.
 * Deux décimales dans les deux cas.
 */
export const AMOUNT_DECIMALS = 2;

export type AmountCheck = { ok: true; amount: number } | { ok: false; error: string };

/**
 * Valide un montant saisi (virgule ou point décimal). Messages en français, traduits à
 * l'affichage comme le reste de l'interface.
 */
export function parseAmount(input: string, options: { decimals: number; min?: number }): AmountCheck {
  const text = input.trim().replace(",", ".");
  if (text === "") return { ok: false, error: "Indique un montant" };
  const pattern = new RegExp(`^\\d{1,7}(\\.\\d{0,${options.decimals}})?$`);
  if (!pattern.test(text)) return { ok: false, error: "Montant invalide" };
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Montant invalide" };
  if (amount > MAX_AMOUNT) return { ok: false, error: "Montant trop élevé" };
  if (options.min !== undefined && amount < options.min) return { ok: false, error: "Montant inférieur au minimum" };
  return { ok: true, amount };
}

/** N'accepte qu'une URL https absolue : jamais `javascript:`, `data:` ni un chemin relatif. */
export function safeOnrampUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Demande l'URL d'achat ou de pont. Lève une `Error` dont le message est celui du serveur
 * (`error`), à traduire à l'affichage, ou un message générique.
 */
export async function requestOnrampUrl(request: OnrampRequest, fetchImpl: Fetch = fetch): Promise<string> {
  // Corps reconstruit champ par champ : rien d'autre que ces trois clés ne part, même si
  // l'appelant passe un objet plus large.
  const body = { method: request.method, asset: request.asset, amount: request.amount };
  let response: Response;
  try {
    response = await fetchImpl("/api/onramp", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Service d’ajout de fonds injoignable");
  }
  const payload = (await response.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" && payload.error ? payload.error : "Ajout de fonds indisponible");
  }
  const url = safeOnrampUrl(payload?.url);
  if (!url) throw new Error("Réponse du service d’ajout de fonds invalide");
  return url;
}

/**
 * Ouvre l'URL dans un nouvel onglet, sans lien de retour vers Sirius. Avec `noopener`,
 * `window.open` renvoie toujours `null` : on ne peut pas savoir si le navigateur l'a
 * bloquée. La fenêtre affiche donc toujours un lien de secours.
 */
export function openOnrampUrl(url: string, opener: Pick<Window, "open"> = window): void {
  opener.open(url, "_blank", "noopener,noreferrer");
}
