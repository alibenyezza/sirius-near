export const PENDING_REAPER_TTL_MS = 10 * 60_000;
export const SUBMISSION_REAPER_LEASE_MS = 30_000;
export const TRAINING_REAPER_LEASE_MS = 90_000;
export const SETTLEMENT_REAPER_LEASE_MS = 90_000;
export const CHAIN_REAPER_LEASE_MS = 90_000;
/**
 * Durée pendant laquelle un prêt annulé sans hash de lock est encore recherché on-chain.
 * L'autorisation de lock expire avant createdAt + PENDING_REAPER_TTL_MS (lock-policy.ts) et le
 * contrat refuse tout lock après cette échéance : 24 h couvrent largement la finalité mainnet.
 */
export const CANCELLED_LOCK_SEARCH_WINDOW_MS = 24 * 60 * 60_000;
/**
 * Délai avant de revérifier, sous le bloc finalisé, un release accepté au palier rapide
 * (fast-settlement-review.ts) : le bloc `finalized` traîne un quart d'heure derrière la tête sur
 * Robinhood Chain, repasser plus tôt ne ferait que lire « pas encore ».
 */
export const FAST_SETTLEMENT_VERIFY_DELAY_MS = 15 * 60_000;
/**
 * Un prêt ESCROWED classé rapide (entraînement échoué puis rendu, lancement jamais repris) pèse sur
 * le plafond rapide sans rien faire : au-delà de ce délai sans activité, le reaper le ramène à la
 * finalité complète ; il repassera en rapide au prochain lancement si le plafond le permet.
 */
export const FAST_IDLE_REVERT_MS = 10 * 60_000;

export type LoanReaperAction =
  | "cancel-pending"
  | "reconcile-submission"
  | "reset-training"
  | "reconcile-chain";

export interface LoanReaperSnapshot {
  status: "PENDING" | "SUBMITTING" | "ESCROWED" | "TRAINING" | "SETTLING" | "SETTLED" | "CANCELLED";
  createdAt: Date;
  updatedAt: Date;
  evmDeadline: Date | null;
  modelCid: string | null;
}

export function loanReaperAction(
  loan: LoanReaperSnapshot,
  now: Date,
): LoanReaperAction | null {
  const age = now.getTime() - loan.updatedAt.getTime();
  if (loan.status === "PENDING") {
    return now.getTime() - loan.createdAt.getTime() >= PENDING_REAPER_TTL_MS
      ? "cancel-pending"
      : null;
  }
  if (loan.status === "SUBMITTING") {
    return age >= SUBMISSION_REAPER_LEASE_MS ? "reconcile-submission" : null;
  }
  if (
    (loan.status === "ESCROWED" || loan.status === "TRAINING" || loan.status === "SETTLING") &&
    loan.evmDeadline &&
    loan.evmDeadline.getTime() <= now.getTime() &&
    age >= CHAIN_REAPER_LEASE_MS
  ) {
    return "reconcile-chain";
  }
  if (loan.status === "TRAINING" && !loan.modelCid && age >= TRAINING_REAPER_LEASE_MS) {
    return "reset-training";
  }
  if (loan.status === "SETTLING" && age >= SETTLEMENT_REAPER_LEASE_MS) {
    return "reconcile-chain";
  }
  return null;
}
