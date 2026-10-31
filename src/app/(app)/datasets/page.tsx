"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectPrompt } from "@/components/wallet/ConnectCta";
import { Page, PageHeader } from "@/components/layout/Page";
import { DatasetAddTile, DatasetCard } from "@/components/datasets/DatasetCard";
import { ensureVerifiedFor, requestVerification, useOnboardingStore } from "@/components/onboarding/onboarding-store";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { messageOf } from "@/lib/errors-client";
import { createInFlightGuard } from "@/lib/onboarding/steps";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { settlementToken } from "@/lib/datasets/token";
import { publishDataset } from "@/lib/datasets/client";
import { PublishDraftButton } from "./[id]/PublishDraftButton";
import { DATASET_CATEGORY_LABEL_KEYS, parseDatasetCategory } from "@/lib/datasets/publication";
import { addressesEqual } from "@/lib/evm/address";
import { modelSelection } from "@/lib/models/registry";
import { useWalletStore } from "@/stores/wallet";
import {
  DATASET_SORTS,
  aggregateLoanStats,
  displayStatus,
  isListingExpired,
  isDatasetSort,
  sortDatasets,
  type DatasetSort,
  type LoanForStats,
} from "@/lib/datasets/manage";

interface DatasetRow {
  id: string;
  name: string;
  status: string;
  category: string | null;
  ipfsCid: string | null;
  modelId: string | null;
  modelVersion: string | null;
  sizeBytes: number | null;
  metrics: { rowCount: number; columnCount: number } | null;
  priceUsdcAtomic: string;
  listingExpiresAt: string | null;
  createdAt: string;
}

interface LoanRow extends LoanForStats {
  datasetId: string;
  provider: string;
}

/** Pages de 24 suivies au plus ce nombre de fois : le tri porte sur tout ce qui est chargé. */
const MAX_PAGES = 20;

const SORT_LABELS: Record<DatasetSort, string> = {
  date: "Date",
  revenue: "Revenus",
  borrows: "Emprunts",
};

const SORT_STORAGE_KEY = "sirius.datasets.sort";

// Jeton de règlement du réseau (USDG sur mainnet, USDC de test sur testnet), fabrique de l'upload.
const TOKEN = settlementToken(resolveClientNetwork());

/** Catégorie de la liste fixe de l'upload, traduite ; une valeur inconnue n'est pas affichée. */
function categoryLabel(value: string | null, t: (key: string) => string): string | null {
  const category = parseDatasetCategory(value);
  return category ? t(DATASET_CATEGORY_LABEL_KEYS[category]) : null;
}

export default function DatasetsPage() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <DatasetsContent key={identity} />;
}

function readStoredSort(): DatasetSort {
  try {
    const stored = window.localStorage.getItem(SORT_STORAGE_KEY);
    return isDatasetSort(stored) ? stored : "date";
  } catch {
    return "date";
  }
}

