import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EN_MESSAGES } from "@/lib/i18n/english";
import {
  DUPLICATE_LOAN_NOTICE,
  LOAN_DISPLAY_STATES,
  LOAN_STATE_LABEL_KEY,
  LOAN_STATE_VARIANT,
  activeLoanOnDataset,
  canRefund,
  duplicateLoanNotice,
  needsLockFinalityCheck,
  canResumeSettlement,
  canRetrain,
  canRetrieveModelKey,
  hasOtherActiveLoan,
  isFailedWithoutModel,
  isOverdueUnsettled,
  isOverdueWithCapsule,
  canRescueRefund,
  loanDisplayState,
  parseAdminResponse,
  type LoanDisplayInput,
} from "./loan-display";

const ME = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const KEY = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;

function loan(overrides: Partial<LoanDisplayInput> = {}): LoanDisplayInput {
  return {
    id: "loan-1",
    datasetId: "dataset-1",
    borrower: ME,
    status: "ESCROWED",
    evmLockTxHash: TX,
    evmLoanKey: KEY,
    settleTxHash: null,
    cancelTxHash: null,
    modelCid: null,
    refundable: false,
    ...overrides,
  };
}

const failed = () => loan({ refundable: true });
const completed = () => loan({ status: "SETTLED", settleTxHash: TX, modelCid: "bafy" });

test("états lisibles : un état par statut de prêt", () => {
  assert.equal(loanDisplayState(loan({ status: "PENDING" })), "awaiting-finality");
  // Prêt créé avant le devis, rien n'a été payé : jamais présenté comme un paiement envoyé.
  assert.equal(loanDisplayState(loan({ status: "PENDING", evmLockTxHash: null, evmLoanKey: null })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "SUBMITTING" })), "awaiting-finality");
  assert.equal(loanDisplayState(loan({ status: "ESCROWED" })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "TRAINING" })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "TRAINING", modelCid: "bafy" })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "SETTLING", modelCid: "bafy", settleTxHash: TX })), "awaiting-finality");
  assert.equal(loanDisplayState(completed()), "completed");
  assert.equal(loanDisplayState(loan({ status: "CANCELLED", cancelTxHash: TX })), "refunded");
  assert.equal(loanDisplayState(loan({ status: "CANCELLED" })), "failed");
  assert.equal(loanDisplayState(failed()), "failed");
  assert.equal(loanDisplayState(loan({ status: "TRAINING", refundable: true })), "failed");
});

test("un statut inconnu ou absent n'est jamais présenté comme réussi ni échoué", () => {
  assert.equal(loanDisplayState(loan({ status: "BIZARRE" })), "unknown");
  assert.equal(loanDisplayState(loan({ status: "" })), "unknown");
  assert.equal(loanDisplayState(loan({ status: undefined as unknown as string })), "unknown");
  assert.equal(loanDisplayState(loan({ status: "settled" })), "unknown");
});

test("chaque état a un libellé et une variante", () => {
  for (const state of LOAN_DISPLAY_STATES) {
    assert.ok(LOAN_STATE_LABEL_KEY[state], state);
    assert.ok(LOAN_STATE_VARIANT[state], state);
  }
  assert.deepEqual(
    Object.values(LOAN_STATE_LABEL_KEY).filter((key) => key !== "État inconnu"),
    ["Paiement en attente de finalité", "En cours", "Terminé", "Échoué", "Remboursé"],
  );
});

test("Rembourser : proposé pour un échec sans modèle, à l'emprunteur seulement", () => {
  assert.equal(canRefund(failed(), ME), true);
  assert.equal(canRefund(failed(), ME.toUpperCase().replace("0X", "0x")), true);
  assert.equal(canRefund(loan({ status: "TRAINING", refundable: true }), ME), true);
  assert.equal(canRefund(loan({ status: "SETTLING", refundable: true }), ME), true);
});

