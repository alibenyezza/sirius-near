import assert from "node:assert/strict";
import { test } from "node:test";
import { createKybStatusReader } from "./kyb";
import { marketplaceToken } from "./token";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

test("KYB : vrai, faux, et une réponse non booléenne n'est jamais « vérifié »", async () => {
  const reader = createKybStatusReader(async (address) => (address === A ? true : address === B ? false : ("yes" as unknown as boolean)));
  const result = await reader([A, B, MIXED]);
  assert.deepEqual([...result.entries()], [[A, true], [B, false], [MIXED, false]]);
});

test("KYB : une panne, une exception synchrone ou un délai dépassé donnent « inconnu »", async () => {
  const slow = createKybStatusReader(() => new Promise(() => {}), { timeoutMs: 20 });
  assert.equal((await slow([A])).get(A), null);
  const failing = createKybStatusReader(async () => { throw new Error("RPC down"); });
  assert.equal((await failing([A])).get(A), null);
  const throwing = createKybStatusReader(() => { throw new Error("adresse du registre manquante"); });
  assert.equal((await throwing([A])).get(A), null);
});

test("KYB : adresses invalides ignorées, lectures bornées par requête", async () => {
  let reads = 0;
  const reader = createKybStatusReader(async () => { reads++; return true; }, { maxLookups: 2 });
  const result = await reader(["pas une adresse", "0x123", A, B, `0x${"44".repeat(20)}`]);
  assert.equal(result.get("pas une adresse"), null);
  assert.equal(result.get("0x123"), null);
  assert.equal(result.get(`0x${"44".repeat(20)}`), null);
  assert.equal(reads, 2);
});

test("KYB : résultat mis en cache, échec retenu moins longtemps", async () => {
  let clock = 0;
  let reads = 0;
  let fail = true;
  const reader = createKybStatusReader(async () => {
    reads++;
    if (fail) throw new Error("RPC");
    return true;
  }, { now: () => clock });
  assert.equal((await reader([A])).get(A), null);
  clock += 5_000;
  assert.equal((await reader([A])).get(A), null);
  assert.equal(reads, 1);
  fail = false;
  clock += 6_000;
  assert.equal((await reader([A])).get(A), true);
  assert.equal(reads, 2);
  clock += 59_000;
  assert.equal((await reader([A, A])).get(A), true);
  assert.equal(reads, 2);
  clock += 2_000;
  await reader([A]);
  assert.equal(reads, 3);
});

test("KYB : requêtes simultanées partagent la même lecture ; une relecture en échec garde la dernière valeur", async () => {
  let clock = 0;
  let reads = 0;
  let fail = false;
  let release: () => void = () => {};
  const gate = () => new Promise<void>((resolve) => { release = resolve; });
  let wait = gate();
  const reader = createKybStatusReader(async () => {
    reads++;
    await wait;
    if (fail) throw new Error("RPC");
    return true;
  }, { now: () => clock, timeoutMs: 1_000 });
  const parallel = Promise.all(Array.from({ length: 20 }, () => reader([A])));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  for (const result of await parallel) assert.equal(result.get(A), true);
  assert.equal(reads, 1);

  // Le cache expire, la relecture échoue : la dernière valeur connue reste servie un temps borné.
  fail = true;
  wait = Promise.resolve();
  clock += 61_000;
  assert.equal((await reader([A])).get(A), true);
  clock += 10 * 60_000;
  assert.equal((await reader([A])).get(A), null);
});

test("jeton affiché : USDG à 6 décimales sur mainnet, USDC du testnet à 18", () => {
  assert.deepEqual(marketplaceToken("mainnet"), { symbol: "USDG", decimals: 6 });
  assert.deepEqual(marketplaceToken("testnet"), { symbol: "USDC", decimals: 18 });
});
