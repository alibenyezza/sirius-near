"use client";

import { parseCsv } from "@/lib/sirius/metrics";
import type { DownloadedModel, HistoricalLinearRegressionModel, LinearRegressionModel, LogisticRegressionModel } from "@/lib/models/registry";

export interface LinearModelEvaluation {
  algo: "linear_regression";
  n: number;
  r2: number;
  rmse: number;
  mae: number;
}

export interface LogisticModelEvaluation {
  algo: "logistic_regression";
  n: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

export type ModelEvaluation = LinearModelEvaluation | LogisticModelEvaluation;

export type ModelPrediction =
  | { algo: "linear_regression"; value: number }
  | { algo: "logistic_regression"; probability: number; label: 0 | 1 };

const MIN_EVALUATION_ROWS = 20;

function numberValue(value: string | undefined, column: string): number {
  const number = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isFinite(number)) {
    throw new Error(`Valeur invalide dans la colonne « ${column} »`);
  }
  return number;
}

function binaryValue(value: string | undefined, column: string): 0 | 1 {
  if (value === "0") return 0;
  if (value === "1") return 1;
  throw new Error(`La colonne « ${column} » doit être strictement encodée en 0 ou 1`);
}

function score(model: DownloadedModel, values: Record<string, number>): number {
  const prediction = model.features.reduce((sum, feature, index) => {
    const value = values[feature];
    if (!Number.isFinite(value)) throw new Error(`Valeur invalide pour « ${feature} »`);
    return sum + value * model.coefficients[index + 1];
  }, model.coefficients[0]);
  if (!Number.isFinite(prediction)) throw new Error("Prédiction numérique instable");
  return prediction;
}

function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

export function predictModel(model: LinearRegressionModel | HistoricalLinearRegressionModel, values: Record<string, number>): Extract<ModelPrediction, { algo: "linear_regression" }>;
export function predictModel(model: LogisticRegressionModel, values: Record<string, number>): Extract<ModelPrediction, { algo: "logistic_regression" }>;
export function predictModel(model: DownloadedModel, values: Record<string, number>): ModelPrediction;
export function predictModel(model: DownloadedModel, values: Record<string, number>): ModelPrediction {
  const value = score(model, values);
  if (model.algo === "linear_regression") return { algo: model.algo, value };
  const probability = sigmoid(value);
  return { algo: model.algo, probability, label: probability >= 0.5 ? 1 : 0 };
}

export function evaluateModelCsv(model: LinearRegressionModel | HistoricalLinearRegressionModel, csv: string): LinearModelEvaluation;
export function evaluateModelCsv(model: LogisticRegressionModel, csv: string): LogisticModelEvaluation;
export function evaluateModelCsv(model: DownloadedModel, csv: string): ModelEvaluation;
export function evaluateModelCsv(model: DownloadedModel, csv: string): ModelEvaluation {
  const [header, ...rows] = parseCsv(csv);
  if (!header || rows.length < MIN_EVALUATION_ROWS) {
    throw new Error(`Le CSV de test doit contenir au moins ${MIN_EVALUATION_ROWS} lignes`);
  }
  if (new Set(header).size !== header.length) throw new Error("En-têtes CSV en double");
  const positions = new Map(header.map((column, index) => [column, index]));
  const required = [...model.features, model.target];
  if (required.some((column) => positions.get(column) === undefined)) {
    throw new Error("Le CSV de test doit contenir la cible et les mêmes features");
  }

  const values = rows.map((row) => Object.fromEntries(
    model.features.map((feature) => [feature, numberValue(row[positions.get(feature)!], feature)]),
  ));
  if (model.algo === "linear_regression") {
    const expected = rows.map((row) => numberValue(row[positions.get(model.target)!], model.target));
    const predicted = values.map((row) => score(model, row));
    const mean = expected.reduce((sum, value) => sum + value, 0) / expected.length;
    let squaredError = 0;
    let totalVariation = 0;
    let absoluteError = 0;
    for (let index = 0; index < expected.length; index++) {
      const error = expected[index] - predicted[index];
      squaredError += error ** 2;
      totalVariation += (expected[index] - mean) ** 2;
      absoluteError += Math.abs(error);
    }
    return {
      algo: model.algo,
      n: expected.length,
      r2: totalVariation === 0 ? 0 : 1 - squaredError / totalVariation,
      rmse: Math.sqrt(squaredError / expected.length),
      mae: absoluteError / expected.length,
    };
  }

  const expected = rows.map((row) => binaryValue(row[positions.get(model.target)!], model.target));
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (let index = 0; index < expected.length; index++) {
    const label = sigmoid(score(model, values[index])) >= 0.5 ? 1 : 0;
    if (label === 1 && expected[index] === 1) truePositive++;
    else if (label === 1) falsePositive++;
    else if (expected[index] === 1) falseNegative++;
    else trueNegative++;
  }
  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  return {
    algo: model.algo,
    n: expected.length,
    accuracy: (truePositive + trueNegative) / expected.length,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}
