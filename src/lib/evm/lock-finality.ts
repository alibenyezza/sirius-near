/**
 * Attente de finalité d'un lock de paiement : estimation partagée entre la route
 * `GET /api/loans/[id]/finality` et la page Train. Fonctions pures, sans accès réseau.
 *
 * Sur Robinhood Chain (Arbitrum Nitro), le bloc `finalized` suit la finalité L1 et reste
 * environ un quart d'heure derrière la tête (docs/passage-mainnet/19-mise-en-production.md :
 * ≈ 8 500 blocs, 14 min, relevé du 5 octobre ; docs/MAINNET-RUNBOOKS.md : « environ
 * 16 minutes »). `prepareLoanResult` refuse l'entraînement tant que le bloc stable n'a pas
 * atteint le bloc de lock (`assertBlockStable`). Plutôt qu'une constante qui vieillirait,
 * l'estimation lit la chaîne : le pointeur stable avance au rythme de l'horloge, donc le temps
 * qu'il atteigne le bloc de lock vaut à peu près l'écart entre l'horodatage du lock et celui
 * du bloc stable courant. En mode `confirmations` (testnet), cet écart se compte en secondes.
 */

export interface LockFinalityObservation {
  lockBlock: bigint;
  /** Horodatage du bloc de lock, en secondes (champ `timestamp` du bloc). */
  lockTimestamp: bigint;
  /** Bloc stable courant (`confirmedBlock`) et son horodatage en secondes. */
  stableBlock: bigint;
  stableTimestamp: bigint;
}

export interface LockFinalityEstimate {
  pending: boolean;
  /** Durée estimée avant que le lock passe sous le bloc stable ; 0 s'il l'est déjà. */
  remainingMs: number;
  /** Instant estimé (ms epoch serveur) correspondant ; `now` s'il l'est déjà. */
  estimatedReadyAt: number;
}

export function estimateLockFinality(observation: LockFinalityObservation, now = Date.now()): LockFinalityEstimate {
  if (observation.stableBlock >= observation.lockBlock) return { pending: false, remainingMs: 0, estimatedReadyAt: now };
  const remainingMs = Math.max(0, Number(observation.lockTimestamp - observation.stableTimestamp) * 1_000);
  return { pending: true, remainingMs, estimatedReadyAt: now + remainingMs };
}

/**
 * Palier rapide (fast-finality.ts) : le lock est prêt dès que la tête a `confirmations - 1` blocs
 * au-dessus de lui. Robinhood Chain produit une dizaine de blocs par seconde ; l'estimation
 * compte 250 ms par bloc, volontairement large : mieux vaut annoncer dix secondes et en attendre
 * trois que l'inverse. En pratique, trente confirmations se comptent en secondes.
 */
export const FAST_FINALITY_MS_PER_BLOCK = 250;

export interface FastLockFinalityObservation {
  lockBlock: bigint;
  tipBlock: bigint;
  confirmations: number;
}

export function estimateFastLockFinality(observation: FastLockFinalityObservation, now = Date.now()): LockFinalityEstimate {
  const required = observation.lockBlock + BigInt(observation.confirmations) - BigInt(1);
  if (observation.tipBlock >= required) return { pending: false, remainingMs: 0, estimatedReadyAt: now };
  const remainingMs = Number(required - observation.tipBlock) * FAST_FINALITY_MS_PER_BLOCK;
  return { pending: true, remainingMs, estimatedReadyAt: now + remainingMs };
}

/** Minutes restantes affichées, arrondies au supérieur ; 0 dès que l'estimation est dépassée. */
export function lockFinalityMinutesLeft(estimatedReadyAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((estimatedReadyAt - now) / 60_000));
}

/** Secondes restantes affichées (palier rapide), arrondies au supérieur ; 0 dès que l'estimation est dépassée. */
export function lockFinalitySecondsLeft(estimatedReadyAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((estimatedReadyAt - now) / 1_000));
}

/** Relecture au plus tôt 20 s, au plus tard 60 s après la précédente : jamais de rafale RPC. */
export const LOCK_FINALITY_POLL_MIN_MS = 20_000;
export const LOCK_FINALITY_POLL_MAX_MS = 60_000;
/** Palier rapide : l'attente se compte en secondes, la relecture aussi (la route admet 30 lectures par minute). */
export const LOCK_FINALITY_FAST_POLL_MIN_MS = 5_000;
export const LOCK_FINALITY_FAST_POLL_MAX_MS = 20_000;

export type LockFinalityTier = "FULL" | "FAST";

/**
 * Délai avant la prochaine lecture de `/api/loans/[id]/finality` : à l'instant estimé, borné
 * entre les limites du palier. Une estimation dépassée relit donc toutes les 20 s (5 s en rapide).
 */
export function nextLockFinalityCheckMs(estimatedReadyAt: number, now = Date.now(), tier: LockFinalityTier = "FULL"): number {
  const [min, max] = tier === "FAST"
    ? [LOCK_FINALITY_FAST_POLL_MIN_MS, LOCK_FINALITY_FAST_POLL_MAX_MS]
    : [LOCK_FINALITY_POLL_MIN_MS, LOCK_FINALITY_POLL_MAX_MS];
  return Math.min(max, Math.max(min, estimatedReadyAt - now));
}

export interface LockFinalityResponse {
  pending: boolean;
  /** Durée restante calculée par le serveur (ms) quand `pending` ; `null` sinon. Jamais une date : l'horloge du client peut différer. */
  remainingMs: number | null;
  /** ISO 8601 indicatif quand `pending` ; `null` sinon. */
  estimatedReadyAt: string | null;
  /** Palier de finalité du prêt (`FAST` : secondes ; `FULL` : un quart d'heure sur mainnet). Absent sur les anciennes réponses. */
  tier?: LockFinalityTier;
}

/**
 * Lecture d'un corps HTTP 200. Tout corps inattendu vaut « pas en attente » : l'appelant ne doit
 * passer ici qu'une réponse 200, une erreur HTTP ou réseau n'est jamais une finalité. Le palier
 * illisible ou absent vaut `FULL` : l'affichage long est le plus prudent.
 */
export function parseLockFinalityResponse(body: unknown): { pending: boolean; remainingMs: number | null; tier: LockFinalityTier } {
  const tier = body && typeof body === "object" && (body as { tier?: unknown }).tier === "FAST" ? "FAST" : "FULL";
  if (!body || typeof body !== "object" || (body as { pending?: unknown }).pending !== true) {
    return { pending: false, remainingMs: null, tier };
  }
  const raw = (body as { remainingMs?: unknown }).remainingMs;
  return { pending: true, remainingMs: typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null, tier };
}
