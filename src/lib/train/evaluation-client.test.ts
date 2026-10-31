import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { gateModel } from "@/lib/tee/output-gate";
import { trainLinearRegression, trainLogisticRegression } from "@/lib/tee/train";
import { evaluateModelCsv, predictModel } from "./evaluation-client";
import type { DeliveredModel, HistoricalLinearRegressionModel } from "@/lib/models/registry";

const exactModel: DeliveredModel = {
  algo: "linear_regression",
  version: "1.0.0",
  target: "target",
  features: ["feature"],
  coefficients: [2, 3],
  metrics: { r2: 1, rmse: 0, mae: 0, n: 100 },
};

test("évalue un modèle sur un CSV tenu hors de l'entraînement", () => {
  const csv = ["feature,target", ...Array.from({ length: 25 }, (_, index) => `${index},${2 + 3 * index}`)].join("\n");
  assert.deepEqual(predictModel(exactModel, { feature: 2 }), { algo: "linear_regression", value: 8 });
  assert.deepEqual(evaluateModelCsv(exactModel, csv), { algo: "linear_regression", n: 25, r2: 1, rmse: 0, mae: 0 });
});

test("évalue et utilise les coefficients historiques sans inventer de métrique d'entraînement", () => {
  const historical: HistoricalLinearRegressionModel = {
    algo: "linear_regression", target: "target", features: ["feature"], coefficients: [2, 3],
    metrics: { r2: 1, rmse: 0, n: 100 },
  };
  const csv = ["feature,target", ...Array.from({ length: 25 }, (_, index) => `${index},${3 + 3 * index}`)].join("\n");
  assert.deepEqual(predictModel(historical, { feature: 2 }), { algo: "linear_regression", value: 8 });
  const evaluation = evaluateModelCsv(historical, csv);
  assert.equal(evaluation.mae, 1);
  assert.equal(evaluation.rmse, 1);
  assert.equal(evaluation.n, 25);
  assert.equal(Object.hasOwn(historical.metrics, "mae"), false);
  assert.equal(Object.hasOwn(historical, "version"), false);
});

test("refuse un CSV de test qui ne contient pas les colonnes du modèle", () => {
  const csv = ["other,target", ...Array.from({ length: 20 }, (_, index) => `${index},${index}`)].join("\n");
  assert.throws(() => evaluateModelCsv(exactModel, csv), /mêmes features/);
});

test("évalue une classification binaire et expose la probabilité", () => {
  const model: DeliveredModel = {
    algo: "logistic_regression",
    version: "1.0.0",
    target: "target",
    features: ["feature"],
    coefficients: [-2, 4],
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, n: 100 },
  };
  const csv = ["feature,target", ...Array.from({ length: 25 }, (_, index) => `${index % 2},${index % 2}`)].join("\n");

  assert.deepEqual(predictModel(model, { feature: 1 }), { algo: "logistic_regression", probability: 0.8807970779778823, label: 1 });
  assert.deepEqual(evaluateModelCsv(model, csv), {
    algo: "logistic_regression",
    n: 25,
    accuracy: 1,
    precision: 1,
    recall: 1,
    f1: 1,
  });
});

test("refuse une cible de test logistique non binaire", () => {
  const model: DeliveredModel = {
    algo: "logistic_regression",
    version: "1.0.0",
    target: "target",
    features: ["feature"],
    coefficients: [-2, 4],
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, n: 100 },
  };
  const csv = ["feature,target", ...Array.from({ length: 20 }, (_, index) => `${index % 2},${index % 3}`)].join("\n");

  assert.throws(() => evaluateModelCsv(model, csv), /strictement encodée en 0 ou 1/);
});

test("évalue le modèle immobilier sur son jeu tenu à l'écart", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/regression/housing-prices-train.csv"))),
  ).model;
  const evaluation = evaluateModelCsv(
    model,
    readFileSync(resolve(process.cwd(), "public/examples/regression/housing-prices-test.csv"), "utf8"),
  );

  assert.equal(evaluation.n, 28);
  assert.ok(evaluation.r2 > 0.95);
  assert.ok(evaluation.rmse < 30_000);
});

test("évalue le modèle énergie sur sa période de test chronologique", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/regression/energy-demand-train.csv"))),
  ).model;
  const evaluation = evaluateModelCsv(
    model,
    readFileSync(resolve(process.cwd(), "public/examples/regression/energy-demand-test.csv"), "utf8"),
  );

  assert.equal(evaluation.n, 1_752);
  assert.ok(evaluation.r2 > 0.9);
  assert.ok(evaluation.rmse < 4);
});

test("évalue le modèle logistique sur un jeu de défaut bruité tenu à l'écart", () => {
  const model = gateModel(
    trainLogisticRegression(readFileSync(resolve(process.cwd(), "public/examples/classification/credit-default-train.csv"))),
  ).model;
  const evaluation = evaluateModelCsv(
    model,
    readFileSync(resolve(process.cwd(), "public/examples/classification/credit-default-test.csv"), "utf8"),
  );

  assert.equal(evaluation.algo, "logistic_regression");
  assert.equal(evaluation.n, 120);
  assert.ok(evaluation.accuracy > 0.7);
  assert.ok(evaluation.accuracy < 0.95);
  assert.ok(evaluation.f1 > 0.45);
  assert.ok(evaluation.f1 < 0.9);
});
