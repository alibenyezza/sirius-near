import "server-only";
import { AppError } from "@/lib/app-error";
import { getPublicClient } from "@/lib/evm/client";
import { siriusescrowv7Abi } from "@/lib/evm/abi/siriusescrowv7";
import type { OnChainLoan } from "@/lib/evm/escrow";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { usdcAddress } from "@/lib/evm/addresses";
import { computeQuoteHash, quoteTermsHash, totalQuoteAmount, verifyComputeQuote, type SignedComputeQuote } from "./quote";

export async function verifyPreparedComputeQuote(value: unknown): Promise<SignedComputeQuote> {
  const binding = evmEscrowBinding();
  const runner = await getPublicClient().readContract({ address: binding.escrow as `0x${string}`, abi: siriusescrowv7Abi, functionName: "lockAuthorizer" });
  const signed = await verifyComputeQuote(value, { ...binding, runner }, true);
  if (signed.quote.usdc !== usdcAddress().toLowerCase()) throw new AppError("Token ou précision du tarif incohérent", 503);
  return signed;
}

export function loanBillingQuote(loan: {
  id: string; borrower: string; provider: string; datasetId: string; amountUsdcAtomic: string;
  billingQuote?: string | null; billingQuoteHash?: string | null; evmHashlock?: string | null;
}): SignedComputeQuote | undefined {
  if (!loan.billingQuote) {
    if (loan.billingQuoteHash) throw new AppError("Devis compute absent du prêt", 409);
    return undefined;
  }
  let signed: SignedComputeQuote;
  try { signed = JSON.parse(loan.billingQuote) as SignedComputeQuote; }
  catch { throw new AppError("Devis compute invalide", 409); }
  const q = signed.quote;
  if (computeQuoteHash(q) !== loan.billingQuoteHash || q.loanId !== loan.id || q.borrower !== loan.borrower
    || q.provider !== loan.provider || q.datasetId !== loan.datasetId || q.hashlock !== loan.evmHashlock
    || totalQuoteAmount(q) !== loan.amountUsdcAtomic) throw new AppError("Devis compute hors scope", 409);
  return signed;
}

export function assertBilledLock(loan: Parameters<typeof loanBillingQuote>[0], onChain: OnChainLoan): void {
  const signed = loanBillingQuote(loan);
  if (Boolean(signed) !== Boolean(onChain.billing)
    || (signed && onChain.billing?.termsHash !== quoteTermsHash(signed.quote))) throw new AppError("Lock de paiement hors scope de l’emprunt", 409);
}
