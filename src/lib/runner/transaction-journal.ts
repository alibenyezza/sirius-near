import "server-only";
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { decrypt, deriveKey, encrypt, getMasterKey } from "@/lib/crypto/encryption";
import type { BudgetOperation, BudgetPolicy } from "./budget-ledger";

function journalKey(id: string, fingerprint: string): Buffer {
  return deriveKey(getMasterKey(), `runner-transaction:v1:${id}:${fingerprint}`);
}

export function sealRunnerTransaction(id: string, fingerprint: string, serialized: Hex): string {
  return JSON.stringify(encrypt(Buffer.from(serialized.slice(2), "hex"), journalKey(id, fingerprint)));
}

export async function openRunnerTransaction(ciphertext: string, operation: BudgetOperation, policy: BudgetPolicy): Promise<Hex> {
  try {
    const raw: Hex = `0x${decrypt(JSON.parse(ciphertext), journalKey(operation.id, operation.fingerprint)).toString("hex")}`;
    if (!raw.startsWith("0x02")) throw new Error();
    const transaction = parseTransaction(raw);
    const sender = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
    const target = /^(release|failure):(\d+):(0x[a-f0-9]{40}):(0x[a-f0-9]{64})$/.exec(operation.id);
    if (!target || Number(target[2]) !== policy.chainId || keccak256(raw) !== operation.txHash
      || transaction.type !== "eip1559" || transaction.chainId !== policy.chainId
      || sender.toLowerCase() !== policy.wallet || transaction.to?.toLowerCase() !== target[3]
      || transaction.nonce !== operation.nonce || (transaction.value ?? BigInt(0)) !== BigInt(0)
      || !transaction.data || keccak256(transaction.data) !== operation.fingerprint
      || !transaction.gas || !transaction.maxFeePerGas
      || transaction.gas > BigInt(policy.gas.maxGas) || transaction.maxFeePerGas > BigInt(policy.gas.maxFeePerGasWei)
      || transaction.gas * transaction.maxFeePerGas > BigInt(policy.gas.maxTransactionWei)
      || (transaction.maxPriorityFeePerGas ?? BigInt(0)) !== BigInt(0)) throw new Error();
    return raw;
  } catch {
    throw new AppError("Journal de transaction runner invalide : intervention requise", 503);
  }
}