test("Rembourser : jamais proposé à un tiers, au fournisseur ou sans wallet", () => {
  assert.equal(canRefund(failed(), OTHER), false);
  assert.equal(canRefund(failed(), null), false);
  assert.equal(canRefund(failed(), undefined), false);
  assert.equal(canRefund(failed(), ""), false);
  assert.equal(canRefund(loan({ refundable: true, borrower: undefined }), ME), false);
  assert.equal(canRefund(loan({ refundable: true, borrower: null }), ME), false);
  assert.equal(canRefund(loan({ refundable: true, borrower: "pas-une-adresse" }), "pas-une-adresse"), false);
});

test("Rembourser : jamais avant l'échéance, jamais si le serveur ne le dit pas", () => {
  assert.equal(canRefund(loan({ refundable: false }), ME), false);
  assert.equal(canRefund(loan({ refundable: undefined }), ME), false);
  assert.equal(canRefund({ ...failed(), refundable: "true" as unknown as boolean }, ME), false);
  assert.equal(canRefund({ ...failed(), refundable: 1 as unknown as boolean }, ME), false);
});

test("Rembourser : jamais si un release est diffusé ou le prêt réglé", () => {
  // Capsule prête avec reçu, dans les délais : le règlement reste possible, pas de remboursement.
  assert.equal(canRefund(loan({ refundable: false, modelCid: "bafy", runnerReceipt: "receipt" }), ME), false);
  assert.equal(canRefund(loan({ status: "TRAINING", refundable: false, modelCid: "bafy", runnerReceipt: "receipt" }), ME), false);
  // Release diffusé avant l'échéance : il peut être miné, réconciliation seulement.
  assert.equal(canRefund(loan({ status: "SETTLING", refundable: true, settleTxHash: TX }), ME), false);
  assert.equal(canRefund(loan({ status: "SETTLING", refundable: true, modelCid: "bafy", runnerReceipt: "receipt", settleTxHash: TX }), ME), false);
  assert.equal(canRefund({ ...completed(), refundable: true }, ME), false);
  assert.equal(canRefund(completed(), ME), false);
});

test("Rembourser : jamais sur un emprunt déjà remboursé, abandonné ou pas encore verrouillé", () => {
  assert.equal(canRefund(loan({ status: "CANCELLED", cancelTxHash: TX, refundable: true }), ME), false);
  assert.equal(canRefund(loan({ status: "CANCELLED", refundable: true }), ME), false);
  assert.equal(canRefund(loan({ status: "PENDING", refundable: true }), ME), false);
  assert.equal(canRefund(loan({ status: "SUBMITTING", refundable: true }), ME), false);
  assert.equal(canRefund(loan({ status: "INCONNU", refundable: true }), ME), false);
  assert.equal(canRefund(loan({ refundable: true, evmLoanKey: null }), ME), false);
  assert.equal(canRefund(loan({ refundable: true, cancelTxHash: TX }), ME), false);
});

test("échu + capsule sans reçu : remboursement de secours, jamais de fonds bloqués", () => {
  const stuck = (overrides: Partial<LoanDisplayInput> = {}) => loan({ refundable: true, modelCid: "bafy", runnerReceipt: null, ...overrides });
  for (const status of ["ESCROWED", "TRAINING", "SETTLING"]) {
    assert.equal(canRefund(stuck({ status }), ME), true, status);
    assert.equal(canRescueRefund(stuck({ status }), ME), true, status);
    assert.equal(loanDisplayState(stuck({ status })), "failed", status);
  }
  assert.equal(canRescueRefund(failed(), ME), false);
  // Garde-fous inchangés : tiers, fournisseur, délai, règlement soumis, déjà remboursé, reçu présent.
  assert.equal(canRefund(stuck(), OTHER), false);
  assert.equal(canRefund(stuck({ borrower: null }), ME), false);
  assert.equal(canRefund(stuck({ refundable: false }), ME), false);
  assert.equal(canRefund(stuck({ settleTxHash: TX }), ME), false);
  assert.equal(canRefund(stuck({ cancelTxHash: TX }), ME), false);
  assert.equal(canRefund(stuck({ evmLoanKey: null }), ME), false);
  assert.equal(canRefund(stuck({ status: "SETTLED", settleTxHash: TX }), ME), false);
});

