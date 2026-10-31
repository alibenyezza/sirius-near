import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReaperMainnetConfiguration, reaperMainnetIssues } from "./mainnet-guard";

const complete = {
  EVM_NETWORK: "mainnet", TEE_MODE: "phala", SIRIUS_REQUIRE_PHALA: "true", SIRIUS_BILLING_VERSION: "7",
  SIRIUS_EVM_FINALITY: "finalized", EVM_RPC_URL: "https://rpc", RUNNER_URL: "https://runner", RUNNER_TRANSPORT_SECRET: "s",
  SIRIUS_LOCK_AUTHORIZER: "0x1", SIRIUS_USDC_ADDRESS: "0x2", SIRIUS_KYB_ADDRESS: "0x3", SIRIUS_EXPECTED_MRTD: "a",
  SIRIUS_EXPECTED_COMPOSE_HASH: "c", SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256: "d",
  NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: "e",
};

test("A-02 : le reaper mainnet démarre sans SIRIUS_EXPECTED_RTMR3, qui n'est plus épinglé, et tolère sa présence", () => {
  assert.ok(!("SIRIUS_EXPECTED_RTMR3" in complete));
  assert.deepEqual(reaperMainnetIssues(complete), []);
  assert.deepEqual(reaperMainnetIssues({ ...complete, SIRIUS_EXPECTED_RTMR3: "b" }), []);
});

test("le testnet garde ses valeurs historiques", () => {
  assert.deepEqual(reaperMainnetIssues({ EVM_NETWORK: "testnet", TEE_MODE: "stub" }), []);
  assert.deepEqual(reaperMainnetIssues({}), []);
});

test("une configuration mainnet complète démarre", () => {
  assert.doesNotThrow(() => assertReaperMainnetConfiguration(complete));
});

test("finalité rapide : facultative, finalized reste exigé, bornes invalides refusées, jamais de « confirmations » nu", () => {
  assert.deepEqual(reaperMainnetIssues({ ...complete, SIRIUS_FAST_FINALITY: "true" }), []);
  assert.deepEqual(reaperMainnetIssues({ ...complete, SIRIUS_FAST_FINALITY: "false" }), []);
  assert.deepEqual(reaperMainnetIssues({ ...complete, SIRIUS_FAST_FINALITY: "true", SIRIUS_FAST_FINALITY_MAX_USDC: "25",
    SIRIUS_FAST_FINALITY_TOTAL_USDC: "100", SIRIUS_FAST_FINALITY_CONFIRMATIONS: "30" }), []);
  for (const [env, issue] of [
    [{ SIRIUS_FAST_FINALITY: "yes" }, /SIRIUS_FAST_FINALITY doit valoir true ou false/],
    [{ SIRIUS_FAST_FINALITY: "true", SIRIUS_FAST_FINALITY_CONFIRMATIONS: "0" }, /SIRIUS_FAST_FINALITY_CONFIRMATIONS/],
    [{ SIRIUS_FAST_FINALITY: "true", SIRIUS_FAST_FINALITY_CONFIRMATIONS: "101" }, /SIRIUS_FAST_FINALITY_CONFIRMATIONS/],
    [{ SIRIUS_FAST_FINALITY: "true", SIRIUS_FAST_FINALITY_MAX_USDC: "0" }, /SIRIUS_FAST_FINALITY_MAX_USDC/],
    [{ SIRIUS_FAST_FINALITY: "true", SIRIUS_FAST_FINALITY_MAX_USDC: "200" }, /supérieur à SIRIUS_FAST_FINALITY_TOTAL_USDC/],
    [{ SIRIUS_FAST_FINALITY: "false", SIRIUS_FAST_FINALITY_MAX_USDC: "abc" }, /SIRIUS_FAST_FINALITY_MAX_USDC/],
    // La finalité rapide ne remplace jamais finalized : le mode confirmations reste refusé.
    [{ SIRIUS_FAST_FINALITY: "true", SIRIUS_EVM_FINALITY: "confirmations" }, /SIRIUS_EVM_FINALITY=finalized/],
  ] as const) {
    assert.throws(() => assertReaperMainnetConfiguration({ ...complete, ...env }), issue, JSON.stringify(env));
  }
  // Hors mainnet, la garde ne lit rien.
  assert.deepEqual(reaperMainnetIssues({ EVM_NETWORK: "testnet", SIRIUS_FAST_FINALITY: "yes" }), []);
});

test("les valeurs de démonstration et les oublis bloquent le démarrage sur mainnet", () => {
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, TEE_MODE: "stub" }), /TEE_MODE=phala/);
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, SIRIUS_BILLING_VERSION: "6" }), /SIRIUS_BILLING_VERSION=7/);
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, SIRIUS_REQUIRE_PHALA: "false" }), /SIRIUS_REQUIRE_PHALA/);
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, RUNNER_URL: "" }), /RUNNER_URL/);
  assert.throws(() => assertReaperMainnetConfiguration({ ...complete, SIRIUS_LEGACY_ESCROW_ADDRESSES: "0xabc" }), /LEGACY/);
});
