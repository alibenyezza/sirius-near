import { getAddress, isAddress, type Address } from "viem";
import { AppError } from "@/lib/app-error";

/**
 * Normalisation des adresses EVM — brique de sécurité, pas de confort.
 *
 * Une adresse EVM s'écrit en hexadécimal et l'EIP-55 y encode une somme de
 * contrôle **dans la casse** : `0xAbC…` et `0xabc…` désignent le même compte
 * tout en étant deux chaînes différentes.
 *
 * Or les contrôles d'accès de Sirius comparent des identités d'adresse :
 *   - `assertOwner()`
 *   - `assertGrantSubject()`
 *   - `finalizeLoan()`
 * Une casse divergente entre le wallet, la session et la base créerait soit un
 * refus injustifié, soit deux comptes distincts pour un même utilisateur.
 *
 * Règle du projet, sans exception : **tout ce qui est persisté, comparé ou signé
 * est en minuscules**. La forme EIP-55 n'existe que pour l'affichage.
 */

/** Adresse canonique telle que stockée en base et comparée : minuscules, préfixée `0x`. */
export type CanonicalAddress = `0x${string}`;

/** Normalise ou lève une 400. À utiliser à toute frontière d'entrée (API, body, params). */
export function normalizeAddress(value: unknown, field = "adresse"): CanonicalAddress {
  const normalized = tryNormalizeAddress(value);
  if (!normalized) throw new AppError(`${field} EVM invalide`, 400);
  return normalized;
}

/** Variante non levante, pour les chemins où une adresse absente est légitime. */
export function tryNormalizeAddress(value: unknown): CanonicalAddress | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // `isAddress` avec `strict: false` accepte les deux casses ; on rejette ensuite
  // tout ce qui n'est pas exactement 20 octets hexadécimaux.
  if (!isAddress(trimmed, { strict: false })) return null;
  return trimmed.toLowerCase() as CanonicalAddress;
}

/**
 * Comparaison sûre de deux adresses, insensible à la casse.
 * Préférer cette fonction à `===` partout où une adresse provient d'un wallet,
 * d'un événement on-chain ou d'un corps de requête.
 */
export function addressesEqual(left: unknown, right: unknown): boolean {
  const a = tryNormalizeAddress(left);
  const b = tryNormalizeAddress(right);
  return a !== null && b !== null && a === b;
}

/** Forme EIP-55 (casse mixte) — **affichage uniquement**, jamais persistée ni comparée. */
export function displayAddress(value: string): Address {
  return getAddress(value);
}

/** Adresse nulle, utilisée comme sentinelle « aucun destinataire ». */
export const ZERO_ADDRESS: CanonicalAddress = "0x0000000000000000000000000000000000000000";

export function isZeroAddress(value: unknown): boolean {
  return tryNormalizeAddress(value) === ZERO_ADDRESS;
}
