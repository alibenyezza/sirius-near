import assert from "node:assert/strict";
import { test } from "node:test";
import { reputationScore, reputationSnapshot, type ResolvedLoanEvidence } from "./reputation-policy";

const evidence: ResolvedLoanEvidence[] = [
  { provider: "rProvider", borrower: "rBorrower1", resolution: "settled" },
  { provider: "rProvider", borrower: "rBorrower2", resolution: "settled" },
  { provider: "rProvider", borrower: "rBorrower3", resolution: "cancelled" },
  { provider: "rOther", borrower: "rBorrower1", resolution: "settled" },
];

test("la réputation ne compte que les résolutions on-chain du rôle demandé", () => {
  assert.deepEqual(reputationSnapshot("rProvider", "provider", evidence), {
    address: "rProvider",
    role: "provider",
    score: 40,
    completedLoans: 2,
    cancelledEscrows: 1,
    settlementRate: 67,
    evidenceCount: 3,
  });
  assert.deepEqual(reputationSnapshot("rBorrower1", "borrower", evidence), {
    address: "rBorrower1",
    role: "borrower",
    score: 40,
    completedLoans: 2,
    cancelledEscrows: 0,
    settlementRate: 100,
    evidenceCount: 2,
  });
});

test("les annulations restent visibles sans pénaliser une partie sans attribution", () => {
  assert.equal(reputationScore(0), 0);
  assert.equal(reputationScore(15), 100);
  assert.equal(
    reputationSnapshot("rProvider", "provider", evidence).score,
    reputationSnapshot("rProvider", "provider", evidence.filter((item) => item.resolution === "settled")).score,
  );
});
