import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { verifyTdxQuote } from "@/lib/tee/quote";
import type { QuoteVerification } from "@/lib/tee/quote";
import { hashLoanAttestationPayload, parseLoanAttestationPayload } from "@/lib/tee/attestation";
import { loanEscrowBinding } from "@/lib/evm/history";
import type { LoanAttestationPayload } from "@/lib/tee/types";
import { AppError, errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const attestationLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 10,
  maxGlobal: 100,
});
const ATTESTATION_CACHE_TTL_MS = 10 * 60_000;
const ATTESTATION_CACHE_MAX = 1_000;
const verificationCache = new Map<string, { expiresAt: number; value: QuoteVerification }>();

async function verifyCachedAttestation(
  cacheKey: string,
  quote: string,
  payloadHash: string,
  evidence?: { eventLog: string; composeHash: string },
): Promise<QuoteVerification> {
  const now = Date.now();
  const cached = verificationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  verificationCache.delete(cacheKey);
  if (verificationCache.size >= ATTESTATION_CACHE_MAX) {
    const oldest = verificationCache.keys().next().value;
    if (oldest) verificationCache.delete(oldest);
  }
  const value = await verifyTdxQuote(quote, payloadHash, evidence);
  verificationCache.set(cacheKey, { expiresAt: now + ATTESTATION_CACHE_TTL_MS, value });
  return value;
}

/** Preuve TEE liée au modèle, au scope de prêt et à la capsule livrée. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(attestationLimiter, `subject:${session.address}`);
    const { id } = await params;
    const loan = await prisma.loan.findUnique({ where: { id }, include: { dataset: true } });
    if (!loan) throw new AppError("Loan introuvable", 404);
    if (session.address !== loan.borrower && session.address !== loan.provider) {
      throw new AppError("Accès refusé : preuve réservée aux parties de l'emprunt", 403);
    }
    if (loan.status !== "SETTLED" || !loan.attestationHash || !loan.attestationPayload) {
      throw new AppError("Emprunt pas encore réglé", 409);
    }

    let payload: LoanAttestationPayload;
    try {
      payload = parseLoanAttestationPayload(loan.attestationPayload);
    } catch {
      throw new AppError("Preuve d’attestation invalide", 409);
    }
    const { chainId, escrow } = loanEscrowBinding(loan);
    if (
      hashLoanAttestationPayload(loan.attestationPayload) !== loan.attestationHash ||
      payload.chainId !== chainId ||
      payload.escrow !== escrow ||
      payload.loanId !== loan.id ||
      payload.loanKey !== loan.evmLoanKey ||
      payload.datasetId !== loan.datasetId ||
      payload.datasetCid !== loan.dataset.ipfsCid ||
      payload.provider !== loan.provider ||
      payload.borrower !== loan.borrower ||
      payload.amountUsdcAtomic !== loan.amountUsdcAtomic ||
      (payload.billingQuoteHash ?? null) !== (loan.billingQuoteHash ?? null) ||
      payload.challengeDays !== loan.dataset.challengeDays ||
      payload.merkleRoot !== loan.dataset.merkleRoot ||
      payload.modelId !== loan.modelId ||
      payload.modelVersion !== loan.modelVersion ||
      payload.modelCid !== loan.modelCid
    ) {
      throw new AppError("Preuve d’attestation incohérente", 409);
    }

    if (!loan.attestationQuote) {
      return NextResponse.json({
        payloadHash: loan.attestationHash,
        payload,
        auditReceipt: loan.auditReceipt,
        quote: null,
        verification: null,
      });
    }

    // La vérif matérielle est sautée d'elle-même au simulateur (cf verifyTdxQuote).
    const evidence =
      loan.attestationEventLog && loan.attestationComposeHash
        ? { eventLog: loan.attestationEventLog, composeHash: loan.attestationComposeHash }
        : undefined;
    const verification = await verifyCachedAttestation(
      `${loan.id}:${loan.attestationHash}`,
      loan.attestationQuote,
      loan.attestationHash,
      evidence,
    );
    return NextResponse.json({
      payloadHash: loan.attestationHash,
      payload,
      auditReceipt: loan.auditReceipt,
      quote: loan.attestationQuote,
      evidence,
      verification,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
