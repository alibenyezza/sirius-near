import { createWalletClient, http, type Hex, type PublicClient } from "viem";
import { getPublicClient } from "../src/lib/evm/client";
import { resolveServerNetwork } from "../src/lib/evm/networks";
import { settlementAccount } from "../src/lib/evm/runner-account";
import { runnerBudget } from "../src/lib/runner/budget";
import type { BudgetLedger, BudgetOperation } from "../src/lib/runner/budget-ledger";
import { resignWithFreshFees } from "../src/lib/runner/fee-replacement";
import { reconcileRunnerTransactions } from "../src/lib/runner/transaction-recovery";
import { initEnclave } from "../src/lib/tee/dstack";

const USAGE = "Usage : pnpm runner:transactions <reconcile|rebroadcast>\n"
  + "        pnpm runner:transactions abandon <id-operation> --actor=<nom> --reason=<motif>";

export function parseTransactionsCommand(argv: string[]) {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of argv) {
    const flag = /^--(actor|reason)=([\s\S]+)$/.exec(arg);
    if (flag) flags.set(flag[1], flag[2]);
    else if (arg.startsWith("--")) throw new Error(USAGE);
    else positional.push(arg);
  }
  const [command, ...extra] = positional;
  if (command === "abandon") {
    if (extra.length !== 1 || !flags.get("actor")?.trim() || !flags.get("reason")?.trim()) throw new Error(USAGE);
    return { command, operationId: extra[0], actor: flags.get("actor")!, reason: flags.get("reason")! } as const;
  }
  if ((command !== "reconcile" && command !== "rebroadcast") || extra.length || flags.size) throw new Error(USAGE);
  return { command } as const;
}

/**
 * Un abandon n'est sûr que si la transaction ne peut plus être incluse : jamais signée, ou
 * son nonce déjà consommé par une autre transaction du wallet. Une transaction dont le reçu
 * existe passe par la réconciliation, jamais par l'abandon.
 */
export async function assertAbandonable(client: PublicClient, wallet: Hex, operation: BudgetOperation): Promise<void> {
  if (operation.kind !== "transaction" || operation.state !== "reserved") {
    throw new Error("Seule une transaction encore réservée peut être abandonnée");
  }
  if (!operation.txHash) return;
  const receipt = await client.getTransactionReceipt({ hash: operation.txHash as Hex }).catch(() => null);
  if (receipt) throw new Error("Reçu présent : utiliser reconcile, pas abandon");
  const latest = await client.getTransactionCount({ address: wallet, blockTag: "latest" });
  if (operation.nonce === null || latest <= operation.nonce) {
    throw new Error("Nonce encore libre : la transaction peut être incluse. Attendre, ou laisser rebroadcast la re-signer.");
  }
}

async function abandon(ledger: BudgetLedger, operationId: string, actor: string, reason: string, wallet: Hex): Promise<void> {
  const operation = ledger.operation(operationId);
  if (!operation) throw new Error("Opération introuvable");
  await assertAbandonable(getPublicClient(), wallet, operation);
  ledger.abandonTransaction(operation.id, operation.fingerprint, actor, reason);
  console.error(`[runner:transactions] ${operation.id} abandonnée par ${actor}, action journalisée`);
}

async function main() {
  let parsed: ReturnType<typeof parseTransactionsCommand>;
  try { parsed = parseTransactionsCommand(process.argv.slice(2)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; return; }
  if (process.env.TEE_MODE === "phala") await initEnclave();
  const ledger = runnerBudget();
  if (!ledger) throw new Error();
  try {
    const account = settlementAccount();
    const { chain, rpcUrl } = resolveServerNetwork();
    if (ledger.policy.wallet !== account.address.toLowerCase() || ledger.policy.chainId !== chain.id) throw new Error();
    if (parsed.command === "abandon") {
      await abandon(ledger, parsed.operationId, parsed.actor, parsed.reason, account.address);
    } else {
      const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 0, timeout: 20000 }) });
      const client = getPublicClient();
      const rebroadcast = parsed.command === "rebroadcast";
      await reconcileRunnerTransactions(ledger, client, chain.id, account.address,
        rebroadcast ? (serializedTransaction) => wallet.sendRawTransaction({ serializedTransaction }) : undefined,
        rebroadcast ? (serialized) => resignWithFreshFees(serialized, account, client, ledger.policy.gas) : undefined);
    }
    const pending = ledger.diagnostics().pendingTransactions;
    console.log(JSON.stringify({ pending }, null, 2));
    if (pending.length) process.exitCode = 1;
  } finally { ledger.close(); }
}

if (process.argv[1] && /runner-transactions\.ts$/.test(process.argv[1])) {
  void main().catch((error) => {
    const message = error instanceof Error && /^(Seule|Reçu|Nonce|Opération)/.test(error.message) ? ` ${error.message}.` : "";
    console.error(`Réconciliation runner refusée : vérifier réseau, identité, registre et finalité. Aucun nouveau nonce n’est signé.${message}`);
    process.exitCode = 1;
  });
}
