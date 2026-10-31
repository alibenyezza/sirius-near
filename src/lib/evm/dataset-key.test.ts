import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { merkleRootAsBytes32 } from "./dataset-key";

/**
 * Deux formes de racine Merkle coexistent, et les confondre a bloqué le produit deux
 * fois : d'abord la publication, puis l'entraînement — à chaque fois avec un message
 * annonçant une racine « invalide » alors qu'elle était parfaitement correcte.
 *
 * La cause n'était pas le contrôle mais sa duplication : deux fichiers, deux copies,
 * une seule corrigée. Ces tests fixent la conversion et interdisent de la réécrire.
 */

const CANONIQUE = "c9697942" + "0".repeat(50) + "2f9674"; // 64 caractères

test("la forme canonique, sans préfixe, est acceptée et préfixée", () => {
  assert.equal(CANONIQUE.length, 64);
  assert.equal(merkleRootAsBytes32(CANONIQUE), `0x${CANONIQUE}`);
});

test("une racine déjà préfixée est rendue telle quelle", () => {
  assert.equal(merkleRootAsBytes32(`0x${CANONIQUE}`), `0x${CANONIQUE}`);
});

test("une longueur ou un alphabet incorrects sont refusés", () => {
  for (const invalide of ["", "0x", CANONIQUE.slice(0, 60), `${CANONIQUE}ff`, "z".repeat(64)]) {
    assert.throws(
      () => merkleRootAsBytes32(invalide),
      /Racine Merkle EVM invalide/,
      `« ${invalide.slice(0, 12)}… » doit être refusée`,
    );
  }
});

/**
 * Le contrôle ne doit exister qu'ici. Un fichier qui teste lui-même la forme `0x…64`
 * sur une racine reproduit la panne : il rejettera la valeur que le runner produit.
 */
test("aucun autre fichier ne revalide une racine Merkle de son côté", () => {
  const racine = join(process.cwd(), "src");
  const parcourir = (d: string): string[] =>
    readdirSync(d).flatMap((e) => {
      const p = join(d, e);
      if (statSync(p).isDirectory()) return parcourir(p);
      return /\.tsx?$/.test(e) && !e.endsWith(".test.ts") ? [p] : [];
    });

  const fautifs = parcourir(racine)
    .filter((chemin) => !chemin.endsWith(join("evm", "dataset-key.ts")))
    .filter((chemin) => {
      const source = readFileSync(chemin, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      return /merkleRoot[\s\S]{0,80}\/\^0x\[0-9a-fA-F\]\{64\}\$\//.test(source);
    })
    .map((c) => c.slice(process.cwd().length + 1));

  assert.deepEqual(
    fautifs,
    [],
    `Ces fichiers revalident une racine au lieu d'utiliser merkleRootAsBytes32 :\n  ${fautifs.join("\n  ")}`,
  );
});
