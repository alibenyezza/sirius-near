import { LOCK_AUTHORIZATION_TTL_SECONDS } from "@/lib/evm/lock-authorization";
import { AppError } from "@/lib/app-error";
import { PENDING_REAPER_TTL_MS } from "./reaper-policy";

export function lockAuthorizationDeadline(createdAt: Date, now = Date.now()): number {
  // L'autorisation expire avant que le reaper puisse libérer le dataset.
  const deadline = Math.min(
    Math.floor(now / 1_000) + LOCK_AUTHORIZATION_TTL_SECONDS,
    Math.floor((createdAt.getTime() + PENDING_REAPER_TTL_MS - 60_000) / 1_000),
  );
  if (deadline < Math.floor(now / 1_000) + 60) {
    throw new AppError("Préparation du prêt expirée. Relance l’emprunt ; l’approbation du stablecoin reste acquise.", 409);
  }
  return deadline;
}
