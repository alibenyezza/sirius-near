import assert from "node:assert/strict";
import { test } from "node:test";
import { loanReaperAction, type LoanReaperSnapshot } from "./reaper-policy";

const now = new Date("2026-08-02T12:00:00.000Z");

function loan(overrides: Partial<LoanReaperSnapshot>): LoanReaperSnapshot {
  return {
    status: "PENDING",
    createdAt: new Date(now.getTime() - 60_000),
    updatedAt: new Date(now.getTime() - 60_000),
    evmDeadline: null,
    modelCid: null,
    ...overrides,
  };
}

test("le reaper expire les réservations et réconcilie les soumissions abandonnées", () => {
  assert.equal(
    loanReaperAction(loan({ createdAt: new Date(now.getTime() - 10 * 60_000) }), now),
    "cancel-pending",
  );
  assert.equal(
    loanReaperAction(loan({ status: "SUBMITTING", updatedAt: new Date(now.getTime() - 30_000) }), now),
    "reconcile-submission",
  );
});

test("un escrow expiré est réconcilié avant tout changement terminal local", () => {
  for (const status of ["ESCROWED", "TRAINING", "SETTLING"] as const) {
    assert.equal(
      loanReaperAction(loan({
        status,
        evmDeadline: new Date(now.getTime() - 1),
        updatedAt: new Date(now.getTime() - 90_000),
      }), now),
      "reconcile-chain",
    );
  }
});

test("les leases de calcul et règlement sont récupérables sans toucher aux jobs actifs", () => {
  assert.equal(
    loanReaperAction(loan({
      status: "TRAINING",
      updatedAt: new Date(now.getTime() - 90_000),
    }), now),
    "reset-training",
  );
  assert.equal(
    loanReaperAction(loan({
      status: "TRAINING",
      modelCid: "bafy-model",
      updatedAt: new Date(now.getTime() - 90_000),
    }), now),
    null,
  );
  assert.equal(
    loanReaperAction(loan({
      status: "SETTLING",
      updatedAt: new Date(now.getTime() - 90_000),
    }), now),
    "reconcile-chain",
  );
});
