import type { ModelId } from "@/lib/models/registry";

export interface Attestation {
  signer: string;
  payloadHash: string;
  signature: string;
}

export interface TdxEvidence {
  quote: string;
  eventLog: string;
  composeHash: string;
}

export interface LoanAttestationPayload {
  version: 1 | 2;
  kind: "sirius-loan-training";
  chainId: number;
  escrow: string;
  loanId: string;
  loanKey: string;
  datasetId: string;
  datasetCid: string;
  provider: string;
  borrower: string;
  amountUsdcAtomic: string;
  challengeDays: number;
  merkleRoot: string;
  modelId: ModelId;
  modelVersion: string;
  modelCid: string;
  releaseEnvelopeHash: string;
  billingQuoteHash?: string;
}

export interface LoanExecutionAttestation extends Attestation {
  payload: string;
  evidence: TdxEvidence | null;
}

export interface RunnerRaTlsEvidence extends TdxEvidence {
  certificateSha256: string;
  ingressKeySha256: string;
  masterKeyChainSha256: string;
  settlementAddress: string;
  bootstrapOnly: boolean;
}
