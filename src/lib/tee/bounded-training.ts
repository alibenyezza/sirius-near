import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { AppError } from "@/lib/app-error";
import { parseDeliveredModel, type DeliveredModel, type ModelSelection } from "@/lib/models/registry";

/** Message sûr à exposer : il ne révèle rien du contenu du dataset. */
export const INVALID_DATASET_MESSAGE = "Dataset inexploitable pour ce modèle";

export async function trainInWorker(selection: ModelSelection, csv: Buffer, signal: AbortSignal): Promise<DeliveredModel> {
  signal.throwIfAborted();
  const worker = new Worker("require('tsx/cjs'); require(require('node:worker_threads').workerData.module);", {
    eval: true, execArgv: ["--conditions=react-server"],
    workerData: { module: resolve(process.cwd(), "src/lib/tee/train-worker.ts"), selection, csv },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
  });
  try {
    return await new Promise<DeliveredModel>((resolve, reject) => {
      const fail = () => reject(new AppError("Exécution confidentielle interrompue", 503));
      signal.addEventListener("abort", fail, { once: true });
      worker.once("error", fail);
      worker.once("exit", fail);
      worker.once("message", (message: { model?: unknown; invalidDataset?: unknown }) => {
        if (message.invalidDataset === true) return reject(new AppError(INVALID_DATASET_MESSAGE, 422));
        try { resolve(parseDeliveredModel(message.model)); } catch { fail(); }
      });
      worker.once("exit", () => signal.removeEventListener("abort", fail));
      if (signal.aborted) fail();
    });
  } finally { await worker.terminate(); }
}
