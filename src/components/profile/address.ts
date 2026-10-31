import { getAddress, isAddress } from "viem";

/**
 * Affichage d'une adresse EVM dans le bouton profil et sur la page Wallet.
 *
 * L'adresse vient du store du wallet, rempli par le navigateur : on ne l'affiche, ne
 * la copie et ne la met en QR code qu'après l'avoir validée. Une valeur qui n'est pas une
 * adresse EVM valide (mauvaise longueur, somme de contrôle fausse, texte quelconque) est
 * refusée, et non « corrigée » : afficher une adresse altérée à quelqu'un qui s'apprête à
 * y envoyer de l'argent est pire que de n'afficher rien.
 */

/** Adresse en casse de somme de contrôle (EIP-55), ou `null` si la valeur n'est pas une adresse valide. */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Aucune normalisation des espaces : une adresse entourée d'espaces n'est pas une adresse.
  if (!isAddress(value)) return null;
  return getAddress(value);
}

/**
 * Forme courte `0x1234…abcd` (six premiers et quatre derniers caractères), la même que le
 * bouton de connexion. `null` si la valeur n'est pas une adresse valide : l'appelant décide
 * de l'affichage de repli, la fonction n'invente jamais de contenu.
 */
export function shortAddress(value: unknown): string | null {
  const address = normalizeAddress(value);
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}
