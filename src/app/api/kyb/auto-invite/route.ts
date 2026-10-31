import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { autoInviteEnabled } from "@/lib/kyb/auto-invite";
import { issueSessionAutoInvitation } from "@/lib/sirius/kyb-auto-invite";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store" };
// Garde-fou par instance, en plus des plafonds en base (1 par wallet et par 24 h, N par IP et par heure, N par heure).
const clientLimiter = new FixedWindowRateLimiter({ windowMs: 60 * 60_000, maxPerKey: 10, maxGlobal: 600 });

/** Adresse IP transmise par l'ingress (`SIRIUS_TRUST_PROXY_HEADERS=true`) ; sinon aucune, et le plafond par IP ne s'applique pas. */
function trustedIp(clientKey: string | null): string | null {
  return clientKey?.startsWith("ip:") ? clientKey.slice(3) : null;
}

/**
 * Accès instantané KYB : signe une invitation pour le wallet de la session, et pour lui seul.
 * Le wallet l'accepte ensuite on-chain par le même chemin qu'un code collé.
 *
 * 404 tant que `SIRIUS_KYB_AUTO_INVITE=true` et sa clé ne sont pas posés : pour le reste du
 * monde, la route n'existe pas.
 */
export async function POST(req: Request) {
  try {
    if (!autoInviteEnabled()) return NextResponse.json({ error: "Accès instantané KYB indisponible" }, { status: 404 });
    const session = requireAuth(req);
    const clientKey = requestClientKey(req, session.address);
    enforceRateLimit(clientLimiter, clientKey);
    return NextResponse.json(await issueSessionAutoInvitation(session.address, trustedIp(clientKey)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
