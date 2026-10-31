import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingPolicy } from "./config";

const profile = { computeAmount: "3000000", maxFailureFee: "1000000", executionRateAtomicPerMs: "100", maxExecutionMs: 15000 };
const policy = (computeAmount = "3000000") => ({
  version: 1, tariffVersion: "test-v1", costReference: "synthetic", validUntil: Date.now() + 86_400_000,
  chainId: 46630, usdc: `0x${"34".repeat(20)}`, usdcDecimals: 6, computeRecipient: `0x${"56".repeat(20)}`,
  minimumComputeAmount: "1000000",
  profiles: { linear_regression: { ...profile, computeAmount }, logistic_regression: profile },
});

test("le tarif se lit dans la variable JSON quand aucun fichier n'est configuré", () => {
  const loaded = billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) });
  assert.equal(loaded.profiles.linear_regression.computeAmount, "3000000");
});

test("le fichier du runner garde la priorité sur la variable", () => {
  const dir = mkdtempSync(join(tmpdir(), "sirius-tarif-"));
  try {
    const file = join(dir, "billing.json");
    writeFileSync(file, JSON.stringify(policy("5000000")));
    const loaded = billingPolicy({ RUNNER_BILLING_POLICY_FILE: file, SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) });
    assert.equal(loaded.profiles.linear_regression.computeAmount, "5000000");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("un tarif absent, invalide, périmé ou trop volumineux est refusé", () => {
  assert.throws(() => billingPolicy({}), /Tarif compute/);
  assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: "{" }), /Tarif compute/);
  assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify({ ...policy(), validUntil: Date.now() - 1 }) }), /Tarif compute/);
  assert.throws(() => billingPolicy({ SIRIUS_BILLING_POLICY_JSON: JSON.stringify(policy()) + " ".repeat(16_384) }), /Tarif compute/);
});
