import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { messageOf } from "../errors-client";
import { MODEL_REGISTRY, modelDisplayName, selectionForModelId } from "../models/registry";
import { EN_MESSAGES, translateEnglish as t } from "./english";

test("les profils, actions et erreurs métier sont affichés en anglais", () => {
  const examples = {
    "Profil absent": "Missing profile",
    "Profil d’entraînement": "Training profile",
    "Profil du dataset verrouillé": "Dataset profile locked",
    "TEE en cours…": "TEE working…",
    "Récupérer le lock": "Recover lock",
    "Probabilité (classe 1)": "Probability (class 1)",
    "Classe prédite": "Predicted class",
    "Origine de requête non autorisée": "Request origin not allowed",
    "Challenge refusé": "Sign-in challenge rejected",
    "Loan non verrouillé ou déjà en cours": "Loan not locked or already running",
    "Contrats EVM Sirius indisponibles ou incompatibles": "Sirius EVM contracts are unavailable or incompatible",
  };
  for (const [key, expected] of Object.entries(examples)) assert.equal(t(key), expected);
});

test("la traduction reste à la frontière d'affichage, après les décisions métier", () => {
  const error = new Error("Loan non verrouillé ou déjà en cours");
  assert.equal(messageOf(error), "Loan non verrouillé ou déjà en cours");
  assert.equal(t(messageOf(error)), "Loan not locked or already running");
  assert.equal(t(messageOf({ code: 4001 })), "Transaction rejected in your wallet.");
});

test("les erreurs dynamiques gardent les colonnes utilisateur, identifiants et valeurs", () => {
  const examples = {
    "Valeur invalide dans la colonne « revenu_annuel_€ »": "Invalid value in column “revenu_annuel_€”",
    "La colonne « défaut » doit être strictement encodée en 0 ou 1": "Column “défaut” must be strictly encoded as 0 or 1",
    "Valeur invalide pour « prix »": "Invalid value for “prix”",
    "Le CSV de test doit contenir au moins 2 lignes": "The test CSV must contain at least 2 rows",
    "trop de colonnes CSV (max 32)": "Too many CSV columns (maximum 32)",
    "dataset trop petit pour préserver la confidentialité (min 100 lignes)": "Dataset too small to preserve privacy (minimum 100 rows)",
    "Trop de poids (40 > 32) — borné par l'output-gate": "Too many weights (40 > 32) — restricted by the output gate",
    "Pinata upload échoué (503): Service unavailable": "Pinata upload failed (503): Service unavailable",
    "Intégrité Merkle invalide pour dataset-123": "Invalid Merkle integrity for dataset-123",
    "Attestation parrainée indisponible (503)": "Sponsored attestation unavailable (503)",
    "adresse du contrat escrow EVM invalide": "Invalid EVM escrow contract address",
    "Clé de session invalide": "Invalid session key",
    "Empreinte de la chaîne KMS non authentifiée": "KMS chain fingerprint could not be authenticated",
  };
  for (const [key, expected] of Object.entries(examples)) assert.equal(t(key), expected);
  for (const [role, english] of [["fournisseur", "provider"], ["emprunteur", "borrower"]]) {
    assert.equal(
      t(`Emprunt impossible : le ${role} de ce dataset n'a pas d'attestation KYB valide. ` +
        "Elle est absente, expirée ou révoquée, et doit être renouvelée de son côté."),
      `Cannot borrow: the dataset ${english} has no valid KYB attestation. It is missing, expired, or revoked and must be renewed by the ${english}.`,
    );
  }
});

test("les paramètres et textes externes ne sont pas réinterprétés", () => {
  assert.equal(t("{count} lignes", { count: 0 }), "0 rows");
  assert.equal(t("{count} lignes"), "{count} rows");
  assert.equal(t("{count} lignes", {}), "{count} rows");
  assert.equal(t("Profil du dataset verrouillé : {model}", { model: "$& {count}" }), "Dataset profile locked: $& {count}");
  assert.equal(t("Mon dataset personnel"), "Mon dataset personnel");
  assert.equal(t("Execution reverted."), "Execution reverted.");
  assert.equal(t("constructor"), "constructor");
  assert.equal(t("{constructor}", {}), "{constructor}");
});

test("chaque traduction conserve les paramètres de sa clé", () => {
  const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g))].sort();
  for (const [key, value] of Object.entries(EN_MESSAGES)) {
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
});

test("les noms publics des modèles sont anglais sans modifier leurs identifiants", () => {
  assert.deepEqual(Object.keys(MODEL_REGISTRY), ["linear_regression", "logistic_regression"]);
  assert.equal(modelDisplayName(selectionForModelId("linear_regression")), "Linear regression v1.0.0");
  assert.equal(modelDisplayName(selectionForModelId("logistic_regression")), "Binary logistic regression v1.0.0");
  assert.equal(MODEL_REGISTRY.linear_regression.description, "Predicts a continuous numeric value.");
  assert.equal(MODEL_REGISTRY.logistic_regression.description, "Classifies a target strictly encoded as 0 or 1.");
  assert.ok(MODEL_REGISTRY.logistic_regression.metrics.includes("Probability"));
});

const root = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return ["i18n", "generated", "abi"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function staticStrings(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...staticStrings(node.whenTrue), ...staticStrings(node.whenFalse)];
  if (ts.isBinaryExpression(node)) return [...staticStrings(node.left), ...staticStrings(node.right)];
  return [];
}

test("toutes les clés statiques de l'interface et les erreurs exposées ont une traduction", () => {
  const alreadyEnglish = new Set([
    "Invalid IV length", "Invalid auth tag length", "Invalid encoded key", "chunkSize must be positive",
  ]);
  const missing = new Set<string>();
  const files = [
    ...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "components")),
    ...sourceFiles(join(root, "lib")), join(root, "runner/handler.ts"), join(root, "runner/server.ts"),
  ];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function check(node: ts.Node | undefined) {
      for (const key of staticStrings(node)) {
        if (key && !Object.hasOwn(EN_MESSAGES, key) && !alreadyEnglish.has(key)) missing.add(`${relative(root, file)}: ${key}`);
      }
    }
    function visit(node: ts.Node) {
      // Les messages de progression sont traduits à l’affichage, comme les erreurs.
      if (ts.isCallExpression(node) && ["t", "progress", "setProgress"].includes(node.expression.getText(source))) check(node.arguments[0]);
      if (ts.isNewExpression(node) && ["Error", "AppError"].includes(node.expression.getText(source))) check(node.arguments?.[0]);
      if (file.includes("/api/") && ts.isPropertyAssignment(node) && node.name.getText(source) === "error") check(node.initializer);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual([...missing].sort(), []);
});
