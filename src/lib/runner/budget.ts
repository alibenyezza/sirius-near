import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "@/lib/app-error";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { BudgetLedger, type BudgetKind, type BudgetPolicy, type WorkflowBudget } from "./budget-ledger";
import { countsAsRunnerFailure, releasesReservation } from "./failure-policy";

const workflowContext = new AsyncLocalStorage<WorkflowBudget>();
export const currentWorkflowBudget = () => workflowContext.getStore();
export function withWorkflowBudget<T>(scope: WorkflowBudget, action: () => Promise<T>): Promise<T> {
  return workflowContext.run(scope, action);
}

let cached: { path: string; chainId: number; wallet: string; ledger: BudgetLedger } | undefined;

export function runnerBudget(): BudgetLedger | null {
  const path = process.env.RUNNER_BUDGET_FILE;
  if (cached && !path) throw new AppError("Changement du registre runner interdit à chaud", 503);
  if (!path) {
    if (process.env.NODE_ENV === "production" || process.env.TEE_MODE === "phala" || process.env.EVM_NETWORK === "mainnet") {
      throw new AppError("RUNNER_BUDGET_FILE obligatoire avant toute opération runner", 503);
    }
    return null;
  }
  const { chainId } = evmEscrowBinding();
  const wallet = process.env.SIRIUS_LOCK_AUTHORIZER?.toLowerCase();
  if (!wallet) throw new AppError("Identité du wallet requise pour le budget runner", 503);
  if (cached && (cached.path !== path || cached.chainId !== chainId || cached.wallet !== wallet)) {
    throw new AppError("Changement du registre runner interdit à chaud", 503);
  }
  if (!cached) {
    try { cached = { path, chainId, wallet, ledger: new BudgetLedger(path, chainId, wallet) }; }
    catch { throw new AppError("Registre de budget runner indisponible", 503); }
  }
  assertTrialDeployment(cached.ledger.policy);
  return cached.ledger;
}

export function assertTrialDeployment(policy: BudgetPolicy, env: Record<string, string | undefined> = process.env): void {
  if (policy.sponsored && (env.SIRIUS_PHALA_DEMO !== "true" || env.EVM_NETWORK !== "testnet"
    || env.TEE_MODE !== "phala" || env.DSTACK_SIMULATOR_ENDPOINT
    || env.SIRIUS_APP_ORIGIN !== policy.sponsored.origin)) {
    throw new AppError("Budget sponsorisé réservé à la démonstration Phala déclarée", 503);
  }
  if (env.SIRIUS_PHALA_DEMO === "true" && !policy.sponsored) {
    throw new AppError("Budget sponsorisé requis pour la démonstration publique", 503);
  }
  if (policy.trial && (env.EVM_NETWORK !== "testnet" || env.SIRIUS_BILLING_VERSION !== "7"
    || env.SIRIUS_APP_ORIGIN !== "https://sirius-evm-staging.vercel.app"
    || env.SIRIUS_ESCROW_ADDRESS?.toLowerCase() !== policy.trial.escrow)) {
    throw new AppError("Crédits d’essai réservés au déploiement staging déclaré", 503);
  }
}

export function assertTrialSubject(subject: string, policy = runnerBudget()?.policy): void {
  const trial = policy?.trial;
  if (trial && !trial.wallets.includes(subject.toLowerCase())) {
    throw new AppError("Essais réservés aux wallets autorisés de l’équipe", 403);
  }
}

export function budgetFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  })).digest("hex");
}

export async function runBudgetedOperation<T>(
  ledger: BudgetLedger | null,
  kind: Exclude<BudgetKind, "transaction">,
  id: string,
  fingerprint: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!ledger) return action();
  const reservation = ledger.reserve(id, fingerprint, kind, currentWorkflowBudget());
  if (!reservation.fresh) {
    if (reservation.operation.state === "succeeded" && reservation.operation.result !== null) {
      return JSON.parse(reservation.operation.result) as T;
    }
    throw new AppError("Opération runner déjà engagée : réconciliation requise", 503);
  }
  try {
    const result = await action();
    ledger.finish(id, fingerprint, true, kind === "training" ? JSON.stringify(result) : null);
    return result;
  } catch (error) {
    if (releasesReservation(error) && ledger.releaseReservation(id, fingerprint)) throw error;
    ledger.finish(id, fingerprint, false, null, countsAsRunnerFailure(error));
    throw error;
  }
}

export function budgetRunnerRequest<T>(action: () => Promise<T>): Promise<T> {
  return runBudgetedOperation(runnerBudget(), "request", `request:${randomUUID()}`, "request-v1", action);
}

export function budgetRunnerJob<T>(kind: "seal" | "training", scope: unknown, input: unknown, action: () => Promise<T>): Promise<T> {
  return runBudgetedOperation(runnerBudget(), kind, `${kind}:${budgetFingerprint(scope)}`, budgetFingerprint(input), action);
}
