"use client";

import { useId, useRef, useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { formatBytes } from "@/lib/format";
import { formatCount } from "@/lib/copy/numbers";
import { csvRejectionText, type CsvInspection, type CsvRejection } from "@/lib/datasets/csv-check";
import { DATASET_CATEGORIES, DATASET_CATEGORY_LABEL_KEYS, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from "@/lib/datasets/publication";
import { MODEL_OPTIONS, type ModelId } from "@/lib/models/registry";
import { INPUT_CLASS, PRIMARY_BUTTON_CLASS, type DataValues, type LoadedFile } from "./wizard-types";


interface DataStepProps {
  values: DataValues;
  onChange: (patch: Partial<DataValues>) => void;
  file: LoadedFile | null;
  /** Fichier refusé avant lecture (vide, trop gros) ou illisible. */
  fileRejection: CsvRejection | null;
  /** Contrôle du contenu, recalculé quand le profil change. */
  inspection: CsvInspection | null;
  readingFile: boolean;
  onFileSelected: (file: File | null) => void;
  onLoadExample: () => void;
  loadingExample: boolean;
  canContinue: boolean;
  onContinue: () => void;
}

const EXAMPLES: Record<ModelId, { path: string; hint: string }> = {
  linear_regression: { path: "/examples/regression/housing-prices-train.csv", hint: "— 112 lignes d’entraînement, jeu de test séparé." },
  logistic_regression: { path: "/examples/classification/credit-default-train.csv", hint: "— 480 lignes d’entraînement, jeu de test séparé." },
};

export function exampleDatasetPath(modelId: ModelId): string {
  return EXAMPLES[modelId].path;
}

/** Étape 1 : le fichier, son contrôle immédiat, le nom, la description, la catégorie et le modèle. */
export function DataStep({
  values,
  onChange,
  file,
  fileRejection,
  inspection,
  readingFile,
  onFileSelected,
  onLoadExample,
  loadingExample,
  canContinue,
  onContinue,
}: DataStepProps) {
  const { t } = useLocale();
  const ids = { file: useId(), name: useId(), description: useId(), category: useId(), model: useId(), report: useId() };
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const rejection = fileRejection ?? (inspection && !inspection.ok ? inspection.reason : null);
  const summary = inspection?.ok ? inspection.summary : null;

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0] ?? null;
    if (inputRef.current) inputRef.current.value = "";
    onFileSelected(dropped);
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canContinue) onContinue();
      }}
      noValidate
    >
      <DisclaimerNote messages={["dataLimits"]} />

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor={ids.file}>{t("Fichier CSV")}</label>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          data-dragging={dragging ? "true" : undefined}
          data-guide="page:upload:file"
          className={`flex min-w-0 flex-col gap-3 rounded-xl border border-dashed p-4 transition-colors ${
            dragging ? "border-accent bg-accent/5" : "border-border bg-surface/30"
          }`}
        >
          <p className="text-sm text-muted">{t("Glisse ton CSV ici ou choisis un fichier. Il reste dans ton navigateur tant que tu ne publies pas.")}</p>
          <input
            ref={inputRef}
            id={ids.file}
            name="file"
            type="file"
            accept=".csv,text/csv"
            aria-describedby={ids.report}
            onChange={(event) => onFileSelected(event.target.files?.[0] ?? null)}
            className="w-full min-w-0 text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-background hover:file:bg-accent/90"
          />
          <div id={ids.report} aria-live="polite" className="min-w-0 text-sm">
            {readingFile && <p className="text-muted">{t("Lecture du fichier…")}</p>}
            {!readingFile && file && (
              <p className="wrap-anywhere text-foreground">
                <span className="font-medium">{file.name}</span>
                <span className="text-muted"> · {formatBytes(file.sizeBytes)}</span>
              </p>
            )}
            {!readingFile && rejection && (
              <p role="alert" className="mt-1 text-negative">{csvRejectionText(rejection, t)}</p>
            )}
            {!readingFile && summary && (
              <div className="mt-2 rounded-lg border border-positive/30 bg-positive/5 p-3 text-xs text-foreground/90">
                <p className="font-medium text-positive">{t("Fichier accepté par le contrôle du navigateur.")}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-muted">{t("Lignes de données")}</dt>
                    <dd className="tabular-nums">{formatCount(summary.rowCount)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted">{t("Colonnes")}</dt>
                    <dd className="tabular-nums">{formatCount(summary.columnCount)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted">{t("Colonnes numériques")}</dt>
                    <dd className="tabular-nums">{formatCount(summary.numericColumns.length)}</dd>
                  </div>
                  <div className="col-span-2 min-w-0 sm:col-span-3">
                    <dt className="text-muted">{t("Colonne cible")}</dt>
                    <dd className="wrap-anywhere font-mono">{summary.target}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-muted">
                  {t("L’enclave entraîne sur la dernière colonne numérique du fichier et utilise les autres colonnes numériques comme variables ({count}). Réordonne les colonnes si la cible n’est pas la bonne.", {
                    count: formatCount(summary.features.length),
                  })}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted">{t("Voir les colonnes numériques")}</summary>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {summary.numericColumns.map((column) => (
                      <li key={column} className="max-w-full rounded-full border border-border px-2 py-0.5 font-mono wrap-anywhere">{column}</li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </div>
          <p className="text-xs text-muted">
            {t("Pas de données sous la main ?")}{" "}
            <button
              type="button"
              onClick={onLoadExample}
              disabled={loadingExample || readingFile}
              className="py-2 underline underline-offset-4 transition-colors hover:text-foreground disabled:opacity-50"
            >
              {loadingExample ? t("Chargement…") : t("Charger le jeu d'exemple")}
            </button>{" "}
            {t(EXAMPLES[values.modelId].hint)}{" "}
            <a href={EXAMPLES[values.modelId].path} download className="py-2 underline underline-offset-4 transition-colors hover:text-foreground">
              {t("Télécharger")}
            </a>
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor={ids.name}>{t("Nom")}</label>
        <input
          id={ids.name}
          name="name"
          value={values.name}
          maxLength={MAX_NAME_LENGTH}
          required
          autoComplete="off"
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder={t("Ex : Transactions e-commerce 2025")}
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor={ids.description}>
          {t("Description")} <span className="text-muted">{t("(optionnel)")}</span>
        </label>
        <textarea
          id={ids.description}
          name="description"
          value={values.description}
          maxLength={MAX_DESCRIPTION_LENGTH}
          rows={3}
          onChange={(event) => onChange({ description: event.target.value })}
          placeholder={t("Contenu, provenance, fraîcheur…")}
          className={INPUT_CLASS}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2" data-guide="page:upload:profile">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={ids.category}>{t("Catégorie")}</label>
          <select
            id={ids.category}
            name="category"
            value={values.category}
            required
            onChange={(event) => onChange({ category: (DATASET_CATEGORIES as readonly string[]).includes(event.target.value) ? (event.target.value as DataValues["category"]) : "" })}
            className={INPUT_CLASS}
          >
            <option value="">{t("Choisir une catégorie")}</option>
            {DATASET_CATEGORIES.map((category) => (
              <option key={category} value={category}>{t(DATASET_CATEGORY_LABEL_KEYS[category])}</option>
            ))}
          </select>
          <p className="text-xs text-muted">{t("Obligatoire : elle sert de filtre sur la marketplace.")}</p>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor={ids.model}>{t("Profil d’entraînement")}</label>
          <select
            id={ids.model}
            name="modelId"
            value={values.modelId}
            onChange={(event) => onChange({ modelId: event.target.value as ModelId })}
            className={INPUT_CLASS}
          >
            {MODEL_OPTIONS.map((model) => (
              <option key={model.id} value={model.id}>{model.label} · v{model.version}</option>
            ))}
          </select>
          <p className="text-xs text-muted">{t("Ce choix est vérifié sur le CSV puis verrouillé dans le titre EVM et chaque escrow.")}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={!canContinue} className={PRIMARY_BUTTON_CLASS}>
          {t("Continuer vers le prix")}
        </button>
        {!canContinue && (
          <p className="text-xs text-muted">{t("Un fichier accepté, un nom et une catégorie sont nécessaires pour continuer.")}</p>
        )}
      </div>
    </form>
  );
}
