import { handlePreviewRequest } from "@/lib/preview-gate/preview-route";

/**
 * `GET /preview?key=…` : ouvre la porte d'aperçu du passage mainnet à ce navigateur.
 *
 * Toute la logique vit dans src/lib/preview-gate/preview-route.ts, en API Web pure, pour être
 * testée sans Next. Ici : rien à journaliser, rien à mettre en cache. Le proxy laisse ce
 * chemin passer (liste blanche) ; sans lui, personne ne pourrait obtenir le cookie.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handlePreviewRequest(request);
}
