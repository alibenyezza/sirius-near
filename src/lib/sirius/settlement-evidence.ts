import "server-only";
import type { Hex, PublicClient } from "viem";
import { prisma } from "@/lib/db";
import { getPublicClient } from "@/lib/evm/client";
import { publishedPreimage } from "@/lib/evm/escrow";
import { loanEscrowBinding } from "@/lib/evm/history";
import { serializeSignedTransaction, type SignedTransactionFields } from "@/lib/evm/signed-transaction";

/**
 * Preuves de rediffusion d'un release accepté au palier rapide (fast-finality.ts).
 *
 * Si une réorganisation efface un release déjà compté comme réglé, le registre du runner le tient
 * pour réussi et ne le renverra pas seul. Pour qu'un opérateur puisse le rejouer sans ouvrir
 * l'enclave, Next conserve, dès le passage en SETTLED d'un prêt rapide :
 *  - la transaction signée brute, reconstituée depuis le RPC (`eth_getTransactionByHash` rend les
 *    champs et la signature v/r/s) : `eth_sendRawTransaction` la rediffuse telle quelle tant que son
 *    nonce n'est pas consommé ;
 *  - le préimage, public dès le release (`preimageOf`) : `release(loanKey, preimage)` est sans
 *    permission dans SiriusEscrowV7, n'importe quel wallet peut le rejouer avant l'échéance.
 * Capture au mieux : une panne ici ne doit jamais faire échouer un règlement déjà confirmé ; la
 * revérification du reaper redit de toute façon si les preuves ont servi (runbook 20).
 */

export interface SettlementEvidence {
  settleRawTx: Hex;
  settlePreimage: Hex;
}

export async function collectSettlementEvidence(
  client: PublicClient,
  loan: { evmLoanKey: string; settleTxHash: string; evmChainId?: number | null; evmEscrowAddress?: string | null; runnerReceipt?: string | null; attestationPayload?: string | null },
): Promise<SettlementEvidence> {
  const [transaction, settlePreimage] = await Promise.all([
    client.getTransaction({ hash: loan.settleTxHash as Hex }),
    publishedPreimage(loan.evmLoanKey as Hex, loanEscrowBinding(loan)),
  ]);
  return { settleRawTx: serializeSignedTransaction(transaction as unknown as SignedTransactionFields), settlePreimage };
}

/**
 * Persiste les preuves sur un prêt rapide tout juste SETTLED. Jamais bloquant : l'erreur est
 * journalisée par sa classe, sans hash ni identifiant sensible, et le reaper n'en dépend pas.
 */
export async function recordSettlementEvidence(loanId: string, client: PublicClient = getPublicClient()): Promise<boolean> {
  try {
    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      select: { status: true, finalityTier: true, evmLoanKey: true, settleTxHash: true, settleRawTx: true, evmChainId: true, evmEscrowAddress: true, runnerReceipt: true, attestationPayload: true },
    });
    if (!loan || loan.status !== "SETTLED" || loan.finalityTier !== "FAST" || !loan.evmLoanKey || !loan.settleTxHash || loan.settleRawTx) return false;
    const evidence = await collectSettlementEvidence(client, { ...loan, evmLoanKey: loan.evmLoanKey, settleTxHash: loan.settleTxHash });
    const saved = await prisma.loan.updateMany({ where: { id: loanId, status: "SETTLED", settleTxHash: loan.settleTxHash, settleRawTx: null }, data: evidence });
    return saved.count === 1;
  } catch (error) {
    console.error(`[settle] preuves de rediffusion non enregistrées (${error instanceof Error ? error.name : typeof error})`);
    return false;
  }
}
