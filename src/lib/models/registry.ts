export const MODEL_REGISTRY = {
  linear_regression: {
    id: "linear_regression",
    version: "1.0.0",
    label: "Linear regression",
    description: "Predicts a continuous numeric value.",
    metrics: ["R²", "RMSE", "MAE"],
  },
  logistic_regression: {
    id: "logistic_regression",
    version: "1.0.0",
    label: "Binary logistic regression",
    description: "Classifies a target strictly encoded as 0 or 1.",
    metrics: ["Accuracy", "Precision", "Recall", "F1", "Probability"],
  },
} as const;

export type ModelId = keyof typeof MODEL_REGISTRY;

export type ModelSelection = {
  [Id in ModelId]: {
    modelId: Id;
    modelVersion: (typeof MODEL_REGISTRY)[Id]["version"];
  };
}[ModelId];

export interface LinearRegressionModel {
  algo: "linear_regression";
  version: typeof MODEL_REGISTRY.linear_regression.version;
  target: string;
  features: string[];
  coefficients: number[];
  metrics: { r2: number; rmse: number; mae: number; n: number };
}

export interface LogisticRegressionModel {
  algo: "logistic_regression";
  version: typeof MODEL_REGISTRY.logistic_regression.version;
  target: string;
  features: string[];
  coefficients: number[];
  metrics: { accuracy: number; precision: number; recall: number; f1: number; n: number };
}

export type DeliveredModel = LinearRegressionModel | LogisticRegressionModel;

export interface HistoricalLinearRegressionModel extends Omit<LinearRegressionModel, "version" | "metrics"> {
  version?: never;
  metrics: { r2: number; rmse: number; n: number; mae?: never };
}

export type DownloadedModel = DeliveredModel | HistoricalLinearRegressionModel;

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  modelId: "linear_regression",
  modelVersion: MODEL_REGISTRY.linear_regression.version,
};

export const MODEL_OPTIONS = Object.values(MODEL_REGISTRY);

export function selectionForModelId(modelId: ModelId): ModelSelection {
  return { modelId, modelVersion: MODEL_REGISTRY[modelId].version } as ModelSelection;
}

export function modelSelectionForId(modelId: unknown): ModelSelection | null {
  if (typeof modelId !== "string" || !Object.hasOwn(MODEL_REGISTRY, modelId)) return null;
  return selectionForModelId(modelId as ModelId);
}

export function modelSelection(modelId: unknown, modelVersion: unknown): ModelSelection | null {
  if (typeof modelVersion !== "string") return null;
  const selection = modelSelectionForId(modelId);
  if (!selection) return null;
  return selection.modelVersion === modelVersion ? selection : null;
}

export function trainingProfileHash(selection: ModelSelection): Hex {
  return keccak256(stringToBytes(`sirius.training-profile.v1:${selection.modelId}:${selection.modelVersion}`));
}

export function modelDisplayName(selection: ModelSelection): string {
  return `${MODEL_REGISTRY[selection.modelId].label} v${selection.modelVersion}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isModelBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.target === "string" &&
    value.target.length > 0 &&
    Array.isArray(value.features) &&
    value.features.length > 0 &&
    value.features.length <= 31 &&
    value.features.every((feature) => typeof feature === "string" && feature.length > 0) &&
    new Set(value.features).size === value.features.length &&
    Array.isArray(value.coefficients) &&
    value.coefficients.length === value.features.length + 1 &&
    value.coefficients.every(isFiniteNumber)
  );
}

function exactMetrics(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && keys.every((key) => key in value) &&
    Object.keys(value).length === keys.length;
}

export function parseDeliveredModel(value: unknown): DeliveredModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Modèle déchiffré invalide");
  const model = value as Record<string, unknown>;
  if (
    Object.keys(model).length !== 6 ||
    !["algo", "version", "target", "features", "coefficients", "metrics"].every((key) => key in model) ||
    !isModelBase(model) ||
    typeof model.algo !== "string" ||
    typeof model.version !== "string"
  ) {
    throw new Error("Modèle déchiffré invalide");
  }

  if (
    model.algo === "linear_regression" &&
    model.version === MODEL_REGISTRY.linear_regression.version &&
    exactMetrics(model.metrics, ["r2", "rmse", "mae", "n"]) &&
    isFiniteNumber(model.metrics.r2) &&
    isFiniteNumber(model.metrics.rmse) && model.metrics.rmse >= 0 &&
    isFiniteNumber(model.metrics.mae) && model.metrics.mae >= 0 &&
    isCount(model.metrics.n)
  ) {
    return model as unknown as LinearRegressionModel;
  }

  if (
    model.algo === "logistic_regression" &&
    model.version === MODEL_REGISTRY.logistic_regression.version &&
    exactMetrics(model.metrics, ["accuracy", "precision", "recall", "f1", "n"]) &&
    isFiniteNumber(model.metrics.accuracy) && model.metrics.accuracy >= 0 && model.metrics.accuracy <= 1 &&
    isFiniteNumber(model.metrics.precision) && model.metrics.precision >= 0 && model.metrics.precision <= 1 &&
    isFiniteNumber(model.metrics.recall) && model.metrics.recall >= 0 && model.metrics.recall <= 1 &&
    isFiniteNumber(model.metrics.f1) && model.metrics.f1 >= 0 && model.metrics.f1 <= 1 &&
    isCount(model.metrics.n)
  ) {
    return model as unknown as LogisticRegressionModel;
  }

  throw new Error("Modèle déchiffré invalide");
}

// Compatibility is limited to downloads; new runner outputs still require their declared version and all metrics.
export function parseDownloadedModel(value: unknown): DownloadedModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Modèle déchiffré invalide");
  if (Object.hasOwn(value, "version")) return parseDeliveredModel(value);
  const model = value as Record<string, unknown>;
  if (
    Object.keys(model).length === 5 &&
    ["algo", "target", "features", "coefficients", "metrics"].every((key) => Object.hasOwn(model, key)) &&
    model.algo === "linear_regression" &&
    isModelBase(model) &&
    exactMetrics(model.metrics, ["r2", "rmse", "n"]) &&
    isFiniteNumber(model.metrics.r2) &&
    isFiniteNumber(model.metrics.rmse) && model.metrics.rmse >= 0 &&
    isCount(model.metrics.n)
  ) {
    return model as unknown as HistoricalLinearRegressionModel;
  }
  throw new Error("Modèle déchiffré invalide");
}
import { keccak256, stringToBytes, type Hex } from "viem";
