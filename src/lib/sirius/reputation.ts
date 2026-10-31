import "server-only";
import { prisma } from "@/lib/db";
import {
  reputationSnapshotFromCounts,
  type ReputationRole,
  type ReputationSnapshot,
} from "./reputation-policy";

interface ResolutionCounts {
  settled: Map<string, number>;
  cancelled: Map<string, number>;
}

async function resolutionCounts(addresses: string[], role: ReputationRole): Promise<ResolutionCounts> {
  if (role === "provider") {
    const [settled, cancelled] = await Promise.all([
      prisma.loan.groupBy({
        by: ["provider"],
        where: { provider: { in: addresses }, status: "SETTLED", settleTxHash: { not: null } },
        _count: { _all: true },
      }),
      prisma.loan.groupBy({
        by: ["provider"],
        where: { provider: { in: addresses }, status: "CANCELLED", cancelTxHash: { not: null } },
        _count: { _all: true },
      }),
    ]);
    return {
      settled: new Map(settled.map((row) => [row.provider, row._count._all])),
      cancelled: new Map(cancelled.map((row) => [row.provider, row._count._all])),
    };
  }

  const [settled, cancelled] = await Promise.all([
    prisma.loan.groupBy({
      by: ["borrower"],
      where: { borrower: { in: addresses }, status: "SETTLED", settleTxHash: { not: null } },
      _count: { _all: true },
    }),
    prisma.loan.groupBy({
      by: ["borrower"],
      where: { borrower: { in: addresses }, status: "CANCELLED", cancelTxHash: { not: null } },
      _count: { _all: true },
    }),
  ]);
  return {
    settled: new Map(settled.map((row) => [row.borrower, row._count._all])),
    cancelled: new Map(cancelled.map((row) => [row.borrower, row._count._all])),
  };
}

export async function reputationsForAddresses(
  addresses: string[],
  role: ReputationRole,
): Promise<Map<string, ReputationSnapshot>> {
  const uniqueAddresses = [...new Set(addresses)];
  if (uniqueAddresses.length === 0) return new Map();
  const counts = await resolutionCounts(uniqueAddresses, role);
  return new Map(
    uniqueAddresses.map((address) => [
      address,
      reputationSnapshotFromCounts(
        address,
        role,
        counts.settled.get(address) ?? 0,
        counts.cancelled.get(address) ?? 0,
      ),
    ]),
  );
}

export async function reputationForAddress(address: string, role: ReputationRole) {
  return (await reputationsForAddresses([address], role)).get(address)!;
}
