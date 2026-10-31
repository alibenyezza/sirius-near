import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { setTimeout as delay } from "node:timers/promises";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL manquante");

// Adaptateur Postgres générique plutôt que celui propre à Neon : le même code sert
// à la base managée derrière Vercel et à un Postgres rapatrié sur le VPS, sans que
// le choix d'hébergement se retrouve figé dans l'application.
//
// La taille du pool est volontairement basse. L'application tourne en serverless :
// chaque instance froide ouvre son propre pool, et une valeur généreuse par instance
// épuise les connexions de la base bien avant d'être utile.
const adapter = new PrismaPg({
  connectionString: url,
  max: Number(process.env.DATABASE_POOL_MAX ?? 5),
});

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// `omit` global : la DEK enveloppée ne doit JAMAIS sortir dans une réponse API.
// Les rares lectures serveur qui en ont besoin la ré-incluent via `omit: { wrappedKey: false }`.
// Même règle pour le consentement à l'amélioration des modèles : c'est une trace contractuelle
// propre au fournisseur, pas une donnée de catalogue, et `datasetResponse()` projette la ligne
// entière vers des routes publiques. La fiche du fournisseur et l'admin la ré-incluent de même.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    omit: {
      dataset: {
        wrappedKey: true,
        trainingConsentAt: true,
        trainingConsentVersion: true,
        trainingConsentRevokedAt: true,
      },
      // Preuves de rediffusion d'un release rapide (settlement-evidence.ts) : matière d'opérateur,
      // jamais une donnée de l'API. `GET /api/loans` renvoie la ligne entière ; seule la capture les
      // relit, par `select` explicite.
      loan: {
        settleRawTx: true,
        settlePreimage: true,
      },
    },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

function isTransactionConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const value = error as { code?: string; sqlState?: string; originalCode?: string; kind?: string; cause?: unknown };
  return value.code === "P2034" || value.kind === "TransactionWriteConflict"
    || [value.code, value.sqlState, value.originalCode].some((code) => code === "40001" || code === "40P01")
    || isTransactionConflict(value.cause, depth + 1);
}

export async function serializableTransaction<T>(action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isTransactionConflict(error) || attempt === 2) throw error;
      await delay(10 * 2 ** attempt + Math.floor(Math.random() * 10));
    }
  }
}
