import "server-only";
import { formatTokenAmount } from "@/components/datasets/price";
import { publishedTariff } from "@/lib/datasets/tariff-server";
import { createCatalogueSnapshotCache, loadCatalogue } from "@/lib/marketplace/catalogue";
import { DEFAULT_MARKETPLACE_QUERY, foldSearchText, MAX_SEARCH_TERMS } from "@/lib/marketplace/query";
import { marketplaceDeps } from "@/lib/marketplace/server";
import { MODEL_REGISTRY, type ModelId } from "@/lib/models/registry";
import { readProtocolStatus } from "@/lib/sirius/protocol-status";
import type { AssistantToolSource, ListDatasetsInput, ProtocolStatusSummary } from "./tools";

/**
 * Sources réelles des outils de Sirio : le catalogue public (même lecture, même cache court que
 * `GET /api/marketplace`) et l'état du protocole (`readProtocolStatus`, la même lecture que la
 * page /status : réseau, plafonds, contrats), complété du tarif publié. Aucune session n'est lue :
 * la réponse est la même pour tous les visiteurs.
 */

const snapshot = createCatalogueSnapshotCache();

function protocolStatus(): ProtocolStatusSummary {
  const status = readProtocolStatus();
  const { network, chain, mainnet, symbol } = status;
  const tariff = publishedTariff();
  const amount = (atomic: string) => `${formatTokenAmount(atomic, tariff?.decimals ?? 6) ?? atomic} ${symbol}`;
  return {
    network,
    chain: { name: chain.name, id: chain.id },
    settlementToken: mainnet ? `${symbol} (Global Dollar, issued by Paxos)` : `${symbol} (valueless test token)`,
    confidentialCompute: status.confidentialCompute,
    settlement: status.settlement,
    externalAudit: status.externalAudit,
    limits: status.limits,
    tariff: tariff
      ? {
        version: tariff.version,
        computeFeeByProfile: Object.fromEntries(
          (Object.keys(tariff.computeFeeAtomic) as ModelId[]).map((id) => [MODEL_REGISTRY[id].label, amount(tariff.computeFeeAtomic[id])]),
        ),
        minimumProviderPrice: amount(tariff.minimumProviderAtomic),
      }
      : null,
    contracts: Object.fromEntries(status.contracts.map((contract) => [contract.key === "stablecoin" ? symbol : contract.key, contract.address])),
    pages: { status: "/status", marketplace: "/marketplace" },
  };
}

/** Catalogue filtré comme la page : termes repliés, catégorie, tri par date, première page. */
async function catalogue(input: ListDatasetsInput) {
  const terms = input.search ? foldSearchText(input.search).split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS) : [];
  const deps = marketplaceDeps();
  return loadCatalogue({ ...DEFAULT_MARKETPLACE_QUERY, terms, category: input.category }, deps, snapshot);
}

export function assistantToolSource(): AssistantToolSource {
  return { catalogue, status: protocolStatus };
}
