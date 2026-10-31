/**
 * Durée de conservation des traces d'accès instantané (`KybAutoInvite`).
 *
 * Chaque ligne porte le wallet, le code signé et, quand l'ingress la transmet, l'adresse IP
 * du demandeur. Elles ne servent qu'aux plafonds (24 h par wallet, 1 h par IP et global) :
 * passé 48 heures, elles n'ont plus d'usage et sont supprimées par le reaper
 * (src/worker/reaper.ts), un lot borné par passe, la suivante reprenant le reste.
 * Idempotent : une passe sans ligne échue ne fait rien.
 *
 * Module sans accès base : le stockage est injecté, la version Prisma est dans
 * `src/lib/sirius/kyb-auto-invite.ts`. Les tests l'exécutent donc sans base.
 */

export const AUTO_INVITE_RETENTION_HOURS = 48;
/** Lignes supprimées au plus par passe : une passe du reaper reste courte même après un arriéré. */
export const AUTO_INVITE_PURGE_BATCH = 1_000;

export interface AutoInviteRetentionStore {
  /** Identifiants des lignes créées strictement avant `before`, les plus anciennes d'abord, au plus `limit`. */
  expiredIds(before: Date, limit: number): Promise<string[]>;
  /** Supprime ces lignes ; rend le nombre réellement supprimé. */
  deleteIds(ids: string[]): Promise<number>;
}

export function autoInviteCutoff(now: Date, hours = AUTO_INVITE_RETENTION_HOURS): Date {
  return new Date(now.getTime() - hours * 60 * 60_000);
}

/** Supprime un lot des lignes échues ; rend le nombre de lignes supprimées. */
export async function purgeExpiredAutoInvites(
  store: AutoInviteRetentionStore,
  now: Date,
  batch = AUTO_INVITE_PURGE_BATCH,
): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError("Lot de purge invalide");
  const ids = await store.expiredIds(autoInviteCutoff(now), batch);
  if (ids.length === 0) return 0;
  return store.deleteIds(ids);
}