test("A-05, A-10 : échu avec capsule et reçu, sans release diffusé : Rembourser visible, Finaliser masqué", () => {
  // Le contrat refuse tout `release` après l'échéance (`ChallengePeriodElapsed`) : le règlement est
  // devenu impossible, que le runner ait répondu (A-05) ou que sa quote ne soit plus acceptée (A-10).
  const prepared = (overrides: Partial<LoanDisplayInput> = {}) =>
    loan({ refundable: true, modelCid: "bafy", runnerReceipt: "receipt", ...overrides });
  for (const status of ["ESCROWED", "TRAINING", "SETTLING"]) {
    assert.equal(canRefund(prepared({ status }), ME), true, status);
    assert.equal(canRescueRefund(prepared({ status }), ME), true, status);
    assert.equal(isOverdueUnsettled(prepared({ status })), true, status);
    assert.equal(isOverdueWithCapsule(prepared({ status })), true, status);
    assert.equal(isFailedWithoutModel(prepared({ status })), false, status);
    assert.equal(loanDisplayState(prepared({ status })), "failed", status);
    assert.equal(canResumeSettlement(prepared({ status })), false, status);
  }
  // Garde-fous inchangés : tiers, fournisseur, délai, release diffusé, déjà remboursé, réglé, sans clé.
  assert.equal(canRefund(prepared(), OTHER), false);
  assert.equal(canRefund(prepared({ borrower: null }), ME), false);
  assert.equal(canRefund(prepared({ refundable: false }), ME), false);
  assert.equal(canRefund(prepared({ refundable: undefined }), ME), false);
  assert.equal(canRefund(prepared({ settleTxHash: TX }), ME), false);
  assert.equal(canRefund(prepared({ cancelTxHash: TX }), ME), false);
  assert.equal(canRefund(prepared({ evmLoanKey: null }), ME), false);
  assert.equal(canRefund(prepared({ status: "SETTLED", settleTxHash: TX }), ME), false);
  assert.equal(canRefund(prepared({ status: "SETTLED", settleTxHash: null }), ME), false);
  assert.equal(canRefund(prepared({ status: "CANCELLED" }), ME), false);
});

test("Finaliser ou réconcilier le règlement : capsule et reçu, et règlement encore possible", () => {
  const ready = (overrides: Partial<LoanDisplayInput> = {}) =>
    loan({ status: "TRAINING", modelCid: "bafy", runnerReceipt: "receipt", ...overrides });
  assert.equal(canResumeSettlement(ready()), true);
  assert.equal(canResumeSettlement(ready({ status: "SETTLING" })), true);
  // Release diffusé avant l'échéance : la réconciliation reste proposée, même échu.
  assert.equal(canResumeSettlement(ready({ status: "SETTLING", settleTxHash: TX, refundable: true })), true);
  // Échu sans release : le contrat refuserait, seul le remboursement reste.
  assert.equal(canResumeSettlement(ready({ refundable: true })), false);
  assert.equal(canResumeSettlement(ready({ status: "SETTLING", refundable: true })), false);
  // Jamais sans capsule, sans reçu, ni hors TRAINING/SETTLING.
  assert.equal(canResumeSettlement(ready({ runnerReceipt: null })), false);
  assert.equal(canResumeSettlement(ready({ modelCid: null })), false);
  for (const status of ["PENDING", "SUBMITTING", "ESCROWED", "SETTLED", "CANCELLED", "X"]) {
    assert.equal(canResumeSettlement(ready({ status })), false, status);
  }
  // Un prêt n'est jamais à la fois remboursable et réglable.
  for (const status of ["ESCROWED", "TRAINING", "SETTLING"]) {
    for (const refundable of [true, false]) {
      for (const settleTxHash of [null, TX]) {
        const candidate = ready({ status, refundable, settleTxHash });
        assert.ok(!(canRefund(candidate, ME) && canResumeSettlement(candidate)), `${status} ${refundable} ${settleTxHash}`);
      }
    }
  }
});

