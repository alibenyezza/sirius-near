import { MODEL_REGISTRY, type LinearRegressionModel, type LogisticRegressionModel, type ModelSelection } from "@/lib/models/registry";
import { parseCsv } from "@/lib/sirius/metrics";

export type TrainedModel = LinearRegressionModel | LogisticRegressionModel;

const RIDGE = 1e-8;
export const MAX_TRAINING_FEATURES = 31;
export const MAX_TRAINING_OPERATIONS = 20_000_000;
const MAX_ABS_VALUE = 1e12;
const DEFAULT_TRAINING_TIMEOUT_MS = 15_000;
export const MIN_TRAINING_ROWS = 100;
export const MIN_ROWS_PER_PARAMETER = 10;
const LOGISTIC_ITERATIONS = 200;
const LOGISTIC_LEARNING_RATE = 0.1;
const LOGISTIC_L2 = 0.01;

/**
 * Erreur imputable au fichier fourni, pas au système.
 *
 * Elle n'est convertie en réponse 400 qu'à l'ingestion, où celui qui lit le message est
 * celui qui a déposé le fichier. Pendant un entraînement, elle reste opaque : le lecteur
 * serait alors l'emprunteur, et le motif décrirait la donnée du fournisseur.
 */
export class DatasetValidationError extends Error {}

function isNum(value: string): boolean {
  const number = Number(value);
  return value !== "" && Number.isFinite(number) && Math.abs(number) <= MAX_ABS_VALUE;
}

function numericColumns(header: string[], rows: string[][]): number[] {
  return header.map((_, column) => column).filter((column) => rows.every((row) => isNum(row[column] ?? "")));
}

function assertWithinDeadline(deadline: number): void {
  if (performance.now() > deadline) throw new Error("budget de calcul dépassé");
}

function trainingTimeoutMs(): number {
  const value = Number(process.env.RUNNER_TRAINING_TIMEOUT_MS ?? DEFAULT_TRAINING_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000) {
    throw new Error("RUNNER_TRAINING_TIMEOUT_MS invalide");
  }
  return value;
}

interface TrainingColumns {
  header: string[];
  rows: string[][];
  targetIdx: number;
  featureIdx: number[];
}

function trainingColumns(csv: Buffer, target: string | undefined, deadline: number): TrainingColumns {
  const table = parseCsv(csv.toString("utf-8"));
  assertWithinDeadline(deadline);
  if (table.length < 2) throw new DatasetValidationError("dataset insuffisant");

  const [header, ...rows] = table;
  if (new Set(header).size !== header.length || header.some((column) => !column)) {
    throw new DatasetValidationError("en-têtes CSV invalides");
  }
  const numeric = numericColumns(header, rows);
  if (numeric.length < 2) throw new DatasetValidationError("au moins 2 colonnes numériques requises");
  if (numeric.length > MAX_TRAINING_FEATURES + 1) {
    throw new DatasetValidationError(`trop de features numériques (max ${MAX_TRAINING_FEATURES})`);
  }

  const targetIdx = target ? header.indexOf(target) : numeric[numeric.length - 1];
  if (!numeric.includes(targetIdx)) throw new DatasetValidationError("colonne cible non numérique");
  const featureIdx = numeric.filter((column) => column !== targetIdx);
  const parameterCount = featureIdx.length + 1;
  const requiredRows = Math.max(MIN_TRAINING_ROWS, parameterCount * MIN_ROWS_PER_PARAMETER);
  if (rows.length < requiredRows) {
    throw new DatasetValidationError(`dataset trop petit pour préserver la confidentialité (min ${requiredRows} lignes)`);
  }
  return { header, rows, targetIdx, featureIdx };
}

function assertTrainingBudget(rows: number, parameters: number, logistic: boolean): void {
  const operations = rows * parameters * (logistic ? LOGISTIC_ITERATIONS : parameters);
  if (operations > MAX_TRAINING_OPERATIONS) {
    throw new DatasetValidationError("budget de calcul dépassé : réduis le nombre de lignes ou de features");
  }
}

