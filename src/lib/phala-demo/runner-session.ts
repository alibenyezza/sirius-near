import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { budgetFingerprint, runnerBudget } from "@/lib/runner/budget";
import { parseDemoPolicy } from "./contract";
import { DemoSessionStore } from "./session-store";

let cached: { path: string; store: DemoSessionStore } | undefined;

export function demoEnabled(): boolean {
  const flag = process.env.SIRIUS_PHALA_DEMO;
  if (flag && flag !== "true" && flag !== "false") throw new AppError("Mode démonstration invalide", 503);
  if (flag !== "true") return false;
  if (process.env.EVM_NETWORK !== "testnet" || process.env.TEE_MODE !== "phala"
    || process.env.DSTACK_SIMULATOR_ENDPOINT) throw new AppError("Démonstration réservée à Phala sur testnet", 503);
  return true;
}

export function demoSessions(): DemoSessionStore {
  if (!demoEnabled()) throw new AppError("Démonstration non configurée", 404);
  const path = process.env.RUNNER_DEMO_SESSION_FILE;
  if (!path || (cached && cached.path !== path)) throw new AppError("Registre de session indisponible", 503);
  if (!cached) cached = { path, store: new DemoSessionStore(path) };
  return cached.store;
}

/**
 * Au démarrage d'un runner de démonstration : rien n'est en cours dans ce processus, donc
 * toute opération encore « en cours » vient du processus précédent. Sans cette reprise, une
 * coupure pendant un entraînement empêchait de fermer puis de rouvrir la démonstration.
 */
export function recoverDemoAfterRestart(): { admissions: number; operations: number } {
  const admissions = demoSessions().recoverOrphans();
  const budget = runnerBudget();
  const operations = budget?.policy.sponsored
    ? budget.failInterruptedOperations("runner-startup", "redémarrage du runner : opérations interrompues")
    : [];
  if (admissions.length || operations.length) {
    console.warn(`[runner] démonstration reprise après redémarrage : ${admissions.length} admission(s) et ${operations.length} opération(s) interrompue(s) passées en échec`);
  }
  return { admissions: admissions.length, operations: operations.length };
}

export function demoControlAuthorized(header: string | string[] | undefined): boolean {
  const secret = process.env.RUNNER_DEMO_CONTROL_SECRET;
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret) || typeof header !== "string" || header.length > 128) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header), hash(`Bearer ${secret}`));
}

export function checkDemoOperation(op: string): void {
  if (!demoEnabled()) return;
  if (op === "self-train-key") return;
  if (!["dataset-ingress-key", "seal-dataset", "run-training"].includes(op)) {
    throw new AppError("Cette instance est réservée à l’entraînement sur ses propres données", 403);
  }
  if (!demoSessions().read().open) throw new AppError("Démonstration Phala fermée", 403);
}

export function demoGrantScope(): { demoSessionRevision?: number } {
  return demoEnabled() ? { demoSessionRevision: demoSessions().read().revision } : {};
}

export async function withDemoAdmission<T>(id: string, owner: string, input: unknown, action: () => Promise<T>, revision?: number): Promise<T> {
  if (!demoEnabled()) return action();
  const store = demoSessions();
  if (!Number.isSafeInteger(revision)) throw new AppError("Révision de session manquante", 409);
  const fresh = store.admit(id, owner.toLowerCase(), budgetFingerprint(input), revision);
  try {
    const result = await action();
    if (fresh) store.finish(id, true);
    return result;
  } catch (error) {
    if (fresh) store.finish(id, false);
    throw error;
  }
}

export function demoControl(body?: Record<string, unknown>) {
  const store = demoSessions();
  const budget = runnerBudget();
  if (!budget?.policy.sponsored) throw new AppError("Budget sponsorisé requis", 503);
  let configured = parseDemoPolicy(budget.policy.sponsored);
  if (body) {
    if (!["open", "close", "configure", "recover"].includes(body.command as string) || typeof body.actor !== "string"
      || typeof body.revision !== "number") throw new AppError("Commande opérateur invalide", 400);
    if (body.command === "recover") {
      const session = store.read();
      if (session.open || session.revision !== body.revision) throw new AppError("Ferme la session avant de reprendre les opérations orphelines", 409);
      const orphans = store.recoverOrphans();
      if (orphans.length) console.warn(`[runner] ${orphans.length} admission(s) orpheline(s) passées en échec par ${body.actor}`);
    }
    if (body.command === "configure") {
      const session = store.read();
      if (session.open || session.activeOperations || session.revision !== body.revision) throw new AppError("Ferme la session avant de changer le financement", 409);
      if (typeof body.observedAtMs !== "number") throw new AppError("Date de financement vérifiée requise", 400);
      budget.configureSponsored(parseDemoPolicy(body.policy), body.observedAtMs, body.actor);
      configured = parseDemoPolicy(budget.policy.sponsored);
    }
    if (body.command === "open") {
      if (JSON.stringify(parseDemoPolicy(body.policy)) !== JSON.stringify(configured)) {
        throw new AppError("La session doit utiliser le financement et les quotas du registre runner", 409);
      }
      const check = budget.diagnostics();
      const minimum = Object.values(budget.policy.costsUsdMicros).reduce((sum, cost) => sum + BigInt(cost), BigInt(0));
      if (check.expired || check.circuitOpen || check.incompleteJobs > 0 || check.remainingUsd < minimum) {
        throw new AppError("Le budget runner ne permet pas l’ouverture", 409);
      }
    }
    if (body.command === "open" || body.command === "close") store.command(body.command, body.revision, body.actor, configured);
  }
  const session = store.read();
  const check = budget.diagnostics();
  const minimum = Object.values(budget.policy.costsUsdMicros).reduce((sum, cost) => sum + BigInt(cost), BigInt(0));
  const available = session.open && !check.expired && !check.circuitOpen && check.remainingUsd >= minimum
    && session.activeOperations < configured.maxConcurrent && session.usedOperations < configured.maxOperations;
  return { session, policy: configured, available };
}
