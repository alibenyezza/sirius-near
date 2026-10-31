import type { DatasetIngressKey } from "@/lib/tee/contract";
import { modelSelection, type ModelId, type ModelSelection } from "@/lib/models/registry";
import { ESCROW_CHALLENGE_DAYS, type DatasetCategory, type ListingDurationDays } from "./publication";

export interface DraftResponse {
  datasetId: string;
  ingressKey: DatasetIngressKey;
  priceUsdcAtomic: string;
  challengeDays: typeof ESCROW_CHALLENGE_DAYS;
  sizeBytes: number;
  model: ModelSelection;
  category: DatasetCategory;
  listingDays: ListingDurationDays;
  trainingConsentAt: string | null;
}

export interface ExpectedDraft {
  priceUsdcAtomic: string;
  sizeBytes: number;
  modelId: ModelId;
  category: DatasetCategory;
  listingDays: ListingDurationDays;
  trainingConsent: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * Réponse de `POST /api/datasets` relue avant de chiffrer et de signer quoi que ce soit.
 *
 * Le navigateur signe ensuite une autorisation de scellement sur ces termes ; il vérifie
 * donc qu'ils sont exactement ceux du formulaire (prix, taille, profil, catégorie, durée,
 * consentement) et que le délai de sécurité est bien la constante de Sirius. Une réponse
 * altérée (proxy, bug serveur) est refusée avant tout envoi du fichier.
 */
export function checkDraftResponse(body: unknown, expected: ExpectedDraft): DraftResponse {
  const r = body as Partial<DraftResponse> | undefined;
  if (!r || typeof r !== "object") throw new Error("Échec de la préparation du dépôt");
  if (typeof r.datasetId !== "string" || !ID_RE.test(r.datasetId)) throw new Error("Échec de la préparation du dépôt");
  const key = r.ingressKey;
  if (!key || key.version !== 1 || typeof key.publicKey !== "string" || typeof key.origin !== "string") {
    throw new Error("Échec de la préparation du dépôt");
  }
  const model = modelSelection(r.model?.modelId, r.model?.modelVersion);
  if (!model || model.modelId !== expected.modelId) throw new Error("Le serveur a renvoyé un autre profil d’entraînement");
  if (r.priceUsdcAtomic !== expected.priceUsdcAtomic) throw new Error("Le serveur a renvoyé un autre prix");
  if (r.sizeBytes !== expected.sizeBytes) throw new Error("Le serveur a renvoyé une autre taille de fichier");
  if (r.challengeDays !== ESCROW_CHALLENGE_DAYS) throw new Error("Délai de sécurité incohérent");
  if (r.category !== expected.category || r.listingDays !== expected.listingDays) {
    throw new Error("Le serveur a renvoyé d’autres termes de publication");
  }
  const consentAt = r.trainingConsentAt ?? null;
  if (consentAt !== null && typeof consentAt !== "string") throw new Error("Le serveur a renvoyé d’autres termes de publication");
  if ((consentAt !== null) !== expected.trainingConsent) throw new Error("Le serveur a renvoyé d’autres termes de publication");
  return {
    datasetId: r.datasetId,
    ingressKey: { version: 1, publicKey: key.publicKey, origin: key.origin },
    priceUsdcAtomic: r.priceUsdcAtomic,
    challengeDays: ESCROW_CHALLENGE_DAYS,
    sizeBytes: r.sizeBytes,
    model,
    category: r.category,
    listingDays: r.listingDays,
    trainingConsentAt: consentAt,
  };
}
