import "server-only";
import { createWalletClient, encodeFunctionData, http, keccak256, toHex, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { getPublicClient } from "@/lib/evm/client";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { settlementAccount } from "@/lib/evm/runner-account";
import { readLoan, reconcileLoanEscrow } from "@/lib/evm/escrow";
import { siriusescrowv7Abi } from "@/lib/evm/abi/siriusescrowv7";
import { boundedGas, lowGasBalanceAlert } from "@/lib/runner/gas-policy";
import { sendBudgetedTransaction } from "@/lib/runner/budget-transaction";
import { reconcileRunnerTransactions } from "@/lib/runner/transaction-recovery";
import { sealRunnerTransaction } from "@/lib/runner/transaction-journal";
import { resignWithFreshFees } from "@/lib/runner/fee-replacement";
import { assertCanonicalReceipt } from "@/lib/evm/finality";
import type { FinalityTier } from "@/lib/evm/fast-finality";
import { releasesReservation } from "@/lib/runner/failure-policy";
import { quoteWorkflow, requireBillingBudget } from "./runner";
import { executionReceiptTypedData, failureFee, quoteTermsHash, type ComputeQuote } from "./quote";

/**
 * `finalityTier` : profondeur à laquelle le reçu vaut confirmation. `FULL` (défaut, et toujours pour
 * un remboursement) attend le bloc finalisé ; `FAST`, déjà arbitré par l'enclave pour un petit prêt,
 * se contente des confirmations rapides avec contrôle du hash canonique. Avant cette profondeur, la
 * transaction reste « pending » : hash durable, reprise plus tard, aucun échec compté.
 */
async function sendBilledAction(quote: ComputeQuote, loanKey: Hex, kind: "release" | "failure", data: Hex, finalityTier: FinalityTier = "FULL"): Promise<string> {
  const ledger = requireBillingBudget();
  const account = settlementAccount();
  const client = getPublicClient();
  const { chain, rpcUrl } = resolveServerNetwork();
  if (chain.id !== quote.chainId || account.address.toLowerCase() !== quote.runner) throw new AppError("Devis compute hors scope", 409);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 0, timeout: 20000 }) });
  const send = (serializedTransaction: Hex) => wallet.sendRawTransaction({ serializedTransaction });
  const resign = (serialized: Hex) => resignWithFreshFees(serialized, account, client, ledger.policy.gas);
  await reconcileRunnerTransactions(ledger, client, quote.chainId, account.address, send, resign);
  const id = `${kind}:${quote.chainId}:${quote.escrow}:${loanKey}`;
  const fingerprint = keccak256(data);
  return sendBudgetedTransaction(ledger, id, fingerprint, {
    seal: (serialized) => sealRunnerTransaction(id, fingerprint, serialized),
    async prepare() {
      if (await client.getChainId() !== quote.chainId) throw new AppError("RPC sur un autre réseau", 409);
      const [estimate, price, balance, nonce] = await Promise.all([
        client.estimateGas({ account, to: quote.escrow, data, value: BigInt(0) }), client.getGasPrice(),
        client.getBalance({ address: account.address, blockTag: "pending" }),
        client.getTransactionCount({ address: account.address, blockTag: "pending" }),
      ]);
      lowGasBalanceAlert(ledger.policy.gas, balance, account.address);
      const fees = boundedGas(ledger.policy.gas, estimate, price, balance);
      return { nonce, serialized: await account.signTransaction({
        chainId: quote.chainId, to: quote.escrow, data, value: BigInt(0), nonce, ...fees,
        type: "eip1559", maxPriorityFeePerGas: BigInt(0),
      }) };
    },
    send,
    resign,
    latestNonce: () => client.getTransactionCount({ address: account.address, blockTag: "latest" }),
    async confirm(hash) {
      if (await client.getChainId() !== quote.chainId) return "pending";
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: ledger.policy.gas.confirmations, timeout: 15000, retryCount: 0 });
      if (receipt.transactionHash.toLowerCase() !== hash || receipt.from.toLowerCase() !== quote.runner
        || receipt.to?.toLowerCase() !== quote.escrow) return "pending";
      await assertCanonicalReceipt(client, receipt, ledger.policy.gas.confirmations, finalityTier);
      return receipt.status;
    },
  }, quoteWorkflow(quote));
}

