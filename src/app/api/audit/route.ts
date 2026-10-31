import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { resolveServerNetwork } from "@/lib/evm/networks";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    const loans = await prisma.loan.findMany({
      where: { OR: [{ borrower: session.address }, { provider: session.address }] },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        borrower: true,
        provider: true,
        amountUsdcAtomic: true,
        modelId: true,
        modelVersion: true,
        status: true,
        evmLockTxHash: true,
        settleTxHash: true,
        auditReceipt: true,
        cancelTxHash: true,
        attestationHash: true,
        attestationComposeHash: true,
        evmDeadline: true,
        createdAt: true,
        settledAt: true,
        dataset: {
          select: { name: true, evmDatasetId: true, evmMintTxHash: true },
        },
      },
    });
    return NextResponse.json({ network: resolveServerNetwork().network, loans });
  } catch (error) {
    return errorResponse(error);
  }
}
