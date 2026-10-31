"use client";

import { messageOf } from "@/lib/errors-client";
import { encryptDatasetForRunner } from "@/lib/tee/ingress-client";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { encodeRunnerGrantHeader } from "@/lib/runner/authorization-contract";
import type { ModelId } from "@/lib/models/registry";
import { publishDataset, type PublishDatasetStage } from "./client";
import { checkDraftResponse } from "./draft-response";
import type { DatasetCategory, ListingDurationDays } from "./publication";

/** Étapes affichées pendant la publication (07-upload.md : chiffrement, envoi, scellement, inscription). */
export type UploadStep = "draft" | "encrypt" | "seal" | "register";
export const UPLOAD_STEPS: readonly UploadStep[] = ["draft", "encrypt", "seal", "register"];

export interface UploadInput {
  /** Contenu du fichier, déjà lu dans le navigateur. */
  content: ArrayBuffer;
  sizeBytes: number;
  name: string;
  description: string;
  category: DatasetCategory;
  modelId: ModelId;
  /** Gain du fournisseur par emprunt, saisi en jeton (« 20 », « 0.5 »). */
  priceUsdc: string;
  /** Même montant en unités atomiques, calculé par le formulaire ; la réponse serveur doit le confirmer. */
  priceUsdcAtomic: string;
  listingDays: ListingDurationDays;
  trainingConsent: boolean;
}

export interface UploadProgress {
  step: UploadStep;
  stage?: PublishDatasetStage;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly step: UploadStep,
    /** Identifiant du brouillon scellé, si l'échec survient après le scellement. */
    readonly sealedDatasetId: string | null,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorText(body: Record<string, unknown>, fallback: string): string {
  return typeof body.error === "string" && body.error ? body.error : fallback;
}

/**
 * Publication complète : brouillon, chiffrement sur l'appareil, scellement par l'enclave,
 * inscription du titre on-chain. Chaque étape est annoncée via `onProgress` avant de
 * commencer. Le fichier n'est chiffré qu'une fois le brouillon créé, car la clé de
 * chiffrement est liée à son identifiant ; la donnée en clair ne quitte jamais ce code.
 */
export async function uploadAndPublishDataset(
  input: UploadInput,
  onProgress: (progress: UploadProgress) => void,
): Promise<{ datasetId: string }> {
  let step: UploadStep = "draft";
  let sealedDatasetId: string | null = null;
  try {
    onProgress({ step });
    const initRes = await fetch("/api/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        description: input.description || undefined,
        sizeBytes: input.sizeBytes,
        priceUsdc: input.priceUsdc,
        category: input.category,
        listingDays: input.listingDays,
        trainingConsent: input.trainingConsent,
        modelId: input.modelId,
      }),
    });
    const initBody = await responseJson(initRes);
    if (!initRes.ok) throw new Error(errorText(initBody, "Échec de la préparation du dépôt"));
    const draft = checkDraftResponse(initBody, {
      priceUsdcAtomic: input.priceUsdcAtomic,
      sizeBytes: input.sizeBytes,
      modelId: input.modelId,
      category: input.category,
      listingDays: input.listingDays,
      trainingConsent: input.trainingConsent,
    });

    step = "encrypt";
    onProgress({ step });
    const envelope = await encryptDatasetForRunner(input.content, draft.datasetId, draft.ingressKey);

    step = "seal";
    onProgress({ step });
    const authorization = await issueRunnerGrant(
      "seal-dataset",
      { datasetId: draft.datasetId },
      [
        draft.datasetId,
        draft.priceUsdcAtomic,
        String(draft.challengeDays),
        String(draft.sizeBytes),
        envelope.ciphertext,
        draft.model.modelId,
        draft.model.modelVersion,
      ],
    );
    const uploadRes = await fetch(`/api/datasets/${draft.datasetId}/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sirius-runner-grant": encodeRunnerGrantHeader(authorization),
      },
      body: JSON.stringify({ envelope }),
    });
    if (!uploadRes.ok) throw new Error(errorText(await responseJson(uploadRes), "Échec de l’upload confidentiel"));
    sealedDatasetId = draft.datasetId;

    step = "register";
    onProgress({ step });
    await publishDataset(draft.datasetId, (stage) => onProgress({ step: "register", stage }));
    return { datasetId: draft.datasetId };
  } catch (error) {
    // `messageOf` lit aussi les rejets nus des wallets (`{ code, message }`), comme le reste du site.
    throw new UploadError(messageOf(error), step, sealedDatasetId);
  }
}
