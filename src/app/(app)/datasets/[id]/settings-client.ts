"use client";

import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { setDatasetVisibility } from "@/lib/datasets/client";
import type { ListingExtensionDays, LoanStats, OwnerDatasetView } from "@/lib/datasets/manage";

/**
 * Appels de la fiche d'un dataset vers ses routes privées. Le serveur refait tous les
 * contrôles (session, propriété, transition) : rien ici n'est une garde.
 */

export class DatasetRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DatasetRequestError";
  }
}

export type DatasetStatsView = LoanStats & { truncated: boolean; tokenDecimals: number };

function datasetPath(id: string, suffix = ""): string {
  return `/api/datasets/${encodeURIComponent(id)}${suffix}`;
}

async function parse<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : fallback;
    throw new DatasetRequestError(message, response.status);
  }
  return body as T;
}

export async function fetchOwnerView(id: string, signal?: AbortSignal): Promise<OwnerDatasetView> {
  const response = await fetch(datasetPath(id, "/settings"), { signal, cache: "no-store" });
  return parse<OwnerDatasetView>(response, "Chargement du dataset impossible");
}

export async function fetchDatasetStats(id: string, signal?: AbortSignal): Promise<DatasetStatsView> {
  const response = await fetch(datasetPath(id, "/stats"), { signal, cache: "no-store" });
  return parse<DatasetStatsView>(response, "Statistiques indisponibles");
}

function jsonRequest(method: "PATCH" | "POST", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export async function saveDatasetDetails(id: string, details: { name?: string; description?: string | null }): Promise<OwnerDatasetView> {
  const response = await fetch(datasetPath(id, "/settings"), jsonRequest("PATCH", details));
  return parse<OwnerDatasetView>(response, "Enregistrement impossible");
}

/** Pause (LISTED → UNLISTED) ou remise en ligne (→ LISTED), avec le grant de visibilité existant. */
export async function changeListing(id: string, action: "pause" | "resume"): Promise<OwnerDatasetView> {
  const target = action === "pause" ? "UNLISTED" : "LISTED";
  const authorization = await issueRunnerGrant("set-dataset-visibility", { datasetId: id }, [id, target]);
  const response = await fetch(datasetPath(id, "/settings/listing"), jsonRequest("POST", { action, authorization }));
  return parse<OwnerDatasetView>(response, "Échec du changement de visibilité");
}

/**
 * Prolongation. Si l'annonce est en ligne mais expirée, la prolonger la remet sur la
 * marketplace : le serveur exige alors le même grant que la remise en ligne.
 */
export async function extendListing(id: string, days: ListingExtensionDays, relists: boolean): Promise<OwnerDatasetView> {
  const authorization = relists ? await issueRunnerGrant("set-dataset-visibility", { datasetId: id }, [id, "LISTED"]) : undefined;
  const response = await fetch(datasetPath(id, "/settings/listing"), jsonRequest("POST", { action: "extend", days, ...(authorization ? { authorization } : {}) }));
  return parse<OwnerDatasetView>(response, "Prolongation impossible");
}

/** Passage en privé par la route de visibilité existante (refusé pendant un emprunt en cours). */
export async function makePrivate(id: string): Promise<void> {
  await setDatasetVisibility(id, "PRIVATE");
}

export async function revokeConsent(id: string): Promise<OwnerDatasetView> {
  const response = await fetch(datasetPath(id, "/settings/consent"), jsonRequest("POST", { action: "revoke" }));
  return parse<OwnerDatasetView>(response, "Retrait du consentement impossible");
}
