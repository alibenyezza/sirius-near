import "server-only";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { readLoan, reconcileLoanEscrow } from "@/lib/evm/escrow";
import { getPublicClient } from "@/lib/evm/client";
import { assertLockStable } from "@/lib/evm/finality";
import type { FinalityTier } from "@/lib/evm/fast-finality";
import { assignLoanFinalityTier, effectiveLoanFinalityTier } from "./finality-tier";
import { recordSettlementEvidence } from "./settlement-evidence";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { recoverLoanJobInRunner, runLoanJobInRunner, settleLoanInRunner } from "@/lib/tee/runner-client";
import type { RunnerReleaseEnvelope } from "@/lib/tee/contract";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { unpinModelUnlessReferenced } from "./model-storage";
import { modelSelection } from "@/lib/models/registry";
import type { ModelId } from "@/lib/models/registry";
import { deferredLoanDeliveryCommitment, hashRunnerReleaseEnvelope } from "@/lib/runner/delivery";
import {
  hashLoanAttestationPayload,
  parseLoanAttestationPayload,
  serializeLoanAttestationPayload,
} from "@/lib/tee/attestation";
import { isRecordedQuoteHardwareValid, verifyTdxQuote } from "@/lib/tee/quote";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import type { LoanAttestationPayload } from "@/lib/tee/types";
import { loanBillingQuote } from "@/lib/billing/loan";
import { LOCK_FINALITY_PENDING } from "@/lib/loans/settlement-status";

const TRAINING_LEASE_MS = 90_000;

async function verifyLoanAttestation(input: {
  attestation: Awaited<ReturnType<typeof runLoanJobInRunner>>["attestation"];
  loanId: string;
  loanKey: string;
  datasetId: string;
  datasetCid: string;
  provider: string;
  borrower: string;
  amountUsdcAtomic: string;
  challengeDays: number;
  merkleRoot: string;
  modelId: ModelId;
  modelVersion: string;
  modelCid: string;
  releaseEnvelope?: RunnerReleaseEnvelope;
  releaseEnvelopeHash: string;
  deliveryPublicKey: string;
  billingQuoteHash?: string;
}): Promise<void> {
  const { chainId, escrow } = evmEscrowBinding();
  if (!input.billingQuoteHash && !input.releaseEnvelope) throw new AppError("Capsule de release incompatible", 409);
  const expectedDeliveryHash = input.billingQuoteHash
    ? deferredLoanDeliveryCommitment(input.loanKey, input.modelCid, input.deliveryPublicKey)
    : hashRunnerReleaseEnvelope(input.releaseEnvelope!);
  if (input.releaseEnvelopeHash !== expectedDeliveryHash || (input.billingQuoteHash && input.releaseEnvelope)) {
    throw new AppError("Accusé de capsule invalide", 409);
  }
  const payload = serializeLoanAttestationPayload({
    chainId,
    escrow,
    loanId: input.loanId,
    loanKey: input.loanKey,
    datasetId: input.datasetId,
    datasetCid: input.datasetCid,
    provider: input.provider,
    borrower: input.borrower,
    amountUsdcAtomic: input.amountUsdcAtomic,
    challengeDays: input.challengeDays,
    merkleRoot: input.merkleRoot,
    modelId: input.modelId,
    modelVersion: input.modelVersion,
    modelCid: input.modelCid,
    releaseEnvelopeHash: expectedDeliveryHash,
    ...(input.billingQuoteHash ? { billingQuoteHash: input.billingQuoteHash } : {}),
  });
  const attestation = input.attestation;
  if (
    attestation.signer !== "sirius-tee" ||
    !/^[a-f0-9]{64}$/i.test(attestation.signature) ||
    attestation.payload !== payload ||
    attestation.payloadHash !== hashLoanAttestationPayload(payload)
  ) {
    throw new AppError("Attestation runner hors scope", 502);
  }

  if (process.env.TEE_MODE !== "phala") return;
  const evidence = attestation.evidence;
  if (!evidence) throw new AppError("Quote TDX runner manquante", 502);
  const verification = await verifyTdxQuote(evidence.quote, attestation.payloadHash, evidence);
  if (
    verification.reportDataMatches !== true ||
    verification.hardwareVerified !== true ||
    verification.codeIdentityMatches !== true
  ) {
    throw new AppError("Quote TDX runner non authentifiée", 502);
  }
}

