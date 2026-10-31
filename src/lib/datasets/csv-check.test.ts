import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { MAX_CSV_COLUMNS, MAX_CSV_ROWS } from "@/lib/sirius/metrics";
import { DatasetValidationError, MAX_TRAINING_FEATURES, MIN_TRAINING_ROWS, validateTrainingDataset } from "@/lib/tee/train";
import { selectionForModelId, type ModelId } from "@/lib/models/registry";
import { EN_MESSAGES, translateEnglish as t } from "@/lib/i18n/english";
import { checkFileSize, csvRejectionText, inspectCsv, type CsvRejection } from "./csv-check";

/** CSV synthétique : `features` variables puis une cible, `rows` lignes de données. */
function csv(rows: number, features: number, target: (row: number) => string = (row) => String(row % 7)): string {
  const header = [...Array.from({ length: features }, (_, i) => `x${i}`), "y"].join(",");
  const lines = Array.from({ length: rows }, (_, row) =>
    [...Array.from({ length: features }, (_, i) => String((row * 31 + i * 17) % 101)), target(row)].join(","));
  return `${header}\n${lines.join("\n")}\n`;
}

const binary = (row: number) => String(row % 2);

/** Verdict de l'enclave sur le même texte : `null` si accepté, sinon le message du refus. */
function enclaveVerdict(text: string, modelId: ModelId): string | null {
  try {
    validateTrainingDataset(Buffer.from(text, "utf8"), selectionForModelId(modelId));
    return null;
  } catch (error) {
    // Les refus du parseur (`parseCsv`) sont des `Error` ordinaires, ceux de la validation
    // des `DatasetValidationError` : dans les deux cas l'enclave refuse le fichier.
    assert.ok(error instanceof DatasetValidationError || error instanceof Error, `erreur inattendue : ${String(error)}`);
    return error.message;
  }
}

test("un fichier accepté par le navigateur l'est par l'enclave, et inversement, sur les cas de bord", () => {
  const cases: Array<{ text: string; modelId: ModelId; accepted: boolean; label: string }> = [
    { text: csv(100, 1), modelId: "linear_regression", accepted: true, label: "100 lignes, 1 variable" },
    { text: csv(99, 1), modelId: "linear_regression", accepted: false, label: "99 lignes, 1 variable" },
    { text: csv(320, 31), modelId: "linear_regression", accepted: true, label: "320 lignes, 31 variables" },
    { text: csv(319, 31), modelId: "linear_regression", accepted: false, label: "319 lignes, 31 variables" },
    { text: csv(320, 32), modelId: "linear_regression", accepted: false, label: "32 variables" },
    { text: csv(3125, 31, binary), modelId: "logistic_regression", accepted: true, label: "logistique 3125 lignes, 31 variables" },
    { text: csv(3126, 31, binary), modelId: "logistic_regression", accepted: false, label: "logistique 3126 lignes, 31 variables (budget)" },
    { text: csv(19_531, 31), modelId: "linear_regression", accepted: true, label: "linéaire 19 531 lignes, 31 variables" },
    { text: csv(19_532, 31), modelId: "linear_regression", accepted: false, label: "linéaire 19 532 lignes, 31 variables (budget)" },
    { text: csv(19_999, 1), modelId: "linear_regression", accepted: true, label: "19 999 lignes de données" },
    { text: csv(20_000, 1), modelId: "linear_regression", accepted: false, label: "20 000 lignes de données (parseur)" },
    { text: csv(200, 2, binary), modelId: "logistic_regression", accepted: true, label: "logistique 0/1" },
    { text: csv(200, 2, () => "1"), modelId: "logistic_regression", accepted: false, label: "logistique une seule classe" },
    { text: csv(200, 2, (row) => (row % 2 ? "1" : "0.0")), modelId: "logistic_regression", accepted: false, label: "logistique « 0.0 » n'est pas « 0 »" },
    { text: csv(200, 2, (row) => (row % 2 ? "1" : "2")), modelId: "logistic_regression", accepted: false, label: "logistique classes 1/2" },
    { text: csv(200, 2).replace("x0,x1,y", "x0,x0,y"), modelId: "linear_regression", accepted: false, label: "en-tête dupliqué" },
    { text: csv(200, 2).replace("x0,x1,y", ",x1,y"), modelId: "linear_regression", accepted: false, label: "en-tête vide" },
    { text: "x,y\n", modelId: "linear_regression", accepted: false, label: "en-tête seul" },
    { text: "", modelId: "linear_regression", accepted: false, label: "vide" },
    { text: `a,y\n${Array.from({ length: 150 }, (_, i) => `t${i},${i}`).join("\n")}\n`, modelId: "linear_regression", accepted: false, label: "une seule colonne numérique" },
    { text: `x,y\n${Array.from({ length: 150 }, (_, i) => `${i},${i === 3 ? "1e12" : i}`).join("\n")}\n`, modelId: "linear_regression", accepted: true, label: "borne 1e12 acceptée" },
    { text: `x,y\n${Array.from({ length: 150 }, (_, i) => `${i},${i === 3 ? "1000000000001" : i}`).join("\n")}\n`, modelId: "linear_regression", accepted: false, label: "au-delà de 1e12 : colonne non numérique" },
    { text: `x,y\n${Array.from({ length: 150 }, (_, i) => `${i},${i === 3 ? "0x10" : i}`).join("\n")}\n`, modelId: "linear_regression", accepted: true, label: "hexadécimal lu comme nombre (Number())" },
    { text: `x,y\n${Array.from({ length: 150 }, (_, i) => `${i}, ${i}`).join("\n")}\n`, modelId: "linear_regression", accepted: true, label: "espaces tolérés par Number()" },
    { text: `x,y\n${Array.from({ length: 150 }, (_, i) => `${i},${i === 3 ? "Infinity" : i}`).join("\n")}\n`, modelId: "linear_regression", accepted: false, label: "Infinity refusé" },
    { text: `x,y\r\n${Array.from({ length: 150 }, (_, i) => `${i},${i}`).join("\r\n")}\r\n`, modelId: "linear_regression", accepted: true, label: "CRLF" },
    { text: `"x","y"\n${Array.from({ length: 150 }, (_, i) => `"${i}","${i}"`).join("\n")}`, modelId: "linear_regression", accepted: true, label: "guillemets, sans retour final" },
  ];
  for (const { text, modelId, accepted, label } of cases) {
    const verdict = enclaveVerdict(text, modelId);
    const inspection = inspectCsv(text, modelId);
    assert.equal(inspection.ok, verdict === null, `${label} : navigateur ${inspection.ok ? "accepte" : "refuse"}, enclave ${verdict ?? "accepte"}`);
    assert.equal(inspection.ok, accepted, label);
  }
});

