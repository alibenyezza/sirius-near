import { NextResponse } from "next/server";
import { requestDemoController } from "@/lib/phala-demo/controller-client";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 30, maxGlobal: 600 });

export async function GET(req: Request) {
  try {
    enforceRateLimit(limiter, requestClientKey(req));
    const status = await requestDemoController();
    return NextResponse.json({ phase: status.phase, available: status.available,
      activeOperations: status.activeOperations, funding: status.funding, sessionRevision: status.sessionRevision }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