export interface PreparedLoanResult {
  loanId: string;
  modelCid: string;
  runnerReceipt: string;
  releaseEnvelope?: RunnerReleaseEnvelope;
}

export interface SettleResult extends Omit<PreparedLoanResult, "releaseEnvelope"> {
  settleTxHash: string;
}

export async function recoverLoanResult(loanId: string): Promise<boolean> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { dataset: true } });
  if (!loan || loan.modelCid || !["ESCROWED", "TRAINING", "SETTLING"].includes(loan.status)) return false;
  const signed = loanBillingQuote(loan);
  if (!signed || !loan.evmLoanKey || !loan.amountUsdcAtomic) return false;
  const runner = await assertCurrentRunner(loan);
  const recovered = await recoverLoanJobInRunner(loanId, signed);
  if (recovered.state !== "ready") return false;
  const { result } = recovered;
  const model = modelSelection(loan.modelId, loan.modelVersion);
  if (!model || !loan.dataset.ipfsCid || !loan.dataset.merkleRoot) throw new AppError("Dataset de reprise incohérent", 409);
  await verifyLoanAttestation({
    attestation: result.attestation, loanId, loanKey: loan.evmLoanKey, datasetId: loan.datasetId,
    datasetCid: loan.dataset.ipfsCid, provider: loan.provider, borrower: loan.borrower,
    amountUsdcAtomic: loan.amountUsdcAtomic, billingQuoteHash: loan.billingQuoteHash!,
    challengeDays: loan.dataset.challengeDays, merkleRoot: loan.dataset.merkleRoot, ...model,
    modelCid: result.modelCid, releaseEnvelope: result.releaseEnvelope,
    releaseEnvelopeHash: result.releaseEnvelopeHash, deliveryPublicKey: recovered.deliveryPublicKey,
  });
  const persisted = await prisma.loan.updateMany({
    where: { id: loanId, status: loan.status, modelCid: null, updatedAt: loan.updatedAt },
    data: {
      status: "TRAINING", modelCid: result.modelCid, runnerReceipt: result.runnerReceipt,
      attestationHash: result.attestation.payloadHash, attestationPayload: result.attestation.payload,
      attestationQuote: result.attestation.evidence?.quote ?? null,
      attestationEventLog: result.attestation.evidence?.eventLog ?? null,
      attestationComposeHash: result.attestation.evidence?.composeHash ?? null,
      auditReceipt: result.attestation.signature, ...runner,
    },
  });
  return persisted.count === 1;
}

// Partagé avec la page Train (module sans `server-only`), réexporté pour les appelants existants.
export { LOCK_FINALITY_PENDING };