test("la raison du refus correspond à celle de l'enclave", () => {
  const expectations: Array<[string, ModelId, CsvRejection["kind"], RegExp]> = [
    [csv(99, 1), "linear_regression", "too-few-rows", /trop petit/],
    [csv(319, 31), "linear_regression", "too-few-rows", /min 320 lignes/],
    [csv(320, 32), "linear_regression", "too-many-features", /trop de features/],
    [csv(3126, 31, binary), "logistic_regression", "compute-budget", /budget de calcul/],
    [csv(200, 2, () => "1"), "logistic_regression", "logistic-target", /classes 0 et 1/],
    [csv(200, 2).replace("x0,x1,y", "x0,x0,y"), "linear_regression", "invalid-header", /en-têtes/],
    ["x,y\n", "linear_regression", "no-data-rows", /insuffisant/],
    [csv(20_000, 1), "linear_regression", "too-many-rows", /trop de lignes/],
  ];
  for (const [text, modelId, kind, pattern] of expectations) {
    const inspection = inspectCsv(text, modelId);
    assert.ok(!inspection.ok);
    assert.equal(inspection.reason.kind, kind);
    assert.match(enclaveVerdict(text, modelId) ?? "", pattern);
  }
});

test("le résumé annonce les lignes, colonnes, colonnes numériques et la cible que l'enclave utilisera", () => {
  const text = `id,label,x1,x2,price\n${Array.from({ length: 150 }, (_, i) => `${i},item-${i},${i * 2},${i % 5},${i * 3}`).join("\n")}\n`;
  const inspection = inspectCsv(text, "linear_regression");
  assert.ok(inspection.ok);
  assert.deepEqual(inspection.summary, {
    rowCount: 150,
    columnCount: 5,
    header: ["id", "label", "x1", "x2", "price"],
    numericColumns: ["id", "x1", "x2", "price"],
    target: "price",
    features: ["id", "x1", "x2"],
  });
  // Le résumé partiel d'un refus garde ce qui a pu être lu.
  const refused = inspectCsv(csv(99, 1), "linear_regression");
  assert.ok(!refused.ok);
  assert.equal(refused.summary.rowCount, 99);
  assert.equal(refused.summary.target, "y");
});

