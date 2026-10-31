import "server-only";
import {
  escrowHashlock,
  escrowLock,
  evmLoanModelKey,
  runEvmLoanJob,
  runBilledEvmLoanJob,
  runSelfTraining,
  selfTrainModelKey,
} from "@/lib/tee/core";
import { attestLoanExecution } from "@/lib/tee/attestation";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { assertLoanScope, authorizeEscrowLock, publishedFinalizedPreimage, publishedPreimage, settleEscrow } from "@/lib/evm/escrow";
import { assertDatasetScope } from "@/lib/evm/dataset";
import { isValidUsdcAtomicAmount } from "@/lib/evm/usdc";
import { loanIdHash, loanKeyFor } from "@/lib/evm/loan-key";
import { normalizeAddress } from "@/lib/evm/address";
import { datasetIdHash } from "@/lib/evm/dataset-key";
import { datasetRegistryAddress } from "@/lib/evm/addresses";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { getPublicClient } from "@/lib/evm/client";
import { canonicalSubject } from "@/lib/subject";
import { modelSelection, trainingProfileHash, type ModelSelection } from "@/lib/models/registry";
import { AppError } from "@/lib/app-error";
import { datasetIngressPublicKey } from "@/lib/tee/ingress";
import { sealDatasetEnvelope } from "@/lib/tee/core";
import { verifyRunnerGrant } from "@/lib/runner/authorization";
import { assertTrialSubject, budgetRunnerJob, budgetRunnerRequest, withWorkflowBudget } from "@/lib/runner/budget";
import { billingEnabled } from "@/lib/billing/config";
import { assertQuoteDataset, prepareComputeQuote, quoteWorkflow, requireBillingBudget, runnerComputeQuote } from "@/lib/billing/runner";
import { failBilledEscrow, settleBilledEscrow } from "@/lib/billing/settlement";
import { recoverBilledLoanResult } from "@/lib/billing/recovery";
import {
  assertReleaseEnvelopeHash,
  issueDatasetReceipt,
  issueLoanReceipt,
  issueTrainingReceipt,
  verifyDatasetReceipt,
  verifyLoanReceipt,
  verifyLoanDeliveryReceipt,
  verifyTrainingReceipt,
} from "@/lib/runner/receipt";
import {
  encryptRunnerDelivery,
  validateDeliveryPublicKey,
  encryptRunnerRelease,
  hashRunnerReleaseEnvelope,
} from "@/lib/runner/delivery";
import type { DatasetIngressEnvelope, DatasetRef } from "@/lib/tee/contract";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { checkDemoOperation, demoEnabled, demoGrantScope, withDemoAdmission } from "@/lib/phala-demo/runner-session";
import type { RunnerOperation, RunnerScope } from "@/lib/runner/capability";
import { fastFinalityPolicy } from "@/lib/evm/finality";
import { enclaveFinalityTier, type FinalityTier } from "@/lib/evm/fast-finality";
import { totalQuoteAmount, type ComputeQuote } from "@/lib/billing/quote";
import { RunnerRetryLater } from "@/lib/runner/failure-policy";
import { LOCK_FINALITY_PENDING } from "@/lib/loans/settlement-status";

const MAX_ID_LENGTH = 128;

/**
 * Palier de finalité d'un prêt v7, arbitré par l'enclave seule (fast-finality.ts). Le montant vient
 * du devis qu'elle a signé et que `matchesScope` lie aux termes on-chain, jamais du corps de la
 * requête ; les bornes viennent de son environnement attesté (Compose). Next peut demander le
 * palier rapide, l'enclave ne l'accorde que si sa politique l'admet pour ce montant, et refuse
 * explicitement sinon : jamais de profondeur rapide pour un prêt au-dessus du seuil.
 *
 * Cette décision ne réserve rien : règlement et livraison de clé la reprennent telle quelle. Le
 * plafond d'exposition de l'enclave (`reserveFastExposure`) n'est engagé qu'au lancement du calcul,
 * une fois le lock lu à la profondeur rapide : voir `run-loan-job`.
 */
