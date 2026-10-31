import type { EvmNetwork } from "@/lib/evm/networks";

/**
 * Réseau affiché dans le bouton profil (docs/passage-mainnet/02-general.md, section 5).
 *
 * Le réseau d'un site est fixé par son environnement (`NEXT_PUBLIC_EVM_NETWORK`) : la
 * production est sur mainnet, le staging sur testnet. Le badge reflète ce réseau, et
 * non celui du wallet de l'utilisateur ; l'écart entre les deux est signalé à part.
 *
 * Les libellés sont des clés de traduction (`t()`), les classes sont écrites en toutes
 * lettres pour que Tailwind les détecte.
 */

export interface NetworkBadge {
  network: EvmNetwork;
  label: string;
  /** Classes du badge : couleurs distinctes, mainnet vert, testnet ambre. */
  className: string;
  /** Classes du point de couleur du bouton. */
  dotClassName: string;
}

const BADGES: Record<EvmNetwork, NetworkBadge> = {
  mainnet: {
    network: "mainnet",
    label: "Robinhood Chain mainnet",
    className: "border-positive/40 bg-positive/10 text-positive",
    dotClassName: "bg-positive",
  },
  testnet: {
    network: "testnet",
    label: "Robinhood Chain testnet",
    className: "border-yellow-400/40 bg-yellow-400/10 text-yellow-400",
    dotClassName: "bg-yellow-400",
  },
};

export function networkBadge(network: EvmNetwork): NetworkBadge {
  return BADGES[network];
}

/**
 * Libellé du jeton de règlement affiché à côté d'un solde : USDG sur mainnet
 * (docs/passage-mainnet/01-decisions-avant-samedi.md), jeton de test sur testnet.
 * Clé de traduction.
 */
export function stablecoinSymbol(network: EvmNetwork): string {
  return network === "mainnet" ? "USDG" : "test USDC";
}

/**
 * Vrai si le wallet est sur un autre réseau que celui du site. `walletNetwork` est la valeur
 * du store : « mainnet », « testnet », ou l'identifiant brut d'une chaîne inconnue. Tant que
 * le réseau du wallet n'est pas connu (`null`), aucun écart n'est affirmé.
 */
export function isWrongNetwork(expected: EvmNetwork, walletNetwork: string | null | undefined): boolean {
  return Boolean(walletNetwork) && walletNetwork !== expected;
}

/**
 * Montant lisible, sans passage par un flottant. Reçoit la forme décimale exacte d'un
 * montant (« 1234.5678 », issue de `formatUsdcAtomic`) ; la partie décimale est tronquée,
 * jamais arrondie, pour ne jamais afficher plus que le solde réel. Une entrée qui n'est pas
 * un décimal positif renvoie `null`.
 */
export function formatTokenAmount(plain: string, maxFractionDigits = 4): string | null {
  const match = /^(\d{1,40})(?:\.(\d{1,40}))?$/.exec(plain);
  if (!match) return null;
  const whole = new Intl.NumberFormat("en-US").format(BigInt(match[1]));
  const fraction = match[2]?.slice(0, maxFractionDigits).replace(/0+$/, "") ?? "";
  // Non nul mais sous la précision affichée : « <0.0001 » plutôt que « 0 », qui ferait croire
  // à un compte vide.
  if (!fraction && BigInt(match[1]) === BigInt(0) && /[1-9]/.test(match[2] ?? "")) {
    return `<0.${"0".repeat(Math.max(maxFractionDigits - 1, 0))}1`;
  }
  return fraction ? `${whole}.${fraction}` : whole;
}