function DatasetsContent() {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const { t } = useLocale();
  const [datasets, setDatasets] = useState<DatasetRow[] | null>(null);
  const [loans, setLoans] = useState<LoanRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  // Instant de référence des états affichés (expiré ou non), pris au chargement : le rendu reste pur.
  const [loadedAt, setLoadedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [sort, setSort] = useState<DatasetSort>("date");
  const [publishingId, setPublishingId] = useState<string | null>(null);
  // Une seule publication en vol : la garde KYB lit le réseau avant `setPublishingId`.
  const [publishGuard] = useState(createInFlightGuard);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- préférence locale lue après l'hydratation
    setSort(readStoredSort());
    return () => request.current?.abort();
  }, []);

  function chooseSort(next: DatasetSort) {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // Stockage indisponible (navigation privée) : le tri reste valable pour la session.
    }
  }

  // Dépend de l'adresse : les datasets sont scopés à l'identité authentifiée.
  const load = useCallback(async () => {
    request.current?.abort();
    if (!address || !authenticated) {
      setDatasets([]);
      setLoans([]);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setStatsError(null);

    const loansPromise = fetch("/api/loans", { signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error("Statistiques indisponibles");
        const rows: unknown = await res.json();
        if (!Array.isArray(rows)) throw new Error("Statistiques indisponibles");
        return rows as LoanRow[];
      });
    // Le rejet est lu plus bas ; ce gestionnaire évite qu'un abandon avant cette lecture
    // ne remonte comme rejet non géré.
    loansPromise.catch(() => {});

    try {
      const all: DatasetRow[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const res: Response = await fetch(`/api/datasets${query}`, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error("Chargement des datasets impossible");
        all.push(...await res.json() as DatasetRow[]);
        cursor = res.headers.get("x-sirius-next-cursor");
        pages += 1;
      } while (cursor && pages < MAX_PAGES);
      if (controller.signal.aborted) return;
      setLoadedAt(Date.now());
      setDatasets(all);
      setTruncated(Boolean(cursor));
    } catch (err) {
      if (!controller.signal.aborted) setError(messageOf(err));
    }

    try {
      const rows = await loansPromise;
      if (controller.signal.aborted) return;
      // /api/loans renvoie aussi les prêts où le wallet est emprunteur : seuls comptent ceux
      // où il est fournisseur.
      setLoans(rows.filter((loan) => addressesEqual(loan.provider, address)));
    } catch (err) {
      if (!controller.signal.aborted) {
        setLoans(null);
        setStatsError(messageOf(err));
      }
    }
  }, [address, authenticated]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch initial, setState post-await
    load();
  }, [load]);

  // Le bouton ne s'affiche que si le registre refuse encore l'adresse (comportement repris
  // de l'ancienne liste).
  const [kybManquant, setKybManquant] = useState<boolean | null>(null);
  useEffect(() => {
    if (!address) return;
    let actif = true;
    void fetch(`/api/account/status?address=${encodeURIComponent(address)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ known?: unknown }>) : null))
      .then((corps) => {
        if (actif && corps) setKybManquant(corps.known !== true);
      })
      .catch(() => {});
    return () => {
      actif = false;
    };
  }, [address]);

  // Publication d'un brouillon depuis sa carte, comme sur l'ancienne liste (la fiche propose
  // la même action) : bloquée sans profil valide ou sans fichier envoyé.
  async function handlePublish(id: string) {
    await publishGuard.run(() => publishOnce(id));
  }

  async function publishOnce(id: string) {
    setError(null);
    // Wallet non vérifié : fenêtre de vérification, puis la publication reprend.
    if (!(await ensureVerifiedFor("publish"))) return;
    if (useOnboardingStore.getState().kyb === "valid") setKybManquant(false);
    setPublishingId(id);
    try {
      await publishDataset(id);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPublishingId(null);
      await load();
    }
  }

  // Vérification dans la fenêtre partagée (accès instantané, ou invitation si coupé).
  async function handleOnboard() {
    setError(null);
    if (await requestVerification("checklist", "provider")) setKybManquant(false);
  }

  const cards = useMemo(() => {
    if (!datasets) return [];
    const now = loadedAt;
    const byDataset = new Map<string, LoanRow[]>();
    for (const loan of loans ?? []) {
      const list = byDataset.get(loan.datasetId);
      if (list) list.push(loan);
      else byDataset.set(loan.datasetId, [loan]);
    }
    const rows = datasets.map((dataset) => {
      const stats = loans ? aggregateLoanStats(byDataset.get(dataset.id) ?? [], now) : null;
      return {
        dataset,
        id: dataset.id,
        createdAt: dataset.createdAt,
        earnedAtomic: stats ? stats.earnedAtomic : null,
        borrowCount: stats ? stats.borrowCount : null,
        status: displayStatus({
          status: dataset.status,
          listingExpiresAt: dataset.listingExpiresAt,
          inFlightLoans: stats ? stats.inFlightCount : null,
        }, now),
      };
    });
    return sortDatasets(rows, sort);
  }, [datasets, loans, sort, loadedAt]);

  if (!connected || !address) {
    return (
      <Page width="wide">
        <PageHeader title={t("Mes datasets")} />
        <ConnectPrompt message={t("Connecte un wallet pour gérer tes datasets.")} />
      </Page>
    );
  }

  const online = cards.filter((card) => card.status === "online" || card.status === "borrowed").length;

  return (
    <Page width="wide">
      <PageHeader
        title={t("Mes datasets")}
        description={datasets && t("{count} dataset(s), dont {online} en ligne ou emprunté(s).", { count: datasets.length, online })}
        actions={
          <>
            {kybManquant === true && (
              <button
                onClick={handleOnboard}
                className="rounded-xl border border-border bg-surface px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-white/20"
              >
                {t("Vérifier mon wallet")}
              </button>
            )}
            <div role="group" aria-label={t("Trier par")} data-guide="page:datasets:sort" className="flex items-center gap-2">
              <span className="text-xs text-muted">{t("Trier par")}</span>
              <div className="grid grid-cols-3 rounded-lg border border-border p-0.5">
                {DATASET_SORTS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => chooseSort(option)}
                    aria-pressed={sort === option}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      sort === option ? "bg-accent text-background" : "text-muted hover:text-foreground"
                    }`}
                  >
                    {t(SORT_LABELS[option])}
                  </button>
                ))}
              </div>
            </div>
          </>
        }
      />

      {error && (
        <div role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
          {t(error)}
        </div>
      )}
      {statsError && (
        <div role="status" className="rounded-lg border border-border bg-surface/50 px-4 py-3 text-sm text-muted">
          {t("Emprunts et revenus indisponibles pour le moment : {reason}", { reason: t(statsError) })}
        </div>
      )}
      {truncated && (
        <p className="text-xs text-muted">
          {t("Seuls les {count} datasets les plus récents sont affichés et triés.", { count: datasets?.length ?? 0 })}
        </p>
      )}

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-guide={cards.length > 0 ? "page:datasets:cards" : undefined}>
        <li data-guide="page:datasets:new">
          <DatasetAddTile href="/datasets/new" />
        </li>
        {cards.map(({ dataset, status, borrowCount, earnedAtomic }) => (
          <li key={dataset.id} className="flex min-w-0 flex-col gap-1.5">
            <DatasetCard
              name={dataset.name}
              category={categoryLabel(dataset.category, t)}
              modelId={dataset.modelId}
              modelVersion={dataset.modelVersion}
              rowCount={dataset.metrics?.rowCount ?? null}
              columnCount={dataset.metrics?.columnCount ?? null}
              sizeBytes={dataset.sizeBytes}
              priceAtomic={dataset.priceUsdcAtomic}
              priceKind="providerReceives"
              token={TOKEN}
              status={status}
              // Statistiques indisponibles : NaN s'affiche « — » (formatCount), jamais un faux 0.
              borrowCount={borrowCount ?? Number.NaN}
              revenueAtomic={earnedAtomic}
              href={`/datasets/${encodeURIComponent(dataset.id)}`}
            />
            <CardCaption dataset={dataset} status={status} now={loadedAt} />
            <PublishDraftButton
              status={dataset.status}
              ipfsCid={dataset.ipfsCid}
              modelValid={Boolean(modelSelection(dataset.modelId, dataset.modelVersion))}
              pending={publishingId === dataset.id}
              disabled={publishingId !== null}
              onPublish={() => void handlePublish(dataset.id)}
              className="self-start"
            />
          </li>
        ))}
      </ul>

      {datasets === null && !error && <p className="py-8 text-center text-sm text-muted">{t("Chargement…")}</p>}
      {datasets !== null && datasets.length === 0 && !error && (
        <p className="py-8 text-center text-sm text-muted">{t("Aucun dataset pour l’instant : publie le premier avec la tuile ci-dessus.")}</p>
      )}
    </Page>
  );
}

