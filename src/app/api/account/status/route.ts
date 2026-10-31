import { NextResponse } from "next/server";
import { tryNormalizeAddress } from "@/lib/evm/address";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";
import { errorResponse } from "@/lib/errors";
import { AppError } from "@/lib/app-error";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";

export const runtime = "nodejs";

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 1_024;
const statusLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 30,
  maxGlobal: 300,
});
const statusCache = new Map<string, { known: boolean; expiresAt: number }>();

function cachedStatus(address: string): boolean | null {
  const cached = statusCache.get(address);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    statusCache.delete(address);
    return null;
  }
  return cached.known;
}

function cacheStatus(address: string, known: boolean): void {
  if (statusCache.size >= MAX_CACHE_ENTRIES && !statusCache.has(address)) {
    statusCache.delete(statusCache.keys().next().value as string);
  }
  statusCache.set(address, { known, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function GET(req: Request) {
  try {
    const address = tryNormalizeAddress(new URL(req.url).searchParams.get("address"));
    if (!address) {
      return NextResponse.json({ error: "Adresse invalide" }, { status: 400 });
    }
    enforceRateLimit(statusLimiter, requestClientKey(req, address));
    const cached = cachedStatus(address);
    if (cached !== null) return NextResponse.json({ known: cached });

    const known = await getPublicClient().readContract({
      address: kybRegistryAddress(),
      abi: siriuskybregistryAbi,
      functionName: "isKybValid",
      args: [address],
    }).catch(() => { throw new AppError("Statut EVM indisponible", 503); });
    cacheStatus(address, known);
    return NextResponse.json({ known });
  } catch (err) {
    return errorResponse(err);
  }
}
