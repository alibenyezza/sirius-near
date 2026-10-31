import "server-only";
import { prisma } from "@/lib/db";
import { unpinFromIpfs } from "@/lib/ipfs/pinata";

export async function unpinModelUnlessReferenced(
  modelCid: string,
  datasetId: string,
): Promise<void> {
  try {
    const [loan, trainingJob, activeLoan, activeTrainingJob] = await Promise.all([
      prisma.loan.findFirst({ where: { modelCid }, select: { id: true } }),
      prisma.trainingJob.findFirst({ where: { modelCid }, select: { id: true } }),
      prisma.loan.findFirst({
        where: { datasetId, status: "TRAINING", modelCid: null },
        select: { id: true },
      }),
      prisma.trainingJob.findFirst({
        where: { datasetId, status: "RUNNING" },
        select: { id: true },
      }),
    ]);
    if (loan || trainingJob || activeLoan || activeTrainingJob) return;
    await unpinFromIpfs(modelCid);
  } catch {
    console.error(`[model] unpin compensatoire échoué pour ${modelCid}`);
  }
}
