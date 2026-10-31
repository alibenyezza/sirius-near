import { isSimulator } from "@/lib/tee/dstack";
import { billingEnabled, billingPolicy } from "@/lib/billing/config";
import { fastFinalityPolicy } from "@/lib/evm/finality";

export function runnerBootstrapOnly(): boolean {
  const flag = process.env.RUNNER_BOOTSTRAP_ONLY;
  if (flag && flag !== "true" && flag !== "false") throw new Error("RUNNER_BOOTSTRAP_ONLY doit valoir true ou false");
  return flag === "true";
}

export function validateRunnerConfiguration(): { bootstrapOnly: boolean; tlsEnabled: boolean } {
  const bootstrapOnly = runnerBootstrapOnly();
  if (!bootstrapOnly && billingEnabled()) billingPolicy();
  // Bornes de la finalité rapide (constantes du Compose attesté) : lues et refusées au démarrage
  // si elles sont illisibles, jamais découvertes au premier prêt.
  if (!bootstrapOnly) fastFinalityPolicy();
  const production = process.env.NODE_ENV === "production";
  const tlsEnabled = production || bootstrapOnly || process.env.RUNNER_TLS_ENABLED === "true";
  if (tlsEnabled && process.env.TEE_MODE !== "phala") throw new Error("TEE_MODE=phala obligatoire quand TLS runner est activé");
  if (production || bootstrapOnly) {
    if (isSimulator()) throw new Error("Simulateur dstack interdit pour le runner en production ou en amorçage");
    if (process.env.SIRIUS_MASTER_KEY) throw new Error("SIRIUS_MASTER_KEY interdite dans la CVM Phala");
    const required: Array<[string, string | undefined]> = [
      ["RUNNER_TRANSPORT_SECRET", process.env.RUNNER_TRANSPORT_SECRET],
      ["RUNNER_REPLAY_DIR", process.env.RUNNER_REPLAY_DIR],
      ["RUNNER_TLS_HOSTNAME", process.env.RUNNER_TLS_HOSTNAME],
      ["SIRIUS_APP_ORIGIN", process.env.SIRIUS_APP_ORIGIN],
    ];
    if (!bootstrapOnly) required.push(
      ["EVM_NETWORK", process.env.EVM_NETWORK], ["EVM_RPC_URL", process.env.EVM_RPC_URL],
      ["SIRIUS_ESCROW_ADDRESS", process.env.SIRIUS_ESCROW_ADDRESS], ["SIRIUS_USDC_ADDRESS", process.env.SIRIUS_USDC_ADDRESS],
      ["SIRIUS_KYB_ADDRESS", process.env.SIRIUS_KYB_ADDRESS], ["SIRIUS_DATASET_ADDRESS", process.env.SIRIUS_DATASET_ADDRESS],
      ["SIRIUS_LOCK_AUTHORIZER", process.env.SIRIUS_LOCK_AUTHORIZER],
      ["PINATA_JWT", process.env.PINATA_JWT], ["PINATA_GATEWAY", process.env.PINATA_GATEWAY],
      ["RUNNER_BUDGET_FILE", process.env.RUNNER_BUDGET_FILE],
    );
    for (const [name, value] of required) {
      if (!value?.trim()) throw new Error(`${name} obligatoire pour le runner`);
    }
  }
  return { bootstrapOnly, tlsEnabled };
}
