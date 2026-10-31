import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireMutationGrant } from "@/lib/auth/mutation-grant";
import { AppError, errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import {
  applyExtension,
  applyVisibility,
  extendedListingExpiry,
  extensionRelists,
  loadOwnedDataset,
  parseListingRequest,
  readOwnerView,
  visibilityTransition,
} from "@/lib/datasets/manage";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "private, no-store" };
const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 400 });

// Un grant de mutation (délégation + signature P-256) tient sous 4 Ko ; marge confortable.
const MAX_LISTING_BODY_BYTES = 16 * 1024;

/**
 * Publication d'une annonce par son propriétaire :
 * - `pause` (LISTED → UNLISTED) et `resume` (UNLISTED ou PRIVATE → LISTED) exigent le grant
 *   de mutation `set-dataset-visibility` de la route de visibilité existante, lié à
 *   l'identifiant et au statut visé, consommé une seule fois ;
 * - `extend` repousse `listingExpiresAt` de 7, 30 ou 90 jours ; si l'annonce est LISTED et
 *   déjà expirée, la prolonger la remet sur la marketplace et le même grant (cible LISTED)
 *   est exigé.
 * En déploiement de démo Phala, rien n'est remis en ligne par cette route, ni par la
 * reprise ni par la prolongation d'une annonce expirée.
 * Chaque transition est vérifiée en lecture puis rejouée par la base au moment d'écrire.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(limiter, `subject:${session.address}`);
    const { id } = await params;
    const request = parseListingRequest(await readJson<Record<string, unknown>>(req, MAX_LISTING_BODY_BYTES));
    const row = await loadOwnedDataset(prisma, id, session.address);
    const demoMode = process.env.SIRIUS_PHALA_DEMO === "true";
    if (request.action === "extend") {
      const now = Date.now();
      // Contrôlée avant le grant : une prolongation impossible ne consomme rien.
      extendedListingExpiry(row, request.days, now);
      const relists = extensionRelists(row, now);
      if (relists) {
        if (demoMode) throw new AppError("Remise en ligne impossible pour ce dataset", 409);
        // Prolonger une annonce LISTED expirée la remet sur la marketplace : même grant que
        // la remise en ligne.
        if (!request.authorization) throw new AppError("Confirmation wallet requise", 400);
        await requireMutationGrant(session, request.authorization as RunnerGrant, {
          operation: "set-dataset-visibility",
          datasetId: row.id,
          intentParts: [row.id, "LISTED"],
        });
      }
      await applyExtension(prisma, row, request.days, now, { grantChecked: relists });
    } else {
      const transition = visibilityTransition(request.action, row, Date.now(), {
        demoMode,
      });
      await requireMutationGrant(session, request.authorization as RunnerGrant, {
        operation: "set-dataset-visibility",
        datasetId: row.id,
        intentParts: [row.id, transition.to],
      });
      await applyVisibility(prisma, row, transition);
    }
    return NextResponse.json(await readOwnerView(prisma, row.id, session.address, Date.now(), { demoMode }), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
