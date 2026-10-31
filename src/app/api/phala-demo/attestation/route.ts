import { NextResponse } from "next/server";
import { attestedRunnerFetch } from "@/lib/tee/ra-tls-client";
import { runnerEndpoint } from "@/lib/runner/config";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 6, maxGlobal: 60 });

export async function GET(req: Request) {
  try {
    enforceRateLimit(limiter, requestClientKey(req));
    if (process.env.SIRIUS_PHALA_DEMO !== "true") throw new Error();
    const endpoint = runnerEndpoint();
    if (!endpoint?.startsWith("https:")) throw new Error();
    const response = await attestedRunnerFetch(new URL("/ra-tls", endpoint), { method: "GET", timeoutMs: 10_000 });
    if (!response.ok) throw new Error();
    return NextResponse.json({ verifiedAt: new Date().toISOString(), evidence: await response.json() }, { headers: { "cache-control": "no-store" } });
  } catch { return NextResponse.json({ error: "Attestation indisponible : le runner doit être actif" }, { status: 503 }); }
}
