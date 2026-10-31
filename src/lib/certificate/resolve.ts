import "server-only";
import { hashLoanAttestationPayload, parseLoanAttestationPayload } from "@/lib/tee/attestation";
import { loanEscrowBinding } from "@/lib/evm/history";
import type { EvmEscrowBinding } from "@/lib/tee/evm-binding";
import { modelDisplayName, modelSelection } from "@/lib/models/registry";
import { EVM_CHAIN_IDS, type EvmNetwork } from "@/lib/evm/networks";

/**
 * Résolution d'un certificat d'exécution public à partir d'une ligne de prêt.
 *
 * La page `/certificate/[loanId]` et le téléchargement JSON sont publics : aucune session,
 * aucun contrôle de partie. Tout le contrôle d'accès tient donc ici, dans trois règles
 * appliquées côté serveur avant toute présentation :
 *
 * 1. Identifiant mal formé, prêt inexistant ou dataset qui n'est plus publiquement
 *    visible → `not-found`. Les trois cas rendent la même réponse (404) : on ne peut pas
 *    distinguer « n'existe pas » de « existe mais n'est pas montrable ».
 * 2. Prêt pas encore réglé, annulé, sans attestation ou dont l'attestation ne se recoupe
 *    pas avec la ligne → `unavailable`, sans aucun détail.
 * 3. Sinon → `ready`, avec uniquement les champs du certificat. Le payload d'attestation
 *    brut est gardé pour le téléchargement et la vérification de la quote (son hash est
 *    dans la quote : il faut la chaîne exacte), mais n'est jamais affiché tel quel.
 *
 * Les vérifications de cohérence reprennent celles de `GET /api/loans/[id]/attestation`,
 * qu'on ne modifie pas : une attestation qui ne correspond pas au prêt n'est jamais
 * présentée comme un certificat.
 */

/** Bornes de l'identifiant de prêt accepté en entrée (cuid en pratique). */
const LOAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
/** Même borne que la relecture de l'event-log (`identity.ts`). */
const MAX_EVENT_LOG = 2 * 1024 * 1024;

/**
 * Datasets dont la page de preuve publique est ouverte : même règle que
 * `src/app/proof/[id]/page.tsx`. Le certificat renvoie vers cette page ; si elle est
 * fermée (dataset passé en privé, supprimé), le certificat l'est aussi.
 */
const VISIBLE_DATASET_STATUSES = new Set(["LISTED", "UNLISTED", "SUSPENDED"]);

/** Réseau connu de l'application pour un identifiant de chaîne, sinon `null`. */
export function networkForChain(chainId: number): EvmNetwork | null {
  for (const network of Object.keys(EVM_CHAIN_IDS) as EvmNetwork[]) {
    if (EVM_CHAIN_IDS[network] === chainId) return network;
  }
  return null;
}

export function isCertificateLoanId(value: unknown): value is string {
  return typeof value === "string" && LOAN_ID.test(value);
}

/** Champs lus en base : la requête n'en sélectionne pas d'autres (voir `load.ts`). */
export interface CertificateLoanRow {
  id: string;
  status: string;
  datasetId: string;
  borrower: string;
  provider: string;
  amountUsdcAtomic: string;
  billingQuoteHash: string | null;
  modelId: string;
  modelVersion: string;
  modelCid: string | null;
  evmLoanKey: string | null;
  evmChainId: number | null;
  evmEscrowAddress: string | null;
  attestationHash: string | null;
  attestationPayload: string | null;
  attestationQuote: string | null;
  attestationEventLog: string | null;
  attestationComposeHash: string | null;
  settleTxHash: string | null;
  settledAt: Date | null;
  /** Revue ouverte par le reaper : release rapide contredit à finalité complète (fast-settlement-review.ts). */
  finalityReview?: string | null;
  dataset: {
    id: string;
    name: string;
    status: string;
    evmDatasetId: string | null;
    ipfsCid: string | null;
    challengeDays: number;
    merkleRoot: string | null;
  };
}

export interface CertificateEvidence {
  /** Chaîne exacte attestée : son SHA-256 est `payloadHash`, porté par la quote. */
  payload: string;
  payloadHash: string;
  quote: string | null;
  eventLog: string | null;
  composeHash: string | null;
}

export interface CertificateRecord {
  loanId: string;
  dataset: { id: string; name: string };
  model: { name: string; cid: string };
  settledAt: Date | null;
  settlement: { txHash: string; chainId: number; network: EvmNetwork };
  evidence: CertificateEvidence;
}

export type CertificateResolution =
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | { kind: "ready"; record: CertificateRecord };

const NOT_FOUND: CertificateResolution = { kind: "not-found" };
const UNAVAILABLE: CertificateResolution = { kind: "unavailable" };

type BindingResolver = (loan: CertificateLoanRow) => EvmEscrowBinding;

