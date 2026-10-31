import "dotenv/config";
import { prisma } from "../src/lib/db";
import { AppError } from "../src/lib/app-error";
import { checkEscrowUpgrade } from "../src/lib/sirius/escrow-upgrade";

async function main() {
  try {
    await checkEscrowUpgrade();
    console.log("Préflight Escrow v6 validé. Republier les datasets dans le nouveau registre avant de rouvrir les emprunts.");
  } catch (error) {
    console.error(error instanceof AppError ? error.message : "Préflight escrow impossible : vérifier la configuration, la base et le RPC");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
