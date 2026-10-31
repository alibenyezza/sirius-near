"use client";

import type { Eip1193Provider } from "@/lib/wallet/manager";

/**
 * Découverte des portefeuilles installés, selon EIP-6963.
 *
 * `window.ethereum` est un emplacement unique que plusieurs extensions se disputent :
 * celle qui s'injecte en dernier l'emporte, presque toujours MetaMask. Un utilisateur
 * qui a Phantom et MetaMask se voit donc proposer MetaMask sans qu'on lui demande
 * rien, et son autre portefeuille reste invisible pour le site.
 *
 * EIP-6963 remplace ce point de contention par une annonce : le site demande, chaque
 * portefeuille se signale avec son nom et son icône, et le choix revient à
 * l'utilisateur.
 *
 * Un portefeuille peut répondre après le premier appel — l'extension n'est pas
 * forcément prête au chargement de la page. On écoute donc en permanence, et on
 * redemande à chaque interrogation.
 */

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface AnnouncedWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

const CLE_CHOIX = "sirius.wallet.rdns";

/**
 * Identifiant du portefeuille embarqué dans cette table.
 *
 * EIP-6963 est une annonce faite par les extensions ; un portefeuille embarqué ne s'annonce
 * pas. On lui réserve donc un `rdns` que personne d'autre ne peut revendiquer, pour qu'il
 * soit choisi, mémorisé et retrouvé exactement comme les autres.
 *
 * Il vit ici et non dans `embedded.ts` pour que ce module puisse le reconnaître sans
 * importer le SDK : l'importer chargerait plusieurs centaines de kilo-octets sur toutes les
 * pages, y compris pour les visiteurs qui n'utiliseront jamais la connexion sociale.
 */
export const EMBEDDED_RDNS = "com.sirius.embedded";

/** Sans Client ID, la connexion sociale n'est pas proposée du tout. */
export function embeddedConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID?.trim());
}

/** Vrai si c'est le portefeuille embarqué que l'utilisateur a choisi. */
export function embeddedSelected(): boolean {
  return selectedWalletRdns() === EMBEDDED_RDNS;
}

const decouverts = new Map<string, AnnouncedWallet>();
let ecouteDemarree = false;
let choixSession: string | null | undefined;
const abonnements = new Set<() => void>();

function notifier(): void {
  for (const abonnement of abonnements) abonnement();
}

export function subscribeWalletChanges(listener: () => void): () => void {
  abonnements.add(listener);
  detectedWallets();
  return () => { abonnements.delete(listener); };
}

/**
 * Les opérations du portefeuille embarqué qui ne passent pas par EIP-1193.
 *
 * Un portefeuille embarqué n'a ni sélecteur de comptes ni permissions accordées à un site :
 * `wallet_requestPermissions` et `wallet_revokePermissions` n'y ont pas d'équivalent, et
 * changer de chaîne se demande au SDK plutôt qu'au provider. Ces trois gestes doivent donc
 * être fournis à part.
 */
export interface EmbeddedWallet {
  /** `null` tant qu'aucune session n'est ouverte. */
  provider(): Eip1193Provider | null;
  switchChain(chainId: string): Promise<void>;
  logout(): Promise<void>;
}

/**
 * Implémentation posée par `embedded.ts` au moment où il est chargé.
 *
 * L'inversion est délibérée : c'est le SDK qui se déclare ici, et non ce module — ni
 * `manager.ts` — qui va le chercher. Tous deux sont importés par à peu près tout le reste
 * de l'application ; un import direct entraînerait le SDK dans le bundle de chaque page,
 * y compris pour les visiteurs qui ne se connecteront jamais.
 */
let embarque: EmbeddedWallet | null = null;

export function registerEmbeddedWallet(wallet: EmbeddedWallet): void {
  embarque = wallet;
  notifier();
}

/**
 * Signale que l'ensemble des portefeuilles disponibles a changé.
 *
 * Une extension s'annonce d'elle-même ; une session sociale, non. Quand elle s'ouvre ou se
 * rouvre, c'est au SDK de le dire, sinon le connecteur resterait lié à ce qu'il avait vu au
 * montage — c'est-à-dire à rien.
 */
export function notifyWalletChange(): void {
  notifier();
}

/** `null` tant que `embedded.ts` n'a pas été chargé — donc tant qu'il n'a pas servi. */
export function embeddedWallet(): EmbeddedWallet | null {
  return embarque;
}

