import { addressesEqual } from "@/lib/evm/address";

/**
 * Logique d'affichage de la page Train pour les emprunts (docs/passage-mainnet/09-train-et-certificat.md,
 * « Avant le 6 »). Fonctions pures : aucune décision d'argent ne se prend ici. Le serveur reste
 * l'autorité (`POST /api/loans/[id]/cancel` vérifie l'emprunteur, l'échéance et l'état on-chain) ;
 * ces règles ne décident que de ce que l'interface propose, et penchent toujours vers « ne rien
 * proposer » en cas de doute.
 */

export type LoanStatus = "PENDING" | "SUBMITTING" | "ESCROWED" | "TRAINING" | "SETTLING" | "SETTLED" | "CANCELLED";

/** Champs de la réponse `GET /api/loans` utiles à l'affichage. */
export interface LoanDisplayInput {
  id: string;
  datasetId: string;
  /** Adresse de l'emprunteur. `GET /api/loans` renvoie aussi les prêts où l'on est fournisseur. */
  borrower?: string | null;
  status: string;
  evmLockTxHash?: string | null;
  evmLoanKey?: string | null;
  settleTxHash?: string | null;
  cancelTxHash?: string | null;
  modelCid?: string | null;
  runnerReceipt?: string | null;
  /** Calculé par le serveur : prêt actif dont l'échéance est dépassée. */
  refundable?: boolean;
  /** Lu sur `GET /api/loans/[id]/finality` : lock pas encore sous le bloc stable, lancement refusé. */
  lockFinalityPending?: boolean;
}

export const LOAN_DISPLAY_STATES = [
  "awaiting-finality",
  "in-progress",
  "completed",
  "failed",
  "refunded",
  "unknown",
] as const;

export type LoanDisplayState = (typeof LOAN_DISPLAY_STATES)[number];

/** Statuts pendant lesquels des fonds sont engagés et le prêt n'est pas terminé. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"]);

/** Statuts où l'escrow est verrouillé on-chain et peut être remboursé après l'échéance. */
const ESCROWED_STATUSES: ReadonlySet<string> = new Set(["ESCROWED", "TRAINING", "SETTLING"]);

function addressesEqualSafe(left: string, right: string): boolean {
  try {
    return addressesEqual(left, right);
  } catch {
    return false;
  }
}

function isBorrower(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return (
    typeof loan.borrower === "string" &&
    typeof viewer === "string" &&
    viewer !== "" &&
    addressesEqualSafe(loan.borrower, viewer)
  );
}

/**
 * Échu sans règlement soumis : escrow verrouillé, échéance dépassée selon le serveur, aucun
 * `release` envoyé (`settleTxHash` vide) et pas déjà remboursé (`cancelTxHash` vide). Après
 * l'échéance, le contrat refuse tout `release` (`ChallengePeriodElapsed`, audit A-05 et A-10) :
 * le règlement est devenu impossible, quels que soient `modelCid` et `runnerReceipt`, et seul
 * `refund()` libère les fonds. Un `settleTxHash` présent signifie un release déjà diffusé avant
 * l'échéance, qui peut être miné : on ne propose alors que la réconciliation, jamais le remboursement.
 */
export function isOverdueUnsettled(loan: LoanDisplayInput): boolean {
  return (
    ESCROWED_STATUSES.has(loan.status) &&
    loan.refundable === true &&
    !loan.settleTxHash &&
    !loan.cancelTxHash &&
    Boolean(loan.evmLoanKey)
  );
}

/** Échec sans modèle livré : échu, sans capsule préparée (`modelCid` vide). */
export function isFailedWithoutModel(loan: LoanDisplayInput): boolean {
  return isOverdueUnsettled(loan) && !loan.modelCid;
}

/**
 * Échu avec une capsule de modèle (avec ou sans reçu enclave) dont le règlement ne peut plus être
 * finalisé. Aucun modèle n'a été livré (`settleTxHash` vide, clé jamais libérée) : sans secours, les
 * fonds resteraient bloqués, le remboursement est donc proposé.
 */
export function isOverdueWithCapsule(loan: LoanDisplayInput): boolean {
  return isOverdueUnsettled(loan) && Boolean(loan.modelCid);
}

