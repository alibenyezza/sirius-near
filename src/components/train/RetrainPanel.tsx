"use client";

import { useEffect, useRef, useState } from "react";
import { PriceBreakdown } from "@/components/datasets/PriceBreakdown";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useComputeQuoteConfirmation } from "@/components/loans/ComputeQuoteDialog";
import { useDuplicateLoanConfirmation } from "@/components/loans/DuplicateLoanDialog";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { messageOf } from "@/lib/errors-client";
import { borrowDataset } from "@/lib/loans/client";
import type { DetailResponse } from "@/lib/marketplace/catalogue";
import { modelSelection } from "@/lib/models/registry";
import { useWalletStore } from "@/stores/wallet";

type Listing =
  | { status: "loading" }
  | { status: "ready"; detail: DetailResponse }
  | { status: "unavailable" };

/**
 * Ré-entraînement d'un emprunt terminé : un NOUVEL emprunt complet du même dataset (donnée payée à
 * nouveau, plus le calcul : docs/passage-mainnet/01-decisions-avant-samedi.md, section 2).
 *
 * Aucune nouvelle transaction : on réutilise `borrowDataset`, le parcours d'emprunt existant
 * (préparation du prêt, devis signé confirmé par l'emprunteur avec le total, approbation, lock). Le
 * prix vient de la fiche publique du dataset ; le total exact est confirmé dans le devis, avant tout
 * paiement. L'avertissement de déterminisme est affiché à côté du bouton, avant même de cliquer.
 */
export function RetrainPanel({
  datasetId,
  otherActiveLoan,
  onBorrowed,
  onError,
}: {
  datasetId: string;
  /** Un autre emprunt de ce compte est déjà actif sur ce dataset : confirmation avant d'en ouvrir un. */
  otherActiveLoan: { status: string } | null;
  onBorrowed: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useLocale();
  const { confirmQuote, quoteDialog } = useComputeQuoteConfirmation();
  const { confirmDuplicate, duplicateDialog } = useDuplicateLoanConfirmation();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch(`/api/marketplace/${encodeURIComponent(datasetId)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as (DetailResponse & { error?: unknown }) | null;
        if (controller.signal.aborted) return;
        setListing(response.ok && body?.dataset ? { status: "ready", detail: body } : { status: "unavailable" });
      })
      .catch(() => {
        if (!controller.signal.aborted) setListing({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [open, datasetId]);

  const detail = listing.status === "ready" ? listing.detail : null;
  const model = detail ? modelSelection(detail.dataset.modelId, detail.dataset.modelVersion) : null;
  const price = detail?.dataset.providerPriceAtomic ?? null;
  const fee = detail?.dataset.computeFee;
  const canConfirm = listing.status === "ready" && Boolean(model) && Boolean(price) && !busy;

  async function confirm() {
    if (inFlight.current || !detail || !price || !model) return;
    onError("");
    // Emprunt payé déjà en attente sur ce dataset : confirmation explicite, avant toute signature.
    if (otherActiveLoan && !(await confirmDuplicate(otherActiveLoan))) return;
    const snapshot = useWalletStore.getState();
    if (!snapshot.authenticated || !snapshot.address) {
      onError(t("Connecte un wallet pour lancer un entraînement."));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    let borrowed = false;
    try {
      borrowed = await borrowDataset({ datasetId, priceUsdcAtomic: price, confirmQuote });
    } catch (err) {
      onError(messageOf(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
    if (!borrowed) return;
    if (mounted.current) setOpen(false);
    // Le prêt est déjà verrouillé : une erreur d'actualisation ne doit pas passer pour un échec de l'emprunt.
    await onBorrowed().catch(() => {});
  }

  return (
    <div className="mt-4 space-y-3" data-testid="retrain-panel">
      {quoteDialog}
      {duplicateDialog}
      <DisclaimerNote variant="warning" messages={["retrainDeterministic"]}>
        <span>{t("Réentraîne uniquement si le dataset a changé.")}</span>
      </DisclaimerNote>
      {!open ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setListing({ status: "loading" });
              setOpen(true);
            }}
            className="rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20"
          >
            {t("Réentraîner")}
          </button>
          <p className="text-xs text-muted">
            {t("Un réentraînement est un nouvel emprunt complet : la donnée et le calcul sont payés à nouveau.")}
          </p>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border border-border bg-surface/30 p-3" aria-live="polite">
          <p className="text-xs text-muted">
            {t("Un réentraînement est un nouvel emprunt complet : la donnée et le calcul sont payés à nouveau.")}
          </p>
          {listing.status === "loading" && <p className="text-xs text-muted">{t("Chargement…")}</p>}
          {listing.status === "unavailable" && (
            <p role="status" className="text-xs text-negative">
              {t("Ce dataset n’est plus disponible à l’emprunt : le réentraînement est impossible.")}
            </p>
          )}
          {detail && !model && <p className="text-xs text-negative">{t("Profil d’entraînement manquant")}</p>}
          {detail && price && fee && fee.kind !== "unknown" && (
            <PriceBreakdown providerAtomic={price} computeAtomic={fee.atomic} token={detail.token} perspective="borrower" />
          )}
          {detail && price && (!fee || fee.kind === "unknown") && (
            <p className="text-xs text-muted">{t("Les frais de calcul et le total sont affichés dans le devis, avant tout paiement.")}</p>
          )}
          {detail && fee?.kind === "quoted" && (
            <p className="text-xs text-muted">
              {t("Frais de calcul indicatifs pour ce modèle (dernier devis ou tarif publié). Le montant exact est affiché dans le devis, avant tout paiement.")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={!canConfirm}
              aria-busy={busy}
              autoFocus
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {busy ? t("Escrow…") : t("Voir le devis et réentraîner")}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded-xl px-3 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50"
            >
              {t("Annuler")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
