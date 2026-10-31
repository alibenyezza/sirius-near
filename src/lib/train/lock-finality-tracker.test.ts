import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCK_FINALITY_ERROR_BACKOFF_MAX_MS,
  LOCK_FINALITY_MAX_WAIT_MS,
  initialLockFinalityTracking,
  lockFinalityErrorBackoffMs,
  lockFinalityLocalReadyAt,
  lockFinalityRunRefused,
  observeLockFinality,
  type LockFinalityTracking,
} from "./lock-finality-tracker";

const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);
const MIN = 60_000;

const pending = (remainingMs: number | null = 14 * MIN) => ({ kind: "ok", pending: true, remainingMs } as const);
const ready = { kind: "ok", pending: false } as const;
const failure = { kind: "error" } as const;

test("une première lecture « en attente » ouvre l'attente, relit à l'instant estimé et ne lance rien", () => {
  const decision = observeLockFinality(initialLockFinalityTracking(), pending(), NOW);
  assert.equal(decision.action, "recheck");
  assert.equal(decision.recheckInMs, 60_000);
  assert.deepEqual(decision.next, { phase: "pending", remainingMs: 14 * MIN, observedAt: NOW, waitingSince: NOW, failures: 0, autoStarted: false, tier: "FULL" });
  assert.equal(lockFinalityLocalReadyAt(decision.next), NOW + 14 * MIN);
  // Sans estimation : relecture au plus tôt.
  assert.equal(observeLockFinality(initialLockFinalityTracking(), pending(null), NOW).recheckInMs, 20_000);
});

test("palier rapide annoncé par le serveur : compte en secondes, relecture courte, palier conservé sur erreur et à la fin", () => {
  const fast = observeLockFinality(initialLockFinalityTracking(), { kind: "ok", pending: true, remainingMs: 7_000, tier: "FAST" }, NOW);
  assert.equal(fast.action, "recheck");
  assert.equal(fast.recheckInMs, 7_000, "entre 5 s et 20 s, à l'instant estimé");
  assert.equal(fast.next.tier, "FAST");
  assert.equal(observeLockFinality(initialLockFinalityTracking(), { kind: "ok", pending: true, remainingMs: 0, tier: "FAST" }, NOW).recheckInMs, 5_000);
  // Une erreur ne change pas le palier ; une lecture sans palier le conserve aussi.
  assert.equal(observeLockFinality(fast.next, failure, NOW + 5_000).next.tier, "FAST");
  assert.equal(observeLockFinality(fast.next, pending(3_000), NOW + 5_000).next.tier, "FAST");
  assert.equal(observeLockFinality(fast.next, pending(3_000), NOW + 5_000).recheckInMs, 5_000);
  // Le serveur peut rétrograder (plafond atteint entre deux lectures) : l'affichage repasse en minutes.
  const downgraded = observeLockFinality(fast.next, { kind: "ok", pending: true, remainingMs: 14 * MIN, tier: "FULL" }, NOW + 10_000);
  assert.equal(downgraded.next.tier, "FULL");
  assert.equal(downgraded.recheckInMs, 60_000);
  const done = observeLockFinality(fast.next, { kind: "ok", pending: false, tier: "FAST" }, NOW + 8_000);
  assert.equal(done.action, "auto-run");
  assert.equal(done.next.tier, "FAST");
});

test("seule une réponse 200 pending:false après une attente observée lance le job, une seule fois", () => {
  const waiting = observeLockFinality(initialLockFinalityTracking(), pending(), NOW).next;
  const done = observeLockFinality(waiting, ready, NOW + 14 * MIN);
  assert.equal(done.action, "auto-run");
  assert.equal(done.next.phase, "ready");
  assert.equal(done.next.autoStarted, true);
  // Déjà prêt : plus aucune lecture ni lancement, quoi que dise une relecture.
  for (const result of [ready, pending(), failure]) {
    const again = observeLockFinality(done.next, result, NOW + 15 * MIN);
    assert.equal(again.action, "none");
    assert.equal(again.next, done.next);
  }
  // Prêt dès la première lecture (page ouverte après la finalité) : rien ne part tout seul.
  const fresh = observeLockFinality(initialLockFinalityTracking(), ready, NOW);
  assert.equal(fresh.action, "none");
  assert.equal(fresh.next.phase, "ready");
  assert.equal(fresh.next.autoStarted, false);
});

