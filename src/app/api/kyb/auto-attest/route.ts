import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { autoSponsorEnabled } from "@/lib/kyb/auto-invite";
import { prepareSessionSponsoredAttestation, submitSessionSponsoredAttestation } from "@/lib/sirius/kyb-auto-invite";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store" };
// Garde-fou par instance, en plus des plafonds en base partagés avec l'accès instantané.
const clientLimiter = new FixedWindowRateLimiter({ windowMs: 60 * 60_000, maxPerKey: 10, maxGlobal: 600 });

/** Adresse IP transmise par l'ingress (`SIRIUS_TRUST_PROXY_HEADERS=true`) ; sinon aucune, et le plafond par IP ne s'applique pas. */
function trustedIp(clientKey: string | null): string | null {
  return clientKey?.startsWith("ip:") ? clientKey.slice(3) : null;
}

function unavailable() {
  return NextResponse.json({ error: "Attestation parrainée indisponible" }, { status: 404 });
}

/**
 * Attestation parrainée, juste après la connexion : le wallet de la session signe son
 * consentement (POST le prépare), puis le vérificateur automatique pose l'attestation et paie
 * le gas (PUT). L'utilisateur n'a ni bouton, ni transaction, ni ETH à avoir.
 *
 * 404 tant que `SIRIUS_KYB_AUTO_INVITE=true`, sa clé et `SIRIUS_KYB_AUTO_SPONSOR=true` ne sont
 * pas posés : le client retombe alors sur le parcours de vérification habituel.
 */
export async function POST(req: Request) {
  try {
    if (!autoSponsorEnabled()) return unavailable();
    const session = requireAuth(req);
    const clientKey = requestClientKey(req, session.address);
    enforceRateLimit(clientLimiter, clientKey);
    return NextResponse.json(await prepareSessionSponsoredAttestation(session.address, trustedIp(clientKey)), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    if (!autoSponsorEnabled()) return unavailable();
    const session = requireAuth(req);
    const clientKey = requestClientKey(req, session.address);
    enforceRateLimit(clientLimiter, clientKey);
    const body = await readJson<{ expiresAt?: unknown; signature?: unknown }>(req);
    if (typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt)) {
      return NextResponse.json({ error: "expiresAt invalide" }, { status: 400 });
    }
    if (typeof body.signature !== "string") return NextResponse.json({ error: "signature invalide" }, { status: 400 });
    const result = await submitSessionSponsoredAttestation(session.address, trustedIp(clientKey), body.expiresAt, body.signature);
    return NextResponse.json({ subject: result.subject, expiresAt: result.expiresAt, txHash: result.txHash }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
