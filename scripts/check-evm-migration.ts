import "dotenv/config";
import { prisma } from "../src/lib/db";
import { checkEvmMigration } from "../src/lib/sirius/migration-check";
import { postgresConnectionSummary, preflightErrorMessage } from "./preflight-diagnostics";

async function main() {
  try {
    console.log(`[préflight EVM] ${postgresConnectionSummary(process.env.DATABASE_URL)}`);
    await checkEvmMigration((step) => console.log(`[préflight EVM] ${step}`));
    console.log("Préflight EVM validé");
  } catch (error) {
    console.error(preflightErrorMessage(error));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
