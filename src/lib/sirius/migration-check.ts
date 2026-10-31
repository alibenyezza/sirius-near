import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/app-error";
import { readLoan } from "@/lib/evm/escrow";
import { normalizeAddress } from "@/lib/evm/address";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { getPublicClient } from "@/lib/evm/client";
import { checkDatabaseChain } from "./chain-guard";

export async function checkEvmMigration(report: (step: string) => void = () => {}): Promise<void> {
  report("Configuration PostgreSQL");
  const schema = new URL(process.env.DATABASE_URL!).searchParams.get("schema");
  if (schema && schema !== "public") throw new AppError("Préflight EVM : seul le schéma PostgreSQL public est supporté", 409);
  report("PostgreSQL : connexion et détection de la table Loan");
  const tables = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('public."Loan"') IS NOT NULL AS present`;
  if (!tables[0]?.present) return;
  // Avant toute autre vérification et à chaque déploiement : la base doit appartenir à la chaîne visée.
  const network = process.env.EVM_NETWORK?.trim() || "testnet";
  if (network !== "mainnet" && network !== "testnet") throw new AppError("Préflight EVM : EVM_NETWORK invalide", 409);
  await checkDatabaseChain(network, report);
  report("PostgreSQL : lecture de l'historique des migrations Prisma");
  const applied = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "_prisma_migrations"
      WHERE migration_name = '20260905000000_add_dataset_training_profile'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS present`;
  if (applied[0]?.present) return;
  // Champs antérieurs à la migration : exécutable même sur l'ancien schéma.
  report("PostgreSQL : lecture des anciens prêts");
  const loans = await prisma.$queryRaw<{ id: string; evmLoanKey: string | null; evmLockTxHash: string | null }[]>`
    SELECT id, "evmLoanKey", "evmLockTxHash" FROM "Loan"
    WHERE status NOT IN ('SETTLED', 'CANCELLED') OR (status = 'CANCELLED' AND "cancelTxHash" IS NULL)`;
  if (!loans.some((loan) => loan.evmLoanKey)) return;
  report("Configuration du réseau et des anciens escrows");
  const addresses = (process.env.SIRIUS_MIGRATION_ESCROW_ADDRESSES ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean).map((value) => normalizeAddress(value));
  if (!addresses.length || !process.env.EVM_NETWORK) {
    throw new AppError("Migration bloquée : renseigne EVM_NETWORK et SIRIUS_MIGRATION_ESCROW_ADDRESSES (tous les anciens escrows) pour vérifier les prêts, y compris CANCELLED", 409);
  }
  process.env.SIRIUS_ESCROW_ADDRESS = addresses[0];
  process.env.SIRIUS_LEGACY_ESCROW_ADDRESSES = addresses.join(",");
  const { chainId } = evmEscrowBinding();
  report("RPC : vérification du réseau");
  if (await getPublicClient().getChainId() !== chainId) throw new AppError("RPC de migration sur un autre réseau", 409);
  for (const loan of loans) {
    if (!loan.evmLoanKey) continue;
    if (loan.evmLockTxHash) {
      report("RPC : lecture de la transaction de lock");
      const tx = await getPublicClient().getTransaction({ hash: loan.evmLockTxHash as `0x${string}` });
      if (!tx.to || !addresses.includes(normalizeAddress(tx.to))) throw new AppError(`Ancien escrow non déclaré pour ${loan.id}`, 409);
      report("RPC : confirmation de la transaction de lock");
      try {
        await getPublicClient().getTransactionReceipt({ hash: loan.evmLockTxHash as `0x${string}` });
      } catch {
        throw new AppError(`Migration bloquée : transaction de lock non confirmée pour ${loan.id}`, 409);
      }
    }
    report("RPC : vérification de l'état des anciens escrows");
    for (const escrow of addresses) {
      const state = await readLoan(loan.evmLoanKey as `0x${string}`, { chainId, escrow });
      if (state?.status === 1) throw new AppError(`Migration bloquée : escrow encore actif pour ${loan.id}, même si annulé en base`, 409);
    }
  }
}
