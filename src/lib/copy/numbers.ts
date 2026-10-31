/**
 * Formatage de nombres pour les textes partagés.
 *
 * Le séparateur de milliers est écrit à la main plutôt que délégué à `toLocaleString` : le
 * rendu serveur et le rendu navigateur doivent produire exactement la même chaîne, sinon
 * React signale une erreur d'hydratation, et la locale du navigateur ne doit pas changer
 * un montant ou une limite affichés (« 20 000 » contre « 20,000 »).
 */

const MEBIBYTE = 1024 * 1024;
const KIBIBYTE = 1024;

/** Insère une virgule tous les trois chiffres dans une suite de chiffres non signée. */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Entier positif ou nul groupé par milliers (« 20000 » → « 20,000 »), « — » sinon. */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "—";
  return groupDigits(String(value));
}

/**
 * Taille limite en « MB » (1 MB = 1 048 576 octets, comme `formatBytes`).
 *
 * Une limite ne doit jamais être annoncée plus large qu'elle n'est : un reste est donc
 * tronqué à une décimale, jamais arrondi vers le haut (2,99 Mio donne « 2.9 MB »).
 */
export function formatLimitBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return "—";
  if (bytes >= MEBIBYTE) return `${truncatedOneDecimal(bytes, MEBIBYTE)} MB`;
  if (bytes >= KIBIBYTE) return `${truncatedOneDecimal(bytes, KIBIBYTE)} KB`;
  return `${bytes} B`;
}

function truncatedOneDecimal(bytes: number, unit: number): string {
  const tenths = Math.floor((bytes * 10) / unit);
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return fraction === 0 ? String(whole) : `${whole}.${fraction}`;
}