function loanFinalityTier(requested: unknown, quote: ComputeQuote): FinalityTier {
  const tier = enclaveFinalityTier(requested, BigInt(totalQuoteAmount(quote)), fastFinalityPolicy());
  if (tier === null) throw new AppError("Finalité rapide refusée par l’enclave pour ce prêt", 409);
  return tier;
}

/**
 * Plafond d'exposition propre à l'enclave : la somme des prêts rapides verrouillés non libérés est
 * tenue dans son registre persistant (`fast_exposure`, budget-ledger.ts) et bornée par la constante
 * attestée SIRIUS_FAST_FINALITY_TOTAL_USDC. Appelé au lancement seulement, après lecture du lock à
 * la profondeur rapide ; idempotent pour un même prêt ; la part est rendue au release ou au
 * remboursement confirmés, à l'échec définitif du règlement, et purgée après l'échéance du prêt.
 * Jamais sur la livraison de clé : le release l'a déjà rendue, la réserver à nouveau figerait le
 * plafond jusqu'à l'échéance de prêts pourtant clos.
 */
function reserveFastExposure(quote: ComputeQuote): boolean {
  const config = fastFinalityPolicy();
  const deadlineMs = (quote.expiresAt + quote.challengeDays * 86_400) * 1_000;
  return requireBillingBudget().reserveFastExposure(quoteWorkflow(quote), BigInt(totalQuoteAmount(quote)), config.totalInFlightAtomic, deadlineMs);
}
const MAX_CID_LENGTH = 256;
const MAX_WRAPPED_KEY_LENGTH = 1_024;
const MAX_RECEIPT_LENGTH = 8_192;

function text(body: Record<string, unknown>, key: string, maxLength = MAX_ID_LENGTH): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AppError(`${key} invalide`, 400);
  }
  return value;
}

function boundedInteger(body: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AppError(`${key} invalide`, 400);
  }
  return value as number;
}

function usdcAmount(body: Record<string, unknown>, key: string): string {
  const value = text(body, key, 26);
  if (!isValidUsdcAtomicAmount(value)) throw new AppError(`${key} invalide`, 400);
  return value;
}

function datasetRef(body: Record<string, unknown>): DatasetRef {
  return {
    datasetId: text(body, "datasetId"),
    cid: text(body, "cid", MAX_CID_LENGTH),
    wrappedKey: text(body, "wrappedKey", MAX_WRAPPED_KEY_LENGTH),
    merkleRoot: text(body, "merkleRoot", 128),
    priceUsdcAtomic: usdcAmount(body, "priceUsdcAtomic"),
    challengeDays: boundedInteger(body, "challengeDays", 1, 30),
    ...trainingModel(body),
  };
}

function trainingModel(body: Record<string, unknown>): ModelSelection {
  const selection = modelSelection(body.modelId, body.modelVersion);
  if (!selection) throw new AppError("Modèle ou version non autorisé", 400);
  return selection;
}

function ingressEnvelope(body: Record<string, unknown>): DatasetIngressEnvelope {
  const value = body.envelope;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("Enveloppe dataset manquante", 400);
  }
  return value as DatasetIngressEnvelope;
}

export function loanDeliveryContext(loanId: string, subject: string): string {
  return `loan:${canonicalSubject(subject)}:${loanId}`;
}

export function selfTrainDeliveryContext(jobId: string, owner: string): string {
  return `self-train:${canonicalSubject(owner)}:${jobId}`;
}

export function scopeForRunnerOp(op: string, body: Record<string, unknown>): { op: RunnerOperation; scope: RunnerScope } {
  switch (op) {
    case "dataset-ingress-key":
      return { op, scope: {} };
    case "seal-dataset":
      return { op, scope: { datasetId: text(body, "datasetId") } };
    case "prepare-escrow-lock":
      return { op, scope: { datasetId: text(body, "datasetId"), loanId: text(body, "loanId"), borrower: text(body, "borrower") } };
    case "run-loan-job":
      return { op, scope: { datasetId: text(body, "datasetId"), loanId: text(body, "loanId") } };
    case "settle-loan":
    case "recover-loan-job":
    case "loan-model-key":
      return { op, scope: { loanId: text(body, "loanId") } };
    case "run-training":
      return { op, scope: { datasetId: text(body, "datasetId"), jobId: text(body, "jobId") } };
    case "self-train-key":
      return { op, scope: { jobId: text(body, "jobId") } };
    default:
      throw new AppError("Opération runner inconnue", 404);
  }
}

