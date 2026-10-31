import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { gateModel } from "./output-gate";
import { DatasetValidationError, MAX_TRAINING_FEATURES, MIN_TRAINING_ROWS, trainLinearRegression, trainLogisticRegression, validateTrainingDataset } from "./train";
import { trainSelectedModel } from "./model-registry";
import { modelSelection } from "@/lib/models/registry";
import { translateEnglish } from "@/lib/i18n/english";

function dataset(rows: number): Buffer {
  const lines = ["feature,target"];
  for (let index = 1; index <= rows; index++) lines.push(`${index},${index * 3 + 2}`);
  return Buffer.from(lines.join("\n"));
}

test("refuse un dataset trop petit pour éviter une inversion directe", () => {
  assert.throws(
    () => trainLinearRegression(dataset(MIN_TRAINING_ROWS - 1)),
    /dataset trop petit pour préserver la confidentialité/,
  );
});

test("accepte un dataset qui respecte le seuil de confidentialité", () => {
  const model = trainLinearRegression(dataset(MIN_TRAINING_ROWS));
  assert.equal(model.metrics.n, MIN_TRAINING_ROWS);
  assert.deepEqual(model.features, ["feature"]);
});

test("le registre runner n'accepte que les modèles et versions allowlistés", () => {
  const linear = modelSelection("linear_regression", "1.0.0");
  const logistic = modelSelection("logistic_regression", "1.0.0");
  assert.deepEqual(linear, { modelId: "linear_regression", modelVersion: "1.0.0" });
  assert.deepEqual(logistic, { modelId: "logistic_regression", modelVersion: "1.0.0" });
  assert.equal(modelSelection("gradient_boosting", "1.0.0"), null);
  assert.equal(modelSelection("linear_regression", "2.0.0"), null);
  assert.equal(trainSelectedModel(linear!, dataset(MIN_TRAINING_ROWS)).algo, "linear_regression");
  const binary = Buffer.from([
    "feature,target",
    ...Array.from({ length: MIN_TRAINING_ROWS }, (_, index) => `${index % 2},${index % 2}`),
  ].join("\n"));
  assert.equal(trainSelectedModel(logistic!, binary).algo, "logistic_regression");
});

test("livre le modèle attendu pour le jeu immobilier de démonstration", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/regression/housing-prices.csv"))),
  ).model;

  assert.equal(model.algo, "linear_regression");
  assert.equal(model.version, "1.0.0");
  assert.equal(model.target, "price_eur");
  assert.deepEqual(model.features, ["surface_m2", "rooms", "age_years", "distance_km", "energy_score"]);
  assert.deepEqual(model.coefficients, [41076.6, 2941.28, 12162.4, -608.333, -4784.21, 364.224]);
  assert.equal(model.metrics.r2, 0.974095);
  assert.equal(model.metrics.rmse, 25392.9);
  assert.ok(model.metrics.mae > 0);
  assert.equal(model.metrics.n, 140);
});

test("entraîne le jeu de demande énergétique volumineux", () => {
  const model = gateModel(
    trainLinearRegression(readFileSync(resolve(process.cwd(), "public/examples/regression/energy-demand.csv"))),
  ).model;

  assert.equal(model.metrics.n, 8_760);
  assert.ok(model.metrics.r2 > 0.95);
  assert.ok(model.metrics.rmse < 3);
});

test("borne le nombre de features avant le calcul quadratique", () => {
  const featureNames = Array.from({ length: MAX_TRAINING_FEATURES + 1 }, (_, index) => `f${index}`);
  const lines = [[...featureNames, "target"].join(",")];
  for (let row = 1; row <= 400; row++) {
    lines.push([...featureNames.map((_, index) => row + index), row * 2].join(","));
  }
  assert.throws(() => trainLinearRegression(Buffer.from(lines.join("\n"))), /trop de features/);
});

test("entraîne une régression logistique binaire déterministe", () => {
  const lines = ["feature,target"];
  for (let row = 0; row < MIN_TRAINING_ROWS; row++) lines.push(`${row % 2},${row % 2}`);
  const model = gateModel(trainLogisticRegression(Buffer.from(lines.join("\n")))).model;

  assert.equal(model.algo, "logistic_regression");
  assert.equal(model.version, "1.0.0");
  assert.equal(model.metrics.n, MIN_TRAINING_ROWS);
  assert.ok(model.metrics.accuracy > 0.99);
  assert.ok(model.metrics.f1 > 0.99);
});