test("le contrôle du navigateur dépend du profil : la même cible 0/1 passe en linéaire comme en logistique, une cible continue seulement en linéaire", () => {
  const binaryText = csv(200, 2, binary);
  assert.ok(inspectCsv(binaryText, "linear_regression").ok);
  assert.ok(inspectCsv(binaryText, "logistic_regression").ok);
  const continuous = csv(200, 2);
  assert.ok(inspectCsv(continuous, "linear_regression").ok);
  assert.ok(!inspectCsv(continuous, "logistic_regression").ok);
});

test("les jeux d'exemple proposés par le formulaire passent le contrôle du navigateur et celui de l'enclave", () => {
  const examples: Array<[string, ModelId, string, number]> = [
    ["public/examples/regression/housing-prices-train.csv", "linear_regression", "price_eur", 112],
    ["public/examples/classification/credit-default-train.csv", "logistic_regression", "defaulted", 480],
  ];
  for (const [path, modelId, target, rows] of examples) {
    const text = readFileSync(join(process.cwd(), path), "utf8");
    const inspection = inspectCsv(text, modelId);
    assert.ok(inspection.ok, `${path} refusé : ${inspection.ok ? "" : inspection.reason.kind}`);
    assert.equal(inspection.summary.target, target);
    assert.equal(inspection.summary.rowCount, rows);
    assert.equal(enclaveVerdict(text, modelId), null);
  }
});

test("la taille du fichier est bornée avant lecture", () => {
  assert.deepEqual(checkFileSize(0), { kind: "empty-file" });
  assert.deepEqual(checkFileSize(-1), { kind: "empty-file" });
  assert.deepEqual(checkFileSize(1.5), { kind: "empty-file" });
  assert.equal(checkFileSize(1), null);
  assert.equal(checkFileSize(MAX_DATASET_BYTES), null);
  assert.deepEqual(checkFileSize(MAX_DATASET_BYTES + 1), { kind: "file-too-large", sizeBytes: MAX_DATASET_BYTES + 1, maxBytes: MAX_DATASET_BYTES });
});

test("les limites affichées sont lues dans le code, et chaque raison a un texte anglais", () => {
  const reasons: CsvRejection[] = [
    { kind: "empty-file" },
    { kind: "file-too-large", sizeBytes: MAX_DATASET_BYTES + 1, maxBytes: MAX_DATASET_BYTES },
    { kind: "unreadable" },
    { kind: "too-many-rows", maxRows: MAX_CSV_ROWS },
    { kind: "too-many-columns", maxColumns: MAX_CSV_COLUMNS },
    { kind: "cell-too-large" },
    { kind: "no-data-rows" },
    { kind: "invalid-header" },
    { kind: "too-few-numeric-columns", found: 1 },
    { kind: "too-many-features", found: 32, maxFeatures: MAX_TRAINING_FEATURES },
    { kind: "too-few-rows", rows: 99, minRows: MIN_TRAINING_ROWS },
    { kind: "compute-budget" },
    { kind: "logistic-target", target: "<b>y</b>" },
  ];
  for (const reason of reasons) {
    const text = csvRejectionText(reason, t);
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /[{}]/, `paramètre non résolu : ${text}`);
    assert.doesNotMatch(text, /[àéèç]/, `texte non traduit : ${text}`);
  }
  assert.equal(csvRejectionText({ kind: "too-many-rows", maxRows: MAX_CSV_ROWS }, t), "Too many rows: at most 20,000 rows, header included.");
  assert.equal(csvRejectionText({ kind: "too-many-features", found: 32, maxFeatures: MAX_TRAINING_FEATURES }, t), "Too many numeric features: 32, maximum 31 in addition to the target.");
  assert.equal(csvRejectionText({ kind: "file-too-large", sizeBytes: MAX_DATASET_BYTES + 1, maxBytes: MAX_DATASET_BYTES }, t), "File too large: 3.0 MB (3,145,729 bytes), maximum 3 MB.");
  assert.equal(csvRejectionText({ kind: "logistic-target", target: "y" }, t), "For logistic regression, the target column “y” must contain only 0 and 1, with both classes present.");
  // Les clés françaises des raisons sont toutes traduites (le test d'anglais vérifie les appels `t()`).
  assert.ok(Object.hasOwn(EN_MESSAGES, "Budget de calcul dépassé : réduis le nombre de lignes ou de variables."));
});
