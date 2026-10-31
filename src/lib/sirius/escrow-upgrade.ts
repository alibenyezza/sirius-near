import "server-only";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/app-error";
import { getPublicClient } from "@/lib/evm/client";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { requireCurrentEvmDeployment } from "@/lib/evm/deployment";
import { trustedEscrowBindings } from "@/lib/evm/history";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";

/** Préflight de changement de contrats, indépendant des migrations Prisma déjà appliquées. */
export async function checkEscrowUpgrade(): Promise<void> {
  await requireCurrentEvmDeployment();
  const current = evmEscrowBinding();
  const client = getPublicClient();
  if (await client.getChainId() !== current.chainId) throw new AppError("RPC de migration sur un autre réseau", 409);
  const allowed = trustedEscrowBindings();
  const unbound = await prisma.loan.count({ where: { AND: [
    { OR: [{ evmEscrowAddress: null }, { evmChainId: null }] },
    { OR: [{ evmLoanKey: { not: null } }, { evmLockTxHash: { not: null } },
      { runnerReceipt: { not: null } }, { attestationPayload: { not: null } }] },
  ] } });
  if (unbound) throw new AppError("Migration escrow bloquée : réconcilier les historiques sans déploiement, même clôturés", 409);
  const previous = await prisma.loan.findMany({
    where: { evmEscrowAddress: { not: null } }, distinct: ["evmEscrowAddress", "evmChainId"],
    select: { evmEscrowAddress: true, evmChainId: true },
  });
  if (previous.some(loan => !allowed.some(binding => binding.escrow === loan.evmEscrowAddress && binding.chainId === loan.evmChainId))) {
    throw new AppError("Migration escrow bloquée : déploiement historique non déclaré", 409);
  }
  const outstanding = await prisma.loan.count({ where: {
    status: { in: ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] },
    OR: [{ evmEscrowAddress: null }, { evmEscrowAddress: { not: current.escrow } }],
  } });
  if (outstanding) throw new AppError("Migration escrow bloquée : terminer les prêts de l’ancien déploiement", 409);
  for (const binding of allowed) {
    if (binding.escrow === current.escrow) continue;
    const [locked] = await client.readContract({ address: binding.escrow as `0x${string}`, abi: siriusescrowAbi, functionName: "accounting" });
    if (locked !== BigInt(0)) throw new AppError("Migration escrow bloquée : fonds encore verrouillés dans un ancien escrow", 409);
  }
}
