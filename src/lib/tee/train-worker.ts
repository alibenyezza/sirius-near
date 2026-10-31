import { parentPort, workerData } from "node:worker_threads";
import { trainSelectedModel } from "./model-registry";
import type { ModelSelection } from "@/lib/models/registry";

const input = workerData as { csv: Uint8Array; selection: ModelSelection };
try {
  parentPort!.postMessage({ model: trainSelectedModel(input.selection, Buffer.from(input.csv)) });
} catch {
  // L'entraînement est un calcul pur sur le CSV : une exception ici vient des données
  // (CSV invalide, matrice singulière, valeurs hors plage), pas d'une panne du runner.
  // Un dépassement mémoire ou un arrêt brutal passent par l'événement « error »/« exit ».
  parentPort!.postMessage({ failed: true, invalidDataset: true });
}
