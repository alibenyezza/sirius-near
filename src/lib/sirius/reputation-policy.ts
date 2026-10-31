export type ReputationRole = "provider" | "borrower";

export interface ResolvedLoanEvidence {
  provider: string;
  borrower: string;
  resolution: "settled" | "cancelled";
}

export interface ReputationSnapshot {
  address: string;
  role: ReputationRole;
  score: number;
  completedLoans: number;
  cancelledEscrows: number;
  settlementRate: number | null;
  evidenceCount: number;
}

export function reputationScore(completedLoans: number): number {
  if (completedLoans === 0) return 0;
  const confidence = Math.min(1, Math.log2(completedLoans + 1) / 4);
  return Math.round(confidence * 100);
}

export function reputationSnapshotFromCounts(
  address: string,
  role: ReputationRole,
  completedLoans: number,
  cancelledEscrows: number,
): ReputationSnapshot {
  const evidenceCount = completedLoans + cancelledEscrows;
  return {
    address,
    role,
    score: reputationScore(completedLoans),
    completedLoans,
    cancelledEscrows,
    settlementRate: evidenceCount === 0 ? null : Math.round((completedLoans / evidenceCount) * 100),
    evidenceCount,
  };
}

export function reputationSnapshot(
  address: string,
  role: ReputationRole,
  evidence: ResolvedLoanEvidence[],
): ReputationSnapshot {
  let completedLoans = 0;
  let cancelledEscrows = 0;
  for (const loan of evidence) {
    if (loan[role] !== address) continue;
    if (loan.resolution === "settled") completedLoans += 1;
    else cancelledEscrows += 1;
  }
  return reputationSnapshotFromCounts(address, role, completedLoans, cancelledEscrows);
}