/**
 * État lisible d'un emprunt.
 *  - `awaiting-finality` : paiement envoyé mais pas finalisé (verrouillage SUBMITTING, ou PENDING avec
 *    un hash de lock, lock ESCROWED pas encore sous le bloc stable, ou règlement SETTLING en cours
 *    de confirmation) ;
 *  - `in-progress` : emprunt en préparation (PENDING sans paiement envoyé : devis refusé ou approbation
 *    en cours), ou fonds verrouillés, entraînement à lancer ou en cours ;
 *  - `completed` : règlement validé, modèle livrable ;
 *  - `failed` : abandonné avant le verrouillage (CANCELLED sans remboursement), ou échéance dépassée
 *    sans modèle ;
 *  - `refunded` : remboursement confirmé on-chain.
 */
export function loanDisplayState(loan: LoanDisplayInput): LoanDisplayState {
  switch (loan.status) {
    case "SETTLED":
      return "completed";
    case "CANCELLED":
      return loan.cancelTxHash ? "refunded" : "failed";
    case "PENDING":
      // `borrowDataset` crée le prêt avant le devis : sans hash de lock, rien n'a été payé.
      return loan.evmLockTxHash ? "awaiting-finality" : "in-progress";
    case "SUBMITTING":
      return "awaiting-finality";
    case "ESCROWED":
    case "TRAINING":
    case "SETTLING":
      if (isOverdueUnsettled(loan)) return "failed";
      if (loan.status === "ESCROWED" && loan.lockFinalityPending === true) return "awaiting-finality";
      return loan.status === "SETTLING" ? "awaiting-finality" : "in-progress";
    default:
      return "unknown";
  }
}

/**
 * « Ré-entraîner » : seulement sur un emprunt terminé et réglé, par son emprunteur. Un fournisseur
 * qui voit le prêt de quelqu'un d'autre ne l'obtient pas ; un prêt remboursé ou échoué non plus.
 */
export function canRetrain(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return (
    loan.status === "SETTLED" &&
    Boolean(loan.settleTxHash) &&
    !loan.cancelTxHash &&
    Boolean(loan.datasetId) &&
    isBorrower(loan, viewer)
  );
}

/**
 * « Rembourser » : prêt échu dont aucun release n'a été diffusé (échec sans modèle, ou capsule
 * préparée que le contrat ne laisse plus régler), par son emprunteur. Jamais sur un emprunt réglé,
 * déjà remboursé, avec un release diffusé (`settleTxHash`) ou encore dans son délai.
 */
export function canRefund(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return isOverdueUnsettled(loan) && isBorrower(loan, viewer);
}

/** Remboursement de secours (échu, capsule préparée mais non réglable) : sert à choisir l'explication affichée. */
export function canRescueRefund(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return isOverdueWithCapsule(loan) && isBorrower(loan, viewer);
}

/**
 * « Finaliser » ou « Réconcilier le règlement » : capsule et reçu présents, et règlement encore
 * possible. Masqué dès que le prêt est échu sans release diffusé : le contrat refuserait le release
 * et seul le remboursement reste (A-05, A-10). Un release déjà diffusé (`settleTxHash`) garde la
 * réconciliation, même après l'échéance.
 */
export function canResumeSettlement(loan: LoanDisplayInput): boolean {
  return (
    (loan.status === "TRAINING" || loan.status === "SETTLING") &&
    Boolean(loan.modelCid) &&
    Boolean(loan.runnerReceipt) &&
    !isOverdueUnsettled(loan)
  );
}

/**
 * « Vérifier et télécharger » : la clé du modèle n'est demandée qu'au clic, sur un emprunt réglé
 * (release miné, reçu enclave présent), par son emprunteur. Jamais au chargement de la page ni pour
 * un prêt où l'on est fournisseur : chaque appel à `/api/loans/[id]/key` consomme le quota de
 * livraison (20 par minute) et, pour un prêt v7, le budget runner prépayé (audit du 5 octobre,
 * A-04 et A-12). Le serveur reste l'autorité (`assertOwner`).
 */
