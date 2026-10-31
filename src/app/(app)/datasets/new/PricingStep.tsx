"use client";

import { useId, useMemo } from "react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { PriceBreakdown } from "@/components/datasets/PriceBreakdown";
import { formatTokenWithSymbol, type TokenInfo } from "@/components/datasets/price";
import { formatBytes } from "@/lib/format";
import { formatCount } from "@/lib/copy/numbers";
import type { CsvSummary } from "@/lib/datasets/csv-check";
import { MAX_PROVIDER_PRICE_WHOLE, minimumProviderPriceAtomic } from "@/lib/datasets/price-input";
import {
  DEFAULT_LISTING_DURATION_DAYS,
  ESCROW_CHALLENGE_DAYS,
  LISTING_DURATIONS_DAYS,
  TRAINING_CONSENT_TEXT_KEY,
  TRAINING_CONSENT_VERSION,
  listingExpiryFrom,
  type ListingDurationDays,
} from "@/lib/datasets/publication";
import type { PublishedTariff } from "@/lib/datasets/tariff";
import { UPLOAD_STEPS, type UploadStep } from "@/lib/datasets/upload-client";
import type { PublishDatasetStage } from "@/lib/datasets/client";
import { MODEL_REGISTRY, type ModelId } from "@/lib/models/registry";
import { INPUT_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS, type LoadedFile, type StepState } from "./wizard-types";

/** Étiquette AES-GCM ajoutée au contenu chiffré ; l'enveloppe JSON et le base64 s'ajoutent sur le fil. */
const AES_GCM_TAG_BYTES = 16;

interface PricingStepProps {
  token: TokenInfo;
  tariff: PublishedTariff | null;
  file: LoadedFile;
  summary: CsvSummary;
  modelId: ModelId;
  price: string;
  onPrice: (value: string) => void;
  /** Gain en unités atomiques, `null` si la saisie est invalide. */
  providerAtomic: bigint | null;
  belowMinimum: boolean;
  listingDays: ListingDurationDays;
  onListingDays: (days: ListingDurationDays) => void;
  consent: boolean;
  onConsent: (value: boolean) => void;
  canPublish: boolean;
  publishing: boolean;
  progress: Record<UploadStep, StepState>;
  stage: PublishDatasetStage | null;
  error: string | null;
  sealedDatasetId: string | null;
  onBack: () => void;
  onPublish: () => void;
}

const STEP_LABEL_KEYS: Record<UploadStep, string> = {
  draft: "Création du brouillon",
  encrypt: "Chiffrement sur ton appareil",
  seal: "Envoi et scellement par l’enclave",
  register: "Inscription du titre on-chain",
};

const STAGE_LABEL_KEYS: Record<PublishDatasetStage, string> = {
  preparing: "préparation du titre",
  signing: "signe la transaction dans ton wallet",
  confirming: "attente de la confirmation",
};

