import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { settlePreparedLoan } from "@/lib/sirius/settle";
import { assertAuthenticGrant, assertOwner, requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { SETTLEMENT_FINALITY_PENDING, SETTLEMENT_FINALITY_PENDING_FAST } from "@/lib/loans/settlement-status";
import { effectiveLoanFinalityTier } from "@/lib/sirius/finality-tier";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const settlementLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 10,
  maxGlobal: 100,
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(settlementLimiter, `subject:${session.address}`);
    const { id } = await params;
    const { authorization } = await readJson<{
      authorization?: RunnerGrant;
    }>(req);
    if (!authorization) {
      return NextResponse.json({ error: "Autorisation manquante" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    const loan = await prisma.loan.findUnique({ where: { id }, select: { borrower: true, finalityTier: true } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    try {
      return NextResponse.json(await settlePreparedLoan(id, authorization));
    } catch (err) {
      if (err instanceof RunnerFinalityPending) {
        // L'attente annoncée suit le palier effectif du prêt (coupe-circuit compris) : secondes en
        // rapide, un quart d'heure sinon.
        const error = effectiveLoanFinalityTier(loan.finalityTier) === "FAST" ? SETTLEMENT_FINALITY_PENDING_FAST : SETTLEMENT_FINALITY_PENDING;
        return NextResponse.json({ pending: true, settleTxHash: err.transactionHash, error }, { status: 202 });
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
