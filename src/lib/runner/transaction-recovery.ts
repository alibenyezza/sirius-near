import "server-only";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { AppError } from "@/lib/app-error";
import type { BudgetLedger } from "./budget-ledger";
import { openRunnerTransaction, sealRunnerTransaction } from "./transaction-journal";
import { classifySendError, replaceUnderpricedTransaction } from "./budget-transaction";
import { assertCanonicalReceipt } from "@/lib/evm/finality";

const UNSENT_LEASE_MS = 5 * 60_000;

export async function reconcileRunnerTransactions(
  ledger: BudgetLedger,
  client: PublicClient,
  chainId: number,
  wallet: Address,
  rebroadcast?: (serialized: Hex) => Promise<Hex>,
  resign?: (serialized: Hex) => Promise<Hex>,
): Promise<void> {
  if (ledger.policy.chainId !== chainId || ledger.policy.wallet !== wallet.toLowerCase()) {
    throw new AppError("Identité du compte opérationnel différente du budget", 503);
  }
  if (await client.getChainId() !== chainId) throw new AppError("RPC sur un autre réseau", 503);
  for (const operation of ledger.pendingTransactions()) {
    if (!operation.txHash) {
      ledger.failUnsentTransaction(operation.id, operation.fingerprint, UNSENT_LEASE_MS);
      continue;
    }
    const parts = /^(release|failure):(\d+):(0x[a-f0-9]{40}):(0x[a-f0-9]{64})$/.exec(operation.id);
    if (!parts || Number(parts[2]) !== chainId || !/^0x[a-f0-9]{64}$/.test(operation.txHash)) {
      throw new AppError("Intention runner hors scope : intervention requise", 503);
    }
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: operation.txHash as Hex }); }
    catch {
      if (rebroadcast) {
        const ciphertext = ledger.claimTransactionRebroadcast(operation.id, operation.fingerprint);
        if (ciphertext) {
          const raw = await openRunnerTransaction(ciphertext, operation, ledger.policy);
          try { await rebroadcast(raw); }
          catch (error) {
            // Le même hash reste réservé après perte de réponse. Seul un refus explicite pour
            // frais trop bas autorise une re-signature au même nonce.
            if (classifySendError(error) === "fee-too-low" && resign && operation.nonce !== null) {
              await replaceUnderpricedTransaction(ledger, operation.id, operation.fingerprint, operation.nonce, raw, {
                latestNonce: () => client.getTransactionCount({ address: wallet, blockTag: "latest" }),
                resign, send: rebroadcast,
                seal: (serialized) => sealRunnerTransaction(operation.id, operation.fingerprint, serialized),
              }).catch(() => { console.warn(`[runner] remplacement de ${operation.id} impossible : intervention requise`); });
            }
          }
        }
      }
      continue;
    }
    const transaction = await client.getTransaction({ hash: operation.txHash as Hex });
    if (receipt.transactionHash.toLowerCase() !== operation.txHash
      || receipt.from.toLowerCase() !== wallet.toLowerCase() || receipt.to?.toLowerCase() !== parts[3]
      || transaction.from.toLowerCase() !== wallet.toLowerCase() || transaction.to?.toLowerCase() !== parts[3]
      || transaction.nonce !== operation.nonce || keccak256(transaction.input) !== operation.fingerprint) {
      throw new AppError("Transaction runner hors scope : intervention requise", 503);
    }
    try { await assertCanonicalReceipt(client, receipt, ledger.policy.gas.confirmations); }
    catch { continue; }
    ledger.finish(operation.id, operation.fingerprint, receipt.status === "success");
  }
}