/** Étape 2 : gain du fournisseur, décomposition, durée, estimations, avertissement, consentement, publication. */
export function PricingStep({
  token,
  tariff,
  file,
  summary,
  modelId,
  price,
  onPrice,
  providerAtomic,
  belowMinimum,
  listingDays,
  onListingDays,
  consent,
  onConsent,
  canPublish,
  publishing,
  progress,
  stage,
  error,
  sealedDatasetId,
  onBack,
  onPublish,
}: PricingStepProps) {
  const { t } = useLocale();
  const ids = { price: useId(), priceHint: useId(), duration: useId(), consent: useId(), consentHint: useId() };
  // Sans tarif chargé, le plancher reste celui que la route impose (0,001 jeton) : il est connu localement.
  const minimum = formatTokenWithSymbol(tariff ? tariff.minimumProviderAtomic : minimumProviderPriceAtomic(token.decimals) ?? "", token) ?? "—";
  // Date indicative : la vraie échéance part de l’inscription on-chain (rebase côté serveur).
  const expiry = useMemo(() => listingExpiryFrom(new Date(), listingDays).toISOString().slice(0, 10), [listingDays]);
  const priceInvalid = price.trim() !== "" && providerAtomic === null;
  // Dataset déjà scellé par l'enclave : les termes sont enregistrés, seule l'inscription
  // on-chain reste à reprendre. Les champs sont gelés pour ne pas laisser croire qu'un
  // changement serait pris en compte.
  const sealed = sealedDatasetId !== null;
  const frozen = publishing || sealed;

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (canPublish && !publishing) onPublish();
      }}
      noValidate
    >
      <div className="flex flex-col gap-1.5" data-guide="page:upload:price">
        <label className="text-sm font-medium" htmlFor={ids.price}>
          {t("Ce que je veux gagner par emprunt ({symbol})", { symbol: token.symbol })}
        </label>
        <input
          id={ids.price}
          name="priceUsdc"
          type="text"
          inputMode="decimal"
          value={price}
          required
          autoComplete="off"
          aria-describedby={ids.priceHint}
          aria-invalid={priceInvalid || belowMinimum ? true : undefined}
          disabled={frozen}
          onChange={(event) => onPrice(event.target.value)}
          className={`${INPUT_CLASS} font-mono tabular-nums`}
        />
        <p id={ids.priceHint} className="text-xs text-muted">
          {t("Entre {minimum} et {maximum} {symbol}, au plus {decimals} décimales. Aucune commission supplémentaire pendant la bêta.", {
            minimum,
            maximum: formatCount(MAX_PROVIDER_PRICE_WHOLE),
            symbol: token.symbol,
            decimals: formatCount(token.decimals),
          })}
        </p>
        {priceInvalid && (
          <p role="alert" className="text-xs text-negative">{t("Montant invalide : vérifie les bornes et le nombre de décimales.")}</p>
        )}
      </div>

      {tariff ? (
        <div className="flex flex-col gap-2">
          {providerAtomic !== null ? (
            <PriceBreakdown
              providerAtomic={providerAtomic}
              computeAtomic={tariff.computeFeeAtomic[modelId]}
              token={token}
              minimumAtomic={tariff.minimumProviderAtomic}
              perspective="provider"
            />
          ) : (
            // En attente d'une saisie valide : pas de montant partiel ni de seconde alerte.
            <section aria-label={t("Décomposition du prix")} className="rounded-xl border border-border bg-surface/50 p-5 text-sm text-muted">
              {t("Indique ton gain pour voir ce que paiera l’emprunteur. Minimum imposé par le tarif : {minimum}.", { minimum })}
            </section>
          )}
          <p className="text-xs text-muted">
            {tariff.version === "legacy-v6"
              ? t("Aucun frais de calcul avec l’escrow actuel : l’emprunteur bloque exactement ta part, que tu reçois à chaque emprunt réglé.")
              : t("Frais de calcul du tarif en vigueur ({version}) pour le profil {model}. L’emprunteur paie ta part plus ces frais ; tu reçois ta part à chaque emprunt réglé.", {
                version: tariff.version,
                model: MODEL_REGISTRY[modelId].label,
              })}
          </p>
        </div>
      ) : (
        <div role="note" className="rounded-xl border border-yellow-400/40 bg-yellow-400/5 p-4 text-xs text-foreground/90">
          <p>{t("Le tarif en vigueur n’a pas pu être chargé : les frais de calcul ne peuvent pas être affichés. La publication est suspendue tant que la décomposition du prix ne peut pas être montrée. Réessaie dans quelques instants ou contacte-nous.")}</p>
          <p className="mt-2">
            {t("Tu recevrais {amount} par emprunt réglé.", {
              amount: providerAtomic === null ? "—" : formatTokenWithSymbol(providerAtomic, token) ?? "—",
            })}
          </p>
        </div>
      )}

      <fieldset className="flex min-w-0 flex-col gap-2" disabled={frozen} data-guide="page:upload:duration">
        <legend id={ids.duration} className="text-sm font-medium">{t("Durée de publication")}</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby={ids.duration}>
          {LISTING_DURATIONS_DAYS.map((days) => (
            <label
              key={days}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                listingDays === days ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:border-white/30"
              }`}
            >
              <input
                type="radio"
                name="listingDays"
                value={days}
                checked={listingDays === days}
                onChange={() => onListingDays(days)}
                className="accent-[var(--accent)]"
              />
              {days === DEFAULT_LISTING_DURATION_DAYS
                ? t("{days} jours (par défaut)", { days })
                : t("{days} jours", { days })}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">
          {t("Mise en ligne pendant {listingDays} jours à compter de l’inscription on-chain (vers le {date}), renouvelable depuis la fiche du dataset. Le délai de sécurité de l’escrow est fixé par Sirius à {days} jours pour tous les datasets : si un emprunt n’est pas réglé dans ce délai, l’emprunteur récupère ses fonds.", {
            listingDays,
            date: expiry,
            days: ESCROW_CHALLENGE_DAYS,
          })}
        </p>
      </fieldset>

      <section aria-label={t("Estimations")} className="rounded-xl border border-border bg-surface/50 p-4">
        <h2 className="text-sm font-medium">{t("Estimations")}</h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Lignes de données")}</dt>
            <dd className="tabular-nums">{formatCount(summary.rowCount)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Colonnes")}</dt>
            <dd className="tabular-nums">{formatCount(summary.columnCount)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Taille chiffrée (environ)")}</dt>
            <dd className="tabular-nums">{formatBytes(file.sizeBytes + AES_GCM_TAG_BYTES)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("Modèle")}</dt>
            <dd className="wrap-anywhere">{MODEL_REGISTRY[modelId].label} · v{MODEL_REGISTRY[modelId].version}</dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt className="text-xs text-muted">{t("Colonne cible")}</dt>
            <dd className="wrap-anywhere font-mono">{summary.target}</dd>
          </div>
        </dl>
      </section>

      <DisclaimerNote variant="warning" />

      <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border p-4">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            id={ids.consent}
            type="checkbox"
            name="trainingConsent"
            checked={consent}
            disabled={frozen}
            aria-describedby={ids.consentHint}
            onChange={(event) => onConsent(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
          <span>{t(TRAINING_CONSENT_TEXT_KEY)}</span>
        </label>
        <p id={ids.consentHint} className="pl-7 text-xs text-muted">
          {t("Facultatif. Ton choix est enregistré avec sa date et la version du texte ({version}). La donnée n’est jamais déchiffrée hors de l’enclave, y compris pour cet usage. Tu pourras le retirer depuis la fiche du dataset.", {
            version: TRAINING_CONSENT_VERSION,
          })}
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
          <p>{t(error)}</p>
          {sealedDatasetId && (
            <p className="mt-1 text-foreground/80">
              {t("Le dataset est scellé par l’enclave.")}{" "}
              <Link href="/datasets" className="underline underline-offset-4">{t("Terminer l’inscription on-chain depuis Mes actifs data")}</Link>
            </p>
          )}
        </div>
      )}

      {(publishing || Object.values(progress).some((state) => state !== "pending")) && (
        <ol aria-label={t("Progression de la publication")} aria-live="polite" className="flex flex-col gap-1.5 text-sm">
          {UPLOAD_STEPS.map((step, index) => {
            const state = progress[step];
            const colour = state === "done" ? "text-positive" : state === "failed" ? "text-negative" : state === "active" ? "text-foreground" : "text-muted";
            return (
              <li key={step} data-state={state} className={`flex items-start gap-2 ${colour}`}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center font-mono text-xs leading-5">
                  {state === "done" ? "✓" : state === "failed" ? "✕" : state === "active" ? "…" : index + 1}
                </span>
                <span className="min-w-0">
                  {t(STEP_LABEL_KEYS[step])}
                  {step === "register" && state === "active" && stage && <span className="text-muted"> — {t(STAGE_LABEL_KEYS[stage])}</span>}
                  <span className="sr-only">
                    {" "}
                    {state === "done" ? t("terminé") : state === "failed" ? t("échoué") : state === "active" ? t("en cours") : t("en attente")}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-3" data-guide="page:upload:publish">
        <button type="button" onClick={onBack} disabled={frozen} className={SECONDARY_BUTTON_CLASS}>
          {t("← Retour à la donnée")}
        </button>
        <button type="submit" disabled={!canPublish || publishing} className={PRIMARY_BUTTON_CLASS}>
          {publishing ? t("Publication…") : sealed ? t("Reprendre l’inscription on-chain") : t("Publier le dataset")}
        </button>
        {!canPublish && !publishing && (
          <p className="text-xs text-muted">
            {tariff === null
              ? t("Publication suspendue : tarif indisponible.")
              : belowMinimum
                ? t("Le gain doit atteindre le minimum imposé par le tarif.")
                : t("Indique un gain valide pour publier.")}
          </p>
        )}
      </div>
    </form>
  );
}
