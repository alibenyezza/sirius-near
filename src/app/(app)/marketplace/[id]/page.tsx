"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BackLink, Page, PageHeader } from "@/components/layout/Page";
import { CardTitle } from "@/components/ui/Heading";
import { useParams } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { PriceBreakdown } from "@/components/datasets/PriceBreakdown";
import { formatTokenWithSymbol } from "@/components/datasets/price";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { StatusPill } from "@/components/ui/StatusPill";
import { formatCount } from "@/lib/copy/numbers";
import { formatBytes, truncate } from "@/lib/format";
import { categoryLabelKey } from "@/lib/marketplace/categories";
import type { DetailResponse } from "@/lib/marketplace/catalogue";
import { MODEL_REGISTRY, modelDisplayName, modelSelection } from "@/lib/models/registry";
import { BorrowPanel } from "./BorrowPanel";

type LoadResult =
  | { id: string; status: "ready"; data: DetailResponse }
  | { id: string; status: "missing" }
  | { id: string; status: "error"; message: string };

/** Date affichée identique quel que soit le fuseau ou la langue du navigateur. */
function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Fiche publique d'un dataset en ligne : ce qu'on achète, à quel prix, ce qu'on obtient et ce
 * qui se passe en cas d'échec. Lisible sans wallet ; seul le bouton « Emprunter » demande la
 * connexion.
 */
