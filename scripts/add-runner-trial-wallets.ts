import { BudgetLedger } from "../src/lib/runner/budget-ledger";

try {
  const [path, ...extra] = process.argv.slice(2);
  const wallet = process.env.SIRIUS_LOCK_AUTHORIZER?.toLowerCase();
  if (!path || extra.length || !wallet || process.env.RUNNER_VOLUME_ACTION !== "add-trial-wallets") throw new Error();
  const ledger = new BudgetLedger(path, 46630, wallet);
  try {
    if (!ledger.policy.trial || ledger.policy.trial.escrow !== process.env.SIRIUS_ESCROW_ADDRESS?.toLowerCase()) throw new Error();
    ledger.addTrialWallets(JSON.parse(process.env.RUNNER_ADDITIONAL_TRIAL_WALLETS ?? ""));
    console.log("Wallets d’essai ajoutés ; engagements et plafonds conservés. Réactiver le runner avec le Compose actif.");
  } finally { ledger.close(); }
} catch {
  console.error("Ajout refusé : vérifier le registre existant, le déploiement et les adresses. Ne pas réinitialiser le budget.");
  process.exitCode = 1;
}
