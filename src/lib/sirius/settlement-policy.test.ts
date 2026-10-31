import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "@/lib/app-error";
import { settlementFailureState } from "./settlement-policy";

test("une capsule invalide libère le lease sans masquer les erreurs ambiguës", () => {
  assert.equal(settlementFailureState(new AppError("capsule invalide", 409)), "TRAINING");
  assert.equal(settlementFailureState(new AppError("escrow annulé", 410)), "CANCELLED");
  assert.equal(settlementFailureState(new AppError("runner indisponible", 503)), null);
  assert.equal(settlementFailureState(new Error("réseau")), null);
});
