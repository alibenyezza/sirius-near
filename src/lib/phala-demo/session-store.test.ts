import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDemoPolicy } from "./contract";
import { DemoSessionStore } from "./session-store";

const owner = `0x${"a".repeat(40)}`;
const secondOwner = `0x${"b".repeat(40)}`;
const fingerprint = "c".repeat(64);
const policy = { funding: "credits", creditsUsdMicros: "5000000", cashUsdMicros: "0", ceilingUsdMicros: "2000000",
  maxOperations: 3, maxOperationsPerWallet: 2, maxConcurrent: 1 };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sirius-demo-"));
  const path = join(dir, "sessions.sqlite");
  const store = new DemoSessionStore(path);
  return { store, path, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("session fermée par défaut, fermeture effective et résultat en cours conservé", () => {
  const f = fixture();
  try {
    assert.equal(f.store.read().open, false);
    assert.throws(() => f.store.admit("train:one", owner, fingerprint), /fermée/);
    const opened = f.store.command("open", 0, owner, policy);
    assert.equal(opened.open, true);
    assert.equal("stopAt" in opened, false);
    f.store.admit("train:one", owner, fingerprint);
    f.store.command("close", opened.revision, owner);
    assert.equal(f.store.read().usedOperations, 1);
    assert.throws(() => f.store.admit("train:two", secondOwner, fingerprint), /fermée/);
    assert.equal(f.store.read().activeOperations, 1);
    assert.throws(() => f.store.command("open", 2, owner, policy), /termine/);
    f.store.finish("train:one", true);
    assert.equal(f.store.command("open", 2, owner, policy).open, true);
    assert.throws(() => f.store.admit("train:stale", owner, fingerprint, opened.revision), /remplacée/);
  } finally { f.cleanup(); }
});

test("les comptes et commandes sont partagés entre deux connexions et après redémarrage", () => {
  const f = fixture();
  const peer = new DemoSessionStore(f.path);
  try {
    f.store.command("open", 0, owner, policy);
    assert.throws(() => peer.command("open", 0, secondOwner, policy), /changé/);
    f.store.admit("train:one", owner, fingerprint);
    assert.throws(() => peer.admit("train:two", secondOwner, fingerprint), /occupée/);
    f.store.finish("train:one", true);
    peer.admit("train:two", owner, fingerprint);
    peer.finish("train:two", false);
    assert.throws(() => f.store.admit("train:three", owner, fingerprint), /Quota/);
    const reopened = new DemoSessionStore(f.path);
    try { assert.equal(reopened.read().usedOperations, 2); } finally { reopened.close(); }
    peer.admit("train:three", secondOwner, fingerprint);
    peer.finish("train:three", true);
    assert.throws(() => f.store.admit("train:four", secondOwner, fingerprint), /Quota/);
  } finally { peer.close(); f.cleanup(); }
});

test("un rejeu terminé ne recrée pas une admission et une substitution de propriétaire est refusée", () => {
  const f = fixture();
  try {
    f.store.command("open", 0, owner, policy);
    assert.equal(f.store.admit("seal:one", owner, fingerprint), true);
    f.store.finish("seal:one", true);
    assert.equal(f.store.admit("seal:one", owner, fingerprint), false);
    assert.equal(f.store.read().usedOperations, 1);
    assert.throws(() => f.store.admit("seal:one", secondOwner, fingerprint), /incompatible/);
  } finally { f.cleanup(); }
});

test("le financement refuse les plafonds non financés et les sources contradictoires", () => {
  assert.throws(() => parseDemoPolicy({ ...policy, ceilingUsdMicros: "6000000" }), /insuffisant/);
  assert.throws(() => parseDemoPolicy({ ...policy, cashUsdMicros: "1" }), /incohérent/);
  assert.throws(() => parseDemoPolicy({ ...policy, funding: "sirius" }), /incohérent/);
  assert.throws(() => parseDemoPolicy({ ...policy, maxOperationsPerWallet: 4 }), /invalide/);
  assert.equal(parseDemoPolicy({ ...policy, funding: "mixed", cashUsdMicros: "1000000" }).funding, "mixed");
});

test("seules les admissions orphelines passent en échec, jamais celles suivies par ce processus", () => {
  const directory = mkdtempSync(join(tmpdir(), "sirius-demo-orphans-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "session.sqlite");
  const owner = `0x${"34".repeat(20)}`;
  const policy = { funding: "credits", creditsUsdMicros: "1000", cashUsdMicros: "0", ceilingUsdMicros: "900",
    maxOperations: 4, maxOperationsPerWallet: 4, maxConcurrent: 2 };
  const crashed = new DemoSessionStore(path);
  try {
    crashed.command("open", 0, `0x${"12".repeat(20)}`, policy);
    crashed.admit("train:orphan", owner, "a".repeat(64));
  } finally { crashed.close(); }
  const store = new DemoSessionStore(path);
  try {
    store.admit("train:live", owner, "b".repeat(64));
    assert.equal(store.read().activeOperations, 2);
    assert.deepEqual(store.recoverOrphans(), ["train:orphan"]);
    assert.equal(store.read().activeOperations, 1, "l’opération suivie ici continue");
    assert.deepEqual(store.recoverOrphans(), []);
    store.finish("train:live", true);
    assert.equal(store.read().activeOperations, 0);
    assert.throws(() => store.admit("train:orphan", owner, "a".repeat(64)), /reprise opérateur/, "une orpheline ne redémarre pas toute seule");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
