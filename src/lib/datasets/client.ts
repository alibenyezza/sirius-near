"use client";

import { sendActiveTransaction } from "@/lib/wallet/transaction-client";
import { guardDatasetTransaction } from "@/lib/wallet/transaction-guard";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";

async function responseBody<T>(response: Response): Promise<T & { error?: string }> {
  return response.json() as Promise<T & { error?: string }>;
}

/** Étapes de l'inscription on-chain, pour afficher la progression (07-upload.md). */
export type PublishDatasetStage = "preparing" | "signing" | "confirming";

export async function publishDataset(
  datasetId: string,
  onStage: (stage: PublishDatasetStage) => void = () => {},
): Promise<void> {
  onStage("preparing");
  const preparation = await fetch(`/api/datasets/${datasetId}/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const prepared = await responseBody<{ transaction?: Record<string, unknown>; reconciled?: boolean }>(preparation);
  if (!preparation.ok) {
    throw new Error(prepared.error ?? "Préparation du titre EVM échouée");
  }
  if (prepared.reconciled) return;
  if (!prepared.transaction) throw new Error("Préparation du titre EVM échouée");
  onStage("signing");
  const txHash = await sendActiveTransaction(guardDatasetTransaction(prepared.transaction, "mint"));
  onStage("confirming");
  const submission = await fetch(`/api/datasets/${datasetId}/list`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash }),
  });
  const submitted = await responseBody<Record<string, never>>(submission);
  if (!submission.ok) throw new Error(submitted.error ?? "Publication EVM échouée");
}

export async function destroyDataset(datasetId: string): Promise<void> {
  const preparation = await fetch(`/api/datasets/${datasetId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const prepared = await responseBody<{ transaction: Record<string, unknown> | null }>(preparation);
  if (!preparation.ok) throw new Error(prepared.error ?? "Préparation de la suppression échouée");
  const txHash = prepared.transaction
    ? await sendActiveTransaction(guardDatasetTransaction(prepared.transaction, "destroy"))
    : undefined;
  const authorization = await issueRunnerGrant(
    "delete-dataset",
    { datasetId },
    [datasetId, txHash ?? ""],
  );
  const deletion = await fetch(`/api/datasets/${datasetId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash, authorization }),
  });
  const deleted = await responseBody<Record<string, never>>(deletion);
  if (!deletion.ok) throw new Error(deleted.error ?? "Suppression EVM du dataset échouée");
}

export async function setDatasetVisibility(datasetId: string, visibility: "LISTED" | "UNLISTED" | "PRIVATE"): Promise<void> {
  const authorization = await issueRunnerGrant(
    "set-dataset-visibility",
    { datasetId },
    [datasetId, visibility],
  );
  const response = await fetch(`/api/datasets/${datasetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility, authorization }),
  });
  const body = await responseBody<Record<string, never>>(response);
  if (!response.ok) throw new Error(body.error ?? "Échec du changement de visibilité");
}
