import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { MAX_CSV_COLUMNS, MAX_CSV_ROWS, parseCsv } from "@/lib/sirius/metrics";
import {
  MAX_TRAINING_FEATURES,
  MAX_TRAINING_OPERATIONS,
  MIN_ROWS_PER_PARAMETER,
  MIN_TRAINING_ROWS,
} from "@/lib/tee/train";
import type { ModelId } from "@/lib/models/registry";
import type { Translate } from "@/lib/copy/disclaimers";
import { formatCount, formatLimitBytes } from "@/lib/copy/numbers";
import { formatBytes } from "@/lib/format";

/**
 * Contrôle du CSV dans le navigateur, avant tout envoi (07-upload.md, étape 1).
 *
 * Il reproduit, dans le même ordre, les contrôles que l'enclave applique au scellement
 * (`validateTrainingDataset`, src/lib/tee/train.ts) : même parseur (`parseCsv`), mêmes
 * constantes importées, même détection des colonnes numériques, même cible (la dernière
 * colonne numérique). Un fichier refusé ici l'aurait été par l'enclave, avec la même
 * raison ; un fichier accepté ici peut encore être refusé par l'enclave (le contrôle du
 * navigateur n'est qu'un confort), jamais l'inverse.
 *
 * Deux constantes privées de `train.ts` sont reproduites ici, faute d'export :
 * `MAX_ABS_VALUE` et `LOGISTIC_ITERATIONS`. `csv-check.test.ts` rejoue
 * `validateTrainingDataset` sur les fichiers à la frontière pour détecter toute dérive.
 */

const MAX_ABS_VALUE = 1e12;
const LOGISTIC_ITERATIONS = 200;

export type CsvRejection =
  | { kind: "empty-file" }
  | { kind: "file-too-large"; sizeBytes: number; maxBytes: number }
  | { kind: "unreadable" }
  | { kind: "too-many-rows"; maxRows: number }
  | { kind: "too-many-columns"; maxColumns: number }
  | { kind: "cell-too-large" }
  | { kind: "no-data-rows" }
  | { kind: "invalid-header" }
  | { kind: "too-few-numeric-columns"; found: number }
  | { kind: "too-many-features"; found: number; maxFeatures: number }
  | { kind: "too-few-rows"; rows: number; minRows: number }
  | { kind: "compute-budget" }
  | { kind: "logistic-target"; target: string };

export interface CsvSummary {
  /** Lignes de données, en-tête exclu. */
  rowCount: number;
  /** Colonnes de l'en-tête. */
  columnCount: number;
  header: string[];
  /** Colonnes numériques sur toutes les lignes, dans l'ordre du fichier. */
  numericColumns: string[];
  /** Colonne cible que l'enclave utilisera : la dernière colonne numérique. */
  target: string;
  /** Variables explicatives : les autres colonnes numériques. */
  features: string[];
}

export type CsvInspection =
  | { ok: true; summary: CsvSummary }
  | { ok: false; reason: CsvRejection; summary: Partial<CsvSummary> };

/** Taille du fichier avant lecture : vide ou au-delà de la limite d'ingestion. */
export function checkFileSize(sizeBytes: number): CsvRejection | null {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return { kind: "empty-file" };
  if (sizeBytes > MAX_DATASET_BYTES) return { kind: "file-too-large", sizeBytes, maxBytes: MAX_DATASET_BYTES };
  return null;
}

// Même expression que `isNum` dans train.ts : `Number()` accepte les espaces et l'hexadécimal,
// refuse la chaîne vide (sinon 0) et l'infini ; la borne absolue écarte les valeurs géantes.
function isNumeric(value: string): boolean {
  const number = Number(value);
  return value !== "" && Number.isFinite(number) && Math.abs(number) <= MAX_ABS_VALUE;
}

function parseRejection(error: unknown): CsvRejection {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("trop de lignes")) return { kind: "too-many-rows", maxRows: MAX_CSV_ROWS };
  if (message.includes("trop de colonnes")) return { kind: "too-many-columns", maxColumns: MAX_CSV_COLUMNS };
  if (message.includes("cellule")) return { kind: "cell-too-large" };
  return { kind: "unreadable" };
}