export async function handleRunnerOp(op: RunnerOperation, body: Record<string, unknown>): Promise<unknown> {
  checkDemoOperation(op);
  if (billingEnabled() && (op === "run-loan-job" || op === "settle-loan" || op === "loan-model-key" || op === "recover-loan-job")) return executeRunnerOp(op, body);
  return budgetRunnerRequest(() => executeRunnerOp(op, body));
}

async function executeRunnerOp(op: RunnerOperation, body: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "dataset-ingress-key":
      return datasetIngressPublicKey();

    case "seal-dataset": {
      const datasetId = text(body, "datasetId");
      const priceUsdcAtomic = usdcAmount(body, "priceUsdcAtomic");
      const challengeDays = boundedInteger(body, "challengeDays", 1, 30);
      const sizeBytes = boundedInteger(body, "sizeBytes", 1, MAX_DATASET_BYTES);
      const envelope = ingressEnvelope(body);
      const model = trainingModel(body);
      const demoScope = demoGrantScope();
      const { subject } = await verifyRunnerGrant(body.authorization, {
        ...demoScope,
        operation: op,
        datasetId,
        intentParts: [
          datasetId,
          priceUsdcAtomic,
          String(challengeDays),
          String(sizeBytes),
          envelope.ciphertext,
          model.modelId,
          model.modelVersion,
        ],
      });
      const result = await withDemoAdmission(`seal:${datasetId}`, canonicalSubject(subject),
        { envelope, sizeBytes, model, priceUsdcAtomic, challengeDays }, () => budgetRunnerJob("seal", [evmEscrowBinding(), canonicalSubject(subject), datasetId],
        { envelope, sizeBytes, model, priceUsdcAtomic, challengeDays },
        () => sealDatasetEnvelope(datasetId, envelope, sizeBytes, model)), demoScope.demoSessionRevision);
      return {
        ...result,
        runnerReceipt: issueDatasetReceipt(subject, {
          datasetId,
          cid: result.cid,
          wrappedKey: result.wrappedKey,
          merkleRoot: result.merkleRoot,
          priceUsdcAtomic,
          challengeDays,
          ...model,
        }),
      };
    }

    case "prepare-escrow-lock": {
      const dataset = datasetRef(body);
      const loanId = text(body, "loanId");
      const borrower = canonicalSubject(text(body, "borrower"));
      const receipt = verifyDatasetReceipt(text(body, "datasetReceipt", MAX_RECEIPT_LENGTH), dataset);
      const provider = normalizeAddress(receipt.owner);
      assertTrialSubject(borrower);
      assertTrialSubject(provider);
      if (provider === borrower) throw new AppError("Un provider ne peut pas emprunter son propre dataset", 400);
      await assertDatasetScope({ ...dataset, provider, model: dataset });
      const onChainDatasetId = await getPublicClient().readContract({
        address: datasetRegistryAddress(), abi: siriusdatasetregistryAbi, functionName: "datasetIdOf",
        args: [provider, datasetIdHash(dataset.datasetId)],
      });
      const hashlock = escrowHashlock(loanId, borrower);
      if (billingEnabled()) {
        const billingQuote = await prepareComputeQuote({
          dataset, datasetReceipt: text(body, "datasetReceipt", MAX_RECEIPT_LENGTH), borrower, provider, loanId,
          onChainDatasetId, hashlock, authorizationDeadline: boundedInteger(body, "authorizationDeadline", 1, 2 ** 40 - 1),
        });
        return { hashlock, authorization: billingQuote.authorization, billingQuote };
      }
      const authorization = await authorizeEscrowLock({
        borrower, provider, amount: BigInt(receipt.priceUsdcAtomic), hashlock,
        challengeDays: receipt.challengeDays, loanIdHash: loanIdHash(loanId),
        datasetId: onChainDatasetId, trainingProfile: trainingProfileHash(dataset),
      }, boundedInteger(body, "authorizationDeadline", 1, 2 ** 40 - 1));
      return { hashlock, authorization };
    }

    case "run-loan-job": {
      const dataset = datasetRef(body);
      const loanId = text(body, "loanId");
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId: dataset.datasetId,
        loanId,
        intentParts: [loanId, dataset.datasetId, datasetReceiptToken, deliveryPublicKey, dataset.modelId, dataset.modelVersion],
      });
      const borrower = canonicalSubject(subject);
      const loanKey = loanKeyFor(borrower, loanId);
      const { hashlock, preimage } = escrowLock(loanId, borrower);
      const signedQuote = billingEnabled() ? await runnerComputeQuote(body.billingQuote) : undefined;
      if (signedQuote) assertQuoteDataset(signedQuote.quote, dataset, datasetReceiptToken, borrower, loanId);
      const candidateTier: FinalityTier = signedQuote ? loanFinalityTier(body.finalityTier, signedQuote.quote) : "FULL";
      const loanScope = (finalityTier: FinalityTier) => assertLoanScope({
        loanKey,
        borrower,
        provider: datasetReceipt.owner,
        datasetId: dataset.datasetId,
        amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
        hashlock,
        model: dataset,
        ...(signedQuote ? { billingQuote: signedQuote.quote, finalityTier } : {}),
      });
      const execute = async () => {
        await Promise.all([
          assertDatasetScope({
            datasetId: dataset.datasetId,
            provider: datasetReceipt.owner,
            merkleRoot: dataset.merkleRoot,
            cid: dataset.cid,
            model: dataset,
          }),
          loanScope(candidateTier),
        ]);
        // Lock lu à la profondeur rapide : la part de ce prêt entre maintenant dans le plafond de
        // l'enclave. Plafond atteint ⇒ le prêt est traité à finalité complète si son lock est déjà
        // sous le bloc finalisé ; sinon « en attente », le même message que Next rend à la page
        // Train pour un lock pas encore stable, sans compter d'échec ni consommer de crédit (le
        // palier de Next, lui, reste rapide : il réessaie, le plafond se libère au fil des releases).
        if (signedQuote && candidateTier === "FAST" && !reserveFastExposure(signedQuote.quote)) {
          console.warn(`[runner] plafond d'exposition rapide atteint : prêt ${loanId} traité à finalité complète`);
          try { await loanScope("FULL"); } catch { throw new RunnerRetryLater(LOCK_FINALITY_PENDING); }
        }

        if (signedQuote) {
          requireBillingBudget().prepareWorkflowResult(quoteWorkflow(signedQuote.quote), JSON.stringify({
            datasetCid: dataset.cid, merkleRoot: dataset.merkleRoot, deliveryPublicKey,
          }));
        }
        let result;
        try {
          result = signedQuote
            ? await runBilledEvmLoanJob({ ...dataset, loanId, borrower }, signedQuote.quote)
            : await runEvmLoanJob({ ...dataset, loanId, borrower });
        } catch (error) {
          if (signedQuote) {
            await failBilledEscrow(signedQuote.quote, loanKey);
            throw new AppError("Calcul échoué : remboursement crédité après retenue des frais consommés", 422);
          }
          throw error;
        }
        if (signedQuote) {
          const recovered = await recoverBilledLoanResult(signedQuote);
          if (recovered.state !== "ready") throw new AppError("Résultat durable manquant", 503);
          return recovered.result;
        }
        const releaseEnvelope = encryptRunnerRelease(
          evmLoanModelKey(loanId, borrower), deliveryPublicKey,
          loanDeliveryContext(loanId, borrower), preimage, "evm-preimage",
        );
        const { chainId, escrow } = evmEscrowBinding();
        const releaseEnvelopeHash = hashRunnerReleaseEnvelope(releaseEnvelope);
        const attestation = await attestLoanExecution({
          chainId,
          escrow,
          loanId,
          loanKey,
          datasetId: dataset.datasetId,
          datasetCid: dataset.cid,
          provider: datasetReceipt.owner,
          borrower,
          amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
          challengeDays: datasetReceipt.challengeDays,
          merkleRoot: dataset.merkleRoot,
          modelId: dataset.modelId,
          modelVersion: dataset.modelVersion,
          modelCid: result.modelCid,
          releaseEnvelopeHash,
        });
        return {
          modelCid: result.modelCid,
          metrics: result.metrics,
          attestation,
          loanKey,
          hashlock,
          ...(releaseEnvelope ? { releaseEnvelope } : {}),
          releaseEnvelopeHash,
          runnerReceipt: issueLoanReceipt({
            loanId,
            datasetId: dataset.datasetId,
            borrower,
            provider: datasetReceipt.owner,
            modelCid: result.modelCid,
            loanKey,
            chainId,
            escrow,
            amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
            challengeDays: datasetReceipt.challengeDays,
            modelId: dataset.modelId,
            modelVersion: dataset.modelVersion,
            deliveryPublicKey,
            releaseEnvelopeHash,
            attestationHash: attestation.payloadHash,
          }),
        };
      };
      return signedQuote ? withWorkflowBudget(quoteWorkflow(signedQuote.quote), () => budgetRunnerRequest(execute)) : execute();
    }

    case "recover-loan-job": {
      if (!billingEnabled()) throw new AppError("Reprise réservée aux prêts v7", 409);
      const loanId = text(body, "loanId");
      const signed = await runnerComputeQuote(body.billingQuote);
      if (signed.quote.loanId !== loanId) throw new AppError("Devis compute hors scope", 409);
      const ledger = requireBillingBudget();
      const scope = quoteWorkflow(signed.quote);
      if (!ledger.workflowResult(scope)) return { state: "missing" };
      if (!ledger.executionEvidence(scope)) return { state: "pending" };
      return withWorkflowBudget(quoteWorkflow(signed.quote), () => budgetRunnerRequest(() => recoverBilledLoanResult(signed)));
    }

    case "settle-loan": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const releaseEnvelopeHash = text(body, "releaseEnvelopeHash", 64);
      const receipt = verifyLoanReceipt(loanReceiptToken, loanId);
      assertReleaseEnvelopeHash(receipt, releaseEnvelopeHash);
      const { preimage } = escrowLock(loanId, receipt.borrower);
      const lockBlock = BigInt(text(body, "lockBlock", 20));
      if (billingEnabled()) {
        const signedQuote = await runnerComputeQuote(receipt.billingQuote);
        if (signedQuote.quote.loanId !== loanId || signedQuote.quote.borrower !== receipt.borrower) throw new AppError("Devis compute hors scope", 409);
        if (body.authorization) {
          const { subject } = await verifyRunnerGrant(body.authorization, {
            operation: op, loanId, intentParts: [loanId, loanReceiptToken],
          });
          if (canonicalSubject(subject) !== receipt.borrower) throw new AppError("Règlement réservé au borrower", 403);
        }
        const finalityTier = loanFinalityTier(body.finalityTier, signedQuote.quote);
        return withWorkflowBudget(quoteWorkflow(signedQuote.quote), () => budgetRunnerRequest(async () => ({
          settleTxHash: await settleBilledEscrow(signedQuote.quote, receipt.loanKey as `0x${string}`, preimage, lockBlock, finalityTier),
        })));
      }
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op, loanId, intentParts: [loanId, loanReceiptToken],
      });
      if (canonicalSubject(subject) !== receipt.borrower) throw new AppError("Règlement réservé au borrower", 403);
      return { settleTxHash: await settleEscrow(receipt.loanKey as `0x${string}`, preimage, lockBlock) };
    }

    case "loan-model-key": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const receipt = verifyLoanDeliveryReceipt(loanReceiptToken, loanId);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        loanId,
        intentParts: [loanId, loanReceiptToken, deliveryPublicKey],
      });
      if (canonicalSubject(subject) !== receipt.borrower) throw new AppError("Clé réservée au borrower", 403);
      const deliver = async () => {
        if (receipt.billingQuote) {
          const signed = await runnerComputeQuote(receipt.billingQuote, false, receipt);
          const settleTxHash = text(body, "settleTxHash", 66);
          if (!/^0x[0-9a-fA-F]{64}$/.test(settleTxHash)) throw new AppError("Hash de règlement invalide", 400);
          await publishedFinalizedPreimage(receipt.loanKey as `0x${string}`,
            settleTxHash as `0x${string}`, signed.quote,
            requireBillingBudget().policy.gas.confirmations, loanFinalityTier(body.finalityTier, signed.quote));
        } else await publishedPreimage(receipt.loanKey as `0x${string}`, receipt);
        return {
          modelCid: receipt.modelCid,
          modelKeyEnvelope: encryptRunnerDelivery(
            evmLoanModelKey(loanId, receipt.borrower, receipt),
            deliveryPublicKey,
            loanDeliveryContext(loanId, receipt.borrower),
          ),
        };
      };
      if (billingEnabled()) {
        if (receipt.billingQuote) {
          const signed = await runnerComputeQuote(receipt.billingQuote, false, receipt);
          if ((signed.quote.expiresAt + signed.quote.challengeDays * 86400) * 1000 > Date.now()) {
            return withWorkflowBudget(quoteWorkflow(signed.quote), () => budgetRunnerRequest(deliver));
          }
        }
        return budgetRunnerRequest(deliver);
      }
      return deliver();
    }

    case "run-training": {
      const dataset = datasetRef(body);
      const jobId = text(body, "jobId");
      const deliveryPublicKey = body.deliveryPublicKey === undefined ? undefined : text(body, "deliveryPublicKey", 200);
      if (demoEnabled() && !deliveryPublicKey) throw new AppError("Clé de livraison requise pour la démonstration", 400);
      if (deliveryPublicKey) validateDeliveryPublicKey(deliveryPublicKey);
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const demoScope = demoGrantScope();
      const { subject } = await verifyRunnerGrant(body.authorization, {
        ...demoScope,
        operation: op,
        datasetId: dataset.datasetId,
        jobId,
        intentParts: [dataset.datasetId, jobId, datasetReceiptToken, dataset.modelId, dataset.modelVersion, ...(deliveryPublicKey ? [deliveryPublicKey] : [])],
      });
      if (canonicalSubject(subject) !== canonicalSubject(datasetReceipt.owner)) {
        throw new AppError("Self-train réservé au propriétaire", 403);
      }
      await assertDatasetScope({
        datasetId: dataset.datasetId,
        provider: datasetReceipt.owner,
        merkleRoot: dataset.merkleRoot,
        cid: dataset.cid,
        model: dataset,
      });
      const result = await withDemoAdmission(`train:${jobId}`, canonicalSubject(subject), { ...dataset, jobId, deliveryPublicKey }, async () => {
        const trained = await runSelfTraining({ ...dataset, jobId, owner: subject });
        return { ...trained, ...(deliveryPublicKey ? { modelKeyEnvelope: encryptRunnerDelivery(
          selfTrainModelKey(jobId, subject), deliveryPublicKey, selfTrainDeliveryContext(jobId, subject),
        ) } : {}) };
      }, demoScope.demoSessionRevision);
      return {
        ...result,
        runnerReceipt: issueTrainingReceipt({
          jobId,
          datasetId: dataset.datasetId,
          owner: subject,
          modelCid: result.modelCid,
          modelId: dataset.modelId,
          modelVersion: dataset.modelVersion,
        }),
      };
    }

    case "self-train-key": {
      const jobId = text(body, "jobId");
      const receipt = verifyTrainingReceipt(text(body, "jobReceipt", MAX_RECEIPT_LENGTH), jobId);
      const deliveryPublicKey = text(body, "deliveryPublicKey", 200);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        jobId,
        intentParts: [jobId, text(body, "jobReceipt", MAX_RECEIPT_LENGTH), deliveryPublicKey],
      });
      if (canonicalSubject(subject) !== canonicalSubject(receipt.owner)) throw new AppError("Clé réservée au propriétaire", 403);
      return {
        modelKeyEnvelope: encryptRunnerDelivery(
          selfTrainModelKey(jobId, receipt.owner),
          deliveryPublicKey,
          selfTrainDeliveryContext(jobId, receipt.owner),
        ),
      };
    }
  }
}
