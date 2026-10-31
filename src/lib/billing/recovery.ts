import "server-only";
import { AppError } from "@/lib/app-error";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { deferredLoanDeliveryCommitment } from "@/lib/runner/delivery";
import { issueLoanReceipt } from "@/lib/runner/receipt";
import { attestLoanExecution } from "@/lib/tee/attestation";
import type { LoanJobResult, RecoveredLoanResult } from "@/lib/tee/contract";
import { quoteWorkflow, requireBillingBudget } from "./runner";
import { totalQuoteAmount, type SignedComputeQuote } from "./quote";
import { failBilledEscrow } from "./settlement";

export interface LoanRecoveryContext {
  datasetCid: string;
  merkleRoot: string;
  deliveryPublicKey: string;
}

export async function recoverBilledLoanResult(signed: SignedComputeQuote): Promise<RecoveredLoanResult> {
  const ledger = requireBillingBudget();
  const quote = signed.quote;
  const scope = quoteWorkflow(quote);
  const stored = ledger.workflowResult(scope);
  if (!stored) return { state: "missing" };
  const evidence = ledger.executionEvidence(scope);
  if (!evidence) return { state: "pending" };
  const measurement = JSON.parse(evidence) as { success: boolean; quoteHash: string };
  if (measurement.quoteHash !== scope.fingerprint) throw new AppError("Preuve de consommation hors scope", 409);
  const loanKey = loanKeyFor(quote.borrower, quote.loanId);
  if (!measurement.success) {
    await failBilledEscrow(quote, loanKey);
    return { state: "failed" };
  }
  if (!stored.result) throw new AppError("Résultat durable manquant", 503);
  const context = JSON.parse(stored.context) as LoanRecoveryContext;
  const model = JSON.parse(stored.result) as Pick<LoanJobResult, "modelCid" | "metrics">;
  const releaseEnvelopeHash = deferredLoanDeliveryCommitment(loanKey, model.modelCid, context.deliveryPublicKey);
  const attestation = await attestLoanExecution({
    chainId: quote.chainId, escrow: quote.escrow, loanId: quote.loanId, loanKey,
    datasetId: quote.datasetId, datasetCid: context.datasetCid, provider: quote.provider,
    borrower: quote.borrower, amountUsdcAtomic: totalQuoteAmount(quote), billingQuoteHash: scope.fingerprint,
    challengeDays: quote.challengeDays, merkleRoot: context.merkleRoot, modelId: quote.modelId,
    modelVersion: quote.modelVersion, modelCid: model.modelCid, releaseEnvelopeHash,
  });
  return {
    state: "ready", deliveryPublicKey: context.deliveryPublicKey,
    result: {
      ...model, attestation, releaseEnvelopeHash,
      runnerReceipt: issueLoanReceipt({
        loanId: quote.loanId, datasetId: quote.datasetId, borrower: quote.borrower, provider: quote.provider,
        modelCid: model.modelCid, loanKey, chainId: quote.chainId, escrow: quote.escrow,
        amountUsdcAtomic: totalQuoteAmount(quote), billingQuote: signed, challengeDays: quote.challengeDays,
        modelId: quote.modelId, modelVersion: quote.modelVersion, deliveryPublicKey: context.deliveryPublicKey,
        releaseEnvelopeHash, attestationHash: attestation.payloadHash,
      }),
    },
  };
}
