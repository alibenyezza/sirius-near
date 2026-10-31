import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deux monnaies coexistent, et les confondre a un coût pour l'utilisateur.
 *
 * L'USDC est ce qu'on dépense : le prix d'un dataset, le montant sous escrow. L'ETH
 * natif est ce qui permet de dépenser : sans lui, aucune transaction ne part.
 *
 * Un compte à court d'ETH voyait ses transactions refusées sans qu'aucun écran ne
 * l'explique. Ces tests fixent les deux garanties qui l'évitent : le seuil existe, et
 * une panne de lecture du gas ne fait pas disparaître le solde USDC.
 */

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "evm", "balance.ts"), "utf8");
const PAGES = ["dashboard", "wallet"].map((p) =>
  readFileSync(join(process.cwd(), "src", "app", "(app)", p, "page.tsx"), "utf8"),
);

test("le solde de gas est lu sans passer par un contrat", () => {
  assert.match(SOURCE, /eth_getBalance/);
  assert.doesNotMatch(
    SOURCE.slice(SOURCE.indexOf("fetchGasBalance")),
    /encodeFunctionData/,
    "le solde natif est une propriété du compte, pas une entrée de registre",
  );
});

test("un seuil signale que le compte ne peut plus payer ses frais", () => {
  assert.match(SOURCE, /low:\s*wei < SEUIL_WEI/);
});

test("une lecture de gas en échec ne masque pas le solde USDC", () => {
  for (const page of PAGES) {
    assert.match(
      page,
      /fetchGasBalance\(address\)\.catch\(\(\) => null\)/,
      "le gas est accessoire : son échec ne doit pas emporter l'affichage principal",
    );
  }
});

test("le solde USDC est présenté comme un jeton de test", () => {
  for (const page of PAGES) {
    assert.match(
      page,
      /t\("test USDC"\)/,
      "un solde libellé en dollars sans mention se lit comme de la vraie monnaie",
    );
  }
});

test("les fonds reçus sont libellés avec le jeton du réseau, jamais « USDC » en dur", () => {
  for (const page of PAGES) {
    assert.match(page, /t\("\{usdc\} \{token\} envoyés\.", \{ usdc: recu\.usdc, token \}\)/);
    assert.match(page, /t\("\{usdc\} \{token\} et \{eth\} ETH envoyés\."/);
    // Sur mainnet, « USDC » à côté d'un montant désignerait un autre jeton que celui du solde (USDG).
    assert.doesNotMatch(page, /\} USDC/);
  }
});
