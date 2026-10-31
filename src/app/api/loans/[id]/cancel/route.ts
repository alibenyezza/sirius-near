import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { cancelExpiredLoan } from "@/lib/sirius/cancel";

export const runtime = "nodejs";

const cancellationLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 5,
  maxGlobal: 100,
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(cancellationLimiter, `subject:${session.address}`);
    const { id } = await params;
    return NextResponse.json(await cancelExpiredLoan(id, session.address));
  } catch (error) {
    return errorResponse(error);
  }
}
