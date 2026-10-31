import "server-only";
import { toHex, type Hex } from "viem";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/app-error";
import { addressesEqual } from "@/lib/evm/address";
import { getPublicClient } from "@/lib/evm/client";
import { readLoan, reconcileLoanEscrow } from "@/lib/evm/escrow";
import { assertLoanLockTransaction, loanEscrowBinding, trustedEscrowBinding, trustedEscrowBindings } from "@/lib/evm/history";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import type { Loan } from "@/generated/prisma/client";
import { modelSelection, trainingProfileHash } from "@/lib/models/registry";
import { assertBilledLock } from "@/lib/billing/loan";

/** Le hash absent en base n'est jamais une preuve d'absence d'escrow. */
export async function recoverUnsubmittedLoan(loan: Loan, options: { requireConfirmedLock?: boolean } = {}): Promise<void> {
  const client = getPublicClient();
  if (!loan.evmLoanKey) {
    if (options.requireConfirmedLock) throw new AppError("Emprunt EVM non préparé", 409);
    // prepareLoan ne retourne aucune transaction tant que la clé n'est pas persistée.
    await prisma.loan.updateMany({
      where: { id: loan.id, status: "PENDING", evmLoanKey: null, updatedAt: loan.updatedAt },
      data: { status: "CANCELLED" },
    });
    return;
  }
  if (loan.evmLoanKey !== loanKeyFor(loan.borrower, loan.id)) throw new AppError("Clé du prêt hors scope", 409);
  const transaction = loan.evmLockTxHash
    ? await client.getTransaction({ hash: loan.evmLockTxHash as Hex })
    : null;
  if (await client.getChainId() !== evmEscrowBinding().chainId) throw new AppError("RPC sur un autre réseau", 409);
  const bindings = loan.evmEscrowAddress || loan.runnerReceipt || loan.attestationPayload
    ? [loanEscrowBinding(loan)]
    : transaction?.to
      ? [trustedEscrowBinding({ chainId: evmEscrowBinding().chainId, escrow: transaction.to })]
      : trustedEscrowBindings();
  const states = await Promise.all(bindings.map(async (binding) => ({ binding, onChain: await readLoan(loan.evmLoanKey as Hex, binding) })));
  const matches = states.filter((state) => state.onChain);
  if (matches.length > 1) throw new AppError("Plusieurs locks pour ce prêt : réconciliation manuelle requise", 409);
  const { binding, onChain } = matches[0] ?? states[0];
  if (!onChain) {
    if (options.requireConfirmedLock) throw new AppError("Lock de paiement non confirmé", 409);
    // Une transaction encore dans le mempool reste SUBMITTING, jamais annulée.
    if (transaction) {
      const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
      if (receipt.status !== "reverted") throw new AppError("Lock non confirmé", 409);
    }
    if (loan.status === "CANCELLED") return;
    await prisma.loan.updateMany({
      where: { id: loan.id, status: loan.status, updatedAt: loan.updatedAt },
      // Sans preuve de lock, conserver l'absence de binding pour rechercher aussi
      // les transactions tardives sur tous les anciens contrats au prochain passage.
      data: { status: "CANCELLED" },
    });
    return;
  }
  if (!addressesEqual(onChain.borrower, loan.borrower) || !addressesEqual(onChain.provider, loan.provider)
    || onChain.amountUsdcAtomic !== loan.amountUsdcAtomic || onChain.hashlock !== loan.evmHashlock) {
    throw new AppError("Lock hors scope du prêt", 409);
  }
  assertBilledLock(loan, onChain);
  const dataset = await prisma.dataset.findUnique({ where: { id: loan.datasetId }, select: { evmDatasetId: true, evmMintBlock: true } });
  const model = modelSelection(loan.modelId, loan.modelVersion);
  if (!dataset?.evmDatasetId || !model || onChain.datasetId !== dataset.evmDatasetId
    || (onChain.trainingProfile !== `0x${"0".repeat(64)}` && onChain.trainingProfile !== trainingProfileHash(model))) {
    throw new AppError("Dataset ou profil du lock hors scope", 409);
  }
  let hash = transaction?.hash;
  if (!hash) {
    const startBlock = loan.evmPreparedBlock ?? dataset.evmMintBlock;
    if (!startBlock) throw new AppError("Bloc de préparation absent : récupère le hash du lock", 409);
    const tip = await client.getBlockNumber({ cacheTime: 0 });
    for (let from = BigInt(startBlock); from <= tip && !hash; from += BigInt(2_000)) {
      const to = from + BigInt(1_999) < tip ? from + BigInt(1_999) : tip;
      const logs = await client.request({
        method: "eth_getLogs",
        params: [{ address: binding.escrow as Hex, topics: [null, loan.evmLoanKey as Hex], fromBlock: toHex(from), toBlock: toHex(to) }],
      });
      hash = logs[0]?.transactionHash ?? undefined;
    }
  }
  if (!hash) throw new AppError("Transaction du lock introuvable", 409);
  const [receipt, lock] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    transaction ?? client.getTransaction({ hash }),
  ]);
  if (receipt.status !== "success") throw new AppError("Transaction du lock hors scope", 409);
  assertLoanLockTransaction(lock, { loanId: loan.id, borrower: loan.borrower, escrow: binding.escrow });
  const state = await reconcileLoanEscrow(loan.evmLoanKey as Hex, receipt.blockNumber, binding);
  const updated = await prisma.loan.updateMany({
    where: { id: loan.id, status: loan.status, updatedAt: loan.updatedAt },
    data: {
      evmChainId: binding.chainId,
      evmEscrowAddress: binding.escrow,
      evmLockTxHash: hash,
      evmLockBlock: receipt.blockNumber.toString(),
      evmDeadline: new Date(onChain.deadline * 1000),
      ...(state.state === "active" ? { status: "ESCROWED" as const }
        : state.state === "settled" ? { status: "SETTLED" as const, settleTxHash: state.txHash, settledAt: new Date() }
          : { status: "CANCELLED" as const, cancelTxHash: state.txHash,
            ...(state.retainedFee !== undefined ? { retainedFeeUsdcAtomic: state.retainedFee, refundAmountUsdcAtomic: state.refundAmount } : {}) }),
    },
  });
  if (updated.count !== 1) throw new AppError("Réconciliation concurrente du prêt : actualise son état", 409);
}
