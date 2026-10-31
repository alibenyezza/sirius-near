import "server-only";
import { prisma } from "@/lib/db";
import { isCertificateLoanId, resolveCertificate, type CertificateLoanRow, type CertificateResolution } from "./resolve";

/**
 * Lecture en base pour le certificat public. La projection est explicite : aucune colonne
 * qui n'entre pas dans le certificat ou dans ses contrôles de cohérence n'est lue
 * (ni devis signé, ni reçu runner, ni reçu d'audit, ni hashlock, ni clé du dataset).
 */
const CERTIFICATE_SELECT = {
  id: true,
  status: true,
  datasetId: true,
  borrower: true,
  provider: true,
  amountUsdcAtomic: true,
  billingQuoteHash: true,
  modelId: true,
  modelVersion: true,
  modelCid: true,
  evmLoanKey: true,
  evmChainId: true,
  evmEscrowAddress: true,
  attestationHash: true,
  attestationPayload: true,
  attestationQuote: true,
  attestationEventLog: true,
  attestationComposeHash: true,
  settleTxHash: true,
  settledAt: true,
  finalityReview: true,
  dataset: {
    select: {
      id: true,
      name: true,
      status: true,
      evmDatasetId: true,
      ipfsCid: true,
      challengeDays: true,
      merkleRoot: true,
    },
  },
} as const;

export async function loadCertificateLoan(loanId: string): Promise<CertificateLoanRow | null> {
  // Entrée bornée avant toute requête : un identifiant hors format ne touche pas la base.
  if (!isCertificateLoanId(loanId)) return null;
  return prisma.loan.findUnique({ where: { id: loanId }, select: CERTIFICATE_SELECT });
}

export async function loadCertificate(loanId: string): Promise<CertificateResolution> {
  return resolveCertificate(await loadCertificateLoan(loanId));
}