export function inspectCsv(text: string, modelId: ModelId): CsvInspection {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    return { ok: false, reason: parseRejection(error), summary: {} };
  }
  if (table.length < 2) return { ok: false, reason: { kind: "no-data-rows" }, summary: { rowCount: Math.max(0, table.length - 1) } };

  const [header, ...rows] = table;
  const summary: Partial<CsvSummary> = { rowCount: rows.length, columnCount: header.length, header };
  if (new Set(header).size !== header.length || header.some((column) => !column)) {
    return { ok: false, reason: { kind: "invalid-header" }, summary };
  }
  const numericIndexes = header
    .map((_, column) => column)
    .filter((column) => rows.every((row) => isNumeric(row[column] ?? "")));
  summary.numericColumns = numericIndexes.map((column) => header[column]);
  if (numericIndexes.length < 2) {
    return { ok: false, reason: { kind: "too-few-numeric-columns", found: numericIndexes.length }, summary };
  }
  if (numericIndexes.length > MAX_TRAINING_FEATURES + 1) {
    return {
      ok: false,
      reason: { kind: "too-many-features", found: numericIndexes.length - 1, maxFeatures: MAX_TRAINING_FEATURES },
      summary,
    };
  }
  const targetIdx = numericIndexes[numericIndexes.length - 1];
  const featureIdx = numericIndexes.filter((column) => column !== targetIdx);
  summary.target = header[targetIdx];
  summary.features = featureIdx.map((column) => header[column]);
  const parameterCount = featureIdx.length + 1;
  const requiredRows = Math.max(MIN_TRAINING_ROWS, parameterCount * MIN_ROWS_PER_PARAMETER);
  if (rows.length < requiredRows) {
    return { ok: false, reason: { kind: "too-few-rows", rows: rows.length, minRows: requiredRows }, summary };
  }
  const logistic = modelId === "logistic_regression";
  const operations = rows.length * parameterCount * (logistic ? LOGISTIC_ITERATIONS : parameterCount);
  if (operations > MAX_TRAINING_OPERATIONS) return { ok: false, reason: { kind: "compute-budget" }, summary };
  if (
    logistic &&
    (!rows.every((row) => row[targetIdx] === "0" || row[targetIdx] === "1") ||
      !rows.some((row) => row[targetIdx] === "0") ||
      !rows.some((row) => row[targetIdx] === "1"))
  ) {
    return { ok: false, reason: { kind: "logistic-target", target: header[targetIdx] }, summary };
  }
  return { ok: true, summary: summary as CsvSummary };
}

/** Raison exacte du refus, traduite, à afficher au fournisseur. */
export function csvRejectionText(reason: CsvRejection, t: Translate): string {
  switch (reason.kind) {
    case "empty-file":
      return t("Fichier vide.");
    case "file-too-large":
      // Taille réelle arrondie (`formatBytes`), limite tronquée (`formatLimitBytes`) : « 3.0 MB, maximum 3 MB »
      // ne se lit jamais comme deux nombres égaux, la taille en octets lève tout doute.
      return t("Fichier trop volumineux : {size} ({bytes} octets), maximum {max}.", {
        size: formatBytes(reason.sizeBytes),
        bytes: formatCount(reason.sizeBytes),
        max: formatLimitBytes(reason.maxBytes),
      });
    case "unreadable":
      return t("Fichier illisible : ce n’est pas un CSV valide.");
    case "too-many-rows":
      return t("Trop de lignes : au plus {max} lignes, en-tête compris.", { max: formatCount(reason.maxRows) });
    case "too-many-columns":
      return t("Trop de colonnes : au plus {max}.", { max: formatCount(reason.maxColumns) });
    case "cell-too-large":
      return t("Une cellule dépasse la taille autorisée.");
    case "no-data-rows":
      return t("Le fichier doit contenir un en-tête et au moins une ligne de données.");
    case "invalid-header":
      return t("En-tête invalide : chaque colonne doit avoir un nom, sans doublon.");
    case "too-few-numeric-columns":
      return t("Au moins deux colonnes entièrement numériques sont requises ({found} détectée(s)).", {
        found: formatCount(reason.found),
      });
    case "too-many-features":
      return t("Trop de variables numériques : {found}, maximum {max} en plus de la cible.", {
        found: formatCount(reason.found),
        max: formatCount(reason.maxFeatures),
      });
    case "too-few-rows":
      return t("Pas assez de lignes : {rows}, minimum {min} pour ce nombre de variables.", {
        rows: formatCount(reason.rows),
        min: formatCount(reason.minRows),
      });
    case "compute-budget":
      return t("Budget de calcul dépassé : réduis le nombre de lignes ou de variables.");
    case "logistic-target":
      return t("Pour la régression logistique, la colonne cible « {target} » doit contenir uniquement 0 et 1, avec les deux classes.", {
        target: reason.target,
      });
  }
}
