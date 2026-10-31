import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Recopie les ABI compilés vers `src/lib/evm/abi/` sous forme de constantes TypeScript.
 *
 * Pourquoi ne pas importer directement l'artefact Hardhat depuis l'application :
 * `contracts/artifacts/` est ignoré par git et absent d'un clone frais, donc un
 * `next build` échouerait tant que les contrats n'ont pas été compilés. Les ABI
 * exportés ici sont versionnés et suffisent à l'application, qui n'a jamais besoin
 * du bytecode.
 *
 * Le `as const` est indispensable : c'est lui qui permet à viem de typer les
 * arguments et les retours de chaque fonction.
 */

const CONTRACTS = ["SiriusEscrow", "SiriusEscrowV7", "SiriusKybRegistry", "SiriusDatasetRegistry"] as const;

const artifactsRoot = resolve(__dirname, "..", "artifacts", "src");
const outputRoot = resolve(__dirname, "..", "..", "src", "lib", "evm", "abi");

for (const name of CONTRACTS) {
  const artifactPath = join(artifactsRoot, `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown[] };

  const target = join(outputRoot, `${name.toLowerCase()}.ts`);
  mkdirSync(dirname(target), { recursive: true });

  const contents = [
    "// Généré par `pnpm contracts:abi` — ne pas modifier à la main.",
    `// Source : contracts/src/${name}.sol`,
    "",
    `export const ${name.toLowerCase()}Abi = ${JSON.stringify(artifact.abi, null, 2)} as const;`,
    "",
  ].join("\n");

  writeFileSync(target, contents);
  console.log(`${name} → ${target} (${artifact.abi.length} entrées)`);
}