export async function prepareLoanResult(
  loanId: string,
  deliveryPublicKey: string,
  authorization: RunnerGrant,
): Promise<PreparedLoanResult> {
  const lock = await prisma.loan.findUnique({
    where: { id: loanId },
    select: { id: true, status: true, evmLockBlock: true, evmLockTxHash: true, evmLoanKey: true, amountUsdcAtomic: true, finalityTier: true },
  });
  if (lock?.status === "ESCROWED" && lock.evmLockBlock) {
    // Palier de finalité décidé ici, au moment où l'entraînement peut démarrer (finality-tier.ts) :
    // le montant est relu sur le contrat avant tout passage en rapide, et la somme des prêts rapides
    // en cours est contrôlée dans la transaction qui marque le prêt. Le marquage n'a lieu qu'une
    // fois la profondeur du lock vérifiée au palier candidat : un lock pas encore assez profond
    // n'occupe jamais le plafond. Sans hash de lock (ligne historique), finalité complète.
    const client = getPublicClient();
    const lockRef = { blockNumber: BigInt(lock.evmLockBlock), txHash: (lock.evmLockTxHash ?? `0x${"0".repeat(64)}`) as `0x${string}` };
    const verifyOnChainAmount = async () => {
      const onChain = lock.evmLoanKey ? await readLoan(lock.evmLoanKey as `0x${string}`) : null;
      return onChain?.amountUsdcAtomic === lock.amountUsdcAtomic;
    };
    const candidate: FinalityTier = lock.evmLockTxHash ? await assignLoanFinalityTier(lock, verifyOnChainAmount, { dryRun: true }) : "FULL";
    await assertLockStable(client, lockRef, candidate, LOCK_FINALITY_PENDING);
    if (candidate === "FAST" && lock.finalityTier !== "FAST") {
      // Le plafond a pu se remplir entre la lecture et le marquage : le palier retenu est celui
      // de la transaction, et un retour à la finalité complète repasse par sa propre garde.
      const marked = await assignLoanFinalityTier(lock, verifyOnChainAmount);
      if (marked !== "FAST") await assertLockStable(client, lockRef, "FULL", LOCK_FINALITY_PENDING);
    }
  }
  const now = new Date();
  await prisma.loan.updateMany({
    where: { id: loanId, status: "TRAINING", modelCid: null, updatedAt: { lte: new Date(now.getTime() - TRAINING_LEASE_MS) } },
    data: { status: "ESCROWED", updatedAt: now },
  });
  const claimed = await prisma.loan.updateMany({
    where: { id: loanId, status: "ESCROWED" },
    data: {
      status: "TRAINING",
      updatedAt: now,
      modelCid: null,
      runnerReceipt: null,
      attestationHash: null,
      attestationPayload: null,
      attestationQuote: null,
      attestationEventLog: null,
      attestationComposeHash: null,
      auditReceipt: null,
    },
  });
  if (claimed.count !== 1) throw new AppError("Loan non verrouillé ou déjà en cours", 409);

  // `wrappedKey` est retirée de toute lecture par le `omit` global de `db.ts`, pour
  // qu'elle ne puisse jamais partir dans une réponse d'API. Les contrôles ci-dessous
  // vérifient qu'elle EXISTE — sur un objet d'où elle vient d'être supprimée, ils
  // échouaient donc systématiquement, et aucun dataset ne pouvait être publié,
  // emprunté ni réglé. On la réinclut ici, comme le prévoit `db.ts` : cet objet ne
  // quitte pas le serveur.
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { dataset: { omit: { wrappedKey: false } } } });
  if (!loan || !loan.evmLoanKey || !loan.evmLockTxHash || !loan.evmLockBlock || !loan.amountUsdcAtomic) {
    throw new AppError("Lock de paiement absent", 409);
  }
  const { dataset } = loan;
  if (!dataset.ipfsCid || !dataset.merkleRoot || !dataset.wrappedKey || !dataset.runnerReceipt || !dataset.priceUsdcAtomic) {
    await prisma.loan.updateMany({ where: { id: loanId, status: "TRAINING", updatedAt: now }, data: { status: "ESCROWED" } });
    throw new AppError("Dataset EVM indisponible", 409);
  }
  const model = modelSelection(loan.modelId, loan.modelVersion);
  if (!model) {
    await prisma.loan.updateMany({ where: { id: loanId, status: "TRAINING", updatedAt: now }, data: { status: "ESCROWED" } });
    throw new AppError("Modèle ou version non autorisé", 409);
  }
  const datasetModel = modelSelection(dataset.modelId, dataset.modelVersion);
  if (!datasetModel || datasetModel.modelId !== model.modelId || datasetModel.modelVersion !== model.modelVersion) {
    await prisma.loan.updateMany({ where: { id: loanId, status: "TRAINING", updatedAt: now }, data: { status: "ESCROWED" } });
    throw new AppError("Profil d’entraînement du dataset incohérent", 409);
  }

  let result: Awaited<ReturnType<typeof runLoanJobInRunner>> | undefined;
  try {
    const runner = await assertCurrentRunner(loan);
    await assertCurrentRunner(dataset);
    const billingQuote = loanBillingQuote(loan);
    result = await runLoanJobInRunner(
      {
        loanId,
        datasetId: dataset.id,
        cid: dataset.ipfsCid,
        wrappedKey: dataset.wrappedKey,
        merkleRoot: dataset.merkleRoot,
        priceUsdcAtomic: dataset.priceUsdcAtomic,
        challengeDays: dataset.challengeDays,
        ...datasetModel,
      },
      dataset.runnerReceipt,
      deliveryPublicKey,
      authorization,
      billingQuote,
      effectiveLoanFinalityTier(loan.finalityTier),
    );
    await verifyLoanAttestation({
      attestation: result.attestation,
      loanId,
      loanKey: loan.evmLoanKey,
      datasetId: dataset.id,
      datasetCid: dataset.ipfsCid,
      provider: loan.provider,
      borrower: loan.borrower,
      amountUsdcAtomic: loan.amountUsdcAtomic,
      ...(loan.billingQuoteHash ? { billingQuoteHash: loan.billingQuoteHash } : {}),
      challengeDays: dataset.challengeDays,
      merkleRoot: dataset.merkleRoot,
      modelId: model.modelId,
      modelVersion: model.modelVersion,
      modelCid: result.modelCid,
      releaseEnvelope: result.releaseEnvelope,
      releaseEnvelopeHash: result.releaseEnvelopeHash,
      deliveryPublicKey,
    });
    const persisted = await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", modelCid: null, updatedAt: now },
      data: {
        modelCid: result.modelCid,
        runnerReceipt: result.runnerReceipt,
        attestationHash: result.attestation.payloadHash,
        attestationPayload: result.attestation.payload,
        attestationQuote: result.attestation.evidence?.quote ?? null,
        attestationEventLog: result.attestation.evidence?.eventLog ?? null,
        attestationComposeHash: result.attestation.evidence?.composeHash ?? null,
        auditReceipt: result.attestation.signature,
        ...runner,
      },
    });
    if (persisted.count !== 1) throw new AppError("Lease d’entraînement expiré", 409);
    return { loanId, modelCid: result.modelCid, runnerReceipt: result.runnerReceipt,
      ...(billingQuote ? {} : { releaseEnvelope: result.releaseEnvelope }) };
  } catch (error) {
    const resolution = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, BigInt(loan.evmLockBlock)).catch(() => undefined);
    await prisma.loan.updateMany({
      where: { id: loanId, status: "TRAINING", modelCid: null, updatedAt: now },
      data: resolution?.state === "cancelled" ? {
        status: "CANCELLED", cancelTxHash: resolution.txHash,
        ...(resolution.retainedFee !== undefined ? { retainedFeeUsdcAtomic: resolution.retainedFee, refundAmountUsdcAtomic: resolution.refundAmount } : {}),
      } : { status: "ESCROWED" },
    });
    if (result?.modelCid && !loan.billingQuote) await unpinModelUnlessReferenced(result.modelCid, dataset.id);
    throw error;
  }
}

