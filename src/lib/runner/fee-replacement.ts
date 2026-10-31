import { parseTransaction, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { AppError } from "@/lib/app-error";
import type { BudgetPolicy } from "./budget-ledger";
import { boundedGas } from "./gas-policy";

/**
 * Re-signe une transaction runner refusée pour frais trop bas : même réseau, même cible,
 * mêmes données, même nonce, valeur nulle. Seuls la limite de gas et le prix maximal sont
 * recalculés, sous les mêmes plafonds que la signature d'origine.
 */
export async function resignWithFreshFees(
  raw: Hex,
  account: PrivateKeyAccount,
  client: PublicClient,
  gasPolicy: BudgetPolicy["gas"],
): Promise<Hex> {
  const original = parseTransaction(raw);
  if (original.type !== "eip1559" || !original.to || !original.data || original.nonce === undefined
    || !original.chainId || (original.value ?? BigInt(0)) !== BigInt(0)) {
    throw new AppError("Transaction runner à remplacer invalide", 409);
  }
  if (await client.getChainId() !== original.chainId) throw new AppError("RPC sur un autre réseau", 503);
  const [estimate, price, balance] = await Promise.all([
    client.estimateGas({ account, to: original.to, data: original.data, value: BigInt(0) }),
    client.getGasPrice(),
    client.getBalance({ address: account.address, blockTag: "latest" }),
  ]);
  const fees = boundedGas(gasPolicy, estimate, price, balance);
  return account.signTransaction({
    chainId: original.chainId, to: original.to, data: original.data, value: BigInt(0), nonce: original.nonce,
    ...fees, maxPriorityFeePerGas: BigInt(0), type: "eip1559",
  });
}