test("une erreur (429, 503, réseau) conserve l'état précédent, ne lance jamais et relit avec un délai croissant", () => {
  const waiting = observeLockFinality(initialLockFinalityTracking(), pending(), NOW).next;
  let state: LockFinalityTracking = waiting;
  const delays: number[] = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    const decision = observeLockFinality(state, failure, NOW + attempt * MIN);
    assert.equal(decision.action, "recheck");
    assert.notEqual(decision.action, "auto-run");
    assert.equal(decision.next.phase, "pending");
    assert.equal(decision.next.remainingMs, waiting.remainingMs, "l'estimation précédente reste affichée");
    assert.equal(decision.next.observedAt, waiting.observedAt);
    assert.equal(decision.next.waitingSince, NOW);
    assert.equal(decision.next.failures, attempt);
    delays.push(decision.recheckInMs!);
    state = decision.next;
  }
  assert.deepEqual(delays, [20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.equal(lockFinalityErrorBackoffMs(50), LOCK_FINALITY_ERROR_BACKOFF_MAX_MS);
  // Une erreur avant toute lecture réussie n'ouvre pas l'attente : pas de lancement automatique plus tard.
  const unknownAfterError = observeLockFinality(initialLockFinalityTracking(), failure, NOW).next;
  assert.equal(unknownAfterError.phase, "unknown");
  assert.equal(unknownAfterError.waitingSince, null);
  assert.equal(observeLockFinality(unknownAfterError, ready, NOW + MIN).action, "none");
  // Une lecture réussie remet les échecs à zéro.
  assert.equal(observeLockFinality(state, pending(), NOW + 10 * MIN).next.failures, 0);
});

test("un lancement refusé pour finalité (409) rend le lancement automatique et reprend l'attente", () => {
  const waiting = observeLockFinality(initialLockFinalityTracking(), pending(), NOW).next;
  const started = observeLockFinality(waiting, ready, NOW + 14 * MIN);
  assert.equal(started.action, "auto-run");
  const refused = lockFinalityRunRefused(started.next, NOW + 14 * MIN + 5_000);
  assert.equal(refused.action, "recheck");
  assert.equal(refused.recheckInMs, 0);
  assert.equal(refused.next.phase, "pending");
  assert.equal(refused.next.autoStarted, false, "le lancement n'a rien lancé : il n'est pas consommé");
  assert.equal(refused.next.waitingSince, NOW, "l'attente initiale borne toujours la durée totale");
  // La finalité arrive ensuite réellement : un nouveau lancement automatique est permis.
  const retried = observeLockFinality(observeLockFinality(refused.next, pending(MIN), NOW + 15 * MIN).next, ready, NOW + 16 * MIN);
  assert.equal(retried.action, "auto-run");
  // Un clic manuel refusé, sans attente préalable, ouvre l'attente à cet instant.
  const manual = lockFinalityRunRefused(initialLockFinalityTracking(), NOW);
  assert.equal(manual.next.phase, "pending");
  assert.equal(manual.next.waitingSince, NOW);
  assert.equal(manual.action, "recheck");
});

test("l'attente s'arrête après la durée maximale : plus de lecture, l'emprunteur reviendra", () => {
  assert.equal(LOCK_FINALITY_MAX_WAIT_MS, 40 * MIN);
  const waiting = observeLockFinality(initialLockFinalityTracking(), pending(), NOW).next;
  const still = observeLockFinality(waiting, pending(MIN), NOW + LOCK_FINALITY_MAX_WAIT_MS - 1);
  assert.equal(still.action, "recheck");
  const exhausted = observeLockFinality(still.next, pending(MIN), NOW + LOCK_FINALITY_MAX_WAIT_MS);
  assert.equal(exhausted.action, "give-up");
  assert.equal(exhausted.next.phase, "exhausted");
  for (const result of [ready, pending(), failure]) {
    assert.equal(observeLockFinality(exhausted.next, result, NOW + 41 * MIN).action, "none");
  }
  assert.equal(lockFinalityRunRefused(exhausted.next, NOW + 41 * MIN).action, "none");
});
