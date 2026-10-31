import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/app-error";

// `scrypt:<sel>:<empreinte>` en base64url : sans `$`, que le chargement des fichiers .env interpolerait.
const CODE_HASH = /^scrypt:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/;
const CODE = /^[\x21-\x7e]{12,128}$/;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

/** Registre partagé des tentatives ; sans base, pour que le script de génération reste autonome. */
export interface OperatorCodeAttempts {
  record(address: string, at: Date): Promise<string>;
  countSince(address: string, since: Date): Promise<number>;
  remove(id: string): Promise<void>;
  purgeBefore(before: Date): Promise<void>;
}

export function hashOperatorCode(code: string, salt = randomBytes(16)): string {
  if (!CODE.test(code)) throw new Error("Code opérateur : 12 à 128 caractères ASCII imprimables, sans espace");
  return `scrypt:${salt.toString("base64url")}:${scryptSync(code, salt, 32).toString("base64url")}`;
}

/**
 * Second facteur des commandes opérateur. Chaque tentative est inscrite, et validée, avant le
 * comptage : sous READ COMMITTED, la k-ième inscription voit les k − 1 précédentes, si bien que
 * même en parallèle sur plusieurs instances, au plus cinq codes faux sont vérifiés par wallet et
 * par quart d'heure. Seuls les échecs restent inscrits ; un succès n'efface pas ceux qui précèdent,
 * sans quoi le polling de l'opérateur légitime rouvrirait les essais d'un tiers.
 */
export async function assertOperatorCode(address: string, code: string | null, attempts: OperatorCodeAttempts,
  now = new Date(), configured = process.env.SIRIUS_DEMO_OPERATOR_CODE_HASH): Promise<void> {
  const match = configured?.trim().match(CODE_HASH);
  if (!match) throw new AppError("Code opérateur non configuré", 403);
  const key = address.toLowerCase();
  const since = new Date(now.getTime() - LOCK_MS);
  const attempt = await attempts.record(key, now);
  if (await attempts.countSince(key, since) > MAX_FAILURES) {
    // Retirée : un refus pendant le verrou ne le prolonge pas.
    await attempts.remove(attempt);
    throw new AppError("Trop d’essais de code opérateur — réessaie dans 15 minutes", 429);
  }
  if (!code || !CODE.test(code)
    || !timingSafeEqual(scryptSync(code, Buffer.from(match[1], "base64url"), 32), Buffer.from(match[2], "base64url"))) {
    await attempts.purgeBefore(since);
    throw new AppError("Code opérateur invalide", 403);
  }
  await attempts.remove(attempt);
}
