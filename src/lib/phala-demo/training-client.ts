"use client";

import { useWalletStore } from "@/stores/wallet";
import { csvWithTargetLast } from "./csv";
import { publishDataset } from "@/lib/datasets/client";
import { ensureKybAttested } from "@/lib/kyb/client";
import { encryptDatasetForRunner } from "@/lib/tee/ingress-client";
import { MAX_DATASET_BYTES, type DatasetIngressKey, type RunnerDeliveryEnvelope } from "@/lib/tee/contract";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { encodeRunnerGrantHeader } from "@/lib/runner/authorization-contract";
import type { ModelId, ModelSelection } from "@/lib/models/registry";
import { prepareDemoDelivery } from "./delivery-client";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Opération Phala refusée");
  return body as T;
}

async function demoScope() {
  const state = await json<{ available: boolean; sessionRevision?: number }>("/api/phala-demo/session", { cache: "no-store" });
  if (!state.available || !Number.isSafeInteger(state.sessionRevision)) throw new Error("La démonstration est fermée ou momentanément indisponible");
  return { demoSessionRevision: state.sessionRevision };
}


export async function trainDemoFile(file: File, modelId: ModelId, target: string, progress: (message: string) => void) {
  const initial = useWalletStore.getState();
  if (!initial.authenticated || !initial.address) throw new Error("Connecte et authentifie ton wallet");
  const owner = initial.address.toLowerCase();
  const current = () => {
    const now = useWalletStore.getState();
    if (!now.authenticated || now.revision !== initial.revision || now.address?.toLowerCase() !== owner) throw new Error("Le wallet a changé ; relance le parcours");
  };
  if (!file.size || file.size > MAX_DATASET_BYTES) throw new Error("CSV vide ou trop volumineux (max 3 Mo)");
  const bytes = csvWithTargetLast(await file.text(), target);
  await demoScope();
  current();
  progress("Préparation du wallet testnet…");
  await ensureKybAttested(owner, current);
  current();
  const jobId = crypto.randomUUID();
  const delivery = await prepareDemoDelivery(jobId, owner);
  progress("Chiffrement de ton fichier…");
  const init = await json<{ datasetId: string; ingressKey: DatasetIngressKey; priceUsdcAtomic: string; challengeDays: number; sizeBytes: number; model: ModelSelection }>("/api/datasets", {
    method: "POST", headers: { "content-type": "application/json" },
    // Termes de publication exigés par la route (07-upload.md) : catégorie « Other », durée
    // minimale, pas de consentement. Le délai de sécurité n'est plus une entrée : le serveur
    // l'impose et le renvoie, et le grant ci-dessous reprend cette valeur.
    body: JSON.stringify({ name: file.name.slice(0, 120), sizeBytes: bytes.length, priceUsdc: "0.001", category: "Other", listingDays: 7, trainingConsent: false, modelId }),
  });
  current();
  const envelope = await encryptDatasetForRunner(bytes.buffer, init.datasetId, init.ingressKey);
  bytes.fill(0);
  current();
  const uploadGrant = await issueRunnerGrant("seal-dataset", { datasetId: init.datasetId, ...await demoScope() }, [init.datasetId, init.priceUsdcAtomic,
    String(init.challengeDays), String(init.sizeBytes), envelope.ciphertext, init.model.modelId, init.model.modelVersion]);
  await json(`/api/datasets/${init.datasetId}/upload`, { method: "POST", headers: { "content-type": "application/json",
    "x-sirius-runner-grant": encodeRunnerGrantHeader(uploadGrant) }, body: JSON.stringify({ envelope }) });
  current();
  progress("Confirme le titre de ton dataset dans ton wallet…");
  await publishDataset(init.datasetId);
  current();
  const dataset = await json<{ runnerReceipt: string }>(`/api/datasets/${init.datasetId}`);
  const authorization = await issueRunnerGrant("run-training", { datasetId: init.datasetId, jobId, ...await demoScope() },
    [init.datasetId, jobId, dataset.runnerReceipt, init.model.modelId, init.model.modelVersion, delivery.publicKey]);
  current();
  progress("Entraînement dans Phala…");
  const result = await json<{ jobId: string; modelCid: string; modelKeyEnvelope: RunnerDeliveryEnvelope; metrics: Record<string, number>; runnerReceipt: string }>("/api/train", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ datasetId: init.datasetId, jobId, datasetReceipt: dataset.runnerReceipt, authorization, deliveryPublicKey: delivery.publicKey }),
  });
  current();
  if (!result.modelKeyEnvelope) throw new Error("Livraison chiffrée absente");
  return { ...result, modelKey: await delivery.decrypt(result.modelKeyEnvelope) };
}
