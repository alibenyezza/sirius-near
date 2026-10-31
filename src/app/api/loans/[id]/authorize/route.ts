import { NextResponse } from "next/server";
import { renewLoanLock } from "@/lib/sirius/borrower";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

// Chaque appel fait signer une autorisation au runner et consomme son budget de requêtes :
// trois par minute et par prêt suffisent au parcours normal (audit M4).
const perLoan = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 3, maxGlobal: 600 });
const perSubject = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 10, maxGlobal: 600 });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    enforceRateLimit(perSubject, `subject:${session.address}`);
    enforceRateLimit(perLoan, `loan:${id}`);
    return NextResponse.json(await renewLoanLock(id, session.address));
  } catch (error) {
    return errorResponse(error);
  }
}
