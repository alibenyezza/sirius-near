import "server-only";
import { prisma } from "@/lib/db";
import type { OperatorCodeAttempts } from "./operator-code";

export const databaseOperatorAttempts: OperatorCodeAttempts = {
  record: async (address, at) => (await prisma.operatorCodeAttempt.create({ data: { address, createdAt: at }, select: { id: true } })).id,
  countSince: (address, since) => prisma.operatorCodeAttempt.count({ where: { address, createdAt: { gt: since } } }),
  remove: async (id) => { await prisma.operatorCodeAttempt.deleteMany({ where: { id } }); },
  purgeBefore: async (before) => { await prisma.operatorCodeAttempt.deleteMany({ where: { createdAt: { lte: before } } }); },
};
