import "server-only";
import { TransactionReceiptNotFoundError, type Hex, type PublicClient } from "viem";
import { confirmedBlock } from "@/lib/evm/finality";

/**
 * Revérification, à finalité complète, d'un release accepté au palier rapide (fast-finality.ts).
 *
 * Un prêt FAST est marqué SETTLED après N confirmations L2 : le modèle est livrable tout de suite.
 * Le reaper repasse ensuite, une fois le bloc finalisé censé avoir dépassé le release
 * (`FAST_SETTLEMENT_VERIFY_DELAY_MS` après `settledAt`), et rend un verdict :
 *  - `pending` : le bloc finalisé n'a pas encore atteint le bloc du reçu, on repassera ;
 *  - `confirmed` : reçu dans un bloc canonique sous le bloc finalisé, escrow libéré on-chain ;
 *  - `discrepancy` : le release a disparu (réorganisation), son bloc n'est plus canonique, l'escrow
 *    n'est pas libéré, ou l'a été par une autre transaction. Le reaper journalise alors une alerte,
 *    pose `finalityReview` sur le prêt (livraison de clé et certificat suspendus) et laisse la
 *    décision à un opérateur (docs/passage-mainnet/20-finalite-rapide.md) : rien n'est retenté
 *    automatiquement, le modèle peut déjà avoir été livré.
 *
 * Aucune transaction n'est envoyée ; les lectures sont toutes au palier complet.
 */

export const ESCROW_STATUS_LOCKED = 1;
export const ESCROW_STATUS_RELEASED = 2;

export type FastSettlementVerdict =
  | { state: "pending" }
  | { state: "confirmed" }
  | { state: "discrepancy"; reason: string };

export interface FastSettlementInput {
  settleTxHash: Hex;
  /** Adresse de l'escrow du prêt, en minuscules. */
  escrow: string;
  /** Statut on-chain courant du prêt (`getLoan().status`), `null` si inconnu du contrat. */
  onChainStatus: () => Promise<number | null>;
}

export async function verifyFastSettlement(client: PublicClient, input: FastSettlementInput): Promise<FastSettlementVerdict> {
  let receipt: { blockNumber: bigint; blockHash: Hex; status: string; to: string | null } | null;
  try {
    receipt = await client.getTransactionReceipt({ hash: input.settleTxHash });
  } catch (error) {
    // Seul « reçu inconnu » vaut absence. Toute autre erreur RPC (réseau, nœud, autre chaîne)
    // remonte à l'appelant : comptée dans la passe et retentée, jamais convertie en divergence.
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    receipt = null;
  }
  if (!receipt) {
    const status = await input.onChainStatus();
    if (status === ESCROW_STATUS_RELEASED) return { state: "discrepancy", reason: "release introuvable mais escrow libéré par une autre transaction" };
    if (status === ESCROW_STATUS_LOCKED) return { state: "discrepancy", reason: "release disparu après réorganisation : escrow encore verrouillé" };
    return { state: "discrepancy", reason: `release introuvable et état on-chain inattendu (${status ?? "inconnu"})` };
  }
  if (receipt.to?.toLowerCase() !== input.escrow.toLowerCase() || receipt.status !== "success") {
    return { state: "discrepancy", reason: "reçu du release hors scope ou rejeté" };
  }
  const [canonical, stable] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), confirmedBlock(client)]);
  if (stable.number === null || stable.number < receipt.blockNumber) return { state: "pending" };
  if (!canonical.hash || canonical.hash !== receipt.blockHash) {
    return { state: "discrepancy", reason: "bloc du release réorganisé après le règlement rapide" };
  }
  const status = await input.onChainStatus();
  if (status !== ESCROW_STATUS_RELEASED) {
    return { state: "discrepancy", reason: `release finalisé mais escrow non libéré on-chain (${status ?? "inconnu"})` };
  }
  return { state: "confirmed" };
}
