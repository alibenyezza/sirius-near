import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { USDC_DECIMALS } from "@/lib/evm/usdc";
import { readDatasetStats } from "@/lib/datasets/manage";

export const runtime = "nodejs";

const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 60, maxGlobal: 1_000 });

/**
 * Statistiques privées d'un dataset : emprunts (total, par semaine, dernier), revenus gagnés
 * et bloqués dans l'escrow, entraînements livrés ou remboursés. Propriétaire uniquement ;
 * la propriété est vérifiée avant toute lecture des prêts.
 *
 * Les retraits ne sont pas ventilés par dataset : l'escrow crédite le wallet du fournisseur
 * (`creditOf`), tous datasets confondus. La fiche renvoie vers la page Wallet pour ce solde.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(limiter, `subject:${session.address}`);
    const { id } = await params;
    const stats = await readDatasetStats(prisma, id, session.address);
    return NextResponse.json({ ...stats, tokenDecimals: USDC_DECIMALS }, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
