"use client";

import { Suspense } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { Page, PageHeader } from "@/components/layout/Page";
import { MarketplaceCatalogue } from "./_components/MarketplaceCatalogue";

/**
 * Marketplace publique : grille, recherche et filtres, consultables sans wallet.
 *
 * Les filtres vivent dans l'URL (lien partageable, retour arrière) ; filtrage, tri et pagination
 * sont faits par `GET /api/marketplace`, route publique sans session. L'emprunt se fait depuis
 * la fiche `/marketplace/[id]`, seul endroit où la connexion est demandée.
 */
export default function MarketplacePage() {
  return (
    <Suspense fallback={<CatalogueFallback />}>
      <MarketplaceCatalogue />
    </Suspense>
  );
}

function CatalogueFallback() {
  const { t } = useLocale();
  return (
    <Page width="wide">
      <PageHeader title={t("Datasets disponibles")} />
      <p className="text-sm text-muted">{t("Chargement…")}</p>
    </Page>
  );
}
