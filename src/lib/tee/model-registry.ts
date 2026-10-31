import { MODEL_REGISTRY, parseDeliveredModel, type DeliveredModel, type ModelId, type ModelSelection } from "@/lib/models/registry";
import { trainLinearRegression, trainLogisticRegression } from "./train";

interface TrainingModelDefinition {
  id: ModelId;
  version: string;
  metrics: readonly string[];
  train: (csv: Buffer) => DeliveredModel;
  validate: (model: DeliveredModel) => boolean;
}

function validatesModel(modelId: ModelId, model: DeliveredModel): boolean {
  try {
    return parseDeliveredModel(model).algo === modelId;
  } catch {
    return false;
  }
}

export const TRAINING_MODEL_REGISTRY = {
  linear_regression: {
    ...MODEL_REGISTRY.linear_regression,
    train: trainLinearRegression,
    validate: (model) => validatesModel("linear_regression", model),
  },
  logistic_regression: {
    ...MODEL_REGISTRY.logistic_regression,
    train: trainLogisticRegression,
    validate: (model) => validatesModel("logistic_regression", model),
  },
} satisfies Record<ModelId, TrainingModelDefinition>;

export function trainSelectedModel(selection: ModelSelection, csv: Buffer): DeliveredModel {
  const model = TRAINING_MODEL_REGISTRY[selection.modelId];
  if (model.version !== selection.modelVersion) throw new Error("Version de modèle non autorisée");
  const trained = model.train(csv);
  if (!model.validate(trained)) throw new Error("Résultat d’entraînement invalide");
  return trained;
}
