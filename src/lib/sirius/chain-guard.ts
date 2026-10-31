import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/app-error";
import { EVM_CHAIN_IDS, type EvmNetwork } from "@/lib/evm/networks";

/**
 * Refuse une base qui appartient à une autre chaîne que celle déployée.
 *
 * Datasets et prêts portent leur chaîne. Réutiliser la base testnet sous mainnet afficherait
 * des prix en 18 décimales lus comme 6 (×10¹²) et des titres pointant vers d'autres contrats ;
 * rien ne l'empêchait jusqu'ici une fois les migrations appliquées (audit M8).
 *
 * Sur mainnet, toute ligne publiée sans chaîne connue est aussi refusée : le lancement se
 * fait sur une base vierge. Lancé avant `prisma migrate deploy`, le contrôle tolère que la
 * colonne Dataset."evmChainId" n'existe pas encore.
 */
export interface ChainCounts {
  foreignLoans: number;
  foreignDatasets: number;
  unknownLoans: number;
  unknownDatasets: number;
}

export function assertChainCounts(network: EvmNetwork, counts: ChainCounts): void {
  if (counts.foreignLoans || counts.foreignDatasets) {
    throw new AppError(
      `Base liée à une autre chaîne : ${counts.foreignDatasets} dataset(s) et ${counts.foreignLoans} prêt(s) ne sont pas sur ${network}`,
      409,
    );
  }
  if (network === "mainnet" && (counts.unknownLoans || counts.unknownDatasets)) {
    throw new AppError(
      `Base non vierge pour mainnet : ${counts.unknownDatasets} dataset(s) et ${counts.unknownLoans} prêt(s) publiés sans chaîne connue`,
      409,
    );
  }
}

export async function checkDatabaseChain(network: EvmNetwork, report: (step: string) => void = () => {}): Promise<void> {
  const chainId = EVM_CHAIN_IDS[network];
  report(`PostgreSQL : contrôle de la chaîne des données (${network}, ${chainId})`);
  const [loans] = await prisma.$queryRaw<{ foreign_count: number; unknown_count: number }[]>`
    SELECT
      COUNT(*) FILTER (WHERE "evmChainId" IS NOT NULL AND "evmChainId" <> ${chainId})::int AS foreign_count,
      COUNT(*) FILTER (WHERE "evmChainId" IS NULL AND "evmLoanKey" IS NOT NULL)::int AS unknown_count
    FROM "Loan"`;
  const [column] = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Dataset' AND column_name = 'evmChainId') AS present`;
  const [datasets] = column?.present
    ? await prisma.$queryRaw<{ foreign_count: number; unknown_count: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE "evmChainId" IS NOT NULL AND "evmChainId" <> ${chainId})::int AS foreign_count,
          COUNT(*) FILTER (WHERE "evmChainId" IS NULL AND "evmDatasetId" IS NOT NULL)::int AS unknown_count
        FROM "Dataset"`
    : await prisma.$queryRaw<{ foreign_count: number; unknown_count: number }[]>`
        SELECT 0 AS foreign_count, COUNT(*) FILTER (WHERE "evmDatasetId" IS NOT NULL)::int AS unknown_count FROM "Dataset"`;
  assertChainCounts(network, {
    foreignLoans: loans?.foreign_count ?? 0,
    unknownLoans: loans?.unknown_count ?? 0,
    foreignDatasets: Number(datasets?.foreign_count ?? 0),
    unknownDatasets: datasets?.unknown_count ?? 0,
  });
}
