import { prisma } from "@/lib/db";
import type { AccessLogRetentionStore } from "./access-log-retention";

/**
 * Stockage Prisma de la purge du journal des accès. La sélection passe par l'index
 * `DatasetAccessLog_createdAt_idx` ; `deleteMany` n'ayant pas de limite, le lot est borné par
 * la sélection des identifiants, puis supprimé par clé primaire.
 */
export const databaseAccessLogRetention: AccessLogRetentionStore = {
  expiredIds: async (before, limit) => (await prisma.datasetAccessLog.findMany({
    where: { createdAt: { lt: before } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  })).map((row) => row.id),
  deleteIds: async (ids) => (await prisma.datasetAccessLog.deleteMany({ where: { id: { in: ids } } })).count,
};
