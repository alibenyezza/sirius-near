"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Page, PageHeader } from "@/components/layout/Page";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { ensureVerifiedFor } from "@/components/onboarding/onboarding-store";
import { createInFlightGuard } from "@/lib/onboarding/steps";
import type { TokenInfo } from "@/components/datasets/price";
import { messageOf } from "@/lib/errors-client";
import { checkFileSize, inspectCsv, type CsvInspection, type CsvRejection } from "@/lib/datasets/csv-check";
import { parseProviderPrice } from "@/lib/datasets/price-input";
import { DEFAULT_LISTING_DURATION_DAYS, type ListingDurationDays } from "@/lib/datasets/publication";
import { providerPriceBreakdown, type PublishedTariff } from "@/lib/datasets/tariff";
import { UPLOAD_STEPS, UploadError, uploadAndPublishDataset, type UploadStep } from "@/lib/datasets/upload-client";
import { publishDataset, type PublishDatasetStage } from "@/lib/datasets/client";
import { DataStep, exampleDatasetPath } from "./DataStep";
import { PricingStep } from "./PricingStep";
import { type DataValues, type LoadedFile, type StepState } from "./wizard-types";

interface NewDatasetWizardProps {
  tariff: PublishedTariff | null;
  token: TokenInfo;
}

type Phase = "data" | "securing" | "pricing";

/** Durée minimale de la transition de sécurisation : 2,4 s (cahier : « deux à trois secondes »). */
const SECURING_MIN_MS = 2_400;
const SECURING_LINE_MS = 700;

const PENDING_PROGRESS: Record<UploadStep, StepState> = { draft: "pending", encrypt: "pending", seal: "pending", register: "pending" };

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parcours de publication en deux étapes (07-upload.md).
 *
 * Étape 1 : fichier contrôlé dans le navigateur, nom, description, catégorie, modèle.
 * Transition : le fichier est pris en empreinte sur l'appareil (SHA-256 réel) ; rien n'est
 * envoyé. Le chiffrement lui-même n'a lieu qu'à la publication, car la clé est liée à
 * l'identifiant du brouillon que le serveur attribue alors — la transition le dit tel quel.
 * Étape 2 : gain, décomposition en direct, durée, estimations, avertissement, consentement,
 * puis publication avec sa progression (brouillon, chiffrement, scellement, titre on-chain).
 */
