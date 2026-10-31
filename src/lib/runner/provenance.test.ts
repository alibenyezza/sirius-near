import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { assertCurrentRunner, currentRunnerProvenance } from "./provenance";
import { parseRunnerRaTlsEvidence } from "@/lib/tee/ra-tls-evidence";

const saved = { ...process.env };
beforeEach(() => {
  for (const key of ["RUNNER_URL", "SIRIUS_REQUIRE_PHALA", "DSTACK_SIMULATOR_ENDPOINT"]) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: "test", TEE_MODE: "stub", EVM_NETWORK: "testnet", SIRIUS_APP_ORIGIN: "http://localhost:3000",
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  });
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test("la provenance suit la clé du runner, pas son URL ni son processus", async () => {
  const original = await currentRunnerProvenance();
  assert.equal(original.runnerKind, "DEVELOPMENT");
  assert.deepEqual(await currentRunnerProvenance(), original);
  assert.deepEqual(await assertCurrentRunner(original), original);
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 2).toString("base64");
  assert.notEqual((await currentRunnerProvenance()).runnerDeploymentId, original.runnerDeploymentId);
  await assert.rejects(assertCurrentRunner(original), /ancien runner/);
});

test("l’historique inconnu reste inconnu et n’est jamais promu vers Phala", async () => {
  const historical = { runnerKind: "UNKNOWN", runnerDeploymentId: null };
  assert.equal((await assertCurrentRunner(historical)).runnerKind, "DEVELOPMENT");
  Object.assign(process.env, {
    RUNNER_URL: "https://runner.example", TEE_MODE: "phala", NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: "12".repeat(32),
  });
  const current = await currentRunnerProvenance();
  assert.deepEqual(current, { runnerKind: "PHALA", runnerDeploymentId: `phala:${"12".repeat(32)}` });
  await assert.rejects(assertCurrentRunner(historical), /ancien runner/);
  assert.deepEqual(historical, { runnerKind: "UNKNOWN", runnerDeploymentId: null });
  process.env.RUNNER_URL = "https://other-host.example";
  assert.deepEqual(await assertCurrentRunner(current), current);
  process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256 = "34".repeat(32);
  await assert.rejects(assertCurrentRunner(current), /ancien runner/);
});

test("la preuve d’amorçage exige une adresse EVM et un mode explicite", () => {
  const evidence = {
    quote: "12", eventLog: "[]", composeHash: "34".repeat(32), certificateSha256: "56".repeat(32),
    ingressKeySha256: "78".repeat(32), masterKeyChainSha256: "9a".repeat(32),
    settlementAddress: `0x${"ab".repeat(20)}`, bootstrapOnly: true,
  };
  const parse = (value: unknown) => parseRunnerRaTlsEvidence(Buffer.from(JSON.stringify(value)));
  assert.deepEqual(parse(evidence), evidence);
  for (const invalid of [null, {}, { ...evidence, bootstrapOnly: undefined }, { ...evidence, settlementAddress: "invalid" },
    { ...evidence, settlementAddress: `0x${"00".repeat(20)}` }, { ...evidence, ingressKeySha256: "short" }]) {
    assert.throws(() => parse(invalid));
  }
});
