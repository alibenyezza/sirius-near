import "server-only";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { evmEscrowBinding, type EvmEscrowBinding } from "@/lib/tee/evm-binding";
import { addressesEqual, normalizeAddress } from "./address";
import { getPublicClient } from "./client";
import { loanIdHash } from "./loan-key";
import { siriusescrowAbi } from "./abi/siriusescrow";
import { siriusescrowv7Abi } from "./abi/siriusescrowv7";

// La lecture historique reste limitée aux déploiements approuvés du même réseau.
export function trustedEscrowBindings(): EvmEscrowBinding[] {
  const current = evmEscrowBinding();
  const addresses = [current.escrow, ...(process.env.SIRIUS_LEGACY_ESCROW_ADDRESSES ?? "").split(",")]
    .map((address) => address.trim()).filter(Boolean).map((address) => normalizeAddress(address));
  return [...new Set(addresses)].map((escrow) => ({ chainId: current.chainId, escrow }));
}

export function trustedEscrowBinding(binding: EvmEscrowBinding): EvmEscrowBinding {
  const escrow = normalizeAddress(binding.escrow);
  if (!trustedEscrowBindings().some((allowed) => allowed.chainId === binding.chainId && allowed.escrow === escrow)) {
    throw new AppError("Déploiement historique non autorisé : configure SIRIUS_LEGACY_ESCROW_ADDRESSES", 409);
  }
  return { chainId: binding.chainId, escrow };
}

export function loanEscrowBinding(loan: {
  evmChainId?: number | null;
  evmEscrowAddress?: string | null;
  runnerReceipt?: string | null;
  attestationPayload?: string | null;
}): EvmEscrowBinding {
  if (loan.evmChainId && loan.evmEscrowAddress) {
    return trustedEscrowBinding({ chainId: loan.evmChainId, escrow: loan.evmEscrowAddress });
  }
  // Métadonnées de la base uniquement : cette lecture ne remplace jamais la
  // vérification HMAC dans le runner, ni la preuve on-chain avant remboursement.
  for (const source of [loan.attestationPayload, loan.runnerReceipt && Buffer.from(loan.runnerReceipt.split(".")[0], "base64url").toString()]) {
    if (!source) continue;
    try {
      const payload = JSON.parse(source) as { chainId?: number; escrow?: string };
      if (typeof payload.chainId === "number" && typeof payload.escrow === "string") {
        return trustedEscrowBinding({ chainId: payload.chainId, escrow: payload.escrow });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
  }
  throw new AppError("Déploiement du prêt absent : réconcilie son lock avant de continuer", 409);
}

export function escrowReadAddress(binding: EvmEscrowBinding): Hex {
  return trustedEscrowBinding(binding).escrow as Hex;
}

export async function resolveLoanEscrow(loan: Parameters<typeof loanEscrowBinding>[0] & { evmLockTxHash?: string | null }): Promise<EvmEscrowBinding> {
  if (loan.evmEscrowAddress || loan.runnerReceipt || loan.attestationPayload) return loanEscrowBinding(loan);
  if (!loan.evmLockTxHash) return loanEscrowBinding(loan);
  const transaction = await getPublicClient().getTransaction({ hash: loan.evmLockTxHash as Hex });
  if (!transaction.to) throw new AppError("Contrat du lock absent", 409);
  return trustedEscrowBinding({ chainId: evmEscrowBinding().chainId, escrow: transaction.to });
}

// v4 précède l'ajout du profil dans le tuple getLoan ; aucun fallback sur erreur RPC.
export const legacyEscrowAbi = parseAbi([
  "function getLoan(bytes32 loanKey) view returns ((address provider, uint96 amount, address borrower, uint40 deadline, uint8 status, bytes32 hashlock, bytes32 preimage, bytes32 datasetId))",
  "function lock(address provider, uint256 amount, bytes32 hashlock, uint8 challengeDays, bytes32 loanIdHash, bytes32 datasetId) returns (bytes32 loanKey)",
  "function lock(address provider, uint256 amount, bytes32 hashlock, uint8 challengeDays, bytes32 loanIdHash, bytes32 datasetId, bytes32 trainingProfile) returns (bytes32 loanKey)",
]);

export function assertLoanLockTransaction(
  transaction: { from: string; to: string | null; input: Hex },
  scope: { loanId: string; borrower: string; escrow: string },
): void {
  if (!addressesEqual(transaction.from, scope.borrower) || !addressesEqual(transaction.to ?? "", scope.escrow)) {
    throw new AppError("Transaction de lock de paiement invalide", 409);
  }
  try {
    const call = decodeFunctionData({ abi: [...siriusescrowAbi, ...legacyEscrowAbi, ...siriusescrowv7Abi], data: transaction.input });
    if (call.functionName === "lock") {
      if (call.args[4] === loanIdHash(scope.loanId)) return;
      const terms = call.args[0];
      if (typeof terms === "object" && terms.loanIdHash === loanIdHash(scope.loanId)) return;
    }
  } catch {
    // Ne pas relayer l'erreur de décodage : elle peut contenir le calldata complet.
  }
  throw new AppError("Transaction étrangère au lock", 409);
}
