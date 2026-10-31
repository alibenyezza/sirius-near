import "server-only";
import { createHash, createHmac } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { deriveKey, getMasterKey, safeEqual } from "@/lib/crypto/encryption";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import type { DatasetRef } from "@/lib/tee/contract";
import type { ModelId } from "@/lib/models/registry";
import { trustedEscrowBinding } from "@/lib/evm/history";
import type { SignedComputeQuote } from "@/lib/billing/quote";

export interface DatasetReceipt {
  version: 3;
  kind: "dataset";
  datasetId: string;
  owner: string;
  cid: string;
  wrappedKeyHash: string;
  merkleRoot: string;
  priceUsdcAtomic: string;
  challengeDays: number;
  modelId: ModelId;
  modelVersion: string;
}

export interface TrainingReceipt {
  version: 2 | 3;
  kind: "training";
  jobId: string;
  datasetId: string;
  owner: string;
  modelCid: string;
  modelId: ModelId;
  modelVersion: string;
}

export interface LoanReceipt {
  version: 2 | 3;
  kind: "loan";
  loanId: string;
  datasetId: string;
  borrower: string;
  provider: string;
  modelCid: string;
  loanKey: string;
  chainId: number;
  escrow: string;
  amountUsdcAtomic: string;
  challengeDays: number;
  modelId: ModelId;
  modelVersion: string;
  deliveryPublicKey: string;
  releaseEnvelopeHash: string;
  attestationHash: string;
  billingQuote?: SignedComputeQuote;
}

type Receipt = DatasetReceipt | TrainingReceipt | LoanReceipt;

function receiptKey(version: 2 | 3 = 3): Buffer {
  return deriveKey(getMasterKey(), `runner-receipt:hmac:v${version}`);
}

function issue(payload: Receipt): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", receiptKey()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verify<T extends Receipt["kind"]>(token: string, kind: T, delivery = false): Extract<Receipt, { kind: T }> {
  const separator = token.indexOf(".");
  if (separator < 1 || token.length > 8_192) throw new AppError("Reçu runner invalide", 401);
  const body = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), "base64url");
  let receipt: Receipt;
  try {
    receipt = JSON.parse(Buffer.from(body, "base64url").toString()) as Receipt;
  } catch {
    throw new AppError("Reçu runner invalide", 401);
  }
  if (!receipt || (receipt.version !== 3 && !(delivery && receipt.version === 2)) || receipt.kind !== kind) {
    throw new AppError("Reçu runner invalide", 401);
  }
  const expected = createHmac("sha256", receiptKey(receipt.version)).update(body).digest();
  if (!safeEqual(signature, expected)) throw new AppError("Reçu runner invalide", 401);
  return receipt as Extract<Receipt, { kind: T }>;
}

function wrappedKeyHash(wrappedKey: string): string {
  return createHash("sha256").update(wrappedKey).digest("hex");
}

export function issueDatasetReceipt(owner: string, dataset: DatasetRef): string {
  return issue({
    version: 3,
    kind: "dataset",
    datasetId: dataset.datasetId,
    owner,
    cid: dataset.cid,
    wrappedKeyHash: wrappedKeyHash(dataset.wrappedKey),
    merkleRoot: dataset.merkleRoot,
    priceUsdcAtomic: dataset.priceUsdcAtomic,
    challengeDays: dataset.challengeDays,
    modelId: dataset.modelId,
    modelVersion: dataset.modelVersion,
  });
}

export function verifyDatasetReceipt(token: string, dataset: DatasetRef): DatasetReceipt {
  const receipt = verify(token, "dataset");
  if (
    receipt.datasetId !== dataset.datasetId ||
    receipt.cid !== dataset.cid ||
    receipt.wrappedKeyHash !== wrappedKeyHash(dataset.wrappedKey) ||
    receipt.merkleRoot !== dataset.merkleRoot ||
    receipt.priceUsdcAtomic !== dataset.priceUsdcAtomic ||
    receipt.challengeDays !== dataset.challengeDays ||
    receipt.modelId !== dataset.modelId ||
    receipt.modelVersion !== dataset.modelVersion
  ) {
    throw new AppError("Reçu dataset hors scope", 401);
  }
  return receipt;
}

export function issueTrainingReceipt(input: Omit<TrainingReceipt, "version" | "kind">): string {
  return issue({ version: 3, kind: "training", ...input });
}

export function verifyTrainingReceipt(token: string, jobId: string): TrainingReceipt {
  const receipt = verify(token, "training", true);
  if (receipt.jobId !== jobId) throw new AppError("Reçu d’entraînement hors scope", 401);
  return receipt;
}

export function issueLoanReceipt(input: Omit<LoanReceipt, "version" | "kind">): string {
  return issue({ version: 3, kind: "loan", ...input });
}

export function verifyLoanReceipt(token: string, loanId: string): LoanReceipt {
  const receipt = verify(token, "loan");
  if (receipt.loanId !== loanId) throw new AppError("Reçu d’emprunt hors scope", 401);
  const { chainId, escrow } = evmEscrowBinding();
  if (receipt.chainId !== chainId || receipt.escrow !== escrow) {
    throw new AppError("Reçu d’emprunt émis pour une autre chaîne ou un autre contrat", 409);
  }
  return receipt;
}

/** Les reçus historiques ne peuvent que relivrer un modèle déjà réglé. */
export function verifyLoanDeliveryReceipt(token: string, loanId: string): LoanReceipt {
  const receipt = verify(token, "loan", true);
  if (receipt.loanId !== loanId) throw new AppError("Reçu d’emprunt hors scope", 401);
  trustedEscrowBinding(receipt);
  return receipt;
}

export function assertReleaseEnvelopeHash(receipt: LoanReceipt, persistedHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(persistedHash)) throw new AppError("Accusé de capsule invalide", 400);
  if (receipt.releaseEnvelopeHash !== persistedHash) {
    throw new AppError("Capsule persistée différente de la capsule attestée", 409);
  }
}