test("entraîne le jeu de défaut de crédit de démonstration", () => {
  const model = gateModel(
    trainLogisticRegression(readFileSync(resolve(process.cwd(), "public/examples/classification/credit-default-train.csv"))),
  ).model;

  assert.equal(model.algo, "logistic_regression");
  assert.deepEqual(model.features, [
    "income_k_eur",
    "debt_ratio_pct",
    "credit_score",
    "late_payments",
    "utilization_pct",
    "employment_years",
  ]);
  assert.equal(model.target, "defaulted");
  assert.equal(model.metrics.n, 480);
  assert.ok(model.metrics.accuracy > 0.7);
  assert.ok(model.metrics.accuracy < 0.9);
  assert.ok(model.metrics.f1 > 0.5);
  assert.ok(model.metrics.f1 < 0.8);
});

test("refuse une cible logistique qui n'est pas strictement binaire", () => {
  const lines = ["feature,target"];
  for (let row = 0; row < MIN_TRAINING_ROWS; row++) lines.push(`${row},${row % 3}`);
  assert.throws(
    () => trainLogisticRegression(Buffer.from(lines.join("\n"))),
    /strictement 0 ou 1/,
  );
});

test("une erreur imputable au fichier est distinguable d'une panne technique", () => {
  // Ce que ce test protège : à l'upload, ces motifs remontent en 400 avec leur message ;
  // pendant un entraînement ils restent opaques. La distinction ne tient qu'au type, donc
  // repasser l'un d'eux en `Error` nu redonnerait « Internal error » à l'utilisateur sans
  // qu'aucun autre test ne s'en aperçoive.
  const binaire = ["feature,target"];
  for (let row = 0; row < MIN_TRAINING_ROWS; row++) binaire.push(`${row},${row % 3}`);

  const cas: [string, () => unknown][] = [
    ["cible logistique non binaire", () =>
      validateTrainingDataset(Buffer.from(binaire.join("\n")), modelSelection("logistic_regression", "1.0.0")!)],
    ["dataset trop court", () => trainLinearRegression(dataset(MIN_TRAINING_ROWS - 1))],
    ["en-têtes dupliqués", () => trainLinearRegression(Buffer.from("a,a\n1,2\n3,4"))],
  ];

  for (const [nom, appel] of cas) {
    assert.throws(appel, (error: unknown) => {
      assert.ok(error instanceof DatasetValidationError, `${nom} : type attendu DatasetValidationError`);
      return true;
    });
  }
});

test("chaque motif de validation a une traduction anglaise", () => {
  // Le message traverse le runner puis `errorResponse` avant d'atteindre l'écran. S'il n'est
  // pas dans le dictionnaire, l'utilisateur lit du français au milieu d'une interface anglaise.
  const motifs = [
    "dataset insuffisant",
    "en-têtes CSV invalides",
    "au moins 2 colonnes numériques requises",
    "colonne cible non numérique",
    "la cible de la régression logistique doit contenir les classes 0 et 1",
    `trop de features numériques (max ${MAX_TRAINING_FEATURES})`,
    `dataset trop petit pour préserver la confidentialité (min ${MIN_TRAINING_ROWS} lignes)`,
  ];
  for (const motif of motifs) {
    assert.notEqual(translateEnglish(motif), motif, `motif non traduit : ${motif}`);
  }
});

for (const [modelId, rows] of [["linear_regression", 19_999], ["logistic_regression", 4_000]] as const) {
  test(`l'ingestion refuse le budget excessif pour ${modelId}`, () => {
    const header = Array.from({ length: 32 }, (_, index) => `f${index}`).join(",");
    const csv = Buffer.from([header, ...Array.from({ length: rows }, (_, index) => Array(32).fill(index % 2).join(","))].join("\n"));
    assert.ok(csv.length < 3 * 1024 * 1024);
    const selection = modelSelection(modelId, "1.0.0")!;
    for (const run of [() => validateTrainingDataset(csv, selection), () => trainSelectedModel(selection, csv)]) {
      assert.throws(run, (error) => error instanceof DatasetValidationError && /budget de calcul/.test(error.message));
    }
    const limit = Math.floor(20_000_000 / (32 * (modelId === "linear_regression" ? 32 : 200)));
    const boundary = Buffer.from([header, ...Array.from({ length: limit }, (_, index) => Array(32).fill(index % 2).join(","))].join("\n"));
    assert.doesNotThrow(() => validateTrainingDataset(boundary, selection));
  });
}