export function validateTrainingDataset(csv: Buffer, selection: ModelSelection): void {
  const deadline = performance.now() + trainingTimeoutMs();
  const { rows, targetIdx, featureIdx } = trainingColumns(csv, undefined, deadline);
  assertTrainingBudget(rows.length, featureIdx.length + 1, selection.modelId === "logistic_regression");
  if (
    selection.modelId === "logistic_regression" &&
    (!rows.every((row) => row[targetIdx] === "0" || row[targetIdx] === "1") ||
      !rows.some((row) => row[targetIdx] === "0") ||
      !rows.some((row) => row[targetIdx] === "1"))
  ) {
    throw new DatasetValidationError("la cible de la régression logistique doit contenir les classes 0 et 1");
  }
}

function invert(matrix: number[][], deadline: number): number[][] {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [
    ...row,
    ...Array.from({ length: size }, (_, column) => (index === column ? 1 : 0)),
  ]);

  for (let column = 0; column < size; column++) {
    assertWithinDeadline(deadline);
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error("matrice singulière");
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];

    const divisor = augmented[column][column];
    for (let index = 0; index < 2 * size; index++) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = 0; index < 2 * size; index++) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row.slice(size));
}

export function trainLinearRegression(csv: Buffer, target?: string): LinearRegressionModel {
  const deadline = performance.now() + trainingTimeoutMs();
  const { header, rows, targetIdx, featureIdx } = trainingColumns(csv, target, deadline);
  const parameterCount = featureIdx.length + 1;
  assertTrainingBudget(rows.length, parameterCount, false);

  const xtx = Array.from({ length: parameterCount }, (_, row) =>
    Array.from({ length: parameterCount }, (_, column) => (row === column ? RIDGE : 0)),
  );
  const xty = Array<number>(parameterCount).fill(0);
  let targetSum = 0;
  for (let row = 0; row < rows.length; row++) {
    if ((row & 127) === 0) assertWithinDeadline(deadline);
    const values = [1, ...featureIdx.map((column) => Number(rows[row][column]))];
    const expected = Number(rows[row][targetIdx]);
    targetSum += expected;
    for (let left = 0; left < parameterCount; left++) {
      xty[left] += values[left] * expected;
      for (let right = 0; right < parameterCount; right++) xtx[left][right] += values[left] * values[right];
    }
  }
  if (xtx.some((row) => row.some((value) => !Number.isFinite(value))) || xty.some((value) => !Number.isFinite(value))) {
    throw new Error("valeurs numériques hors plage");
  }
  const coefficients = invert(xtx, deadline).map((row) => row.reduce((sum, value, index) => sum + value * xty[index], 0));
  if (coefficients.some((value) => !Number.isFinite(value))) throw new Error("modèle numérique instable");

  const targetMean = targetSum / rows.length;
  let residualSum = 0;
  let variationSum = 0;
  let absoluteError = 0;
  for (let row = 0; row < rows.length; row++) {
    if ((row & 255) === 0) assertWithinDeadline(deadline);
    const values = [1, ...featureIdx.map((column) => Number(rows[row][column]))];
    const expected = Number(rows[row][targetIdx]);
    const prediction = values.reduce((sum, value, index) => sum + value * coefficients[index], 0);
    residualSum += (expected - prediction) ** 2;
    variationSum += (expected - targetMean) ** 2;
    absoluteError += Math.abs(expected - prediction);
  }
  if (!Number.isFinite(residualSum) || !Number.isFinite(variationSum)) throw new Error("métriques numériques instables");

  return {
    algo: "linear_regression",
    version: MODEL_REGISTRY.linear_regression.version,
    target: header[targetIdx],
    features: featureIdx.map((column) => header[column]),
    coefficients,
    metrics: {
      r2: variationSum === 0 ? 0 : 1 - residualSum / variationSum,
      rmse: Math.sqrt(residualSum / rows.length),
      mae: absoluteError / rows.length,
      n: rows.length,
    },
  };
}

function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

