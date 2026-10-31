import { LOCK_FINALITY_POLL_MIN_MS, nextLockFinalityCheckMs, type LockFinalityTier } from "@/lib/evm/lock-finality";

/**
 * Suivi, côté page Train, de l'attente de finalité d'un lock : décisions pures, sans horloge ni
 * réseau, pour qu'elles soient testées sans navigateur. La page ne fait qu'appliquer l'action
 * rendue (relire plus tard, lancer le job, s'arrêter).
 *
 * Règles :
 *  - seule une réponse HTTP 200 avec `pending: false` vaut finalité ; une erreur (429, 503,
 *    réseau) conserve l'état précédent et relit avec un délai croissant, sans jamais lancer ;
 *  - un seul lancement automatique par prêt, et seulement après une attente observée sur cette
 *    page ; si ce lancement est refusé pour finalité (409), il n'est pas consommé : l'attente
 *    reprend ;
 *  - un prêt connu « prêt » n'est plus relu ; une attente qui dépasse `LOCK_FINALITY_MAX_WAIT_MS`
 *    s'arrête, l'emprunteur reviendra plus tard, son paiement reste dans l'escrow.
 */

export type LockFinalityPhase = "unknown" | "pending" | "ready" | "exhausted";

export interface LockFinalityTracking {
  phase: LockFinalityPhase;
  /** Durée restante annoncée par le serveur et instant (horloge locale) de cette lecture. */
  remainingMs: number | null;
  observedAt: number | null;
  /** Première lecture « en attente » sur cette page : borne l'attente et autorise le lancement automatique. */
  waitingSince: number | null;
  /** Lectures en erreur consécutives : délai de relecture croissant. */
  failures: number;
  /** Lancement automatique déjà consommé. */
  autoStarted: boolean;
  /** Palier annoncé par le serveur : `FAST` se compte en secondes, `FULL` en minutes. */
  tier: LockFinalityTier;
}

export type LockFinalityObservationResult =
  | { kind: "ok"; pending: true; remainingMs: number | null; tier?: LockFinalityTier }
  | { kind: "ok"; pending: false; tier?: LockFinalityTier }
  | { kind: "error" };

export type LockFinalityAction = "none" | "recheck" | "auto-run" | "give-up";

export interface LockFinalityDecision {
  next: LockFinalityTracking;
  action: LockFinalityAction;
  /** Délai avant la prochaine lecture, pour `recheck` seulement. */
  recheckInMs?: number;
}

/** Au-delà, la page cesse de relire : finalité anormalement longue, l'emprunteur reviendra. */
export const LOCK_FINALITY_MAX_WAIT_MS = 40 * 60_000;
/** Relecture après erreur : 20 s, 40 s, 80 s… plafonnées à 5 min. */
export const LOCK_FINALITY_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

export function initialLockFinalityTracking(): LockFinalityTracking {
  return { phase: "unknown", remainingMs: null, observedAt: null, waitingSince: null, failures: 0, autoStarted: false, tier: "FULL" };
}

export function lockFinalityErrorBackoffMs(failures: number): number {
  return Math.min(LOCK_FINALITY_ERROR_BACKOFF_MAX_MS, LOCK_FINALITY_POLL_MIN_MS * 2 ** Math.max(0, Math.min(failures - 1, 10)));
}

/** Instant (horloge locale) où le lancement devrait être accepté, d'après la dernière lecture. */
export function lockFinalityLocalReadyAt(state: LockFinalityTracking): number | null {
  return state.observedAt !== null && state.remainingMs !== null ? state.observedAt + state.remainingMs : null;
}

export function observeLockFinality(
  state: LockFinalityTracking,
  result: LockFinalityObservationResult,
  now: number,
): LockFinalityDecision {
  if (state.phase === "ready" || state.phase === "exhausted") return { next: state, action: "none" };
  if (result.kind === "error") {
    const next = { ...state, failures: state.failures + 1 };
    return { next, action: "recheck", recheckInMs: lockFinalityErrorBackoffMs(next.failures) };
  }
  // Le palier suit la dernière lecture réussie : relecture courte et compte en secondes en rapide.
  const tier = result.tier ?? state.tier;
  if (result.pending) {
    const waitingSince = state.waitingSince ?? now;
    if (now - waitingSince >= LOCK_FINALITY_MAX_WAIT_MS) {
      return { next: { ...state, phase: "exhausted", waitingSince, failures: 0, tier }, action: "give-up" };
    }
    const next: LockFinalityTracking = { ...state, phase: "pending", remainingMs: result.remainingMs, observedAt: now, waitingSince, failures: 0, tier };
    return { next, action: "recheck", recheckInMs: nextLockFinalityCheckMs(now + (result.remainingMs ?? 0), now, tier) };
  }
  const autoRun = state.waitingSince !== null && !state.autoStarted;
  const next: LockFinalityTracking = { ...state, phase: "ready", remainingMs: 0, observedAt: now, failures: 0, autoStarted: state.autoStarted || autoRun, tier };
  return { next, action: autoRun ? "auto-run" : "none" };
}

/**
 * `POST …/run` a répondu 409 « attente de finalité » (clic ou lancement automatique) : le prêt
 * attend de nouveau, et un lancement automatique consommé est rendu, puisqu'il n'a rien lancé.
 */
export function lockFinalityRunRefused(state: LockFinalityTracking, now: number): LockFinalityDecision {
  if (state.phase === "exhausted") return { next: state, action: "none" };
  const next: LockFinalityTracking = { ...state, phase: "pending", waitingSince: state.waitingSince ?? now, autoStarted: false, failures: 0 };
  return { next, action: "recheck", recheckInMs: 0 };
}
