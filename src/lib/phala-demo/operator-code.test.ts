import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOperatorCode, hashOperatorCode, type OperatorCodeAttempts } from "./operator-code";
import { operatorAllowed } from "./operator";


const code = "correct-horse-battery-staple";
const wrong = "mauvais-code-123";
const configured = hashOperatorCode(code);
const denied = (status: number, pattern: RegExp) => (error: unknown) =>
  (error as { status?: number }).status === status && pattern.test((error as Error).message);

function memoryAttempts() {
  const rows: { id: string; address: string; at: Date }[] = [];
  let next = 0;
  const store: OperatorCodeAttempts = {
    record: async (address, at) => { const id = String(++next); rows.push({ id, address, at }); return id; },
    countSince: async (address, since) => rows.filter((row) => row.address === address && row.at > since).length,
    remove: async (id) => { const index = rows.findIndex((row) => row.id === id); if (index >= 0) rows.splice(index, 1); },
    purgeBefore: async (limit) => { for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index].at <= limit) rows.splice(index, 1); },
  };
  return { store, rows };
}

test("le code est haché avec sel, sans séparateur interpolé par les fichiers .env", () => {
  assert.match(configured, /^scrypt:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
  assert.notEqual(hashOperatorCode(code), configured);
  for (const weak of ["court", "espace interdit ici", "accentué-trop-long"]) assert.throws(() => hashOperatorCode(weak), /12 à 128/);
});

test("seul le bon code passe sans laisser de trace ; l'absence de configuration ferme l'accès", async () => {
  const now = new Date();
  const { store, rows } = memoryAttempts();
  await assertOperatorCode(`0x${"1".repeat(40)}`, code, store, now, configured);
  assert.equal(rows.length, 0);
  for (const guess of [null, "", `${code}x`, "é".repeat(12)]) {
    await assert.rejects(assertOperatorCode(`0x${"2".repeat(40)}`, guess, memoryAttempts().store, now, configured), denied(403, /invalide/));
  }
  for (const missing of [undefined, "", "sha256:abc", configured.replace("scrypt:", "scrypt$")]) {
    await assert.rejects(assertOperatorCode(`0x${"3".repeat(40)}`, code, store, now, missing), denied(403, /non configuré/));
  }
  assert.equal(rows.length, 0);
});

test("cinq échecs verrouillent le wallet quinze minutes, même avec le bon code, sans prolonger le verrou", async () => {
  const { store, rows } = memoryAttempts();
  const wallet = `0x${"a4".repeat(20)}`;
  const start = Date.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(assertOperatorCode(wallet, wrong, store, new Date(start + attempt), configured), denied(403, /invalide/));
  }
  await assert.rejects(assertOperatorCode(`0x${"A4".repeat(20)}`, code, store, new Date(start + 1_000), configured), denied(429, /15 minutes/));
  await assert.rejects(assertOperatorCode(wallet, code, store, new Date(start + 14 * 60_000), configured), denied(429, /15 minutes/));
  assert.equal(rows.length, 5, "les refus pendant le verrou ne s'inscrivent pas");
  await assertOperatorCode(wallet, code, store, new Date(start + 15 * 60_000 + 5), configured);
});

test("un succès n'efface pas les échecs précédents", async () => {
  const { store } = memoryAttempts();
  const wallet = `0x${"5".repeat(40)}`;
  const now = new Date();
  for (let attempt = 0; attempt < 4; attempt += 1) await assert.rejects(assertOperatorCode(wallet, wrong, store, now, configured));
  await assertOperatorCode(wallet, code, store, now, configured);
  await assert.rejects(assertOperatorCode(wallet, wrong, store, now, configured), denied(403, /invalide/));
  await assert.rejects(assertOperatorCode(wallet, code, store, now, configured), denied(429, /15 minutes/));
});

test("les tentatives expirées sont purgées au prochain échec", async () => {
  const { store, rows } = memoryAttempts();
  const start = Date.now();
  await assert.rejects(assertOperatorCode(`0x${"6".repeat(40)}`, wrong, store, new Date(start), configured));
  await assert.rejects(assertOperatorCode(`0x${"7".repeat(40)}`, wrong, store, new Date(start + 16 * 60_000), configured));
  assert.deepEqual(rows.map((row) => row.address), [`0x${"7".repeat(40)}`]);
});

test("l'allowlist opérateur reste stricte et insensible à la casse", () => {
  const first = `0x${"ab".repeat(20)}`;
  assert.equal(operatorAllowed(first.toUpperCase().replace("0X", "0x"), `${first}, 0x${"cd".repeat(20)}`), true);
  assert.equal(operatorAllowed(`0x${"ef".repeat(20)}`, first), false);
  assert.equal(operatorAllowed(first, undefined), false);
  assert.equal(operatorAllowed(first, `${first},pas-une-adresse`), false);
});