test("Rembourser et état échoué restent cohérents", () => {
  for (const status of ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "SETTLED", "CANCELLED", "X"]) {
    for (const refundable of [true, false]) {
      for (const modelCid of [null, "bafy"]) {
        for (const runnerReceipt of [null, "receipt"]) {
          for (const settleTxHash of [null, TX]) {
            for (const cancelTxHash of [null, TX]) {
              const candidate = loan({ status, refundable, modelCid, runnerReceipt, settleTxHash, cancelTxHash });
              if (canRefund(candidate, ME)) {
                assert.equal(loanDisplayState(candidate), "failed");
                assert.equal(isOverdueUnsettled(candidate), true);
                assert.equal(isFailedWithoutModel(candidate) || isOverdueWithCapsule(candidate), true);
                assert.equal(isFailedWithoutModel(candidate) && isOverdueWithCapsule(candidate), false);
                assert.equal(candidate.settleTxHash, null);
                assert.equal(candidate.cancelTxHash, null);
                assert.ok(["ESCROWED", "TRAINING", "SETTLING"].includes(status));
                assert.equal(refundable, true);
              } else if (["ESCROWED", "TRAINING", "SETTLING"].includes(status) && refundable && !settleTxHash && !cancelTxHash) {
                assert.fail(`remboursement attendu : ${status} ${modelCid} ${runnerReceipt}`);
              }
            }
          }
        }
      }
    }
  }
});

test("Ré-entraîner : proposé sur un emprunt terminé et réglé, à son emprunteur", () => {
  assert.equal(canRetrain(completed(), ME), true);
  assert.equal(canRetrain(completed(), ME.toUpperCase().replace("0X", "0x")), true);
});

test("Ré-entraîner : jamais sur un autre état, un tiers ou le fournisseur", () => {
  for (const status of ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "CANCELLED", "X"]) {
    assert.equal(canRetrain(loan({ status, settleTxHash: TX, modelCid: "bafy" }), ME), false, status);
  }
  assert.equal(canRetrain(failed(), ME), false);
  assert.equal(canRetrain(loan({ status: "CANCELLED", cancelTxHash: TX }), ME), false);
  assert.equal(canRetrain(completed(), OTHER), false);
  assert.equal(canRetrain(completed(), null), false);
  assert.equal(canRetrain({ ...completed(), borrower: undefined }, ME), false);
  assert.equal(canRetrain({ ...completed(), settleTxHash: null }, ME), false);
  assert.equal(canRetrain({ ...completed(), cancelTxHash: TX }, ME), false);
  assert.equal(canRetrain({ ...completed(), datasetId: "" }, ME), false);
});

test("un lock ESCROWED en attente de finalité s'affiche comme paiement en attente, et seulement lui", () => {
  assert.equal(loanDisplayState(loan({ lockFinalityPending: true })), "awaiting-finality");
  assert.equal(loanDisplayState(loan({ lockFinalityPending: false })), "in-progress");
  assert.equal(loanDisplayState(loan({ lockFinalityPending: undefined })), "in-progress");
  // Échu : l'échec et le remboursement priment sur l'attente.
  assert.equal(loanDisplayState(loan({ lockFinalityPending: true, refundable: true })), "failed");
  // Les autres statuts ignorent le drapeau : il ne concerne que la garde de `prepareLoanResult`.
  assert.equal(loanDisplayState(loan({ status: "TRAINING", lockFinalityPending: true })), "in-progress");
  assert.equal(loanDisplayState(loan({ status: "SETTLED", settleTxHash: TX, modelCid: "bafy", lockFinalityPending: true })), "completed");
});

