import "server-only";
import { createHash, createHmac } from "node:crypto";
import { deriveKey, getMasterKey, safeEqual } from "@/lib/crypto/encryption";
import { getEnclaveQuote } from "./dstack";
import { modelSelection, type ModelId } from "@/lib/models/registry";
import type { Attestation, LoanAttestationPayload, LoanExecutionAttestation } from "./types";

// L'attestation est un HMAC d'une clé dérivée de la master key. En mode phala cette clé est
// scellée à l'enclave (3d.1) → seul le code mesuré peut signer ; la preuve MATÉRIELLE externe
// est la quote TDX (3d.2). `signer` est un label informationnel (la vérif repose sur le HMAC),
// volontairement DÉCOUPLÉ de la couche provider/DB pour que le cœur runner reste autonome (D-25).
const ATTESTATION_CONTEXT = "attestation-v1";
const ATTESTATION_SIGNER = "sirius-tee";

function sign(payloadHash: string): string {
  const key = deriveKey(getMasterKey(), ATTESTATION_CONTEXT);
  return createHmac("sha256", key).update(payloadHash).digest("hex");
}

export function attest(payloadHash: string): Attestation {
  return { signer: ATTESTATION_SIGNER, payloadHash, signature: sign(payloadHash) };
}

export function verifyAttestation(att: Attestation): boolean {
  return safeEqual(Buffer.from(sign(att.payloadHash), "hex"), Buffer.from(att.signature, "hex"));
}

export interface LoanAttestationInput {
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

const PAYLOAD_KEYS = [
  "version",
  "kind",
  "chainId",
  "escrow",
  "loanId",
  "loanKey",
  "datasetId",
  "datasetCid",
  "provider",
  "borrower",
  "amountUsdcAtomic",
  "challengeDays",
  "merkleRoot",
  "modelId",
  "modelVersion",
  "modelCid",
  "releaseEnvelopeHash",
] as const;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function payloadObject(value: unknown): LoanAttestationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const keys = payload.version === 2 ? [...PAYLOAD_KEYS, "billingQuoteHash"] : PAYLOAD_KEYS;
  if (Object.keys(payload).length !== keys.length || !keys.every((key) => key in payload)) return null;
  if (
    (payload.version !== 1 && payload.version !== 2) ||
    (payload.version === 2 && (typeof payload.billingQuoteHash !== "string" || !/^0x[0-9a-f]{64}$/.test(payload.billingQuoteHash))) ||
    payload.kind !== "sirius-loan-training" ||
    !Number.isSafeInteger(payload.chainId) ||
    (payload.chainId as number) < 1 ||
    !Number.isSafeInteger(payload.challengeDays) ||
    (payload.challengeDays as number) < 1 ||
    (payload.challengeDays as number) > 30 ||
    !modelSelection(payload.modelId, payload.modelVersion) ||
    ![
      payload.escrow,
      payload.loanId,
      payload.loanKey,
      payload.datasetId,
      payload.datasetCid,
      payload.provider,
      payload.borrower,
      payload.amountUsdcAtomic,
      payload.merkleRoot,
      payload.modelVersion,
      payload.modelCid,
      payload.releaseEnvelopeHash,
    ].every(isText)
  ) {
    return null;
  }
  return payload as unknown as LoanAttestationPayload;
}

export function serializeLoanAttestationPayload(input: LoanAttestationInput): string {
  const payload: LoanAttestationPayload = {
    version: input.billingQuoteHash ? 2 : 1,
    kind: "sirius-loan-training",
    chainId: input.chainId,
    escrow: input.escrow,
    loanId: input.loanId,
    loanKey: input.loanKey,
    datasetId: input.datasetId,
    datasetCid: input.datasetCid,
    provider: input.provider,
    borrower: input.borrower,
    amountUsdcAtomic: input.amountUsdcAtomic,
    challengeDays: input.challengeDays,
    merkleRoot: input.merkleRoot,
    modelId: input.modelId,
    modelVersion: input.modelVersion,
    modelCid: input.modelCid,
    releaseEnvelopeHash: input.releaseEnvelopeHash,
    ...(input.billingQuoteHash ? { billingQuoteHash: input.billingQuoteHash } : {}),
  };
  return JSON.stringify(payload);
}

export function parseLoanAttestationPayload(payload: string): LoanAttestationPayload {
  if (payload.length === 0 || payload.length > 4_096) throw new Error("Payload d’attestation invalide");
  try {
    const parsed = payloadObject(JSON.parse(payload));
    if (!parsed || JSON.stringify(parsed) !== payload) throw new Error();
    return parsed;
  } catch {
    throw new Error("Payload d’attestation invalide");
  }
}

export function hashLoanAttestationPayload(payload: string): string {
  parseLoanAttestationPayload(payload);
  return createHash("sha256").update(payload).digest("hex");
}

export async function attestLoanExecution(input: LoanAttestationInput): Promise<LoanExecutionAttestation> {
  const payload = serializeLoanAttestationPayload(input);
  const payloadHash = hashLoanAttestationPayload(payload);
  const evidence = process.env.TEE_MODE === "phala" ? await getEnclaveQuote(payloadHash) : null;
  return { ...attest(payloadHash), payload, evidence };
}
