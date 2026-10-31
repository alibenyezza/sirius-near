import assert from "node:assert/strict";
import { test } from "node:test";
import { RETIRED_ENCLAVES, retiredEnclaveFor } from "./retired-enclaves";

const LAUNCH = "ef6054697b228aa3fe004ea93f7ff6aa8eb4fb3e8cd42c819fd57b4d7a5918b3";

test("compose du lancement mainnet : reconnu pour un prêt mainnet réglé avant la mise à niveau", () => {
  const enclave = retiredEnclaveFor(4663, LAUNCH.toUpperCase(), new Date("2026-10-06T04:26:23Z"));
  assert.equal(enclave?.composeHash, LAUNCH);
});

test("refusé après la mise à niveau, sur une autre chaîne, sans date ou sans compose", () => {
  assert.equal(retiredEnclaveFor(4663, LAUNCH, new Date("2026-10-08T12:28:56Z")), null);
  assert.equal(retiredEnclaveFor(4663, LAUNCH, new Date("2026-10-09T00:00:00Z")), null);
  assert.equal(retiredEnclaveFor(46630, LAUNCH, new Date("2026-10-06T04:26:23Z")), null);
  assert.equal(retiredEnclaveFor(4663, LAUNCH, null), null);
  assert.equal(retiredEnclaveFor(4663, LAUNCH, new Date("invalide")), null);
  assert.equal(retiredEnclaveFor(4663, null, new Date("2026-10-06T04:26:23Z")), null);
  assert.equal(retiredEnclaveFor(4663, "00".repeat(32), new Date("2026-10-06T04:26:23Z")), null);
});

test("chaque entrée : compose SHA-256 en minuscules et date valide", () => {
  for (const enclave of RETIRED_ENCLAVES) {
    assert.match(enclave.composeHash, /^[0-9a-f]{64}$/);
    assert.ok(!Number.isNaN(enclave.retiredAt.getTime()));
  }
});
