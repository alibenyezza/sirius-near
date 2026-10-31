import { AppError } from "@/lib/app-error";

export type SettlementFailureState = "TRAINING" | "CANCELLED" | null;

export function settlementFailureState(error: unknown): SettlementFailureState {
  if (!(error instanceof AppError)) return null;
  if (error.status === 410) return "CANCELLED";
  return error.status >= 400 && error.status < 500 ? "TRAINING" : null;
}
