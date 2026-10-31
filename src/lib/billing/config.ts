import "server-only";
import { readFileSync } from "node:fs";
import { AppError } from "@/lib/app-error";
import type { ModelId } from "@/lib/models/registry";

export function billingEnabled(): boolean {
  const version = process.env.SIRIUS_BILLING_VERSION;
  if (version && version !== "6" && version !== "7") throw new AppError("Version de facturation invalide", 503);
  return version === "7";
}

export interface BillingPolicy {
  version: 1;
  tariffVersion: string;
  costReference: string;
  validUntil: number;
  chainId: number;
  usdc: string;
  usdcDecimals: number;
  computeRecipient: string;
  minimumComputeAmount: string;
  profiles: Record<ModelId, {
    computeAmount: string;
    maxFailureFee: string;
    executionRateAtomicPerMs: string;
    maxExecutionMs: number;
  }>;
}

export function validateBillingPolicy(value: unknown): BillingPolicy {
  try {
    const p = value as BillingPolicy;
    const amount = (s: unknown) => typeof s === "string" && /^(0|[1-9][0-9]{0,28})$/.test(s);
    if (p.version !== 1 || !p.tariffVersion || p.tariffVersion.length > 128 || !p.costReference
      || !Number.isSafeInteger(p.validUntil) || p.validUntil <= Date.now()
      || !Number.isSafeInteger(p.chainId) || p.chainId < 1
      || !/^0x[0-9a-f]{40}$/.test(p.usdc) || !/^0x[0-9a-f]{40}$/.test(p.computeRecipient)
      || !Number.isInteger(p.usdcDecimals) || p.usdcDecimals < 3 || p.usdcDecimals > 30
      || !amount(p.minimumComputeAmount) || BigInt(p.minimumComputeAmount) <= BigInt(0)) throw new Error();
    for (const id of ["linear_regression", "logistic_regression"] as const) {
      const profile = p.profiles[id];
      if (!profile || ![profile.computeAmount, profile.maxFailureFee, profile.executionRateAtomicPerMs].every(amount)
        || !Number.isSafeInteger(profile.maxExecutionMs) || profile.maxExecutionMs < 1000 || profile.maxExecutionMs > 30000) throw new Error();
    }
    return p;
  } catch { throw new AppError("Tarif compute absent, invalide ou périmé", 503); }
}

/**
 * Le runner lit le tarif dans son volume (`RUNNER_BILLING_POLICY_FILE`) : c'est lui qui signe
 * les devis. L'instance Next, hébergée sans système de fichiers persistant, n'en a besoin que
 * pour AFFICHER les frais avant publication : elle peut recevoir le même contenu en JSON dans
 * `SIRIUS_BILLING_POLICY_JSON`. Le fichier garde la priorité ; les deux passent la même
 * validation, et un tarif affiché différent de celui du runner reste sans effet sur l'argent,
 * le devis réellement payé étant toujours celui signé par l'enclave.
 */
export function billingPolicy(env: Record<string, string | undefined> = process.env): BillingPolicy {
  try {
    const path = env.RUNNER_BILLING_POLICY_FILE;
    const inline = env.SIRIUS_BILLING_POLICY_JSON;
    if (path) return validateBillingPolicy(JSON.parse(readFileSync(path, "utf8")));
    if (inline && inline.length <= 16_384) return validateBillingPolicy(JSON.parse(inline));
    throw new Error();
  } catch { throw new AppError("Tarif compute absent, invalide ou périmé", 503); }
}
