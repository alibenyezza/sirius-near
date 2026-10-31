import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { loadListingDetail } from "@/lib/marketplace/catalogue";
import { marketplaceDeps } from "@/lib/marketplace/server";

export const runtime = "nodejs";

/**
 * Fiche publique d'un dataset de la marketplace, en lecture seule et sans session.
 *
 * Seul un dataset en ligne est servi. Pause, expiration, destruction, privé, brouillon ou
 * identifiant inconnu donnent la même 404, sans dire lequel. Cette route ne révèle donc rien de
 * plus ; attention toutefois, `GET /api/datasets/[id]` (hors de cette slice, inchangé) sert
 * toujours la ligne d'un dataset `UNLISTED` (en pause) à qui connaît son identifiant.
 */

const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 120, maxGlobal: 2_400 });

/** Identifiants cuid du dépôt (et ceux des jeux d'essai) : lettres, chiffres, `-` et `_`. */
const DATASET_ID = /^[A-Za-z0-9_-]{1,64}$/;

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    enforceRateLimit(limiter, requestClientKey(req));
    const { id } = await params;
    if (typeof id !== "string" || !DATASET_ID.test(id)) {
      return noStore(NextResponse.json({ error: "Dataset introuvable" }, { status: 404 }));
    }
    const detail = await loadListingDetail(id, marketplaceDeps());
    if (!detail) return noStore(NextResponse.json({ error: "Dataset introuvable" }, { status: 404 }));
    return noStore(NextResponse.json(detail));
  } catch (error) {
    return noStore(errorResponse(error));
  }
}
