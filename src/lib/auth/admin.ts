import "server-only";
import { isZeroAddress, tryNormalizeAddress, type CanonicalAddress } from "@/lib/evm/address";

/**
 * Adresses de l'équipe Sirius, lues dans `SIRIUS_ADMIN_ADDRESSES` : une liste d'adresses
 * EVM séparées par des virgules, comparées en minuscules.
 *
 * Variable distincte de `SIRIUS_DEMO_OPERATORS` (opérateurs de la démo Phala) pour ne pas
 * mélanger les rôles : un opérateur de démo n'est pas forcément administrateur du produit.
 *
 * Règles, toutes « fermées par défaut » :
 *   - variable absente ou vide → personne n'est administrateur ;
 *   - une seule entrée invalide (pas une adresse, adresse nulle, entrée vide après une
 *     virgule) → la liste entière est refusée, personne n'est administrateur ;
 *   - plus de MAX_ADMIN_ADDRESSES entrées (doublons compris) → liste refusée.
 * La casse est indifférente, préfixe `0X` compris : tout est mis en minuscules avant la
 * comparaison. La somme de contrôle EIP-55 n'est pas vérifiée, comme partout dans le projet.
 * Une faute de frappe ferme donc l'accès à tout le monde, ce qui se voit immédiatement,
 * plutôt que d'ouvrir l'accès à une adresse mal lue.
 */
export const ADMIN_ADDRESSES_VARIABLE = "SIRIUS_ADMIN_ADDRESSES";
export const MAX_ADMIN_ADDRESSES = 10;

let warnedFor: string | undefined;

/** Liste canonique (minuscules, dédoublonnée) ou liste vide si la variable est absente ou mal formée. */
export function adminAddresses(configured: string | undefined = process.env.SIRIUS_ADMIN_ADDRESSES): CanonicalAddress[] {
  if (configured === undefined || configured.trim() === "") return [];
  const entries = configured.split(",").map((value) => value.trim());
  const addresses = new Set<CanonicalAddress>();
  for (const entry of entries) {
    const normalized = tryNormalizeAddress(entry.toLowerCase());
    if (!normalized || isZeroAddress(normalized)) return reject(configured);
    addresses.add(normalized);
  }
  if (entries.length > MAX_ADMIN_ADDRESSES) return reject(configured);
  return [...addresses];
}

function reject(configured: string): CanonicalAddress[] {
  // La valeur n'est pas journalisée : un auditeur n'a pas besoin de la lire dans les logs
  // pour comprendre la cause, et une liste publique n'a pas sa place dans un journal.
  if (warnedFor !== configured) {
    warnedFor = configured;
    console.warn(`[admin] ${ADMIN_ADDRESSES_VARIABLE} mal formée : aucune adresse n'est administratrice`);
  }
  return [];
}

/** Vrai si `address` (toute casse) figure dans la liste des administrateurs. */
export function adminAllowed(address: unknown, configured: string | undefined = process.env.SIRIUS_ADMIN_ADDRESSES): boolean {
  const normalized = tryNormalizeAddress(typeof address === "string" ? address.toLowerCase() : address);
  if (!normalized) return false;
  return adminAddresses(configured).includes(normalized);
}