export function trainLogisticRegression(csv: Buffer, target?: string): LogisticRegressionModel {
  const deadline = performance.now() + trainingTimeoutMs();
  const { header, rows, targetIdx, featureIdx } = trainingColumns(csv, target, deadline);
  if (!rows.every((row) => row[targetIdx] === "0" || row[targetIdx] === "1")) {
    throw new DatasetValidationError("la cible de la régression logistique doit être strictement 0 ou 1");
  }
  const labels = rows.map((row) => Number(row[targetIdx]));
  if (!labels.includes(0) || !labels.includes(1)) throw new DatasetValidationError("la cible binaire doit contenir les classes 0 et 1");

  const parameterCount = featureIdx.length + 1;
  assertTrainingBudget(rows.length, parameterCount, true);
  const values = rows.map((row) => featureIdx.map((column) => Number(row[column])));
  const means = Array<number>(featureIdx.length).fill(0);
  for (let row = 0; row < values.length; row++) {
    if ((row & 127) === 0) assertWithinDeadline(deadline);
    for (let column = 0; column < featureIdx.length; column++) means[column] += values[row][column];
  }
  for (let column = 0; column < means.length; column++) means[column] /= rows.length;

  const scales = Array<number>(featureIdx.length).fill(0);
  for (let row = 0; row < values.length; row++) {
    if ((row & 127) === 0) assertWithinDeadline(deadline);
    for (let column = 0; column < featureIdx.length; column++) scales[column] += (values[row][column] - means[column]) ** 2;
  }
  for (let column = 0; column < scales.length; column++) scales[column] = Math.sqrt(scales[column] / rows.length) || 1;

  const weights = Array<number>(parameterCount).fill(0);
  for (let iteration = 0; iteration < LOGISTIC_ITERATIONS; iteration++) {
    assertWithinDeadline(deadline);
    const gradient = Array<number>(parameterCount).fill(0);
    for (let row = 0; row < values.length; row++) {
      if ((row & 127) === 0) assertWithinDeadline(deadline);
      let score = weights[0];
      for (let column = 0; column < featureIdx.length; column++) {
        score += weights[column + 1] * ((values[row][column] - means[column]) / scales[column]);
      }
      const residual = sigmoid(score) - labels[row];
      gradient[0] += residual;
      for (let column = 0; column < featureIdx.length; column++) {
        gradient[column + 1] += residual * ((values[row][column] - means[column]) / scales[column]);
      }
    }
    weights[0] -= LOGISTIC_LEARNING_RATE * (gradient[0] / rows.length);
    for (let column = 0; column < featureIdx.length; column++) {
      weights[column + 1] -= LOGISTIC_LEARNING_RATE * (
        gradient[column + 1] / rows.length + LOGISTIC_L2 * weights[column + 1]
      );
    }
  }
  if (weights.some((weight) => !Number.isFinite(weight))) throw new Error("modèle numérique instable");

  const coefficients = Array<number>(parameterCount).fill(0);
  coefficients[0] = weights[0];
  for (let column = 0; column < featureIdx.length; column++) {
    coefficients[column + 1] = weights[column + 1] / scales[column];
    coefficients[0] -= coefficients[column + 1] * means[column];
  }
  if (coefficients.some((coefficient) => !Number.isFinite(coefficient))) throw new Error("modèle numérique instable");

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (let row = 0; row < values.length; row++) {
    if ((row & 255) === 0) assertWithinDeadline(deadline);
    const probability = sigmoid(coefficients[0] + values[row].reduce(
      (score, value, column) => score + value * coefficients[column + 1],
      0,
    ));
    const prediction = probability >= 0.5 ? 1 : 0;
    if (prediction === 1 && labels[row] === 1) truePositive++;
    else if (prediction === 1) falsePositive++;
    else if (labels[row] === 1) falseNegative++;
    else trueNegative++;
  }
  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);

  return {
    algo: "logistic_regression",
    version: MODEL_REGISTRY.logistic_regression.version,
    target: header[targetIdx],
    features: featureIdx.map((column) => header[column]),
    coefficients,
    metrics: {
      accuracy: (truePositive + trueNegative) / rows.length,
      precision,
      recall,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      n: rows.length,
    },
  };
}
