import "server-only";
import { AppError } from "@/lib/app-error";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { runnerEndpoint as endpoint } from "@/lib/runner/config";
import { issueRunnerCapability, type RunnerOperation, type RunnerScope } from "@/lib/runner/capability";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import type { ModelSelection } from "@/lib/models/registry";
import type { LoanExecutionAttestation } from "./types";
import type {
  AuthorizedSealDatasetResult,
  AuthorizedTrainingResult,
  DatasetIngressEnvelope,
  DatasetIngressKey,
  DatasetRef,
  RunnerDeliveryEnvelope,
  RunnerReleaseEnvelope,
  RecoveredLoanResult,
} from "./contract";
import { attestedRunnerFetch } from "./ra-tls-client";
import type { LockAuthorization } from "@/lib/evm/lock-authorization";
import type { SignedComputeQuote } from "@/lib/billing/quote";
import type { FinalityTier } from "@/lib/evm/fast-finality";

const RUNNER_TIMEOUT_MS = 60_000;

/**
 * Palier demandé à l'enclave, transmis seulement quand il est rapide : un prêt à finalité complète
 * envoie exactement la charge historique, et l'enclave lit « absent » comme `FULL`. Elle n'accorde
 * de toute façon le palier rapide qu'après sa propre vérification (fast-finality.ts).
 */
function finalityTierField(tier?: FinalityTier): { finalityTier?: FinalityTier } {
  return tier === "FAST" ? { finalityTier: "FAST" } : {};
}

export function usesRemoteRunner(): boolean {
  return endpoint() !== null;
}

async function callRunner<T>(op: RunnerOperation, scope: RunnerScope, payload: object): Promise<T> {
  const base = endpoint();
  if (!base) throw new Error("Runner distant non configuré");
  const url = new URL(op, `${base}/`);
  try {
    const headers = {
      "content-type": "application/json",
      "x-sirius-runner-capability": issueRunnerCapability(op, scope),
    };
    const response = url.protocol === "https:"
      ? await attestedRunnerFetch(url, { method: "POST", headers, body: JSON.stringify(payload), timeoutMs: RUNNER_TIMEOUT_MS })
      : await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS) });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; state?: unknown; transactionHash?: unknown } & T;
    if (response.status === 202 && body.state === "pending-finality"
      && typeof body.transactionHash === "string" && /^0x[0-9a-f]{64}$/i.test(body.transactionHash)) {
      throw new RunnerFinalityPending(body.transactionHash.toLowerCase());
    }
    if (!response.ok || response.status !== 200) {
      throw new AppError(typeof body.error === "string" ? body.error : "Runner confidentiel en échec", response.ok ? 502 : response.status);
    }
    return body;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Runner confidentiel indisponible", 503);
  }
}

async function dispatchRunner<T>(op: RunnerOperation, scope: RunnerScope, payload: Record<string, unknown>): Promise<T> {
  if (endpoint()) return callRunner(op, scope, payload);
  const { handleRunnerOp } = await import("@/runner/handler");
  return handleRunnerOp(op, payload) as Promise<T>;
}

export async function datasetIngressKeyInRunner(): Promise<DatasetIngressKey> {
  return dispatchRunner("dataset-ingress-key", {}, {});
}

export async function sealDatasetInRunner(
  datasetId: string,
  priceUsdcAtomic: string,
  challengeDays: number,
  sizeBytes: number,
  envelope: DatasetIngressEnvelope,
  authorization: RunnerGrant,
  model: ModelSelection,
): Promise<AuthorizedSealDatasetResult> {
  return dispatchRunner(
    "seal-dataset",
    { datasetId },
    { datasetId, priceUsdcAtomic, challengeDays, sizeBytes, envelope, authorization, ...model },
  );
}

export async function prepareEscrowLockInRunner(
  dataset: DatasetRef,
  datasetReceipt: string,
  loanId: string,
  borrower: string,
  authorizationDeadline: number,
): Promise<{ hashlock: `0x${string}`; authorization: LockAuthorization; billingQuote?: SignedComputeQuote }> {
  return dispatchRunner("prepare-escrow-lock", { datasetId: dataset.datasetId, loanId, borrower },
    { ...dataset, datasetReceipt, loanId, borrower, authorizationDeadline });
}

export async function runLoanJobInRunner(
  input: Omit<DatasetRef, "datasetId"> & ModelSelection & { datasetId: string; loanId: string },
  datasetReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
  billingQuote?: SignedComputeQuote,
  finalityTier?: FinalityTier,
): Promise<{
  modelCid: string;
  metrics: Record<string, number>;
  attestation: LoanExecutionAttestation;
  releaseEnvelope?: RunnerReleaseEnvelope;
  releaseEnvelopeHash: string;
  runnerReceipt: string;
}> {
  return dispatchRunner(
    "run-loan-job",
    { datasetId: input.datasetId, loanId: input.loanId },
    { ...input, datasetReceipt, deliveryPublicKey, authorization, ...(billingQuote ? { billingQuote } : {}), ...finalityTierField(finalityTier) },
  );
}

export async function settleLoanInRunner(
  loanId: string,
  loanReceipt: string,
  releaseEnvelopeHash: string,
  lockBlock: string,
  authorization?: RunnerGrant,
  finalityTier?: FinalityTier,
): Promise<{ settleTxHash: string }> {
  return dispatchRunner(
    "settle-loan",
    { loanId },
    { loanId, loanReceipt, releaseEnvelopeHash, lockBlock, ...(authorization ? { authorization } : {}), ...finalityTierField(finalityTier) },
  );
}

export async function recoverLoanJobInRunner(loanId: string, billingQuote: SignedComputeQuote): Promise<RecoveredLoanResult> {
  return dispatchRunner("recover-loan-job", { loanId }, { loanId, billingQuote });
}

export async function loanModelKeyInRunner(
  loanId: string,
  loanReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
  settleTxHash?: string,
  finalityTier?: FinalityTier,
): Promise<{ modelCid: string; modelKeyEnvelope: RunnerDeliveryEnvelope }> {
  return dispatchRunner(
    "loan-model-key",
    { loanId },
    { loanId, loanReceipt, deliveryPublicKey, authorization, ...(settleTxHash ? { settleTxHash } : {}), ...finalityTierField(finalityTier) },
  );
}

export async function runSelfTrainingInRunner(
  input: Omit<DatasetRef, "datasetId"> & ModelSelection & { datasetId: string; jobId: string },
  datasetReceipt: string,
  authorization: RunnerGrant,
  deliveryPublicKey?: string,
): Promise<AuthorizedTrainingResult> {
  return dispatchRunner(
    "run-training",
    { datasetId: input.datasetId, jobId: input.jobId },
    { ...input, datasetReceipt, authorization, ...(deliveryPublicKey ? { deliveryPublicKey } : {}) },
  );
}

export async function selfTrainModelKeyInRunner(
  jobId: string,
  jobReceipt: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<RunnerDeliveryEnvelope> {
  const out = await dispatchRunner<{ modelKeyEnvelope: RunnerDeliveryEnvelope }>(
    "self-train-key",
    { jobId },
    { jobId, jobReceipt, deliveryPublicKey, authorization },
  );
  return out.modelKeyEnvelope;
}
