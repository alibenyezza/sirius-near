import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAST_FINALITY_MS_PER_BLOCK,
  LOCK_FINALITY_FAST_POLL_MAX_MS,
  LOCK_FINALITY_FAST_POLL_MIN_MS,
  LOCK_FINALITY_POLL_MAX_MS,
  LOCK_FINALITY_POLL_MIN_MS,
  estimateFastLockFinality,
  estimateLockFinality,
  lockFinalityMinutesLeft,
  lockFinalitySecondsLeft,
  nextLockFinalityCheckMs,
  parseLockFinalityResponse,
} from "./lock-finality";

const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);

test("un lock sous le bloc stable n'attend plus, quel que soit l'écart d'horodatage", () => {
  for (const stableBlock of [BigInt(100), BigInt(150)]) {
    const estimate = estimateLockFinality(
      { lockBlock: BigInt(100), lockTimestamp: BigInt(1_000), stableBlock, stableTimestamp: BigInt(10) },
      NOW,
    );
    assert.deepEqual(estimate, { pending: false, remainingMs: 0, estimatedReadyAt: NOW });
  }
});

test("un lock au-dessus du bloc stable attend l'écart entre son horodatage et celui du bloc stable", () => {
  // Bloc stable horodaté 14 minutes avant le lock (≈ 8 500 blocs sur Robinhood Chain) : 14 min d'attente.
  const estimate = estimateLockFinality(
    { lockBlock: BigInt(9_000), lockTimestamp: BigInt(1_000 + 14 * 60), stableBlock: BigInt(500), stableTimestamp: BigInt(1_000) },
    NOW,
  );
  assert.deepEqual(estimate, { pending: true, remainingMs: 14 * 60_000, estimatedReadyAt: NOW + 14 * 60_000 });
  // Mode confirmations (testnet) : un bloc d'écart, quelques secondes.
  assert.deepEqual(
    estimateLockFinality({ lockBlock: BigInt(11), lockTimestamp: BigInt(1_002), stableBlock: BigInt(10), stableTimestamp: BigInt(1_000) }, NOW),
    { pending: true, remainingMs: 2_000, estimatedReadyAt: NOW + 2_000 },
  );
  // Horodatages incohérents (RPC en retard) : jamais de durée négative.
  assert.deepEqual(
    estimateLockFinality({ lockBlock: BigInt(11), lockTimestamp: BigInt(900), stableBlock: BigInt(10), stableTimestamp: BigInt(1_000) }, NOW),
    { pending: true, remainingMs: 0, estimatedReadyAt: NOW },
  );
});

test("les minutes restantes sont arrondies au supérieur et jamais négatives", () => {
  assert.equal(lockFinalityMinutesLeft(NOW + 14 * 60_000, NOW), 14);
  assert.equal(lockFinalityMinutesLeft(NOW + 13 * 60_000 + 1, NOW), 14);
  assert.equal(lockFinalityMinutesLeft(NOW + 1, NOW), 1);
  assert.equal(lockFinalityMinutesLeft(NOW, NOW), 0);
  assert.equal(lockFinalityMinutesLeft(NOW - 60_000, NOW), 0);
});

test("la relecture vise l'instant estimé, bornée entre 20 s et 60 s", () => {
  assert.equal(LOCK_FINALITY_POLL_MIN_MS, 20_000);
  assert.equal(LOCK_FINALITY_POLL_MAX_MS, 60_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 14 * 60_000, NOW), 60_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 45_000, NOW), 45_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 5_000, NOW), 20_000);
  assert.equal(nextLockFinalityCheckMs(NOW, NOW), 20_000);
  assert.equal(nextLockFinalityCheckMs(NOW - 60_000, NOW), 20_000);
});