export default function MarketplaceListingPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";
  const { t } = useLocale();
  const [result, setResult] = useState<LoadResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/marketplace/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as (DetailResponse & { error?: unknown }) | null;
        if (controller.signal.aborted) return;
        if (response.status === 404) return setResult({ id, status: "missing" });
        if (!response.ok || !body?.dataset) {
          return setResult({ id, status: "error", message: typeof body?.error === "string" ? body.error : "Fiche indisponible" });
        }
        setResult({ id, status: "ready", data: body });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ id, status: "error", message: "Fiche indisponible" });
      });
    return () => controller.abort();
  }, [id]);

  const back = { href: "/marketplace", label: t("Retour à la marketplace") };

  if (!result || result.id !== id) {
    return (
      <Page>
        <BackLink {...back} />
        <p className="text-sm text-muted" aria-live="polite">{t("Chargement…")}</p>
      </Page>
    );
  }

  if (result.status !== "ready") {
    return (
      <Page>
        <PageHeader
          back={back}
          title={result.status === "missing" ? t("Dataset indisponible") : t("Fiche indisponible")}
          description={
            <p role={result.status === "error" ? "alert" : undefined}>
              {result.status === "missing"
                ? t("Ce dataset n’est pas en ligne sur la marketplace : il a pu être mis en pause, expirer ou être retiré.")
                : t(result.message)}
            </p>
          }
        />
      </Page>
    );
  }

  const { dataset, token } = result.data;
  const model = modelSelection(dataset.modelId, dataset.modelVersion);
  const fee = dataset.computeFee;
  const resolved = dataset.settledCount + dataset.refundedCount;
  const name = dataset.name.trim() === "" ? t("Dataset sans nom") : dataset.name;
  const days = dataset.challengeDays;

  return (
    <Page>
      <PageHeader back={back} title={name} actions={<StatusPill status="online" className="shrink-0" />}>
        <div className="flex flex-wrap gap-2">
          {dataset.category && <Badge variant="muted">{t(categoryLabelKey(dataset.category))}</Badge>}
          <Badge variant={model ? "default" : "negative"}>{model ? modelDisplayName(model) : t("Profil absent")}</Badge>
          {dataset.verified === true && <Badge variant="positive">{t("Fournisseur vérifié")}</Badge>}
          {dataset.verified === false && <Badge variant="muted">{t("Fournisseur non vérifié")}</Badge>}
        </div>
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="md:col-span-2">
          <CardTitle>{t("Description")}</CardTitle>
          <p className="mt-2 whitespace-pre-line text-sm text-muted">
            {dataset.description?.trim() ? dataset.description : t("Aucune description fournie.")}
          </p>
        </Card>

        <Card data-guide="page:dataset:data">
          <CardTitle>{t("Données")}</CardTitle>
          <dl className="mt-3 space-y-2 text-sm">
            <Fact label={t("Catégorie")} value={dataset.category ? t(categoryLabelKey(dataset.category)) : "—"} />
            <Fact label={t("Lignes")} value={formatCount(dataset.rowCount)} />
            <Fact label={t("Colonnes")} value={formatCount(dataset.columnCount)} />
            <Fact label={t("Taille")} value={dataset.sizeBytes ? formatBytes(dataset.sizeBytes) : "—"} />
          </dl>
          <p className="mt-3 text-xs text-muted">
            {t("Les noms et types des colonnes restent dans le fichier chiffré : ils ne sont pas publiés.")}
          </p>
        </Card>

        <Card data-guide="page:dataset:model">
          <CardTitle>{t("Modèle d’entraînement")}</CardTitle>
          {model ? (
            <dl className="mt-3 space-y-2 text-sm">
              <Fact label={t("Modèle")} value={modelDisplayName(model)} />
              <Fact label={t("Ce qu’il fait")} value={MODEL_REGISTRY[model.modelId].description} />
              <Fact label={t("Ce que vous recevez")} value={t("Le modèle entraîné : ses coefficients et ses métriques de qualité.")} />
            </dl>
          ) : (
            <p className="mt-3 text-sm text-negative">{t("Profil d’entraînement manquant")}</p>
          )}
        </Card>

        <Card data-guide="page:dataset:stats">
          <CardTitle>{t("Statistiques publiques")}</CardTitle>
          <dl className="mt-3 space-y-2 text-sm">
            <Fact label={t("Emprunts")} value={formatCount(dataset.borrowCount)} />
            <Fact label={t("Publication")} value={formatDate(dataset.listedAt)} />
            <Fact
              label={t("Emprunts réglés au fournisseur")}
              value={dataset.successRate === null
                ? t("Aucun emprunt terminé")
                : t("{rate} % ({settled} sur {count} emprunts terminés)", {
                  rate: Math.round(dataset.successRate * 100),
                  settled: formatCount(dataset.settledCount),
                  count: formatCount(resolved),
                })}
            />
          </dl>
          <p className="mt-3 text-xs text-muted">
            {t("Un emprunt terminé est réglé au fournisseur ou remboursé ; un remboursement suit un échec de l’entraînement ou un entraînement jamais lancé.")}
          </p>
        </Card>

        <Card>
          <CardTitle>{t("Fournisseur")}</CardTitle>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <dt className="text-muted">{t("Adresse")}</dt>
              <dd className="font-mono" title={dataset.provider}>{truncate(dataset.provider, 6, 4)}</dd>
            </div>
            <Fact
              label={t("Vérification")}
              value={dataset.verified === true
                ? t("Vérifié")
                : dataset.verified === false ? t("Non vérifié") : t("Statut indisponible")}
            />
          </dl>
          <Link
            href={`/proof/${encodeURIComponent(dataset.id)}`}
            className="mt-3 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline"
          >
            {t("Voir la preuve on-chain")}
          </Link>
        </Card>

        <section aria-labelledby="price-heading" className="min-w-0 md:col-span-2" data-guide="page:dataset:price">
          <CardTitle id="price-heading" className="mb-2">{t("Ce que vous payez")}</CardTitle>
          {fee.kind !== "unknown" && dataset.providerPriceAtomic ? (
            <>
              <PriceBreakdown
                providerAtomic={dataset.providerPriceAtomic}
                computeAtomic={fee.atomic}
                token={token}
                perspective="borrower"
              />
              {fee.kind === "quoted" && (
                <p className="mt-2 text-xs text-muted">
                  {t("Frais de calcul indicatifs pour ce modèle (dernier devis ou tarif publié). Le montant exact est affiché dans le devis, avant tout paiement.")}
                </p>
              )}
            </>
          ) : (
            <Card>
              <dl className="space-y-2 text-sm">
                <Fact
                  label={t("Le fournisseur reçoit")}
                  value={(dataset.providerPriceAtomic && formatTokenWithSymbol(dataset.providerPriceAtomic, token)) || "—"}
                />
                <Fact label={t("Frais de calcul (enclave Phala)")} value={t("Indiqués dans le devis")} />
              </dl>
              <p className="mt-3 text-xs text-muted">
                {t("Les frais de calcul et le total sont affichés dans le devis, avant tout paiement.")}
              </p>
            </Card>
          )}
        </section>

        <Card>
          <CardTitle>{t("Ce que vous obtenez")}</CardTitle>
          <p className="mt-2 text-sm text-muted">
            {t("Un accès à cette donnée et un entraînement dans l’enclave. Vous recevez le modèle entraîné, jamais la donnée. Chaque nouvel entraînement est un nouvel emprunt.")}
          </p>
        </Card>

        <Card>
          <CardTitle>{t("En cas d’échec")}</CardTitle>
          <p className="mt-2 text-sm text-muted">
            {result.data.billingMode === "v6"
              ? t("Aucun frais de calcul n’est prélevé : le montant verrouillé est rendu en entier.")
              : result.data.billingMode === "v7"
                ? t("Seul le calcul réellement consommé est retenu, le reste est remboursé.")
                : t("Le devis précise ce qui est retenu en cas d’échec, avant tout paiement.")}{" "}
            {days < 1
              ? t("Sans règlement à l’échéance de l’escrow, vous récupérez vos fonds depuis la page Entraîner.")
              : days === 1
                ? t("Sans règlement après 1 jour, vous récupérez vos fonds depuis la page Entraîner.")
                : t("Sans règlement après {days} jours, vous récupérez vos fonds depuis la page Entraîner.", { days: formatCount(days) })}
          </p>
        </Card>

        <DisclaimerNote variant="warning" className="md:col-span-2" />

        <Card className="md:col-span-2" data-guide="page:dataset:borrow">
          <BorrowPanel
            datasetId={dataset.id}
            providerVerified={dataset.verified}
            priceUsdcAtomic={dataset.providerPriceAtomic}
            modelId={dataset.modelId}
            modelVersion={dataset.modelVersion}
          />
        </Card>
      </div>
    </Page>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{value}</dd>
    </div>
  );
}