/**
 * Précision sous la carte quand la pastille ne suffit pas : brouillon, publication en cours,
 * dataset privé, archivé par Sirius, en pause ou expiré pendant un emprunt, profil invalide.
 */
function CardCaption({ dataset, status, now }: { dataset: DatasetRow; status: string; now: number }) {
  const { t } = useLocale();
  const notes: string[] = [];
  if (dataset.status === "DRAFT") notes.push(t("Brouillon : publication non terminée."));
  if (dataset.status === "LISTING") notes.push(t("Publication en cours."));
  if (dataset.status === "PRIVATE") notes.push(t("Privé : visible par toi seul."));
  if (dataset.status === "SUSPENDED") notes.push(t("Archivé par Sirius : plus disponible à l’emprunt."));
  if (dataset.status === "DELETED") notes.push(t("Suppression à finaliser."));
  if (status === "borrowed" && dataset.status === "UNLISTED") notes.push(t("En pause : hors marketplace."));
  if (status === "borrowed" && dataset.status === "LISTED" && isListingExpired(dataset.listingExpiresAt, now)) {
    notes.push(t("Annonce expirée."));
  }
  if (dataset.status !== "DELETED" && !modelSelection(dataset.modelId, dataset.modelVersion)) {
    notes.push(t("Ancien dataset sans profil valide : supprime-le et importe-le à nouveau en choisissant un entraînement."));
  }
  if (notes.length === 0) return null;
  return <p className="px-1 text-xs text-muted">{notes.join(" ")}</p>;
}