export function NewDatasetWizard({ tariff, token }: NewDatasetWizardProps) {
  const router = useRouter();
  const { t } = useLocale();
  const [phase, setPhase] = useState<Phase>("data");
  const [values, setValues] = useState<DataValues>({ name: "", description: "", category: "", modelId: "linear_regression" });
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileRejection, setFileRejection] = useState<CsvRejection | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [loadingExample, setLoadingExample] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [securingLines, setSecuringLines] = useState(0);
  const [price, setPrice] = useState("10");
  const [listingDays, setListingDays] = useState<ListingDurationDays>(DEFAULT_LISTING_DURATION_DAYS);
  const [consent, setConsent] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Une seule publication en vol : la garde KYB lit le réseau avant `setPublishing`.
  const [publishGuard] = useState(createInFlightGuard);
  const [progress, setProgress] = useState<Record<UploadStep, StepState>>(PENDING_PROGRESS);
  const [stage, setStage] = useState<PublishDatasetStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sealedDatasetId, setSealedDatasetId] = useState<string | null>(null);
  const readToken = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousPhase = useRef<Phase>("data");

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  // Le bouton qui a déclenché le changement d'étape est démonté : le focus clavier repart
  // du panneau de la nouvelle étape plutôt que du corps de la page. Comparer à la phase
  // précédente (et non « premier rendu ») résiste au double passage des effets en StrictMode.
  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (phase !== "securing") panelRef.current?.focus();
  }, [phase]);

  const inspection: CsvInspection | null = useMemo(
    () => (file ? inspectCsv(file.text, values.modelId) : null),
    [file, values.modelId],
  );
  const summary = inspection?.ok ? inspection.summary : null;
  const canContinue = !!file && !fileRejection && !!summary && values.name.trim() !== "" && values.category !== "" && !readingFile;

  const providerAtomic = useMemo(() => parseProviderPrice(price, token.decimals), [price, token.decimals]);
  const breakdown = tariff && providerAtomic !== null ? providerPriceBreakdown(tariff, values.modelId, providerAtomic.toString()) : null;
  const belowMinimum = breakdown !== null && breakdown.ok && breakdown.belowMinimum;
  // Sans tarif, pas de décomposition du prix : la publication attend (07, « Terminé quand »).
  const canPublish = providerAtomic !== null && !belowMinimum && breakdown !== null && breakdown.ok;

  async function readFile(selected: File | null) {
    // Une lecture plus récente rend la précédente caduque : seule la dernière écrit l'état.
    const ticket = ++readToken.current;
    setError(null);
    setFile(null);
    setFingerprint(null);
    if (!selected) {
      setFileRejection(null);
      setReadingFile(false);
      return;
    }
    const rejection = checkFileSize(selected.size);
    if (rejection) {
      setFileRejection(rejection);
      setReadingFile(false);
      return;
    }
    setReadingFile(true);
    try {
      const content = await selected.arrayBuffer();
      if (ticket !== readToken.current) return;
      const text = new TextDecoder("utf-8").decode(content);
      setFile({ name: selected.name, sizeBytes: content.byteLength, content, text });
      setFileRejection(checkFileSize(content.byteLength));
    } catch {
      if (ticket === readToken.current) setFileRejection({ kind: "unreadable" });
    } finally {
      if (ticket === readToken.current) setReadingFile(false);
    }
  }

  async function loadExample() {
    setError(null);
    setLoadingExample(true);
    try {
      const path = exampleDatasetPath(values.modelId);
      const response = await fetch(path);
      if (!response.ok) throw new Error("Exemple indisponible");
      const blob = await response.blob();
      await readFile(new File([blob], path.slice(path.lastIndexOf("/") + 1), { type: "text/csv" }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoadingExample(false);
    }
  }

  function schedule(callback: () => void, delay: number) {
    timers.current.push(setTimeout(callback, delay));
  }

  async function secureAndContinue() {
    if (!file || !canContinue) return;
    setError(null);
    setPhase("securing");
    setSecuringLines(0);
    const started = Date.now();
    schedule(() => setSecuringLines(1), SECURING_LINE_MS);
    schedule(() => setSecuringLines(2), SECURING_LINE_MS * 2);
    try {
      // Empreinte réelle du fichier, calculée sur l'appareil : elle sert d'identité locale au
      // contenu jusqu'au chiffrement et prouve que le fichier est bien lu en mémoire ici.
      const digest = await crypto.subtle.digest("SHA-256", file.content);
      setFingerprint(toHex(digest));
      const elapsed = Date.now() - started;
      schedule(() => setSecuringLines(3), Math.max(0, SECURING_LINE_MS * 3 - elapsed));
      schedule(() => setPhase("pricing"), Math.max(0, SECURING_MIN_MS - elapsed));
    } catch (cause) {
      // Une erreur n'est jamais masquée par l'animation : retour à l'étape 1 avec le message.
      setError(messageOf(cause));
      setPhase("data");
    }
  }

  /**
   * Après un échec de l'inscription on-chain, le dataset est déjà scellé : on ne recrée
   * pas un brouillon (ce serait un doublon), on reprend seulement le titre.
   */
  async function retryRegistration(datasetId: string) {
    setError(null);
    setStage(null);
    setProgress({ draft: "done", encrypt: "done", seal: "done", register: "active" });
    setPublishing(true);
    try {
      await publishDataset(datasetId, setStage);
      setProgress({ draft: "done", encrypt: "done", seal: "done", register: "done" });
      router.push("/datasets");
    } catch (cause) {
      setProgress((current) => ({ ...current, register: "failed" }));
      setError(messageOf(cause));
      setPublishing(false);
    }
  }

  async function publish() {
    await publishGuard.run(publishOnce);
  }

  async function publishOnce() {
    if (!file || !summary || values.category === "" || providerAtomic === null || !canPublish) return;
    // Wallet non vérifié : fenêtre de vérification avant tout envoi, puis la publication reprend.
    if (!(await ensureVerifiedFor("publish"))) return;
    if (sealedDatasetId) return retryRegistration(sealedDatasetId);
    setError(null);
    setStage(null);
    setProgress(PENDING_PROGRESS);
    setPublishing(true);
    try {
      await uploadAndPublishDataset(
        {
          content: file.content,
          sizeBytes: file.sizeBytes,
          name: values.name.trim(),
          description: values.description.trim(),
          category: values.category,
          modelId: values.modelId,
          priceUsdc: price.trim(),
          priceUsdcAtomic: providerAtomic.toString(),
          listingDays,
          trainingConsent: consent,
        },
        ({ step, stage: nextStage }) => {
          setStage(nextStage ?? null);
          setProgress((current) => {
            const next = { ...current };
            for (const candidate of UPLOAD_STEPS) {
              if (candidate === step) next[candidate] = "active";
              else if (UPLOAD_STEPS.indexOf(candidate) < UPLOAD_STEPS.indexOf(step)) next[candidate] = "done";
            }
            return next;
          });
        },
      );
      setProgress({ draft: "done", encrypt: "done", seal: "done", register: "done" });
      router.push("/datasets");
    } catch (cause) {
      if (cause instanceof UploadError) {
        setProgress((current) => ({ ...current, [cause.step]: "failed" }));
        setSealedDatasetId(cause.sealedDatasetId);
      }
      setError(messageOf(cause));
      setPublishing(false);
    }
  }

  const stepNumber = phase === "data" ? 1 : 2;

  return (
    <Page width="narrow">
      <PageHeader
        back={{ href: "/datasets", label: t("Mes datasets") }}
        title={t("Publier un dataset")}
        actions={<p className="text-sm text-muted" aria-live="polite">{t("Étape {step} / 2", { step: stepNumber })}</p>}
      >
        <ol className="flex gap-2 text-xs" aria-label={t("Étapes")} data-guide="page:upload:steps">
          {[t("La donnée"), t("Prix et publication")].map((label, index) => {
            const current = index + 1 === stepNumber;
            const done = index + 1 < stepNumber;
            return (
              <li
                key={label}
                aria-current={current ? "step" : undefined}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-full border px-3 py-1.5 ${
                  current ? "border-accent text-foreground" : done ? "border-positive/40 text-positive" : "border-border text-muted"
                }`}
              >
                <span aria-hidden="true" className="font-mono">{done ? "✓" : index + 1}</span>
                <span className="min-w-0 wrap-anywhere">{label}</span>
              </li>
            );
          })}
        </ol>
        <p className="text-sm text-muted">
          {t("Chiffré dans ton navigateur → ouvert et rescellé dans le TEE → IPFS. Next.js ne reçoit jamais la donnée brute.")}
        </p>
      </PageHeader>

      {error && phase !== "pricing" && (
        <div role="alert" className="min-w-0 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative wrap-anywhere">
          {t(error)}
        </div>
      )}

      <Card>
        <div ref={panelRef} tabIndex={-1} className="outline-hidden">
        {phase === "data" && (
          <DataStep
            values={values}
            onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
            file={file}
            fileRejection={fileRejection}
            inspection={inspection}
            readingFile={readingFile}
            onFileSelected={readFile}
            onLoadExample={loadExample}
            loadingExample={loadingExample}
            canContinue={canContinue}
            onContinue={secureAndContinue}
          />
        )}

        {phase === "securing" && file && (
          <section aria-live="polite" className="flex flex-col gap-4 py-4">
            <h2 className="text-lg font-medium">{t("Sécurisation sur ton appareil")}</h2>
            <ol className="flex flex-col gap-2 text-sm">
              {[
                t("Fichier lu dans la mémoire de ce navigateur, sans envoi."),
                t("Empreinte SHA-256 calculée sur ton appareil."),
                t("Le chiffrement aura lieu ici, à la publication, pour la clé de l’enclave : la donnée en clair ne quitte jamais ton navigateur."),
              ].map((line, index) => {
                const shown = index < securingLines;
                const active = index === securingLines;
                return (
                  <li
                    key={line}
                    data-state={shown ? "done" : active ? "active" : "pending"}
                    className={`flex items-start gap-2 transition-opacity duration-500 ${shown ? "text-positive opacity-100" : active ? "text-foreground opacity-100" : "text-muted opacity-40"}`}
                  >
                    <span aria-hidden="true" className="w-5 shrink-0 text-center font-mono text-xs leading-5">{shown ? "✓" : active ? "…" : index + 1}</span>
                    <span>
                      {line}
                      <span className="sr-only"> {shown ? t("terminé") : active ? t("en cours") : t("en attente")}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
            <div className="h-1 w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
              <div
                className="h-full bg-accent transition-[width] duration-700 ease-out"
                style={{ width: `${Math.min(100, Math.round((securingLines / 3) * 100))}%` }}
              />
            </div>
            {fingerprint && (
              <p className="wrap-anywhere font-mono text-xs text-muted">{t("Empreinte locale : {fingerprint}", { fingerprint })}</p>
            )}
          </section>
        )}

        {phase === "pricing" && file && summary && (
          <PricingStep
            token={token}
            tariff={tariff}
            file={file}
            summary={summary}
            modelId={values.modelId}
            price={price}
            onPrice={setPrice}
            providerAtomic={providerAtomic}
            belowMinimum={belowMinimum}
            listingDays={listingDays}
            onListingDays={setListingDays}
            consent={consent}
            onConsent={setConsent}
            canPublish={canPublish}
            publishing={publishing}
            progress={progress}
            stage={stage}
            error={error}
            sealedDatasetId={sealedDatasetId}
            onBack={() => {
              if (publishing) return;
              setError(null);
              setPhase("data");
            }}
            onPublish={publish}
          />
        )}
        </div>
      </Card>
    </Page>
  );
}
