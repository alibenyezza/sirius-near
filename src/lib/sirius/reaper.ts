import "server-only";
import type { Loan } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { readLoan, reconcileLoanEscrow } from "@/lib/evm/escrow";
import { getPublicClient } from "@/lib/evm/client";
import {
  CANCELLED_LOCK_SEARCH_WINDOW_MS,
  CHAIN_REAPER_LEASE_MS,
  FAST_IDLE_REVERT_MS,
  FAST_SETTLEMENT_VERIFY_DELAY_MS,
  PENDING_REAPER_TTL_MS,
  SETTLEMENT_REAPER_LEASE_MS,
  SUBMISSION_REAPER_LEASE_MS,
  TRAINING_REAPER_LEASE_MS,
} from "./reaper-policy";
import { recoverUnsubmittedLoan } from "./recover-loan";
import { resolveLoanEscrow } from "@/lib/evm/history";
import { recoverLoanResult, settlePreparedLoan } from "./settle";
import { verifyFastSettlement } from "./fast-settlement-review";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { AppError } from "@/lib/app-error";

const BATCH_SIZE = 50;
let timer: ReturnType<typeof setInterval> | null = null;
let afterId: string | null = null;
let running: Promise<ReaperPassResult> | null = null;

/** Bilan d'une passe : prêts examinés et prêts restés en erreur (hors attente de finalité). */
export type ReaperPassResult = { examined: number; failed: number };

export function startLoanReaper(): void {
  if (timer) return;
  const interval = Number(process.env.SIRIUS_REAPER_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(interval) || interval < 5_000 || interval > 300_000) {
    throw new Error("SIRIUS_REAPER_INTERVAL_MS invalide");
  }
  const run = () => { void runLoanReaper().catch(() => console.error("[reaper] passe indisponible, reprise à la suivante")); };
  timer = setInterval(run, interval);
  timer.unref?.();
  run();
}

export function runLoanReaper(now = new Date()): Promise<ReaperPassResult> {
  if (!running) running = reapBatch(now).finally(() => { running = null; });
  return running;
}

async function reapBatch(now: Date): Promise<ReaperPassResult> {
  const loans = await prisma.loan.findMany({
    where: {
      ...(afterId ? { id: { gt: afterId } } : {}),
      OR: [
        { status: "PENDING", createdAt: { lte: new Date(now.getTime() - PENDING_REAPER_TTL_MS) } },
        { status: "SUBMITTING", updatedAt: { lte: new Date(now.getTime() - SUBMISSION_REAPER_LEASE_MS) } },
        // Un lock soumis (hash connu) reste toujours suivi ; une préparation jamais signée sort
        // de la liste une fois son autorisation expirée et la finalité largement dépassée.
        {
          status: "CANCELLED", cancelTxHash: null, evmLoanKey: { not: null },
          OR: [
            { evmLockTxHash: { not: null } },
            { createdAt: { gt: new Date(now.getTime() - CANCELLED_LOCK_SEARCH_WINDOW_MS) } },
          ],
        },
        { status: "TRAINING", modelCid: null, updatedAt: { lte: new Date(now.getTime() - TRAINING_REAPER_LEASE_MS) } },
        { status: "SETTLING", updatedAt: { lte: new Date(now.getTime() - SETTLEMENT_REAPER_LEASE_MS) } },
        { status: { in: ["ESCROWED", "TRAINING", "SETTLING"] }, updatedAt: { lte: new Date(now.getTime() - CHAIN_REAPER_LEASE_MS) } },
        // Release accepté au palier rapide : revérifié sous le bloc finalisé, une fois celui-ci
        // censé l'avoir dépassé, jusqu'à confirmation ou ouverture d'une revue.
        {
          status: "SETTLED", finalityTier: "FAST", finalityVerifiedAt: null, finalityReview: null,
          settledAt: { lte: new Date(now.getTime() - FAST_SETTLEMENT_VERIFY_DELAY_MS) },
        },
        // Prêt rapide rendu à ESCROWED et laissé sans lancement : il n'occupe pas le plafond indéfiniment.
        { status: "ESCROWED", finalityTier: "FAST", updatedAt: { lte: new Date(now.getTime() - FAST_IDLE_REVERT_MS) } },
      ],
    },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });
  // Le curseur avance aussi quand un prêt est actif ou son RPC échoue.
  afterId = loans.length === BATCH_SIZE ? loans.at(-1)!.id : null;
  let failed = 0;
  for (const loan of loans) {
    try {
      if (loan.status === "PENDING" || loan.status === "SUBMITTING" || loan.status === "CANCELLED") {
        await recoverUnsubmittedLoan(loan);
        continue;
      }
      if (loan.status === "SETTLED") {
        await reviewFastSettledLoan(loan, now);
        continue;
      }
      if (loan.status === "ESCROWED" && loan.finalityTier === "FAST" && loan.updatedAt.getTime() <= now.getTime() - FAST_IDLE_REVERT_MS) {
        // Classé rapide puis laissé sans activité : il libère le plafond et repassera par la
        // décision au prochain lancement (finality-tier.ts). Le reste de la passe le reprendra.
        const reverted = await prisma.loan.updateMany({
          where: { id: loan.id, status: "ESCROWED", finalityTier: "FAST", updatedAt: loan.updatedAt },
          data: { finalityTier: "FULL" },
        });
        if (reverted.count === 1) console.log(`[reaper] prêt EVM ${loan.id} : palier rapide rendu après inactivité`);
        continue;
      }
      const chain = loan.billingQuoteHash ? await reconcileClosedLoan(loan) : null;
      if (chain === "closed") continue;
      if (!loan.modelCid && loan.billingQuoteHash) {
        if (await recoverLoanResult(loan.id)) {
          await settlePreparedLoan(loan.id);
          continue;
        }
      } else if (loan.status === "TRAINING" && !loan.modelCid) {
        await prisma.loan.updateMany({ where: { id: loan.id, status: "TRAINING", updatedAt: loan.updatedAt }, data: { status: "ESCROWED" } });
        continue;
      }
      if ((loan.status === "TRAINING" || loan.status === "SETTLING") && loan.modelCid && loan.billingQuoteHash) {
        // Échu et toujours verrouillé on-chain, sans release diffusé : le contrat refuse désormais
        // tout release (`ChallengePeriodElapsed`), seul `refund()` par l'emprunteur libère les fonds
        // (audit A-05, A-10). Retenter le règlement toutes les 90 s ne ferait qu'osciller
        // SETTLING/TRAINING. Un release déjà diffusé (`settleTxHash`) ou un prêt réglé on-chain
        // passent encore par `settlePreparedLoan`, qui reconcilie le hash existant.
        if (chain === "active" && !loan.settleTxHash && loan.evmDeadline && loan.evmDeadline.getTime() <= now.getTime()) {
          console.log(`[reaper] prêt EVM ${loan.id} échu : règlement impossible, remboursement à l'initiative de l'emprunteur`);
          continue;
        }
        await settlePreparedLoan(loan.id);
        continue;
      }
      if (!loan.billingQuoteHash) await reconcileClosedLoan(loan);
    } catch (error) {
      if (error instanceof RunnerFinalityPending) console.log(`[reaper] prêt EVM ${loan.id} : règlement en attente de finalité`);
      else {
        failed += 1;
        console.error(`[reaper] prêt EVM ${loan.id} non réconcilié`);
      }
    }
  }
  return { examined: loans.length, failed };
}

