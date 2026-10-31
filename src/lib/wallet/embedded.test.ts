import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Le portefeuille embarqué dépend d'un SDK navigateur : on vérifie la configuration à la
// source. Une régression ici ferait revenir l'approbation silencieuse des transactions.
const SOURCE = readFileSync(new URL("./embedded.ts", import.meta.url), "utf8");

test("le portefeuille Google exige une confirmation visible et refuse l'export de clé", () => {
  const config = SOURCE.slice(SOURCE.indexOf("walletServicesConfig:"), SOURCE.indexOf("await web3auth.init()"));
  assert.match(config, /confirmationStrategy:\s*"modal"/);
  assert.match(config, /enableKeyExport:\s*false/);
  assert.doesNotMatch(config, /confirmationStrategy:\s*"(auto-approve|default)"/);
});