test("la lecture de finalité ne concerne qu'un lock ESCROWED jamais entraîné, vu par son emprunteur", () => {
  assert.equal(needsLockFinalityCheck(loan(), ME), true);
  assert.equal(needsLockFinalityCheck(loan(), ME.toUpperCase().replace("0X", "0x")), true);
  assert.equal(needsLockFinalityCheck(loan(), OTHER), false);
  assert.equal(needsLockFinalityCheck(loan(), null), false);
  assert.equal(needsLockFinalityCheck(loan({ borrower: null }), ME), false);
  assert.equal(needsLockFinalityCheck(loan({ evmLockTxHash: null }), ME), false);
  assert.equal(needsLockFinalityCheck(loan({ modelCid: "bafy" }), ME), false);
  assert.equal(needsLockFinalityCheck(loan({ refundable: true }), ME), false);
  for (const status of ["PENDING", "SUBMITTING", "TRAINING", "SETTLING", "SETTLED", "CANCELLED", "X"]) {
    assert.equal(needsLockFinalityCheck(loan({ status }), ME), false, status);
  }
});

test("un emprunt payé du même emprunteur sur un dataset est retrouvé avant un nouvel emprunt", () => {
  const waiting = loan({ id: "loan-2" });
  assert.equal(activeLoanOnDataset([waiting], "dataset-1", ME), waiting);
  assert.equal(activeLoanOnDataset([loan({ id: "loan-2", status: "TRAINING" })], "dataset-1", ME)?.id, "loan-2");
  assert.equal(activeLoanOnDataset([loan({ id: "loan-2", status: "SETTLING" })], "dataset-1", ME)?.id, "loan-2");
  assert.equal(activeLoanOnDataset([loan({ id: "loan-2", status: "SUBMITTING" })], "dataset-1", ME)?.id, "loan-2");
  assert.equal(activeLoanOnDataset([loan({ id: "loan-2", status: "PENDING" })], "dataset-1", ME)?.id, "loan-2");
  // Devis refusé ou abandonné, prêt terminé, remboursé, autre dataset, autre emprunteur : rien.
  assert.equal(activeLoanOnDataset([loan({ id: "loan-2", status: "PENDING", evmLockTxHash: null })], "dataset-1", ME), null);
  assert.equal(activeLoanOnDataset([completed()], "dataset-1", ME), null);
  assert.equal(activeLoanOnDataset([loan({ status: "CANCELLED", cancelTxHash: TX })], "dataset-1", ME), null);
  assert.equal(activeLoanOnDataset([waiting], "dataset-2", ME), null);
  assert.equal(activeLoanOnDataset([waiting], "dataset-1", OTHER), null);
  assert.equal(activeLoanOnDataset([waiting], "dataset-1", null), null);
  assert.equal(activeLoanOnDataset([], "dataset-1", ME), null);
  // Le prêt dont on part (ré-entraînement) est exclu.
  assert.equal(activeLoanOnDataset([waiting], "dataset-1", ME, "loan-2"), null);
});

test("un emprunt actif du même emprunteur sur le même dataset est détecté", () => {
  const current = completed();
  assert.equal(hasOtherActiveLoan([current], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "TRAINING" })], current, ME), true);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "PENDING" })], current, ME), true);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "PENDING", evmLockTxHash: null })], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "SUBMITTING" })], current, ME), true);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "SETTLED" })], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", status: "CANCELLED" })], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", datasetId: "dataset-2" })], current, ME), false);
  assert.equal(hasOtherActiveLoan([current, loan({ id: "loan-2", borrower: OTHER })], current, ME), false);
});

