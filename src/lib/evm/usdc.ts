import { resolveUsdcDecimals } from "./networks";

/**
 * Conversion des montants de règlement.
 *
 * Toutes les bornes et tous les motifs se dérivent de la précision du jeton, qui
 * dépend du réseau : le contrat USDC du testnet Robinhood expose 18 décimales,
 * l'USDC de référence en expose 6. Écrire l'une de ces valeurs en dur reviendrait
 * à casser l'autre réseau sans qu'aucune exception ne soit levée.
 */

export const USDC_DECIMALS = resolveUsdcDecimals();

if (USDC_DECIMALS < 3 || USDC_DECIMALS > 30) {
  throw new Error(`Précision USDC hors bornes plausibles : ${USDC_DECIMALS}`);
}

const ATOMIC_PER_USDC = BigInt(10) ** BigInt(USDC_DECIMALS);

/** Plancher de 0,001 USDC. En dessous, le gas d'un règlement dépasse le prêt. */
export const MIN_PRICE_USDC_ATOMIC = ATOMIC_PER_USDC / BigInt(1000);

/** Plafond d'un million d'USDC par prêt. */
export const MAX_PRICE_USDC_ATOMIC = ATOMIC_PER_USDC * BigInt(1000000);

// Partie entière : jusqu'à sept chiffres, le plafond ci-dessus tranchant le reste.
// Partie décimale : au plus la précision du jeton, jamais arrondie au-delà.
const PRICE_PATTERN = new RegExp(`^(0|[1-9][0-9]{0,6})(?:\\.([0-9]{1,${USDC_DECIMALS}}))?$`);

const ATOMIC_PATTERN = new RegExp(`^[0-9]{1,${MAX_PRICE_USDC_ATOMIC.toString().length}}$`);

export function priceUsdcToAtomic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = PRICE_PATTERN.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  const amount = BigInt(match[1]) * ATOMIC_PER_USDC + BigInt(fraction || "0");
  if (amount < MIN_PRICE_USDC_ATOMIC || amount > MAX_PRICE_USDC_ATOMIC) return null;
  return amount.toString();
}

export function isValidUsdcAtomicAmount(value: unknown): value is string {
  if (typeof value !== "string" || !ATOMIC_PATTERN.test(value)) return false;
  const amount = BigInt(value);
  return amount >= MIN_PRICE_USDC_ATOMIC && amount <= MAX_PRICE_USDC_ATOMIC;
}

export function formatUsdcAtomic(value: string): string {
  const amount = BigInt(value);
  const whole = amount / ATOMIC_PER_USDC;
  const fraction = (amount % ATOMIC_PER_USDC).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
