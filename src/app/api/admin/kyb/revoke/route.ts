import { NextResponse } from "next/server";
import { adminAllowed } from "@/lib/auth/admin";
import { requireAuth } from "@/lib/auth/require-auth";
import { AppError, errorResponse } from "@/lib/errors";
import { normalizeAddress } from "@/lib/evm/address";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { revokeSessionAutoAttestation } from "@/lib/sirius/kyb-auto-invite";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store" };
const limiter = new FixedWindowRateLimiter({ windowMs: 60 * 60_000, maxPerKey: 30, maxGlobal: 120 });

/**
 * Révocation, par un membre de l'équipe (`SIRIUS_ADMIN_ADDRESSES`), d'une attestation émise
 * par le vérificateur automatique : `revoke(subject)` signé par sa clé. `requireAuth` impose
 * la session et l'origine de la requête (CSRF) comme toute route qui écrit ; le contrôle
 * admin se refait ici, côté serveur, quoi qu'en dise l'interface.
 */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    if (!adminAllowed(session.address)) throw new AppError("Accès réservé à l’équipe Sirius", 403);
    enforceRateLimit(limiter, `admin:${session.address}`);
    const { subject } = await readJson<{ subject?: unknown }>(req);
    return NextResponse.json(await revokeSessionAutoAttestation(normalizeAddress(subject, "subject"), session.address), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