test("chaque libellé d'état est traduit en anglais", () => {
  const english = new Map<string, string>([
    ["Paiement en attente de finalité", "Payment awaiting finality"],
    ["En cours", "In progress"],
    ["Terminé", "Completed"],
    ["Échoué", "Failed"],
    ["Remboursé", "Refunded"],
    ["État inconnu", "Unknown status"],
  ]);
  for (const key of Object.values(LOAN_STATE_LABEL_KEY)) assert.equal(EN_MESSAGES[key], english.get(key), key);
});

test("l'attente de finalité et la confirmation de double emprunt sont traduites, sans jeton codé en dur", () => {
  const keys = [
    "Finalité du paiement : ~{minutes} min",
    "Finalité imminente…",
    "L’entraînement pourra démarrer dans ~{minutes} min — tu peux fermer cette page, ton paiement est en sécurité dans l’escrow.",
    "Le réseau finalise ton paiement : l’entraînement pourra démarrer d’une minute à l’autre. Ton paiement est en sécurité dans l’escrow.",
    "Si cette page reste ouverte, l’entraînement démarre automatiquement dès la finalité. Sinon, reviens lancer le job : inutile d’emprunter à nouveau.",
    "Emprunt déjà en cours",
    "Tu as déjà un emprunt payé sur ce dataset, en attente d’entraînement. Emprunter à nouveau te fait payer une seconde fois.",
    "Voir mes entraînements",
    "Emprunter quand même",
  ];
  for (const key of keys) {
    assert.equal(typeof EN_MESSAGES[key], "string", key);
    assert.doesNotMatch(`${key} ${EN_MESSAGES[key]}`, /USD[CG]/, key);
  }
  assert.equal(EN_MESSAGES["Tu as déjà un emprunt payé sur ce dataset, en attente d’entraînement. Emprunter à nouveau te fait payer une seconde fois."],
    "You already have a paid loan on this dataset waiting to train. Borrowing again charges you again.");
  assert.equal(EN_MESSAGES["L’entraînement pourra démarrer dans ~{minutes} min — tu peux fermer cette page, ton paiement est en sécurité dans l’escrow."],
    "Training can start in ~{minutes} min — you can close this page, your payment is safe in escrow.");
});

test("la confirmation de double emprunt dit ce que fait déjà l'emprunt existant", () => {
  for (const status of ["ESCROWED", "PENDING", "SUBMITTING"]) assert.equal(duplicateLoanNotice(status), DUPLICATE_LOAN_NOTICE.waiting, status);
  for (const status of ["TRAINING", "SETTLING"]) assert.equal(duplicateLoanNotice(status), DUPLICATE_LOAN_NOTICE.training, status);
  assert.equal(EN_MESSAGES[DUPLICATE_LOAN_NOTICE.training], "Training is already in progress on this dataset for your previous loan. Borrowing again charges you again.");
  assert.equal(EN_MESSAGES["Le réseau met plus de temps que prévu à finaliser ton paiement. Reviens plus tard lancer le job : ton paiement est en sécurité dans l’escrow."],
    "The network is taking longer than expected to finalize your payment. Come back later to run the job: your payment is safe in escrow.");
});

