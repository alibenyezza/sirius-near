import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { runnerBudget } from "./budget";

export function monitoringAuthorized(header: string | string[] | undefined): boolean {
  const secret = process.env.RUNNER_MONITOR_SECRET;
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret) || typeof header !== "string" || header.length > 128) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export function runnerBudgetReport() {
  const ledger = runnerBudget();
  if (!ledger) throw new AppError("Registre de supervision indisponible", 503);
  return {
    version: 1, observedAtMs: Date.now(), chainId: ledger.policy.chainId, wallet: ledger.policy.wallet,
    funding: ledger.policy.sponsored ? `sirius-sponsored-${ledger.policy.sponsored.funding}` : ledger.policy.trial ? "phala-trial-credits" : "earned-margin",
    check: JSON.parse(JSON.stringify(ledger.diagnostics(), (_key, value) => typeof value === "bigint" ? String(value) : value)),
  };
}