function demarrerEcoute(): void {
  if (ecouteDemarree || typeof window === "undefined") return;
  ecouteDemarree = true;
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = (event as CustomEvent<AnnouncedWallet>).detail;
    // L'annonce vient d'une extension tierce : on ne fait confiance ni à sa forme ni
    // à sa complétude, d'où les vérifications malgré ce que promet le type.
    if (typeof detail?.info?.rdns === "string" && typeof detail.provider?.request === "function") {
      const previous = decouverts.get(detail.info.rdns)?.provider;
      decouverts.set(detail.info.rdns, detail);
      if (previous !== detail.provider) notifier();
    }
  });
}

/** Redemande aux portefeuilles de se signaler et rend ceux qui ont répondu. */
export function detectedWallets(): WalletInfo[] {
  if (typeof window === "undefined") return [];
  demarrerEcoute();
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return [...decouverts.values()].map((w) => w.info);
}

/**
 * Attend que les portefeuilles se signalent.
 *
 * L'annonce est synchrone côté extension mais passe par la boucle d'événements : sans
 * ce délai, la première interrogation revient systématiquement vide et l'utilisateur
 * verrait « aucun portefeuille détecté » alors qu'il en a trois.
 */
export async function waitForWallets(delaiMs = 300): Promise<WalletInfo[]> {
  detectedWallets();
  await new Promise((resolve) => setTimeout(resolve, delaiMs));
  return detectedWallets();
}

export function selectedWalletRdns(): string | null {
  if (choixSession !== undefined) return choixSession;
  try {
    return window.localStorage.getItem(CLE_CHOIX);
  } catch {
    return null;
  }
}

export function selectWallet(rdns: string): void {
  choixSession = rdns;
  try {
    window.localStorage.setItem(CLE_CHOIX, rdns);
  } catch {
    // Stockage indisponible : le choix ne survivra pas au rechargement, mais il doit
    // valoir pour la session en cours plutôt que faire échouer la connexion.
  }
  notifier();
}

export function clearSelectedWallet(): void {
  choixSession = null;
  try {
    window.localStorage.removeItem(CLE_CHOIX);
  } catch {
    // Voir ci-dessus.
  }
  notifier();
}

/**
 * Choix fait depuis le bouton « Wallet externe » ou la liste des extensions annoncées.
 *
 * Sans `rdns`, l'utilisateur n'a désigné aucune extension en particulier : le choix
 * mémorisé auparavant (une session Google fermée, une extension désinstallée) doit être
 * oublié, sinon `getExternalWallet` s'y tiendrait, refuserait le repli sur
 * `window.ethereum`, et le bouton ne ferait plus rien jusqu'à l'effacement des données
 * du site.
 */
export function chooseExternalWallet(rdns?: string): void {
  if (rdns) selectWallet(rdns);
  else clearSelectedWallet();
}

/**
 * Portefeuille à utiliser : celui que l'utilisateur a choisi, sinon rien.
 *
 * On ne devine pas à sa place quand plusieurs sont installés — c'est précisément le
 * comportement qu'EIP-6963 existe pour corriger.
 */
export function selectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const rdns = selectedWalletRdns();
  if (!rdns) return null;

  // Le portefeuille embarqué n'est pas dans la table des annonces : il n'en fait jamais.
  // Tant que `embedded.ts` n'a pas été chargé, le lecteur est absent et l'appelant reçoit
  // `null` — ce qui est la bonne réponse, puisqu'il n'y a effectivement aucune session
  // sociale ouverte à ce moment-là.
  if (rdns === EMBEDDED_RDNS) return embarque?.provider() ?? null;

  const connu = decouverts.get(rdns)?.provider;
  if (connu) return connu;

  // Rien en mémoire. Le cas est courant et n'a rien d'anormal : la découverte n'était
  // déclenchée que par le bouton « Connecter », donc au premier rendu d'une page
  // atteinte directement — un rechargement du tableau de bord, un lien partagé — la
  // table restait vide. On retombait alors sur `window.ethereum`, c'est-à-dire sur
  // l'extension qui a gagné la course à l'injection plutôt que sur celle que
  // l'utilisateur a choisie, et les lectures partaient vers un autre réseau.
  //
  // Redemander suffit : l'annonce est synchrone chez la plupart des portefeuilles.
  // Pour les autres, l'écoute reste posée et le prochain appel aboutira.
  detectedWallets();
  return decouverts.get(rdns)?.provider ?? null;
}

// Certaines extensions s'annoncent d'elles-mêmes au chargement, sans qu'on demande
// rien, et ne le répètent pas. Poser l'écoute dès l'import plutôt qu'au premier appel
// évite de manquer cette annonce-là.
demarrerEcoute();
