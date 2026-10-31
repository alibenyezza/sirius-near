import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { prepareLoanResult } from "@/lib/sirius/settle";
import { assertAuthenticGrant, requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";

export const runtime = "nodejs";

/** Phase 1 : lance le job et prépare la capsule locale, sans régler l'escrow. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { authorization, deliveryPublicKey } = await readJson<{
      authorization?: RunnerGrant;
      deliveryPublicKey?: unknown;
    }>(req);
    if (!authorization || typeof deliveryPublicKey !== "string") {
      return NextResponse.json({ error: "Autorisation ou clé de livraison manquante" }, { status: 400 });
    }
    await assertAuthenticGrant(session, authorization);
    const loan = await prisma.loan.findUnique({ where: { id }, select: { borrower: true } });
    if (!loan) return NextResponse.json({ error: "Loan introuvable" }, { status: 404 });
    assertOwner(session, loan.borrower);
    const result = await prepareLoanResult(id, deliveryPublicKey, authorization);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
