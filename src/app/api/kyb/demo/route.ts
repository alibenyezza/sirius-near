import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { prepareDemoAttestation, submitDemoAttestation } from "@/lib/sirius/kyb-demo";
import { finalizeKybAcceptance } from "@/lib/sirius/kyb";

export const runtime = "nodejs";
const kybSubjectLimiter = new FixedWindowRateLimiter({
  windowMs: 60 * 60_000,
  maxPerKey: 3,
  maxGlobal: 120,
});
const kybClientLimiter = new FixedWindowRateLimiter({
  windowMs: 60 * 60_000,
  maxPerKey: 20,
  maxGlobal: 1_200,
});

/**
 * Attestation KYB parrainée, sur les instances de démonstration uniquement.
 *
 * POST prépare ce que le wallet doit signer ; PUT pose l'attestation avec cette
 * signature, aux frais du vérificateur. Le visiteur n'a besoin d'aucun ETH.
 *
 * Les deux verbes exigent une session authentifiée et n'attestent que l'adresse de
 * cette session : sans ça, n'importe qui pourrait faire attester l'adresse d'un tiers
 * et consommer le gas du vérificateur à volonté.
 */

export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(kybSubjectLimiter, `prepare:${session.address}`);
    enforceRateLimit(kybClientLimiter, requestClientKey(req));
    return NextResponse.json(await prepareDemoAttestation(session.address));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(kybSubjectLimiter, `submit:${session.address}`);
    enforceRateLimit(kybClientLimiter, requestClientKey(req));
    const body = await readJson<{ expiresAt?: unknown; signature?: unknown }>(req);

    if (typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt)) {
      return NextResponse.json({ error: "expiresAt invalide" }, { status: 400 });
    }
    if (typeof body.signature !== "string") {
      return NextResponse.json({ error: "signature invalide" }, { status: 400 });
    }

    const resultat = await submitDemoAttestation(session.address, body.expiresAt, body.signature);
    // Réutilise le chemin normal pour la persistance, afin que l'état applicatif soit
    // le même qu'après une attestation posée hors de l'application.
    await finalizeKybAcceptance(session.address, resultat.txHash ?? undefined, resultat.verifier);
    return NextResponse.json(resultat);
  } catch (err) {
    return errorResponse(err);
  }
}