test("page Train : le bouton de lancement est remplacé pendant l'attente de finalité, décidée par le suivi pur", () => {
  const page = readFileSync(fileURLToPath(new URL("../../app/(app)/train/page.tsx", import.meta.url)), "utf8");
  // Le bouton « Lancer le job » n'est rendu qu'en dehors de l'attente ; un bouton inactif le remplace.
  assert.match(page, /\{!l\.refundable && !awaitingLock && \(l\.status === "ESCROWED"/);
  assert.match(page, /data-testid="lock-finality-button"/);
  assert.match(page, /data-testid="lock-finality-wait"/);
  assert.match(page, /data-testid="lock-finality-exhausted"/);
  // Seule une réponse 200 est une lecture ; tout le reste est une erreur pour le suivi (lock-finality-tracker.ts).
  assert.match(page, /if \(response\.status === 200\)/);
  assert.match(page, /observeLockFinality\(current, result, Date\.now\(\)\)/);
  // Le refus de finalité n'est pas une erreur : il rend le lancement automatique et reprend l'attente.
  assert.match(page, /message === LOCK_FINALITY_PENDING[\s\S]*?lockFinalityRunRefused\(current, Date\.now\(\)\)/);
  // Onglet caché : aucune relecture, reprise au retour.
  assert.match(page, /document\.hidden/);
  assert.match(page, /addEventListener\("visibilitychange"/);
});

test("le self training n'est montré que si le serveur répond exactement admin: true", () => {
  assert.equal(parseAdminResponse({ admin: true }), true);
  for (const body of [{ admin: false }, {}, null, undefined, "true", 1, [], { admin: "true" }, { admin: 1 }, { error: "x" }]) {
    assert.equal(parseAdminResponse(body), false);
  }
});

test("Vérifier et télécharger : la clé n'est proposée que sur un emprunt réglé, à son emprunteur", () => {
  const settled = () => loan({ status: "SETTLED", settleTxHash: TX, modelCid: "bafy", runnerReceipt: "receipt" });
  assert.equal(canRetrieveModelKey(settled(), ME), true);
  assert.equal(canRetrieveModelKey(settled(), ME.toUpperCase().replace("0X", "0x")), true);
  // Fournisseur, tiers ou sans wallet : aucun appel à /api/loans/[id]/key (A-12).
  assert.equal(canRetrieveModelKey(settled(), OTHER), false);
  assert.equal(canRetrieveModelKey(settled(), null), false);
  assert.equal(canRetrieveModelKey(settled(), ""), false);
  assert.equal(canRetrieveModelKey({ ...settled(), borrower: undefined }, ME), false);
  assert.equal(canRetrieveModelKey({ ...settled(), borrower: "pas-une-adresse" }, ME), false);
  for (const status of ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "CANCELLED", "X"]) {
    assert.equal(canRetrieveModelKey({ ...settled(), status }, ME), false, status);
  }
  assert.equal(canRetrieveModelKey({ ...settled(), settleTxHash: null }, ME), false);
  assert.equal(canRetrieveModelKey({ ...settled(), runnerReceipt: null }, ME), false);
  assert.equal(canRetrieveModelKey({ ...settled(), runnerReceipt: undefined }, ME), false);
  assert.equal(canRetrieveModelKey({ ...settled(), cancelTxHash: TX }, ME), false);
});

test("page Train : la clé d'un emprunt est demandée au clic, jamais au chargement (A-04, A-12)", () => {
  const page = readFileSync(fileURLToPath(new URL("../../app/(app)/train/page.tsx", import.meta.url)), "utf8");
  const refresh = page.match(/const refresh = useCallback\(async \(\) => \{([\s\S]*?)\}, \[address, authenticated\]\);/);
  assert.ok(refresh, "refresh() introuvable");
  assert.doesNotMatch(refresh![1], /retrieveLoanKey/, "refresh() ne doit pas demander la clé des emprunts");
  assert.doesNotMatch(refresh![1], /fetch\([^)]*\/key\b/, "refresh() ne doit pas appeler la route de livraison de clé");
  // Le bouton est conditionné par l'emprunteur, et le seul appel part du gestionnaire de clic.
  assert.match(page, /\{canRetrieveModelKey\(l, address\) && \(\s*<button\s*onClick=\{\(\) => void inspectLoanModel\(l\)\}/);
  assert.equal(page.match(/retrieveLoanKey\(/g)?.length, 1);
  assert.match(page, /async function inspectLoanModel\(loan: Loan\) \{[\s\S]*?canRetrieveModelKey\(loan, address\)[\s\S]*?retrieveLoanKey\(loan\.id, loan\.runnerReceipt\)/);
});