export async function settleBilledEscrow(quote: ComputeQuote, loanKey: Hex, preimage: Hex, fromBlock: bigint, finalityTier: FinalityTier = "FULL"): Promise<string> {
  const ledger = requireBillingBudget();
  const data = encodeFunctionData({ abi: siriusescrowv7Abi, functionName: "release", args: [loanKey, preimage] });
  if (!ledger.find(`release:${quote.chainId}:${quote.escrow}:${loanKey}`, keccak256(data))) {
    const resolution = await reconcileLoanEscrow(loanKey, fromBlock, quote);
    if (resolution.state !== "active") ledger.releaseFastExposure(quoteWorkflow(quote));
    if (resolution.state === "settled") return resolution.txHash;
    if (resolution.state === "cancelled") throw new AppError("Escrow on-chain déjà remboursé", 410);
  }
  const loan = await readLoan(loanKey, quote);
  if (loan?.billing?.termsHash !== quoteTermsHash(quote)) throw new AppError("Devis compute hors scope", 409);
  let txHash: string;
  try {
    txHash = await sendBilledAction(quote, loanKey, "release", data, finalityTier);
  } catch (error) {
    // Échec définitif du règlement (release rejeté, tentative épuisée) : le prêt ne sera plus libéré
    // par l'enclave, sa part ne pèse plus sur le plafond rapide. Une attente de finalité ou un refus
    // avant signature ne sont pas définitifs : la part reste réservée.
    if (!releasesReservation(error)) ledger.releaseFastExposure(quoteWorkflow(quote));
    throw error;
  }
  // Release confirmé au palier demandé : ce prêt ne pèse plus sur le plafond rapide de l'enclave.
  ledger.releaseFastExposure(quoteWorkflow(quote));
  return txHash;
}

export async function failBilledEscrow(quote: ComputeQuote, loanKey: Hex): Promise<{ refundTxHash: string; retainedFee: string }> {
  const ledger = requireBillingBudget();
  const evidence = ledger.executionEvidence(quoteWorkflow(quote));
  if (!evidence) throw new AppError("Consommation incertaine : remboursement à échéance", 503);
  const measurement = JSON.parse(evidence) as { elapsedMs: number; success: boolean };
  if (measurement.success) throw new AppError("Résultat produit : reprendre le règlement", 409);
  const loan = await readLoan(loanKey, quote);
  if (!loan?.billing || loan.billing.termsHash !== quoteTermsHash(quote)) throw new AppError("Devis compute hors scope", 409);
  const retainedFee = failureFee(quote, measurement.elapsedMs);
  const block = await getPublicClient().getBlock();
  const fixed = JSON.parse(ledger.fixFailureReceipt(quoteWorkflow(quote), JSON.stringify({
    consumedCompute: retainedFee, evidenceHash: keccak256(toHex(evidence)),
    observedAt: Number(block.timestamp),
    finalFailure: true,
  }))) as { consumedCompute: string; evidenceHash: Hex; observedAt: number; finalFailure: boolean };
  const receipt = { ...fixed, consumedCompute: BigInt(fixed.consumedCompute) };
  const signature = await settlementAccount().signTypedData(executionReceiptTypedData(quote, loanKey, receipt));
  const data = encodeFunctionData({ abi: siriusescrowv7Abi, functionName: "recordExecution", args: [loanKey, receipt, signature] });
  const refundTxHash = await sendBilledAction(quote, loanKey, "failure", data);
  // Remboursement confirmé : la part de ce prêt dans le plafond rapide de l'enclave est rendue.
  ledger.releaseFastExposure(quoteWorkflow(quote));
  return { refundTxHash, retainedFee };
}
