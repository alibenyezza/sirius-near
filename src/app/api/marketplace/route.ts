import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { createCatalogueSnapshotCache, loadCatalogue } from "@/lib/marketplace/catalogue";
import { parseMarketplaceQuery } from "@/lib/marketplace/query";
import { marketplaceDeps } from "@/lib/marketplace/server";

export const runtime = "nodejs";

/**
 * Catalogue public de la marketplace, en lecture seule et sans session.
 *
 * Aucune lecture de cookie : la réponse ne dépend que des paramètres de l'URL, identique pour
 * tous les visiteurs. Seuls les datasets en ligne (publiés, non expirés, clé active présente)
 * sont lus, avec une liste blanche de colonnes, puis projetés champ par champ.
 */

// Lecture publique et non authentifiée : débit borné par client (si l'ingress transmet son
// adresse) et par instance, comme les autres routes publiques du dépôt.
const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 60, maxGlobal: 1_200 });
// Lecture du catalogue partagée quelques secondes entre requêtes : le coût en base et en RPC ne
// croît plus avec le nombre de visiteurs. Filtres, tri et pages restent calculés à chaque requête.
const snapshot = createCatalogueSnapshotCache();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(req: Request) {
  try {
    enforceRateLimit(limiter, requestClientKey(req));
    const deps = marketplaceDeps();
    const parsed = parseMarketplaceQuery(new URL(req.url).searchParams, deps.token.decimals);
    if (!parsed.ok) return noStore(NextResponse.json({ error: parsed.error }, { status: 400 }));
    return noStore(NextResponse.json(await loadCatalogue(parsed.query, deps, snapshot)));
  } catch (error) {
    return noStore(errorResponse(error));
  }
}
