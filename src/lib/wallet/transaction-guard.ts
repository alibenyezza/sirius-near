import { decodeFunctionData, isAddress, type Abi, type Address, type Hex } from "viem";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { datasetRegistryAddress, kybRegistryAddress, usdcAddress } from "@/lib/evm/addresses";

/**
 * Vérifie, avant signature, une transaction construite par le serveur.
 *
 * Retraits, remboursements, publication ou suppression d'un titre et acceptation KYB
 * sont préparés côté serveur puis signés tels quels par le wallet. Si le serveur était
 * compromis, il pourrait substituer un transfert ou une approbation USDC à la place de
 * l'opération attendue. Le navigateur refuse donc tout ce qui ne correspond pas au
 * contrat et à la fonction prévus, et toute transaction qui enverrait de l'ETH.
 */

type Transaction = Record<string, unknown>;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function decoded(transaction: Transaction, abi: Abi) {
  const { to, data, value } = transaction;
  if (typeof to !== "string" || !isAddress(to)) throw new Error("Transaction refusée : destinataire invalide");
  if (value !== undefined && value !== null && BigInt(value as string | number | bigint) !== BigInt(0)) {
    throw new Error("Transaction refusée : envoi d’ETH inattendu");
  }
  if (typeof data !== "string" || !data.startsWith("0x")) throw new Error("Transaction refusée : contenu invalide");
  try {
    return { to: to as Address, call: decodeFunctionData({ abi, data: data as Hex }) };
  } catch {
    throw new Error("Transaction refusée : opération inattendue");
  }
}

function notToken(to: Address) {
  if (same(to, usdcAddress())) throw new Error("Transaction refusée : opération inattendue sur le jeton de règlement");
}

/** Retrait des crédits d'un escrow (actuel ou historique) au profit du compte connecté. */
export function guardWithdrawTransaction(transaction: Transaction, account: string): Transaction {
  const { to, call } = decoded(transaction, siriusescrowAbi as Abi);
  notToken(to);
  const beneficiary = call.functionName === "withdrawFor" ? String(call.args?.[0] ?? "") : null;
  if (call.functionName !== "withdraw" && !(beneficiary && same(beneficiary, account))) {
    throw new Error("Transaction refusée : opération inattendue");
  }
  return transaction;
}

/** Remboursement d'un prêt échu sur son escrow. */
export function guardRefundTransaction(transaction: Transaction): Transaction {
  const { to, call } = decoded(transaction, siriusescrowAbi as Abi);
  notToken(to);
  if (call.functionName !== "refund") throw new Error("Transaction refusée : opération inattendue");
  return transaction;
}

/** Publication ou destruction d'un titre de dataset dans le registre courant. */
export function guardDatasetTransaction(transaction: Transaction, operation: "mint" | "destroy"): Transaction {
  const { to, call } = decoded(transaction, siriusdatasetregistryAbi as Abi);
  if (!same(to, datasetRegistryAddress()) || call.functionName !== operation) {
    throw new Error("Transaction refusée : opération inattendue");
  }
  return transaction;
}

/** Acceptation d'une attestation KYB dans le registre courant. */
export function guardKybTransaction(transaction: Transaction): Transaction {
  const { to, call } = decoded(transaction, siriuskybregistryAbi as Abi);
  if (!same(to, kybRegistryAddress()) || !["acceptAttestation", "attestWithConsent"].includes(call.functionName)) {
    throw new Error("Transaction refusée : opération inattendue");
  }
  return transaction;
}
