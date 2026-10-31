import { AppError } from "@/lib/app-error";
import { type Hex, keccak256, parseTransaction } from "viem";
import type { BudgetLedger, WorkflowBudget } from "./budget-ledger";
import { RunnerFinalityPending, RunnerRetryLater } from "./failure-policy";

export interface BudgetedTransactionIO {
  prepare(): Promise<{ serialized: Hex; nonce: number }>;
  send(serialized: Hex): Promise<Hex>;
  confirm(hash: Hex): Promise<"success" | "reverted" | "pending">;
  seal?(serialized: Hex): string;
  /** Nonce `latest` du wallet : au-delà du nonce réservé, celui-ci est déjà consommé. */
  latestNonce?(): Promise<number>;
  /** Re-signe la transaction donnée : même cible, mêmes données, même nonce, frais à jour. */
  resign?(serialized: Hex): Promise<Hex>;
}

export type SendFailure = "fee-too-low" | "nonce-consumed" | "already-known" | "unknown";

/** Classe une erreur de diffusion à partir du message RPC, sans jamais le journaliser. */
export function classifySendError(error: unknown): SendFailure {
  const text = error instanceof Error ? `${error.message} ${(error as { details?: unknown }).details ?? ""}` : String(error);
  if (/max fee per gas less than block base fee|fee cap less than block base fee|transaction underpriced|feecap|replacement transaction underpriced/i.test(text)) {
    return "fee-too-low";
  }
  if (/nonce too low|nonce has already been used/i.test(text)) return "nonce-consumed";
  if (/already known|known transaction/i.test(text)) return "already-known";
  return "unknown";
}

/**
 * Le séquenceur a refusé la transaction pour des frais trop bas : elle n'est dans aucun
 * mempool. Tant que son nonce n'est pas consommé, on la re-signe au même nonce avec des
 * frais à jour et on remplace le hash durable avant de la diffuser. Renvoie le nouveau
 * hash, ou null si le remplacement n'est pas prouvé sûr.
 */
export async function replaceUnderpricedTransaction(
  ledger: BudgetLedger,
  id: string,
  fingerprint: string,
  nonce: number,
  serialized: Hex,
  io: Pick<BudgetedTransactionIO, "latestNonce" | "resign" | "seal" | "send">,
): Promise<Hex | null> {
  if (!io.latestNonce || !io.resign || !io.seal) return null;
  if (await io.latestNonce() > nonce) return null;
  const next = await io.resign(serialized);
  const original = parseTransaction(serialized);
  const replacement = parseTransaction(next);
  if (replacement.nonce !== nonce || original.nonce !== nonce || replacement.chainId !== original.chainId
    || replacement.to?.toLowerCase() !== original.to?.toLowerCase() || replacement.data !== original.data
    || (replacement.value ?? BigInt(0)) !== BigInt(0)) {
    throw new AppError("Remplacement de transaction runner invalide", 409);
  }
  const hash = keccak256(next);
  ledger.replaceTransaction(id, fingerprint, hash, nonce, io.seal(next), "runner-auto", "frais refusés par le séquenceur");
  console.warn(`[runner] transaction ${id} re-signée au nonce ${nonce} avec des frais à jour`);
  try { await io.send(next); }
  catch (error) { console.warn(`[runner] diffusion du remplacement refusée (${classifySendError(error)})`); }
  return hash;
}

export async function sendBudgetedTransaction(
  ledger: BudgetLedger,
  id: string,
  fingerprint: string,
  io: BudgetedTransactionIO,
  workflow?: WorkflowBudget,
): Promise<Hex> {
  const { fresh, operation } = ledger.reserve(id, fingerprint, "transaction", workflow);
  if (operation.state === "succeeded" && operation.txHash) return operation.txHash as Hex;
  if (operation.state === "failed") throw new AppError("Tentative de règlement épuisée", 503);
  let hash = operation.txHash as Hex | null;
  if (fresh) {
    let prepared;
    try {
      prepared = await io.prepare();
    } catch {
      // Rien n'est signé : la réservation est rendue. Un timeout RPC, un pic de gas ou un
      // solde ETH trop bas ne doivent pas rendre le prêt irréglable, puisque le préimage ne
      // quitte jamais l'enclave et que personne d'autre ne peut régler à sa place.
      ledger.releaseReservation(id, fingerprint);
      throw new RunnerRetryLater("Règlement refusé avant signature : nouvelle tentative possible (vérifier ETH, gas et RPC)");
    }
    hash = keccak256(prepared.serialized);
    // Le hash signé et le nonce sont durables AVANT le premier appel d’envoi RPC.
    try {
      ledger.recordTransaction(id, fingerprint, hash, prepared.nonce, io.seal?.(prepared.serialized));
    } catch (error) {
      ledger.failUnsentTransaction(id, fingerprint);
      throw error;
    }
    try {
      const receivedHash = await io.send(prepared.serialized);
      if (receivedHash.toLowerCase() !== hash) throw new Error("RPC hash mismatch");
    } catch (error) {
      // Un timeout ne prouve pas l’absence de diffusion ; seule la confirmation clôt
      // l’intention. Un refus explicite pour frais trop bas, lui, prouve que la transaction
      // n’est nulle part : elle est re-signée au même nonce plutôt que figée.
      const failure = classifySendError(error);
      console.warn(`[runner] diffusion de ${id} refusée (${failure})`);
      if (failure === "fee-too-low") {
        try { hash = await replaceUnderpricedTransaction(ledger, id, fingerprint, prepared.nonce, prepared.serialized, io) ?? hash; }
        catch { console.warn(`[runner] remplacement de ${id} impossible : réconciliation requise`); }
      }
    }
  }
  if (!hash) throw new AppError("Intention runner interrompue : réconciliation manuelle requise", 503);
  let status: "success" | "reverted" | "pending" = "pending";
  try { status = await io.confirm(hash); } catch { /* L’engagement reste réservé. */ }
  // Hash durable, reçu pas encore finalisé : la tentative suivante reprend CETTE transaction,
  // sans nouveau nonce. Ni échec compté, ni crédit de requête consommé.
  if (status === "pending") throw new RunnerFinalityPending(hash);
  ledger.finish(id, fingerprint, status === "success");
  if (status === "reverted") throw new AppError("Règlement on-chain rejeté : aucune relance automatique", 502);
  return hash;
}
