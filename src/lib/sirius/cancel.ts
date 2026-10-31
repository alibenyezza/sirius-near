import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual } from "@/lib/evm/address";
import { readLoan, reconcileLoanEscrow } from "@/lib/evm/escrow";
import { resolveLoanEscrow, escrowReadAddress } from "@/lib/evm/history";
import { refundEscrowTransaction } from "@/lib/evm/transaction";

const ACTIVE = ["ESCROWED", "TRAINING", "SETTLING"] as const;

export async function cancelExpiredLoan(loanId: string, borrower: string) {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan || !addressesEqual(loan.borrower, borrower)) throw new AppError("Loan introuvable", 404);
  if (loan.status === "CANCELLED" && loan.cancelTxHash) return { loanId, status: loan.status, cancelTxHash: loan.cancelTxHash };
  if (loan.status === "SETTLED") throw new AppError("Escrow déjà réglé", 409);
  if (!(ACTIVE as readonly string[]).includes(loan.status) || !loan.evmLoanKey) throw new AppError("Escrow non remboursable", 409);

  const binding = await resolveLoanEscrow(loan);
  const onChain = await readLoan(loan.evmLoanKey as `0x${string}`, binding);
  if (!onChain || (onChain.status === 1 && onChain.deadline * 1000 > Date.now())) throw new AppError("Échéance de l’escrow non atteinte", 409);
  if (!addressesEqual(onChain.borrower, borrower) || !addressesEqual(onChain.provider, loan.provider)
    || onChain.amountUsdcAtomic !== loan.amountUsdcAtomic) throw new AppError("Escrow hors scope", 409);
  if (!loan.evmLockBlock) throw new AppError("Bloc de lock de paiement absent", 409);
  const lockBlock = BigInt(loan.evmLockBlock);
  const resolution = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, lockBlock, binding);
  if (resolution.state === "settled") throw new AppError("Escrow déjà réglé", 409);
  if (resolution.state === "active") {
    return { loanId, transaction: refundEscrowTransaction(loan.evmLoanKey as `0x${string}`, escrowReadAddress(binding)) };
  }
  const txHash = resolution.txHash;
  await prisma.loan.updateMany({
    where: { id: loanId, borrower: loan.borrower, status: { in: [...ACTIVE] } },
    data: { status: "CANCELLED", cancelTxHash: txHash,
      ...(resolution.retainedFee !== undefined ? { retainedFeeUsdcAtomic: resolution.retainedFee, refundAmountUsdcAtomic: resolution.refundAmount } : {}) },
  });
  return { loanId, status: "CANCELLED", cancelTxHash: txHash };
}
