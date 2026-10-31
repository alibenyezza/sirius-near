import { resolve } from "node:path";
import { checkRunnerReplay, initializeRunnerReplay } from "../src/lib/runner/replay";

try {
  const [command, directory, ...extra] = process.argv.slice(2);
  if (!["init", "check"].includes(command) || !directory || extra.length) throw new Error();
  const root = resolve(directory);
  if (command === "init") initializeRunnerReplay(root);
  checkRunnerReplay(root);
  console.log(command === "init" ? "Registre anti-rejeu initialisé." : "Registre anti-rejeu disponible.");
} catch {
  console.error("Registre anti-rejeu refusé : utiliser init uniquement pour une première installation ou une migration contrôlée, check pour un registre existant. Aucun registre existant n’est remplacé.");
  process.exitCode = 1;
}
