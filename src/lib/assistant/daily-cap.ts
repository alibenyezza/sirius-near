import { createHash } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { estimateAssistantCostMicroUsd, type AssistantTokenUsage } from "./config";

/**
 * Plafonds quotidiens de l'assistant, tenus en base pour valoir d'une instance serverless à
 * l'autre :
 *   - `AssistantUsage` : une ligne par jour UTC, nombre de requêtes, jetons et dépense estimée en
 *     micro-dollars ; une nouvelle question est refusée dès que le nombre OU la dépense atteint
 *     son plafond ;
 *   - `AssistantClientUsage` : une ligne par jour et par client (empreinte de l'adresse IP
 *     transmise par l'ingress, sinon du wallet signé), pour qu'un seul poste ne vide pas le budget.
 * Écritures atomiques, jamais de lecture puis écriture : en parallèle sur plusieurs instances,
 * la k-ième requête voit les k − 1 précédentes. Aucun contenu de message, aucune adresse en clair.
 */

/** Sous-ensemble du client Prisma utilisé ici, injectable dans les tests. */
export interface AssistantUsageStore {
  updateMany(args: {
    where: { day: string; count: { lt: number }; spentMicroUsd: { lt: number } };
    data: { count: { increment: number } };
  }): Promise<{ count: number }>;
  create(args: { data: { day: string; count: number } }): Promise<unknown>;
  update(args: {
    where: { day: string };
    data: {
      inputTokens: { increment: number };
      outputTokens: { increment: number };
      cacheReadTokens: { increment: number };
      cacheWriteTokens: { increment: number };
      spentMicroUsd: { increment: number };
    };
  }): Promise<unknown>;
}

export interface AssistantClientUsageStore {
  updateMany(args: { where: { id: string; count: { lt: number } }; data: { count: { increment: number } } }): Promise<{ count: number }>;
  create(args: { data: { id: string; day: string; count: number } }): Promise<unknown>;
  deleteMany(args: { where: { day: { lt: string } } }): Promise<unknown>;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

/**
 * Réserve une requête pour le jour donné ; lève 429 quand le nombre ou le budget est atteint.
 *   1. incrémente la ligne du jour si elle existe et reste sous les deux plafonds ;
 *   2. sinon crée la ligne à 1 ; une création concurrente (P2002) signifie que la ligne vient
 *      d'apparaître : on retente l'incrément une fois, puis on refuse.
 */
export async function reserveAssistantRequest(store: AssistantUsageStore, day: string, cap: number, budgetMicroUsd: number): Promise<void> {
  const refused = new AppError("Assistant indisponible aujourd’hui : plafond quotidien atteint", 429);
  if (cap < 1 || budgetMicroUsd < 1) throw refused;
  const increment = () => store.updateMany({
    where: { day, count: { lt: cap }, spentMicroUsd: { lt: budgetMicroUsd } },
    data: { count: { increment: 1 } },
  });
  if ((await increment()).count === 1) return;
  try {
    await store.create({ data: { day, count: 1 } });
    return;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  if ((await increment()).count === 1) return;
  throw refused;
}

/** Ajoute les jetons d'une réponse et son coût estimé à la ligne du jour (créée par la réservation). */
export async function recordAssistantUsage(store: AssistantUsageStore, day: string, usage: AssistantTokenUsage): Promise<number> {
  const spent = estimateAssistantCostMicroUsd(usage);
  await store.update({
    where: { day },
    data: {
      inputTokens: { increment: usage.inputTokens },
      outputTokens: { increment: usage.outputTokens },
      cacheReadTokens: { increment: usage.cacheReadTokens },
      cacheWriteTokens: { increment: usage.cacheWriteTokens },
      spentMicroUsd: { increment: spent },
    },
  });
  return spent;
}

/** Identifiant de la ligne client : le jour et l'empreinte de la clé (`ip:…` ou `subject:…`), jamais la clé. */
export function assistantClientUsageId(day: string, clientKey: string): string {
  return `${day}:${createHash("sha256").update(clientKey).digest("hex").slice(0, 32)}`;
}

/** Jour UTC précédent : les lignes plus anciennes n'ont plus d'usage. */
function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Réserve une question pour un client et un jour ; lève 429 au-delà de `max`. Même schéma
 * atomique que le compteur global. Les lignes d'avant-hier et plus sont supprimées au passage :
 * le compteur n'a aucune raison de survivre à son jour.
 */
export async function reserveAssistantClient(store: AssistantClientUsageStore, day: string, clientKey: string, max: number): Promise<void> {
  const refused = new AppError("Trop de questions aujourd’hui depuis ce poste — réessaie demain", 429);
  if (max < 1) throw refused;
  const id = assistantClientUsageId(day, clientKey);
  const increment = () => store.updateMany({ where: { id, count: { lt: max } }, data: { count: { increment: 1 } } });
  if ((await increment()).count === 1) return;
  try {
    await store.create({ data: { id, day, count: 1 } });
    // Nettoyage opportuniste, hors du chemin de refus : une erreur ici n'empêche rien.
    await store.deleteMany({ where: { day: { lt: previousDay(day) } } }).catch(() => undefined);
    return;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  if ((await increment()).count === 1) return;
  throw refused;
}
