import { serializeTransaction, type AccessList, type Hex } from "viem";

/**
 * Transaction signée brute reconstituée depuis les champs qu'un nœud rend pour une transaction
 * minée (`eth_getTransactionByHash` : champs décodés plus signature v/r/s). Octet pour octet celle
 * que le wallet a diffusée, donc rediffusable par `eth_sendRawTransaction` tant que son nonce n'est
 * pas consommé. Module pur, sans accès réseau ni base (preuves de rediffusion, settlement-evidence.ts).
 */
export interface SignedTransactionFields {
  type: string;
  chainId: number;
  nonce: number;
  to: Hex | null;
  value: bigint;
  input: Hex;
  gas: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  accessList?: AccessList;
  r: Hex;
  s: Hex;
  v: bigint;
  yParity?: number;
}

export function serializeSignedTransaction(transaction: SignedTransactionFields): Hex {
  const yParity = transaction.yParity ?? (transaction.v === BigInt(28) ? 1 : transaction.v === BigInt(27) ? 0 : Number(transaction.v));
  const signature = { r: transaction.r, s: transaction.s, v: transaction.v, yParity };
  const base = { chainId: transaction.chainId, nonce: transaction.nonce, to: transaction.to ?? undefined, value: transaction.value, data: transaction.input, gas: transaction.gas };
  if (transaction.type === "eip1559") {
    return serializeTransaction({ ...base, type: "eip1559", maxFeePerGas: transaction.maxFeePerGas!, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas!, accessList: transaction.accessList ?? [] }, signature);
  }
  if (transaction.type === "eip2930") {
    return serializeTransaction({ ...base, type: "eip2930", gasPrice: transaction.gasPrice!, accessList: transaction.accessList ?? [] }, signature);
  }
  return serializeTransaction({ ...base, type: "legacy", gasPrice: transaction.gasPrice! }, signature);
}
