import type { CertificateViewProps } from "@/app/certificate/[loanId]/certificate-view";
import { EVM_CHAINS } from "@/lib/evm/networks";
import { transactionExplorerUrl } from "@/lib/evm/explorer";
import { formatCertificateDate, presentVerification, type VerificationOutcome } from "./presentation";
import type { CertificateRecord } from "./resolve";

/**
 * Projection d'un certificat prêt vers les seules propriétés affichées. C'est la
 * frontière de confidentialité de la page : le payload d'attestation (adresses, montant,
 * clé de prêt) reste côté serveur et ne passe que par le téléchargement JSON.
 */

export function certificateDownloadPath(loanId: string): string {
  return `/api/certificate/${encodeURIComponent(loanId)}/attestation`;
}

export function certificateViewProps(record: CertificateRecord, outcome: VerificationOutcome): CertificateViewProps {
  const network = record.settlement.network;
  let settlementHref: string | null;
  try {
    settlementHref = transactionExplorerUrl(network, record.settlement.txHash);
  } catch {
    // Aucun explorateur configuré pour ce réseau : le hash reste affiché, sans lien.
    settlementHref = null;
  }
  return {
    datasetName: record.dataset.name.trim() || "Untitled dataset",
    proofHref: `/proof/${encodeURIComponent(record.dataset.id)}`,
    modelName: record.model.name,
    modelCid: record.model.cid,
    settledAt: formatCertificateDate(record.settledAt),
    networkLabel: EVM_CHAINS[network].name,
    settlementTxHash: record.settlement.txHash,
    settlementHref,
    attestationHash: record.evidence.payloadHash,
    downloadHref: certificateDownloadPath(record.loanId),
    presentation: presentVerification(outcome),
  };
}
