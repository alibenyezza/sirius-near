import "server-only";
import { prisma, serializableTransaction } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { runSelfTrainingInRunner } from "@/lib/tee/runner-client";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { requireAcceptedKyb } from "@/lib/sirius/access";
import { unpinModelUnlessReferenced } from "@/lib/sirius/model-storage";
import { modelSelection } from "@/lib/models/registry";
import { assertDatasetScope } from "@/lib/evm/dataset";
import { requireCurrentEvmDeployment } from "@/lib/evm/deployment";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import type { RunnerDeliveryEnvelope } from "@/lib/tee/contract";

export interface SelfTrainResult {
  jobId: string;
  modelCid: string;
  runnerReceipt: string;
  metrics: Record<string, number>;
  modelKeyEnvelope?: RunnerDeliveryEnvelope;
}

const MAX_RUNNING_JOBS = 1;
const MAX_JOBS_PER_HOUR = 3;
const MAX_GLOBAL_RUNNING_JOBS = 1;
const MAX_GLOBAL_JOBS_PER_HOUR = 30;
const STALE_JOB_MS = 2 * 60_000;

/**
 * Self-train (MLaaS, D-19) : entraînement sur son PROPRE dataset. Aucun escrow ni
 * fair-exchange — le propriétaire a déjà l'accès, il n'y a personne à payer. Le TEE
 * déchiffre, entraîne et rend le modèle chiffré sous une clé livrée directement.
 */
export async function runSelfTrain(
  datasetId: string,
  owner: string,
  jobId: string,
  datasetReceipt: string,
  authorization: RunnerGrant,
  deliveryPublicKey?: string,
): Promise<SelfTrainResult> {
  await requireAcceptedKyb(owner);
  await requireCurrentEvmDeployment();
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId }, omit: { wrappedKey: false } });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (dataset.provider !== owner) throw new AppError("Self-train réservé au propriétaire du dataset", 403);
  const runner = await assertCurrentRunner(dataset);
  if (
    !dataset.ipfsCid ||
    !dataset.merkleRoot ||
    !dataset.wrappedKey ||
    !dataset.runnerReceipt ||
    !dataset.priceUsdcAtomic ||
    !dataset.evmDatasetId ||
    !["LISTED", "UNLISTED", "PRIVATE"].includes(dataset.status)
  ) {
    throw new AppError("Publie d’abord le titre EVM du dataset avant l’entraînement", 409);
  }
  if (dataset.runnerReceipt !== datasetReceipt) throw new AppError("Reçu dataset invalide", 400);
  const model = modelSelection(dataset.modelId, dataset.modelVersion);
  if (!model) throw new AppError("Profil d’entraînement du dataset absent ou invalide", 409);

  await assertDatasetScope({
    datasetId: dataset.id,
    provider: dataset.provider,
    merkleRoot: dataset.merkleRoot,
    cid: dataset.ipfsCid,
    model,
  });

  const job = await serializableTransaction(async (tx) => {
    const now = Date.now();
    const since = new Date(now - 3_600_000);
    await tx.trainingJob.updateMany({
      where: { status: "RUNNING", updatedAt: { lt: new Date(now - STALE_JOB_MS) } },
      data: { status: "FAILED", completedAt: new Date() },
    });
    const [running, recent, globalRunning, globalRecent] = await Promise.all([
      tx.trainingJob.count({ where: { owner, status: "RUNNING" } }),
      tx.trainingJob.count({ where: { owner, createdAt: { gte: since } } }),
      tx.trainingJob.count({ where: { status: "RUNNING" } }),
      tx.trainingJob.count({ where: { createdAt: { gte: since } } }),
    ]);
    if (running >= MAX_RUNNING_JOBS || globalRunning >= MAX_GLOBAL_RUNNING_JOBS) {
      throw new AppError("Runner occupé par un autre entraînement", 429);
    }
    if (recent >= MAX_JOBS_PER_HOUR || globalRecent >= MAX_GLOBAL_JOBS_PER_HOUR) {
      throw new AppError("Quota d’entraînement atteint — réessaie plus tard", 429);
    }
    return tx.trainingJob.create({
      data: { id: jobId, datasetId: dataset.id, owner, modelId: model.modelId, modelVersion: model.modelVersion, status: "RUNNING", ...runner },
    });
  });

  let modelCid: string | undefined;
  try {
    const out = await runSelfTrainingInRunner({
      datasetId: dataset.id,
      cid: dataset.ipfsCid,
      wrappedKey: dataset.wrappedKey,
      merkleRoot: dataset.merkleRoot,
      priceUsdcAtomic: dataset.priceUsdcAtomic,
      challengeDays: dataset.challengeDays,
      jobId: job.id,
      ...model,
    }, datasetReceipt, authorization, deliveryPublicKey);
    if (deliveryPublicKey && !out.modelKeyEnvelope) throw new AppError("Livraison chiffrée manquante", 502);
    modelCid = out.modelCid;
    const completed = await prisma.trainingJob.updateMany({
      where: { id: job.id, status: "RUNNING", updatedAt: job.updatedAt },
      data: {
        status: "DONE",
        modelCid,
        metrics: out.metrics,
        runnerReceipt: out.runnerReceipt,
        ...(out.modelKeyEnvelope ? {
          deliveryPublicKey,
          deliveryEnvelope: JSON.parse(JSON.stringify(out.modelKeyEnvelope)),
        } : {}),
        completedAt: new Date(),
      },
    });
    if (completed.count !== 1) throw new AppError("Le lease d’entraînement a expiré", 409);
    return { jobId: job.id, modelCid, runnerReceipt: out.runnerReceipt, metrics: out.metrics,
      ...(out.modelKeyEnvelope ? { modelKeyEnvelope: out.modelKeyEnvelope } : {}) };
  } catch (err) {
    await prisma.trainingJob.updateMany({
      where: { id: job.id, status: "RUNNING", updatedAt: job.updatedAt },
      data: { status: "FAILED", completedAt: new Date() },
    });
    if (modelCid) await unpinModelUnlessReferenced(modelCid, dataset.id);
    throw err;
  }
}
