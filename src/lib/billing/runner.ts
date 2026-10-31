import "server-only";
import { keccak256, toHex, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { settlementAccount } from "@/lib/evm/runner-account";
import { getPublicClient } from "@/lib/evm/client";
import { usdcAddress } from "@/lib/evm/addresses";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { readLoan } from "@/lib/evm/escrow";
import { confirmedBlock } from "@/lib/evm/finality";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { MAX_DATASET_BYTES, type DatasetRef } from "@/lib/tee/contract";
import { runnerBudget } from "@/lib/runner/budget";
import { billingPolicy } from "./config";
import { computeQuoteHash, parseComputeQuote, quoteAuthorizationTypedData, verifyComputeQuote, type ComputeQuote, type SignedComputeQuote } from "./quote";

export function loanWorkflowId(loanId: string, borrower: string, binding = evmEscrowBinding()): string {
  return `loan:${binding.chainId}:${binding.escrow.toLowerCase()}:${loanKeyFor(borrower, loanId)}`;
}

export function quoteWorkflow(quote: ComputeQuote) {
  return { id: loanWorkflowId(quote.loanId, quote.borrower, quote), fingerprint: computeQuoteHash(quote) };
}

export function requireBillingBudget() {
  const ledger = runnerBudget();
  const account = settlementAccount();
  if (!ledger || ledger.policy.wallet !== account.address.toLowerCase()) throw new AppError("Budget de facturation non configuré pour ce runner", 503);
  return ledger;
}

async function reclaimExpiredUnpaidQuotes(): Promise<void> {
  const ledger = requireBillingBudget();
  const client = getPublicClient();
  if (await client.getChainId() !== ledger.policy.chainId) throw new AppError("RPC sur un autre réseau", 503);
  const stable = await confirmedBlock(client, ledger.policy.gas.confirmations);
  for (const workflow of ledger.expiredUnusedWorkflows(Number(stable.timestamp) * 1000)) {
    let signed: SignedComputeQuote;
    try { signed = JSON.parse(workflow.payload) as SignedComputeQuote; }
    catch { throw new AppError("Budget de clôture hors scope", 503); }
    const quote = parseComputeQuote(signed.quote);
    if (computeQuoteHash(quote) !== workflow.fingerprint || quote.chainId !== ledger.policy.chainId
      || quote.runner !== ledger.policy.wallet || quote.expiresAt >= Number(stable.timestamp)) {
      throw new AppError("Budget de clôture hors scope", 503);
    }
    if (await readLoan(loanKeyFor(quote.borrower, quote.loanId), quote)) continue;
    ledger.releaseUnusedWorkflow(workflow);
  }
}

export function assertQuoteDataset(quote: ComputeQuote, dataset: DatasetRef, receipt: string, borrower: string, loanId: string): void {
  if (quote.loanId !== loanId || quote.borrower !== borrower.toLowerCase() || quote.datasetId !== dataset.datasetId
    || quote.datasetReceiptHash !== keccak256(toHex(receipt)) || quote.datasetAmount !== dataset.priceUsdcAtomic
    || quote.challengeDays !== dataset.challengeDays || quote.modelId !== dataset.modelId || quote.modelVersion !== dataset.modelVersion) {
    throw new AppError("Devis compute hors scope", 409);
  }
}

export async function runnerComputeQuote(value: unknown, requireUnexpired = false, binding = evmEscrowBinding()): Promise<SignedComputeQuote> {
  const signed = await verifyComputeQuote(value, { ...binding, runner: settlementAccount().address }, requireUnexpired);
  const stored = requireBillingBudget().workflowPayload(quoteWorkflow(signed.quote).id);
  if (!stored || computeQuoteHash((JSON.parse(stored) as SignedComputeQuote).quote) !== computeQuoteHash(signed.quote)) {
    throw new AppError("Budget de clôture hors scope", 409);
  }
  return signed;
}

export async function prepareComputeQuote(input: {
  dataset: DatasetRef; datasetReceipt: string; borrower: string; provider: string;
  loanId: string; onChainDatasetId: Hex; hashlock: Hex; authorizationDeadline: number;
}): Promise<SignedComputeQuote> {
  const binding = evmEscrowBinding();
  const ledger = requireBillingBudget();
  const existing = ledger.workflowPayload(loanWorkflowId(input.loanId, input.borrower));
  if (existing) {
    const signed = await runnerComputeQuote(JSON.parse(existing), true);
    assertQuoteDataset(signed.quote, input.dataset, input.datasetReceipt, input.borrower, input.loanId);
    if (signed.quote.onChainDatasetId !== input.onChainDatasetId || signed.quote.hashlock !== input.hashlock
      || signed.quote.provider !== input.provider.toLowerCase()) throw new AppError("Devis compute hors scope", 409);
    return signed;
  }
  await reclaimExpiredUnpaidQuotes();
  const policy = billingPolicy();
  const token = usdcAddress();
  const decimals = await getPublicClient().readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  if (policy.chainId !== binding.chainId || policy.usdc !== token.toLowerCase() || policy.usdcDecimals !== Number(decimals)) {
    throw new AppError("Token ou précision du tarif incohérent", 503);
  }
  const profile = policy.profiles[input.dataset.modelId];
  const minimum = BigInt(policy.minimumComputeAmount);
  const configured = BigInt(profile.computeAmount);
  const expiresAt = Math.min(input.authorizationDeadline, Math.floor(Date.now() / 1000) + 300, Math.floor(policy.validUntil / 1000));
  if (expiresAt * 1000 < Date.now() + 60000) throw new AppError("Devis compute expiré", 409);
  const quote = parseComputeQuote({
    version: 7, ...binding, escrow: binding.escrow.toLowerCase(), usdc: token.toLowerCase(), usdcDecimals: Number(decimals),
    runner: settlementAccount().address.toLowerCase(), loanId: input.loanId, datasetId: input.dataset.datasetId,
    onChainDatasetId: input.onChainDatasetId, datasetReceiptHash: keccak256(toHex(input.datasetReceipt)),
    borrower: input.borrower.toLowerCase(), provider: input.provider.toLowerCase(), computeRecipient: policy.computeRecipient,
    datasetAmount: input.dataset.priceUsdcAtomic, computeAmount: String(configured > minimum ? configured : minimum),
    maxFailureFee: profile.maxFailureFee, executionRateAtomicPerMs: profile.executionRateAtomicPerMs,
    maxExecutionMs: profile.maxExecutionMs, maxDatasetBytes: MAX_DATASET_BYTES, hashlock: input.hashlock,
    challengeDays: input.dataset.challengeDays, modelId: input.dataset.modelId, modelVersion: input.dataset.modelVersion,
    tariffVersion: policy.tariffVersion, expiresAt, failurePolicy: "consumed-execution-only",
  });
  const signature = await settlementAccount().signTypedData(quoteAuthorizationTypedData(quote));
  const signed: SignedComputeQuote = { quote, authorization: { deadline: quote.expiresAt, signature } };
  const gasBalance = await getPublicClient().getBalance({ address: settlementAccount().address, blockTag: "pending" });
  ledger.reserveWorkflow(quoteWorkflow(quote), JSON.stringify(signed), (quote.expiresAt + quote.challengeDays * 86400) * 1000, gasBalance);
  return signed;
}
