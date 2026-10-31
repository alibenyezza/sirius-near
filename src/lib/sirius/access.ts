import "server-only";
import { AppError } from "@/lib/errors";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";
import { normalizeAddress } from "@/lib/evm/address";

async function isKybValid(address: string): Promise<boolean> {
  return getPublicClient().readContract({
    address: kybRegistryAddress(),
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [normalizeAddress(address)],
  });
}

/** KYB de l'appelant lui-même : il peut agir dessus, d'où le 403. */
export async function requireAcceptedKyb(address: string): Promise<void> {
  if (!(await isKybValid(address))) {
    throw new AppError("KYB requis : attestation EVM valide absente", 403);
  }
}

/**
 * KYB d'un tiers à la transaction.
 *
 * `SiriusEscrow.lock` exige une attestation valide pour l'emprunteur *et* pour le
 * fournisseur, et une attestation expire ou se révoque après la publication d'un
 * dataset. Sans ce contrôle, l'emprunteur signe et paie l'`approve` USDC, puis voit
 * le `lock` échouer sur un revert brut — pour une raison qui ne le concerne pas et
 * sur laquelle il ne peut rien.
 *
 * Le statut est 409 et non 403 : ce n'est pas un défaut d'autorisation de l'appelant.
 */
export async function requireCounterpartyKyb(address: string, role: "fournisseur" | "emprunteur"): Promise<void> {
  if (!(await isKybValid(address))) {
    throw new AppError(
      `Emprunt impossible : le ${role} de ce dataset n'a pas d'attestation KYB valide. ` +
        "Elle est absente, expirée ou révoquée, et doit être renouvelée de son côté.",
      409,
    );
  }
}