export async function settlePreparedLoan(
  loanId: string,
  authorization?: RunnerGrant,
): Promise<SettleResult> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { dataset: true } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!authorization && !loanBillingQuote(loan)) throw new AppError("Autorisation runner manquante", 401);
  if (loan.status === "SETTLED" && loan.modelCid && loan.runnerReceipt && loan.settleTxHash) {
    return { loanId, modelCid: loan.modelCid, runnerReceipt: loan.runnerReceipt, settleTxHash: loan.settleTxHash };
  }
  await assertCurrentRunner(loan);
  if (
    (loan.status !== "TRAINING" && loan.status !== "SETTLING") ||
    !loan.modelCid ||
    !loan.runnerReceipt ||
    !loan.evmLoanKey ||
    !loan.evmLockBlock ||
    !loan.attestationHash ||
    !loan.attestationPayload
  ) {
    throw new AppError("Résultat TEE ou preuve d’attestation absente", 409);
  }
  let payload: LoanAttestationPayload;
  try {
    payload = parseLoanAttestationPayload(loan.attestationPayload);
  } catch {
    throw new AppError("Preuve d’attestation invalide", 409);
  }
  const { chainId, escrow } = evmEscrowBinding();
  if (
    hashLoanAttestationPayload(loan.attestationPayload) !== loan.attestationHash ||
    payload.chainId !== chainId ||
    payload.escrow !== escrow ||
    payload.loanId !== loan.id ||
    payload.loanKey !== loan.evmLoanKey ||
    payload.datasetId !== loan.datasetId ||
    payload.datasetCid !== loan.dataset.ipfsCid ||
    payload.provider !== loan.provider ||
    payload.borrower !== loan.borrower ||
    payload.amountUsdcAtomic !== loan.amountUsdcAtomic ||
    (payload.billingQuoteHash ?? null) !== (loan.billingQuoteHash ?? null) ||
    payload.challengeDays !== loan.dataset.challengeDays ||
    payload.merkleRoot !== loan.dataset.merkleRoot ||
    payload.modelId !== loan.modelId ||
    payload.modelVersion !== loan.modelVersion ||
    payload.modelCid !== loan.modelCid
  ) {
    throw new AppError("Preuve d’attestation incohérente", 409);
  }
  if (process.env.TEE_MODE === "phala") {
    if (!loan.attestationQuote || !loan.attestationEventLog || !loan.attestationComposeHash) {
      throw new AppError("Résultat TEE ou preuve d’attestation absente", 409);
    }
    const verification = await verifyTdxQuote(loan.attestationQuote, loan.attestationHash, {
      eventLog: loan.attestationEventLog,
      composeHash: loan.attestationComposeHash,
    });
    // Quote déjà acceptée (TCB UpToDate) au stockage : un TCB déclassé depuis ne bloque
    // pas le règlement, seule une signature refusée ou révoquée le fait (audit A-01).
    if (
      verification.reportDataMatches !== true ||
      !isRecordedQuoteHardwareValid(verification) ||
      verification.codeIdentityMatches !== true
    ) {
      throw new AppError("Quote TDX runner non authentifiée", 502);
    }
  }
  const claimedAt = new Date(Math.max(Date.now(), loan.updatedAt.getTime() + 1));
  const claimed = await prisma.loan.updateMany({
    where: { id: loanId, status: loan.status, runnerReceipt: loan.runnerReceipt, updatedAt: loan.updatedAt },
    data: { status: "SETTLING", updatedAt: claimedAt },
  });
  if (claimed.count !== 1) throw new AppError("Règlement déjà en cours", 409);

  try {
    // Même palier qu'au lancement : un prêt rapide est réglé après les mêmes confirmations, le
    // reaper le revérifie ensuite sous le bloc finalisé (fast-settlement-review.ts). Coupe-circuit
    // fermé entre-temps : finalité complète, comme avant.
    const settlement = await settleLoanInRunner(
      loanId,
      loan.runnerReceipt,
      payload.releaseEnvelopeHash,
      loan.evmLockBlock,
      authorization,
      effectiveLoanFinalityTier(loan.finalityTier),
    );
    const updated = await prisma.loan.updateMany({
      where: { id: loanId, status: "SETTLING", runnerReceipt: loan.runnerReceipt, updatedAt: claimedAt },
      data: { status: "SETTLED", settleTxHash: settlement.settleTxHash, settledAt: new Date() },
    });
    if (updated.count !== 1) throw new AppError("Règlement de l’escrow confirmé mais état local incohérent", 409);
    // Prêt rapide : preuves de rediffusion du release conservées pour l'opérateur (au mieux, jamais bloquant).
    if (effectiveLoanFinalityTier(loan.finalityTier) === "FAST") await recordSettlementEvidence(loanId);
    return { loanId, modelCid: loan.modelCid, runnerReceipt: loan.runnerReceipt, settleTxHash: settlement.settleTxHash };
  } catch (error) {
    if (error instanceof RunnerFinalityPending) {
      // Transaction diffusée, reçu pas encore finalisé : le prêt reste en règlement, avec
      // son hash, et le reaper ou le borrower reprennent la même transaction plus tard.
      await prisma.loan.updateMany({
        where: { id: loanId, status: "SETTLING", runnerReceipt: loan.runnerReceipt, updatedAt: claimedAt },
        data: { settleTxHash: error.transactionHash, updatedAt: new Date() },
      });
      throw error;
    }
    const resolution = await reconcileLoanEscrow(loan.evmLoanKey as `0x${string}`, BigInt(loan.evmLockBlock)).catch(() => undefined);
    // Échu et toujours verrouillé on-chain : le contrat refuse désormais tout `release`
    // (`ChallengePeriodElapsed`). Un hash de release encore en base désigne alors une transaction
    // rejetée ou jamais minée (« Règlement on-chain rejeté », « Tentative de règlement épuisée »)
    // qui ne peut plus aboutir : il est effacé pour que le prêt retombe sous la règle commune,
    // remboursement par l'emprunteur et aucune relance du reaper (audit A-05). L'attente de
    // finalité (`RunnerFinalityPending`) ne passe jamais ici et garde son hash.
    const deadline = loan.evmDeadline?.getTime();
    const unsettleable = resolution?.state === "active" && deadline !== undefined && deadline <= Date.now();
    await prisma.loan.updateMany({
      where: { id: loanId, status: "SETTLING", runnerReceipt: loan.runnerReceipt, updatedAt: claimedAt },
      data:
        resolution?.state === "settled"
          ? { status: "SETTLED", settleTxHash: resolution.txHash, settledAt: new Date() }
          : resolution?.state === "cancelled"
            ? { status: "CANCELLED", cancelTxHash: resolution.txHash,
              ...(resolution.retainedFee !== undefined ? { retainedFeeUsdcAtomic: resolution.retainedFee, refundAmountUsdcAtomic: resolution.refundAmount } : {}) }
            : unsettleable
              ? { status: "TRAINING", settleTxHash: null }
              : { status: "TRAINING" },
    });
    throw error;
  }
}
