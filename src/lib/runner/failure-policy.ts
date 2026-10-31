import { AppError } from "@/lib/app-error";

/**
 * Transaction signée et diffusée, dont le reçu n'est pas encore finalisé. Ce n'est pas un
 * échec : sur mainnet, la finalité L1 prend de quinze minutes à plus d'une heure. Le hash
 * est durable dans le registre, et la tentative suivante reprend la même transaction.
 */
export class RunnerFinalityPending extends AppError {
  constructor(readonly transactionHash: string) {
    super("Transaction envoyée, en attente de finalité du réseau", 202);
    this.name = "RunnerFinalityPending";
  }
}

/**
 * Refus survenu avant toute signature (RPC indisponible, gas au-dessus du plafond, ETH
 * insuffisant). Rien n'a été engagé : la réservation est rendue et une nouvelle tentative
 * repart de zéro.
 */
export class RunnerRetryLater extends AppError {
  constructor(message: string) {
    super(message, 503);
    this.name = "RunnerRetryLater";
  }
}

/** Ni l'attente de finalité ni un refus avant signature ne doivent consommer de crédit. */
export function releasesReservation(error: unknown): boolean {
  return error instanceof RunnerFinalityPending || error instanceof RunnerRetryLater;
}

/**
 * Le coupe-circuit financier protège la plateforme d'une panne de SON côté. Une erreur
 * imputable à l'appelant (4xx : requête invalide, grant refusé, dataset inexploitable, devis
 * hors scope) ne dit rien de la santé du runner : la compter permettrait à n'importe quel
 * utilisateur de fermer la plateforme à tous en trois requêtes.
 */
export function countsAsRunnerFailure(error: unknown): boolean {
  if (releasesReservation(error)) return false;
  return !(error instanceof AppError && error.status >= 400 && error.status < 500);
}
