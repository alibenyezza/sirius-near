import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/app-error";
import { assertApplicationRunnerConfiguration, requiresPhalaRunner } from "@/lib/runner/config";
import { currentRunnerProvenance } from "@/lib/runner/provenance";
import { checkEscrowUpgrade } from "./escrow-upgrade";

export async function checkRunnerMigration() {
  assertApplicationRunnerConfiguration();
  const current = await currentRunnerProvenance();
  if (!requiresPhalaRunner() || current.runnerKind !== "PHALA") {
    throw new AppError("Le préflight de bascule exige SIRIUS_REQUIRE_PHALA=true et un runner Phala", 409);
  }
  await checkEscrowUpgrade();
  const differentRunner = { OR: [
    { runnerKind: { not: current.runnerKind } },
    { runnerDeploymentId: null },
    { runnerDeploymentId: { not: current.runnerDeploymentId } },
  ] };
  const [datasets, jobs, loans, historicalJobs, historicalLoans] = await Promise.all([
    prisma.dataset.count({ where: { ...differentRunner, status: { in: ["LISTING", "LISTED", "UNLISTED", "PRIVATE"] } } }),
    prisma.trainingJob.count({ where: { ...differentRunner, status: { in: ["PENDING", "RUNNING"] } } }),
    prisma.loan.count({ where: { ...differentRunner, status: { in: ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] } } }),
    prisma.trainingJob.count({ where: { ...differentRunner, status: "DONE", modelCid: { not: null } } }),
    prisma.loan.count({ where: { ...differentRunner, status: "SETTLED", modelCid: { not: null } } }),
  ]);
  if (datasets || jobs || loans) {
    throw new AppError(`Bascule Phala bloquée : ${datasets} datasets à suspendre, ${jobs} entraînements et ${loans} prêts historiques à terminer`, 409);
  }
  return { ...current, historicalJobs, historicalLoans };
}
