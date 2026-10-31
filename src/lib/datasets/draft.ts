import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/app-error";
import { beginDatasetIngestion } from "@/lib/sirius/pipeline";
import type { CreateDatasetRequest } from "./create-request";
import { ESCROW_CHALLENGE_DAYS, listingExpiryFrom, TRAINING_CONSENT_VERSION } from "./publication";

export interface DatasetDraftTerms {
  category: CreateDatasetRequest["category"];
  listingDays: CreateDatasetRequest["listingDays"];
  listingExpiresAt: string;
  trainingConsentAt: string | null;
  trainingConsentVersion: string | null;
  /** Toujours `ESCROW_CHALLENGE_DAYS`, pour que le navigateur signe le même reçu que le serveur a enregistré. */
  challengeDays: typeof ESCROW_CHALLENGE_DAYS;
}

/**
 * Crée le brouillon avec les termes de publication (07-upload.md).
 *
 * `beginDatasetIngestion` (src/lib/sirius/pipeline.ts) écrit le cœur du dataset et obtient
 * la clé d'ingestion de l'enclave ; il ne connaît pas les champs de catalogue. Ils sont
 * posés juste après, sur le même brouillon, par une mise à jour conditionnée à son état
 * (`DRAFT`, même fournisseur). Si cette écriture échoue, le brouillon est supprimé : un
 * dataset sans catégorie, sans échéance ni trace de consentement ne doit pas exister.
 *
 * Le délai de sécurité est passé en constante et relu dans la réponse : la valeur reçue du
 * navigateur n'arrive jamais jusqu'ici (`parseCreateDatasetRequest` l'écarte).
 */
export async function createDatasetDraft(request: CreateDatasetRequest, provider: string) {
  const upload = await beginDatasetIngestion({
    name: request.name,
    description: request.description,
    provider,
    sizeBytes: request.sizeBytes,
    priceUsdcAtomic: request.priceUsdcAtomic,
    challengeDays: ESCROW_CHALLENGE_DAYS,
    model: request.model,
  });
  let terms: {
    category: CreateDatasetRequest["category"];
    listingExpiresAt: Date;
    trainingConsentAt: Date | null;
    trainingConsentVersion: string | null;
  };
  try {
    if (upload.challengeDays !== ESCROW_CHALLENGE_DAYS) throw new AppError("Délai de sécurité incohérent", 500);
    // L'échéance part de `createdAt` de la ligne (posé par Prisma à l'insertion), pas d'une
    // horloge relevée après l'appel à l'enclave : `rebasedListingExpiry` retrouve ainsi la
    // durée choisie à la milliseconde près à la mise en ligne, quelle que soit la lenteur du runner.
    const created = await prisma.dataset.findUniqueOrThrow({ where: { id: upload.datasetId }, select: { createdAt: true } });
    const now = new Date();
    terms = {
      category: request.category,
      listingExpiresAt: listingExpiryFrom(created.createdAt, request.listingDays),
      trainingConsentAt: request.trainingConsent ? now : null,
      trainingConsentVersion: request.trainingConsent ? TRAINING_CONSENT_VERSION : null,
    };
    const written = await prisma.dataset.updateMany({
      where: { id: upload.datasetId, provider, status: "DRAFT", ipfsCid: null, wrappedKey: null },
      data: terms,
    });
    if (written.count !== 1) throw new AppError("Le brouillon a changé pendant sa création", 409);
  } catch (error) {
    await prisma.dataset
      .deleteMany({ where: { id: upload.datasetId, provider, status: "DRAFT", ipfsCid: null, wrappedKey: null } })
      .catch(() => console.error(`Nettoyage du brouillon incomplet impossible pour ${upload.datasetId}`));
    throw error;
  }
  const draftTerms: DatasetDraftTerms = {
    category: request.category,
    listingDays: request.listingDays,
    listingExpiresAt: terms.listingExpiresAt.toISOString(),
    trainingConsentAt: terms.trainingConsentAt?.toISOString() ?? null,
    trainingConsentVersion: terms.trainingConsentVersion,
    challengeDays: ESCROW_CHALLENGE_DAYS,
  };
  return { ...upload, ...draftTerms };
}