export function canRetrieveModelKey(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return (
    loan.status === "SETTLED" &&
    Boolean(loan.settleTxHash) &&
    Boolean(loan.runnerReceipt) &&
    !loan.cancelTxHash &&
    isBorrower(loan, viewer)
  );
}

/**
 * Un emprunt payé (ou en cours de paiement) du même emprunteur sur ce dataset, le plus récent
 * d'abord selon l'ordre reçu. Sert à demander confirmation avant un nouvel emprunt du même
 * dataset : ré-emprunter est légitime (le serveur l'accepte), mais fait payer une seconde fois,
 * et un emprunt en attente de finalité se confond facilement avec un emprunt perdu.
 */
export function activeLoanOnDataset(
  loans: readonly LoanDisplayInput[],
  datasetId: string,
  viewer: string | null | undefined,
  excludeLoanId?: string,
): LoanDisplayInput | null {
  return loans.find(
    (other) =>
      other.id !== excludeLoanId &&
      other.datasetId === datasetId &&
      ACTIVE_STATUSES.has(other.status) &&
      // Un prêt PENDING sans lock est un devis refusé ou abandonné, pas un emprunt en cours.
      (other.status !== "PENDING" || Boolean(other.evmLockTxHash)) &&
      isBorrower(other, viewer),
  ) ?? null;
}

/** Un autre emprunt actif du même emprunteur sur ce dataset (confirmation avant d'en ouvrir un nouveau). */
export function hasOtherActiveLoan(
  loans: readonly LoanDisplayInput[],
  loan: LoanDisplayInput,
  viewer: string | null | undefined,
): boolean {
  return activeLoanOnDataset(loans, loan.datasetId, viewer, loan.id) !== null;
}

/**
 * Prêt dont la page doit lire l'attente de finalité : lock confirmé (ESCROWED), entraînement
 * jamais lancé, dans les délais, vu par son emprunteur. Un fournisseur ne lance rien, un prêt
 * échu se rembourse, un prêt TRAINING a déjà passé la garde de finalité.
 */
export function needsLockFinalityCheck(loan: LoanDisplayInput, viewer: string | null | undefined): boolean {
  return (
    loan.status === "ESCROWED" &&
    Boolean(loan.evmLockTxHash) &&
    !loan.modelCid &&
    !isOverdueUnsettled(loan) &&
    isBorrower(loan, viewer)
  );
}

/**
 * Phrase de la confirmation avant un second emprunt, selon ce que fait déjà l'emprunt existant :
 * payé et en attente de lancement (ESCROWED, ou paiement en cours PENDING/SUBMITTING), ou bien
 * entraînement déjà en cours (TRAINING, SETTLING). Clés françaises, traduites dans `train-en.ts`.
 */
export const DUPLICATE_LOAN_NOTICE = {
  waiting: "Tu as déjà un emprunt payé sur ce dataset, en attente d’entraînement. Emprunter à nouveau te fait payer une seconde fois.",
  training: "Un entraînement est déjà en cours sur ce dataset pour ton emprunt précédent. Emprunter à nouveau te fait payer une seconde fois.",
} as const;

export function duplicateLoanNotice(status: string): string {
  return status === "TRAINING" || status === "SETTLING" ? DUPLICATE_LOAN_NOTICE.training : DUPLICATE_LOAN_NOTICE.waiting;
}

/** Clé de traduction du libellé d'un état (phrases françaises, voir `train-en.ts`). */
export const LOAN_STATE_LABEL_KEY: Readonly<Record<LoanDisplayState, string>> = {
  "awaiting-finality": "Paiement en attente de finalité",
  "in-progress": "En cours",
  completed: "Terminé",
  failed: "Échoué",
  refunded: "Remboursé",
  unknown: "État inconnu",
};

export type LoanStateVariant = "default" | "accent" | "positive" | "negative" | "muted" | "warning";

export const LOAN_STATE_VARIANT: Readonly<Record<LoanDisplayState, LoanStateVariant>> = {
  "awaiting-finality": "warning",
  "in-progress": "accent",
  completed: "positive",
  failed: "negative",
  refunded: "default",
  unknown: "muted",
};

/** Le self training n'est affiché qu'à un administrateur confirmé : toute autre valeur le masque. */
export function parseAdminResponse(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { admin?: unknown }).admin === true;
}
