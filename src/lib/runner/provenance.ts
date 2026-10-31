import "server-only";
import { createHash } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { runnerEndpoint } from "./config";

export interface RunnerProvenance {
  runnerKind: "PHALA" | "DEVELOPMENT";
  runnerDeploymentId: string;
}

interface RecordedRunner {
  runnerKind: string;
  runnerDeploymentId: string | null;
}

export async function currentRunnerProvenance(): Promise<RunnerProvenance> {
  const endpoint = runnerEndpoint();
  if (endpoint?.startsWith("https:") && process.env.TEE_MODE === "phala" && !process.env.DSTACK_SIMULATOR_ENDPOINT) {
    const fingerprint = process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256?.trim().toLowerCase();
    if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new AppError("Empreinte du runner Phala absente ou invalide", 503);
    }
    return { runnerKind: "PHALA", runnerDeploymentId: `phala:${fingerprint}` };
  }
  const { datasetIngressKeyInRunner } = await import("@/lib/tee/runner-client");
  const ingress = await datasetIngressKeyInRunner();
  const fingerprint = createHash("sha256").update(Buffer.from(ingress.publicKey, "base64url")).digest("hex");
  return { runnerKind: "DEVELOPMENT", runnerDeploymentId: `development:${fingerprint}` };
}

export async function assertCurrentRunner(record: RecordedRunner): Promise<RunnerProvenance> {
  const current = await currentRunnerProvenance();
  // L'historique sans provenance reste lisible en dev ; le reçu vérifie encore la clé.
  if (record.runnerKind === "UNKNOWN" && !record.runnerDeploymentId && current.runnerKind === "DEVELOPMENT") return current;
  if (record.runnerKind !== current.runnerKind || record.runnerDeploymentId !== current.runnerDeploymentId) {
    throw new AppError("Cette ressource appartient à un ancien runner : réimporter le dataset ou utiliser son environnement historique", 409);
  }
  return current;
}
