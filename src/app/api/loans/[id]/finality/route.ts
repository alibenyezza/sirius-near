import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPublicClient } from "@/lib/evm/client";
import { fastLockFinalityStatus, lockFinalityStatus } from "@/lib/evm/finality";
import type { LockFinalityResponse } from "@/lib/evm/lock-finality";
import { prospectiveLoanFinalityTier } from "@/lib/sirius/finality-tier";
import { requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

// La page Train relit au plus toutes les 20 s par prêt en attente (5 s au palier rapide), et
// jamais onglet caché : trente lectures par minute et par compte couvrent plusieurs prêts sans
// ouvrir une rafale RPC.
const finalityLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 30, maxGlobal: 600 });

/**
 * Le lock de ce prêt est-il déjà sous le bloc stable de son palier ? Lecture seule, réservée à
 * l'emprunteur, sans effet sur le prêt ni sur le budget runner : la décision reste celle de
 * `POST …/run` (`assertLockStable`, après attribution du palier), ceci ne sert qu'à afficher
 * l'attente et à déclencher le lancement au bon moment quand la page reste ouverte. Le palier
 * annoncé est celui que le prêt obtiendrait maintenant (`prospectiveLoanFinalityTier`) : en
 * secondes pour un petit prêt sous le plafond rapide, un quart d'heure sinon. La durée restante
 * est calculée ici, en millisecondes, pour ne pas dépendre de l'horloge du navigateur.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(finalityLimiter, `subject:${session.address}`);
    const { id } = await params;
    const loan = await prisma.loan.findUnique({
      where: { id },
      select: { id: true, borrower: true, status: true, evmLockBlock: true, amountUsdcAtomic: true, finalityTier: true },
    });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    const idle: LockFinalityResponse = { pending: false, remainingMs: null, estimatedReadyAt: null };
    // Seul un prêt ESCROWED est retenu par la finalité du lock (`prepareLoanResult`).
    if (loan.status !== "ESCROWED" || !loan.evmLockBlock) return NextResponse.json(idle);
    const tier = await prospectiveLoanFinalityTier(loan);
    const lockBlock = BigInt(loan.evmLockBlock);
    const estimate = tier === "FAST"
      ? await fastLockFinalityStatus(getPublicClient(), lockBlock)
      : await lockFinalityStatus(getPublicClient(), lockBlock);
    const body: LockFinalityResponse = estimate.pending
      ? { pending: true, remainingMs: estimate.remainingMs, estimatedReadyAt: new Date(estimate.estimatedReadyAt).toISOString(), tier }
      : { ...idle, tier };
    return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
