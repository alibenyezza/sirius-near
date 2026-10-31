import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BudgetLedger, initializeBudgetLedger, validateBudgetPolicy } from "../src/lib/runner/budget-ledger";

const COMMANDS = ["init", "inspect", "export", "check", "backup", "sanitize-key-cache", "reset-failures", "reopen", "journal"] as const;
type Command = typeof COMMANDS[number];
const USAGE = "Usage : pnpm runner:budget <init|inspect|export|check|sanitize-key-cache|journal> <registre.sqlite> <politique.json>\n"
  + "        pnpm runner:budget backup <registre.sqlite> <politique.json> <nouvelle-sauvegarde.sqlite>\n"
  + "        pnpm runner:budget reset-failures <registre.sqlite> <politique.json> --actor=<nom> --reason=<motif>\n"
  + "        pnpm runner:budget reopen <registre.sqlite> <politique.json> <id-operation> --actor=<nom> --reason=<motif>";

export function parseBudgetCommand(argv: string[]) {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of argv) {
    const flag = /^--(actor|reason)=([\s\S]+)$/.exec(arg);
    if (flag) flags.set(flag[1], flag[2]);
    else if (arg.startsWith("--")) throw new Error(USAGE);
    else positional.push(arg);
  }
  const [command, ledgerPath, policyPath, ...extra] = positional;
  if (!COMMANDS.includes(command as Command) || !ledgerPath || !policyPath) throw new Error(USAGE);
  const extraCount = command === "backup" || command === "reopen" ? 1 : 0;
  const operator = command === "reset-failures" || command === "reopen";
  if (extra.length !== extraCount || (operator && (!flags.get("actor")?.trim() || !flags.get("reason")?.trim()))
    || (!operator && flags.size)) throw new Error(USAGE);
  return { command: command as Command, ledgerPath, policyPath, extra, actor: flags.get("actor") ?? "", reason: flags.get("reason") ?? "" };
}

function main() {
  let parsed: ReturnType<typeof parseBudgetCommand>;
  try { parsed = parseBudgetCommand(process.argv.slice(2)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; return; }
  const { command, ledgerPath, policyPath, extra, actor, reason } = parsed;
  try {
    const policy = validateBudgetPolicy(JSON.parse(readFileSync(resolve(policyPath), "utf8")));
    const path = resolve(ledgerPath);
    if (command === "init") initializeBudgetLedger(path, policy);
    const ledger = new BudgetLedger(path, policy.chainId, policy.wallet);
    try {
      if (command === "backup") ledger.backup(resolve(extra[0]));
      if (command === "sanitize-key-cache") ledger.sanitizeKeyCache();
      if (command === "reset-failures") {
        const previous = ledger.resetFailures(actor, reason);
        console.error(`[runner:budget] coupe-circuit réarmé par ${actor} (${previous} échec(s) effacé(s)), action journalisée`);
      }
      if (command === "reopen") {
        const operation = ledger.operation(extra[0]);
        if (!operation) throw new Error("Opération introuvable");
        ledger.reopenTransaction(operation.id, operation.fingerprint, actor, reason);
        console.error(`[runner:budget] opération ${operation.id} rouverte par ${actor}, action journalisée`);
      }
      const diagnostics = ledger.diagnostics();
      const output = command === "export" ? ledger.accountingExport()
        : command === "journal" ? { operatorActions: ledger.operatorActions() }
          : { policy: ledger.policy, ...diagnostics };
      console.log(JSON.stringify(output, (_key, value) => typeof value === "bigint" ? String(value) : value, 2));
      if (command === "check" && (!diagnostics.canQuote || diagnostics.incompleteJobs
        || diagnostics.pendingTransactions.some((transaction) => transaction.ageMs >= 300000))) process.exitCode = 1;
    } finally { ledger.close(); }
  } catch {
    console.error("Budget runner refusé. Vérifier la commande, la politique, les droits privés et le registre existant. Aucun registre existant n’est réinitialisé.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && /runner-budget\.ts$/.test(process.argv[1])) main();