test("la réponse du serveur est lue de façon défensive : seul pending: true met en attente, durée serveur en ms", () => {
  assert.deepEqual(parseLockFinalityResponse({ pending: true, remainingMs: 60_000, estimatedReadyAt: "2026-10-07T10:01:00.000Z" }), { pending: true, remainingMs: 60_000, tier: "FULL" });
  assert.deepEqual(parseLockFinalityResponse({ pending: true, remainingMs: 0 }), { pending: true, remainingMs: 0, tier: "FULL" });
  for (const remainingMs of ["60000", -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.deepEqual(parseLockFinalityResponse({ pending: true, remainingMs }), { pending: true, remainingMs: null, tier: "FULL" }, String(remainingMs));
  }
  for (const body of [{ pending: false, remainingMs: null }, { pending: "true" }, { known: true }, {}, null, undefined, "pending", []]) {
    assert.deepEqual(parseLockFinalityResponse(body), { pending: false, remainingMs: null, tier: "FULL" });
  }
  // Palier rapide annoncé par le serveur ; tout palier illisible retombe sur l'affichage long.
  assert.deepEqual(parseLockFinalityResponse({ pending: true, remainingMs: 5_000, tier: "FAST" }), { pending: true, remainingMs: 5_000, tier: "FAST" });
  assert.deepEqual(parseLockFinalityResponse({ pending: false, tier: "FAST" }), { pending: false, remainingMs: null, tier: "FAST" });
  assert.equal(parseLockFinalityResponse({ pending: true, remainingMs: 5_000, tier: "fast" }).tier, "FULL");
});

test("palier rapide : il manque (confirmations - 1) blocs au-dessus du lock, comptés 250 ms chacun, relecture entre 5 s et 20 s", () => {
  assert.equal(FAST_FINALITY_MS_PER_BLOCK, 250);
  // Lock au bloc 1 000, trente confirmations : prêt dès que la tête atteint 1 029.
  assert.deepEqual(estimateFastLockFinality({ lockBlock: BigInt(1_000), tipBlock: BigInt(1_029), confirmations: 30 }, NOW), { pending: false, remainingMs: 0, estimatedReadyAt: NOW });
  assert.deepEqual(estimateFastLockFinality({ lockBlock: BigInt(1_000), tipBlock: BigInt(5_000), confirmations: 30 }, NOW), { pending: false, remainingMs: 0, estimatedReadyAt: NOW });
  assert.deepEqual(estimateFastLockFinality({ lockBlock: BigInt(1_000), tipBlock: BigInt(1_028), confirmations: 30 }, NOW), { pending: true, remainingMs: 250, estimatedReadyAt: NOW + 250 });
  assert.deepEqual(estimateFastLockFinality({ lockBlock: BigInt(1_000), tipBlock: BigInt(1_000), confirmations: 30 }, NOW), { pending: true, remainingMs: 29 * 250, estimatedReadyAt: NOW + 29 * 250 });
  // Une seule confirmation : le bloc de lock lui-même suffit.
  assert.deepEqual(estimateFastLockFinality({ lockBlock: BigInt(1_000), tipBlock: BigInt(1_000), confirmations: 1 }, NOW), { pending: false, remainingMs: 0, estimatedReadyAt: NOW });
  assert.equal(lockFinalitySecondsLeft(NOW + 7_250, NOW), 8);
  assert.equal(lockFinalitySecondsLeft(NOW, NOW), 0);
  assert.equal(lockFinalitySecondsLeft(NOW - 1, NOW), 0);
  assert.equal(LOCK_FINALITY_FAST_POLL_MIN_MS, 5_000);
  assert.equal(LOCK_FINALITY_FAST_POLL_MAX_MS, 20_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 60_000, NOW, "FAST"), 20_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 7_000, NOW, "FAST"), 7_000);
  assert.equal(nextLockFinalityCheckMs(NOW, NOW, "FAST"), 5_000);
  assert.equal(nextLockFinalityCheckMs(NOW + 7_000, NOW, "FULL"), 20_000, "le palier complet garde ses bornes");
});
