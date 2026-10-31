import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Garde-fou contre une panne muette.
 *
 * Next.js remplace les références à `process.env.NEXT_PUBLIC_X` par leur valeur au
 * moment du build, par substitution textuelle. Sa documentation le dit sans
 * ambiguïté : « dynamic lookups will not be inlined ». Une lecture par clé calculée
 * compile, passe le lint, fonctionne parfaitement côté serveur — et rend `undefined`
 * dans le navigateur.
 *
 * Le jour où c'est arrivé, les quatre adresses de contrats étaient introuvables côté
 * client. Plus une seule transaction ne pouvait être construite : ni l'approbation
 * USDC, ni le verrouillage, ni la publication d'un dataset, ni le KYB. Rien ne le
 * signalait, ni au build ni aux tests — seulement un « solde indisponible » à l'écran.
 */

const RACINE = join(process.cwd(), "src");

/**
 * Retire commentaires de bloc et de ligne avant l'analyse.
 *
 * Sans ça le test se déclencherait sur les commentaires qui *décrivent* le piège,
 * à commencer par celui qui explique pourquoi ce test existe.
 */
function sansCommentaires(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function fichiersSources(repertoire: string): string[] {
  return readdirSync(repertoire).flatMap((entree) => {
    const chemin = join(repertoire, entree);
    if (statSync(chemin).isDirectory()) return fichiersSources(chemin);
    return /\.(ts|tsx)$/.test(entree) && !entree.endsWith(".test.ts") ? [chemin] : [];
  });
}

/**
 * Les seuls endroits où une clé calculée est légitime : ils ne tournent que sous Node,
 * où `process.env` existe réellement à l'exécution, et n'entrent jamais dans un bundle
 * navigateur.
 */
const EXEMPTIONS = [
  join("src", "instrumentation-node.ts"),
  join("src", "runner", "server.ts"),
];

test("aucune lecture de process.env par clé calculée dans le code atteignable par le navigateur", () => {
  const fautifs = fichiersSources(RACINE)
    .filter((chemin) => !EXEMPTIONS.some((exempt) => chemin.endsWith(exempt)))
    .filter((chemin) => /process\.env\s*\[/.test(sansCommentaires(readFileSync(chemin, "utf8"))))
    .map((chemin) => chemin.slice(process.cwd().length + 1));

  assert.deepEqual(
    fautifs,
    [],
    `Lecture par clé calculée — non inlinée par Next, donc undefined dans le navigateur :\n  ${fautifs.join("\n  ")}`,
  );
});

test("les adresses de contrats sont lues en toutes lettres", () => {
  const source = readFileSync(join(RACINE, "lib", "evm", "addresses.ts"), "utf8");
  for (const nom of [
    "NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS",
    "NEXT_PUBLIC_SIRIUS_USDC_ADDRESS",
    "NEXT_PUBLIC_SIRIUS_KYB_ADDRESS",
    "NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS",
  ]) {
    assert.ok(
      source.includes(`process.env.${nom}`),
      `${nom} doit être lue en toutes lettres pour que Next puisse l'inliner`,
    );
  }
});
