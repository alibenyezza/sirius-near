import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { prepareLoan } from "@/lib/sirius/borrower";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { loanBillingQuote } from "@/lib/billing/loan";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

// Chaque préparation fait signer un devis au runner et remplace le PENDING non payé du compte, dont
// l'autorisation de lock reste valable jusqu'à neuf minutes : dix préparations par compte et par
// dix minutes bornent ce que des préparations abandonnées peuvent encore verrouiller (audit A-06).
const preparationLimiter = new FixedWindowRateLimiter({ windowMs: 600_000, maxPerKey: 10, maxGlobal: 600 });

export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    // N'expose que les prêts où le compte est partie prenante (borrower ou provider).
    const loans = await prisma.loan.findMany({
      where: { OR: [{ borrower: session.address }, { provider: session.address }] },
      orderBy: { createdAt: "desc" },
      include: { dataset: { select: { name: true, runnerReceipt: true } } },
    });
    const now = Date.now();
    return NextResponse.json(loans.map((loan) => ({
      ...loan,
      usdcDecimals: loanBillingQuote(loan)?.quote.usdcDecimals,
      refundable:
        (loan.status === "ESCROWED" || loan.status === "TRAINING" || loan.status === "SETTLING") &&
        loan.evmDeadline !== null &&
        loan.evmDeadline.getTime() <= now,
    })));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(preparationLimiter, `subject:${session.address}`);
    const { datasetId } = await readJson<Record<string, unknown>>(req);

    if (typeof datasetId !== "string" || !datasetId) {
      return NextResponse.json({ error: "datasetId manquant" }, { status: 400 });
    }
    const { loan, approveTransaction, lockTransaction, billingQuote } = await prepareLoan(datasetId, session.address);

    return NextResponse.json({ loanId: loan.id, approveTransaction, lockTransaction, billingQuote }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
