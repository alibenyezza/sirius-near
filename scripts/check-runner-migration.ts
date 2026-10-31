import "dotenv/config";
import { prisma } from "../src/lib/db";
import { AppError } from "../src/lib/app-error";
import { checkRunnerMigration } from "../src/lib/sirius/runner-migration";

async function main() {
  try {
    const result = await checkRunnerMigration();
    console.log(`Préflight de bascule Phala validé : ${result.runnerDeploymentId}`);
    console.log(`Modèles d’un ancien runner : ${result.historicalJobs} entraînements personnels, ${result.historicalLoans} prêts réglés.`);
    if (result.historicalJobs || result.historicalLoans) {
      console.log("Préserver leur téléchargement et l’environnement historique avant la bascule : Phala ne dispose pas de leurs clés.");
    }
  } catch (error) {
    console.error(error instanceof AppError ? error.message : "Préflight Phala impossible : vérifier la configuration, les migrations, la base et le RPC");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