export function resolveCertificate(
  loan: CertificateLoanRow | null,
  binding: BindingResolver = loanEscrowBinding,
): CertificateResolution {
  if (!loan || !isCertificateLoanId(loan.id)) return NOT_FOUND;
  const dataset = loan.dataset;
  if (!VISIBLE_DATASET_STATUSES.has(dataset.status)) return NOT_FOUND;
  if (dataset.status === "SUSPENDED" && !dataset.evmDatasetId) return NOT_FOUND;

  if (
    loan.status !== "SETTLED" ||
    // Release rapide contredit sous le bloc finalisé : aucun certificat tant que la revue est ouverte.
    loan.finalityReview ||
    !loan.attestationHash ||
    !loan.attestationPayload ||
    !loan.modelCid ||
    !loan.settleTxHash ||
    !TX_HASH.test(loan.settleTxHash) ||
    !SHA256_HEX.test(loan.attestationHash)
  ) {
    return UNAVAILABLE;
  }

  const model = modelSelection(loan.modelId, loan.modelVersion);
  if (!model) return UNAVAILABLE;

  let chainId: number;
  let network: EvmNetwork | null;
  try {
    const payload = parseLoanAttestationPayload(loan.attestationPayload);
    const escrow = binding(loan);
    chainId = escrow.chainId;
    network = networkForChain(chainId);
    if (!network) return UNAVAILABLE;
    if (
      hashLoanAttestationPayload(loan.attestationPayload) !== loan.attestationHash.toLowerCase() ||
      payload.chainId !== escrow.chainId ||
      payload.escrow !== escrow.escrow ||
      payload.loanId !== loan.id ||
      payload.loanKey !== loan.evmLoanKey ||
      payload.datasetId !== loan.datasetId ||
      payload.datasetCid !== dataset.ipfsCid ||
      payload.provider !== loan.provider ||
      payload.borrower !== loan.borrower ||
      payload.amountUsdcAtomic !== loan.amountUsdcAtomic ||
      (payload.billingQuoteHash ?? null) !== (loan.billingQuoteHash ?? null) ||
      payload.challengeDays !== dataset.challengeDays ||
      payload.merkleRoot !== dataset.merkleRoot ||
      payload.modelId !== loan.modelId ||
      payload.modelVersion !== loan.modelVersion ||
      payload.modelCid !== loan.modelCid
    ) {
      return UNAVAILABLE;
    }
  } catch {
    // Payload illisible ou déploiement d'escrow non approuvé : rien à certifier.
    return UNAVAILABLE;
  }

  // Une quote enregistrée mais mal formée n'est pas effacée en silence : elle reste dans
  // l'export, et la vérification (`verification.ts`) la refuse, ce que la page affiche.
  const evidenceComplete = Boolean(
    loan.attestationEventLog &&
      loan.attestationComposeHash &&
      loan.attestationEventLog.length <= MAX_EVENT_LOG &&
      SHA256_HEX.test(loan.attestationComposeHash),
  );

  return {
    kind: "ready",
    record: {
      loanId: loan.id,
      dataset: { id: dataset.id, name: dataset.name },
      model: { name: modelDisplayName(model), cid: loan.modelCid },
      settledAt: loan.settledAt,
      settlement: { txHash: loan.settleTxHash, chainId, network },
      evidence: {
        payload: loan.attestationPayload,
        payloadHash: loan.attestationHash.toLowerCase(),
        quote: loan.attestationQuote || null,
        eventLog: evidenceComplete ? loan.attestationEventLog : null,
        composeHash: evidenceComplete ? loan.attestationComposeHash!.toLowerCase() : null,
      },
    },
  };
}

/**
 * Contenu du fichier JSON téléchargeable : de quoi revérifier sans faire confiance à
 * Sirius, et rien d'autre. Ni reçu d'audit HMAC (invérifiable sans la clé de l'enclave),
 * ni devis, ni reçu runner. Le payload contient les adresses du fournisseur et de
 * l'emprunteur et le montant : ils sont déjà publics dans les transactions de lock et de
 * règlement, et le hash de la quote porte sur cette chaîne exacte.
 */
export function certificateExport(record: CertificateRecord) {
  return {
    format: "sirius-execution-certificate/1",
    loanId: record.loanId,
    chainId: record.settlement.chainId,
    settlementTxHash: record.settlement.txHash,
    modelCid: record.model.cid,
    attestation: {
      payload: record.evidence.payload,
      payloadSha256: record.evidence.payloadHash,
      tdxQuote: record.evidence.quote,
      eventLog: record.evidence.eventLog,
      composeHash: record.evidence.composeHash,
    },
    howToVerify: [
      "SHA-256 of attestation.payload (exact UTF-8 string) must equal attestation.payloadSha256.",
      "The TDX quote report_data must start with payloadSha256, followed by zero bytes.",
      "Verify the quote signature and TCB status with Intel DCAP collateral (for example with dcap-qvl).",
      "Replay attestation.eventLog: it must reproduce the quote's RTMR3 and contain the compose-hash event equal to attestation.composeHash.",
      "Compare MRTD and composeHash with the values published for the Sirius enclave. RTMR3 changes at every CVM restart and is only authenticated through the replayed event log.",
      "Check that settlementTxHash released the escrow for this loan on the chain identified by chainId.",
    ],
  };
}
