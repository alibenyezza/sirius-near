"use client";

import { useWalletStore } from "@/stores/wallet";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { createRunnerDelivery } from "@/lib/runner/delivery-client";
import type { RunnerDeliveryEnvelope } from "@/lib/tee/contract";
import type { ModelSelection } from "@/lib/models/registry";

export interface SelfTrainResult {
  jobId: string;
  modelCid: string;
  modelKey: string;
  metrics: Record<string, number>;
}

/**
 * Lance un self-train sur son propre dataset (MLaaS, sans escrow). Nécessite une
 * session authentifiée ; le backend vérifie la propriété du dataset.
 */
export async function runSelfTrain(
  datasetId: string,
  datasetReceipt: string,
  model: ModelSelection,
): Promise<SelfTrainResult> {
  const { authenticated } = useWalletStore.getState();
  if (!authenticated) throw new Error("Authentifie-toi (Se connecter) pour entraîner.");

  const jobId = crypto.randomUUID();
  const authorization = await issueRunnerGrant(
    "run-training",
    { datasetId, jobId },
    [datasetId, jobId, datasetReceipt, model.modelId, model.modelVersion],
  );
  const res = await fetch("/api/train", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId, jobId, datasetReceipt, authorization }),
  });
  const body = (await res.json()) as {
    jobId?: string;
    modelCid?: string;
    runnerReceipt?: string;
    metrics?: Record<string, number>;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? "Entraînement échoué");
  if (!body.jobId || !body.modelCid || !body.runnerReceipt || !body.metrics) {
    throw new Error("Réponse runner incomplète");
  }
  const delivery = await retrieveSelfTrainKey(body.jobId, body.runnerReceipt);
  return { jobId: body.jobId, modelCid: body.modelCid, modelKey: delivery.modelKey, metrics: body.metrics };
}

export async function retrieveSelfTrainKey(
  jobId: string,
  runnerReceipt: string,
): Promise<{ modelCid: string; modelKey: string }> {
  const address = useWalletStore.getState().address;
  if (!address) throw new Error("Wallet déconnecté");
  const delivery = await createRunnerDelivery(`self-train:${address}:${jobId}`);
  const authorization = await issueRunnerGrant(
    "self-train-key",
    { jobId },
    [jobId, runnerReceipt, delivery.publicKey],
  );
  const res = await fetch(`/api/train/${jobId}/key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorization, deliveryPublicKey: delivery.publicKey }),
  });
  const body = (await res.json()) as {
    modelCid?: string;
    modelKeyEnvelope?: RunnerDeliveryEnvelope;
    error?: string;
  };
  if (!res.ok || !body.modelCid || !body.modelKeyEnvelope) {
    throw new Error(body.error ?? "Livraison de clé échouée");
  }
  return { modelCid: body.modelCid, modelKey: await delivery.decrypt(body.modelKeyEnvelope) };
}
