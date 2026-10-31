import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { loadOwnedDataset, parseConsentRequest, readOwnerView, revokeTrainingConsent } from "@/lib/datasets/manage";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store" };
// Déploiement de démonstration Phala : rien n'y repasse en ligne (voir manage.ts).
const demoMode = () => process.env.SIRIUS_PHALA_DEMO === "true";

const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 10, maxGlobal: 200 });

/**
 * Retrait du consentement à l'amélioration des modèles. Seul le retrait existe ici : donner
 * un consentement suppose le texte versionné de l'upload, qui appartient à ce parcours.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(limiter, `subject:${session.address}`);
    const { id } = await params;
    parseConsentRequest(await readJson<Record<string, unknown>>(req, 1024));
    const row = await loadOwnedDataset(prisma, id, session.address);
    await revokeTrainingConsent(prisma, row);
    return NextResponse.json(await readOwnerView(prisma, row.id, session.address, Date.now(), { demoMode: demoMode() }), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
