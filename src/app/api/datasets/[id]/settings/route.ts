import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import { applyDetails, loadOwnedDataset, readOwnerView, validateDetailsPatch } from "@/lib/datasets/manage";

export const runtime = "nodejs";

// Fiche du fournisseur : réservée au wallet de la session, jamais mise en cache. Un dataset
// absent et celui d'un autre wallet répondent pareil (404), pour ne pas révéler un identifiant.
const NO_STORE = { "cache-control": "private, no-store" };
// Déploiement de démonstration Phala : rien n'y repasse en ligne (voir manage.ts).
const demoMode = () => process.env.SIRIUS_PHALA_DEMO === "true";


const readLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 60, maxGlobal: 1_000 });
const writeLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 400 });

// 2 000 caractères de description, jusqu'à 4 octets chacun en UTF-8, plus le nom et le JSON.
const MAX_DETAILS_BODY_BYTES = 16 * 1024;

/** Vue complète du propriétaire : description, état, annonce, consentement. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(readLimiter, `subject:${session.address}`);
    const { id } = await params;
    return NextResponse.json(await readOwnerView(prisma, id, session.address, Date.now(), { demoMode: demoMode() }), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Nom et description. Le prix est refusé explicitement : il est scellé dans le reçu de l'enclave. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(writeLimiter, `subject:${session.address}`);
    const { id } = await params;
    const patch = validateDetailsPatch(await readJson<Record<string, unknown>>(req, MAX_DETAILS_BODY_BYTES));
    const row = await loadOwnedDataset(prisma, id, session.address);
    await applyDetails(prisma, row, patch);
    return NextResponse.json(await readOwnerView(prisma, row.id, session.address, Date.now(), { demoMode: demoMode() }), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
