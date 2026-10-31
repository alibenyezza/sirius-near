import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { assertApplicationRunnerConfiguration, assertReaperRunnerConfiguration, runnerEndpoint } from "./config";
import { validateRunnerConfiguration } from "@/runner/config";

const saved = { ...process.env };
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(SIRIUS_|NEXT_PUBLIC_|RUNNER_|TEE_|DSTACK_|EVM_|PINATA_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { NODE_ENV: "production", EVM_NETWORK: "testnet", TEE_MODE: "stub" });
});

test("le mode Phala public interdit le fallback même sans drapeau strict explicite", () => {
  process.env.SIRIUS_PHALA_DEMO = "true";
  process.env.SIRIUS_REQUIRE_PHALA = "false";
  assert.throws(runnerEndpoint, /RUNNER_URL obligatoire/);
  process.env.RUNNER_URL = "http://localhost:4100";
  assert.throws(runnerEndpoint, /HTTPS/);
  process.env.EVM_NETWORK = "mainnet";
  assert.throws(runnerEndpoint, /testnet/);
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test("main peut imposer Phala sur testnet sans retomber sur le mode démonstration", () => {
  assert.equal(runnerEndpoint(), null);
  process.env.SIRIUS_REQUIRE_PHALA = "true";
  assert.throws(runnerEndpoint, /RUNNER_URL obligatoire/);
  process.env.RUNNER_URL = "https://runner.example";
  assert.throws(runnerEndpoint, /Phala/);
  process.env.TEE_MODE = "phala";
  assert.equal(runnerEndpoint(), "https://runner.example");
  process.env.DSTACK_SIMULATOR_ENDPOINT = "http://localhost:8090";
  assert.throws(runnerEndpoint, /simulateur/);
});

test("un runner distant garde les exigences TLS et TEE en démonstration", () => {
  process.env.RUNNER_URL = "http://runner.example";
  assert.throws(runnerEndpoint, /HTTPS/);
  process.env.RUNNER_URL = "https://runner.example/operation";
  assert.throws(runnerEndpoint, /origine racine/);
  process.env.SIRIUS_REQUIRE_PHALA = "tru";
  assert.throws(runnerEndpoint, /true ou false/);
});

test("désactiver le drapeau ne permet pas le fallback in-process sur mainnet", () => {
  process.env.EVM_NETWORK = "mainnet";
  process.env.SIRIUS_REQUIRE_PHALA = "false";
  assert.throws(runnerEndpoint, /RUNNER_URL obligatoire/);
});

test("Next exige les mesures Phala et refuse la master key historique", () => {
  Object.assign(process.env, { TEE_MODE: "phala", RUNNER_URL: "https://runner.example", RUNNER_TRANSPORT_SECRET: "transport" });
  assert.throws(assertApplicationRunnerConfiguration, /SIRIUS_EXPECTED_MRTD/);
  process.env.SIRIUS_EXPECTED_MRTD = "11".repeat(48);
  for (const key of ["SIRIUS_EXPECTED_COMPOSE_HASH", "SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256", "NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256"]) process.env[key] = "22".repeat(32);
  // RTMR3 change à chaque redémarrage de la CVM : il n'est plus épinglé (audit A-01).
  delete process.env.SIRIUS_EXPECTED_RTMR3;
  assert.doesNotThrow(assertApplicationRunnerConfiguration);
  process.env.SIRIUS_MASTER_KEY = "ancienne-cle";
  assert.throws(assertApplicationRunnerConfiguration, /Retirer SIRIUS_MASTER_KEY/);
});

test("le reaper v7 exige le runner distant et ses mesures avant de démarrer", () => {
  assert.doesNotThrow(assertReaperRunnerConfiguration);
  process.env.SIRIUS_BILLING_VERSION = "7";
  assert.throws(assertReaperRunnerConfiguration, /Runner distant obligatoire/);
  Object.assign(process.env, { TEE_MODE: "phala", RUNNER_URL: "https://runner.example", RUNNER_TRANSPORT_SECRET: "transport" });
  assert.throws(assertReaperRunnerConfiguration, /SIRIUS_EXPECTED_MRTD/);
  process.env.SIRIUS_EXPECTED_MRTD = "11".repeat(48);
  for (const key of ["SIRIUS_EXPECTED_COMPOSE_HASH", "SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256", "NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256"]) process.env[key] = "22".repeat(32);
  delete process.env.SIRIUS_EXPECTED_RTMR3;
  assert.doesNotThrow(assertReaperRunnerConfiguration);
  process.env.SIRIUS_MASTER_KEY = "ancienne-cle";
  assert.throws(assertReaperRunnerConfiguration, /Retirer SIRIUS_MASTER_KEY/);
});

test("la CVM peut amorcer son identité sans contrats, mais ne peut pas les omettre à l’activation", () => {
  Object.assign(process.env, {
    TEE_MODE: "phala", RUNNER_BOOTSTRAP_ONLY: "true", RUNNER_TRANSPORT_SECRET: "transport",
    RUNNER_REPLAY_DIR: "/replay", RUNNER_TLS_HOSTNAME: "runner.example", SIRIUS_APP_ORIGIN: "https://app.example",
  });
  assert.deepEqual(validateRunnerConfiguration(), { bootstrapOnly: true, tlsEnabled: true });
  process.env.RUNNER_BOOTSTRAP_ONLY = "false";
  assert.throws(validateRunnerConfiguration, /EVM_RPC_URL/);
  process.env.RUNNER_BOOTSTRAP_ONLY = "true";
  process.env.SIRIUS_MASTER_KEY = "ancienne-cle";
  assert.throws(validateRunnerConfiguration, /SIRIUS_MASTER_KEY interdite/);
  delete process.env.SIRIUS_MASTER_KEY;
  process.env.DSTACK_SIMULATOR_ENDPOINT = "http://localhost:8090";
  assert.throws(validateRunnerConfiguration, /Simulateur/);
});
