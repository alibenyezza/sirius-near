import "server-only";
import { after } from "next/server";
import { assistantToolSource } from "@/lib/assistant/tools-server";
import { loadCertificate } from "@/lib/certificate/load";
import { allowCertificatePage } from "@/lib/certificate/page-guard";
import { verifyCertificate } from "@/lib/certificate/verification";
import { publishedTariff } from "@/lib/datasets/tariff-server";
import { createCatalogueSnapshotCache, loadCatalogue, loadListingDetail } from "@/lib/marketplace/catalogue";
import { marketplaceDeps } from "@/lib/marketplace/server";
import { readProtocolStatus } from "@/lib/sirius/protocol-status";
import type { AgentPricing, AgentToolSource, CertificateLookup } from "./tools";

/**
 * Sources réelles des outils MCP : les mêmes lectures que les pages publiques.
 *
 * - catalogue : `loadCatalogue` avec son propre cache court (comme `GET /api/marketplace`) ;
 * - fiche : `loadListingDetail` (comme `GET /api/marketplace/[id]`) ;
 * - état du protocole : la source de Sirio (`readProtocolStatus` et tarif publié) ;
 * - prix : symbole et jeton de `/status`, frais de calcul du tarif publié (`publishedTariff`) ;
 * - certificat : `loadCertificate` puis `verifyCertificate`, sous le même limiteur que la page
 *   `/certificate/[loanId]` : un agent ne peut pas s'en servir pour contourner son plafond
 *   de vérifications matérielles.
 *
 * Aucune session n'est lue : la réponse est la même pour tous les appelants.
 */

const snapshot = createCatalogueSnapshotCache();

/** Une vérification plus lente que la réponse continue après elle et remplit le cache. */
function keepAlive(pending: Promise<unknown>): void {
  try {
    after(() => pending);
  } catch {
    // Hors du cycle d'une requête Next (script, test) : la vérification continue sans garantie.
  }
}

async function pricing(): Promise<AgentPricing> {
  const status = await assistantToolSource().status();
  const tariff = publishedTariff();
  return {
    symbol: readProtocolStatus().symbol,
    settlementToken: status.settlementToken,
    tariff: tariff && { decimals: tariff.decimals, computeFeeAtomic: tariff.computeFeeAtomic },
  };
}

async function certificate(loanId: string, request: Request | undefined): Promise<CertificateLookup> {
  if (!allowCertificatePage(request?.headers ?? new Headers())) return { kind: "busy" };
  const resolution = await loadCertificate(loanId);
  if (resolution.kind !== "ready") return resolution;
  return { kind: "ready", record: resolution.record, outcome: await verifyCertificate(resolution.record, keepAlive) };
}

export function agentToolSource(request?: Request): AgentToolSource {
  return {
    catalogue: (query) => loadCatalogue(query, marketplaceDeps(), snapshot),
    dataset: (id) => loadListingDetail(id, marketplaceDeps()),
    pricing,
    status: () => assistantToolSource().status(),
    certificate: (loanId) => certificate(loanId, request),
  };
}