/**
 * Prêt FAST déjà SETTLED : verdict à finalité complète (fast-settlement-review.ts). Confirmé ⇒
 * `finalityVerifiedAt`. Divergence ⇒ alerte journalisée, `finalityReview` posé (livraison de clé
 * et certificat suspendus) et erreur comptée dans la passe : le battement du reaper la fait
 * remonter. Rien n'est retenté ni annulé automatiquement : un opérateur tranche (runbook 20).
 */
async function reviewFastSettledLoan(loan: Loan, now: Date): Promise<void> {
  const open = async (reason: string) => {
    console.error(`[reaper] ALERTE finalité rapide : prêt EVM ${loan.id} — ${reason} ; revue manuelle requise (docs/passage-mainnet/20-finalite-rapide.md)`);
    await prisma.loan.updateMany({
      where: { id: loan.id, status: "SETTLED", finalityTier: "FAST", finalityReview: null },
      data: { finalityReview: reason, finalityReviewAt: now },
    });
    throw new AppError(`Finalité rapide contredite : ${reason}`, 409);
  };
  if (!loan.settleTxHash || !loan.evmLoanKey) return open("hash de release ou clé de prêt absents");
  const binding = await resolveLoanEscrow(loan);
  const verdict = await verifyFastSettlement(getPublicClient(), {
    settleTxHash: loan.settleTxHash as `0x${string}`,
    escrow: binding.escrow,
    onChainStatus: async () => (await readLoan(loan.evmLoanKey as `0x${string}`, binding))?.status ?? null,
  });
  if (verdict.state === "pending") return;
  if (verdict.state === "discrepancy") return open(verdict.reason);
  await prisma.loan.updateMany({
    where: { id: loan.id, status: "SETTLED", finalityTier: "FAST", finalityVerifiedAt: null },
    data: { finalityVerifiedAt: now },
  });
  console.log(`[reaper] prêt EVM ${loan.id} : release rapide confirmé à finalité complète`);
}

/**
 * Clôture le prêt en base si la chaîne l'a déjà réglé ou remboursé (`closed`). Sinon, renvoie l'état
 * on-chain (`active`, ou `settled` pour un prêt v7 dont la preuve reste à valider) ou `unbound`
 * (lock absent) : le reaper choisit alors la suite sans relire la chaîne.
 */
async function reconcileClosedLoan(loan: Loan): Promise<"closed" | "active" | "settled" | "unbound"> {
  if (!loan.evmLoanKey || !loan.evmLockBlock) return "unbound";
  const state = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, BigInt(loan.evmLockBlock), await resolveLoanEscrow(loan));
  if (state.state === "active") return "active";
  // La reprise du résultat et la validation de sa preuve précèdent toujours le règlement v7.
  if (state.state === "settled" && loan.billingQuoteHash) return "settled";
  await prisma.loan.updateMany({
    where: { id: loan.id, status: loan.status, updatedAt: loan.updatedAt },
    data: state.state === "settled"
      ? { status: "SETTLED", settleTxHash: state.txHash, settledAt: new Date() }
      : { status: "CANCELLED", cancelTxHash: state.txHash,
        ...(state.retainedFee !== undefined ? { retainedFeeUsdcAtomic: state.retainedFee, refundAmountUsdcAtomic: state.refundAmount } : {}) },
  });
  return "closed";
}
