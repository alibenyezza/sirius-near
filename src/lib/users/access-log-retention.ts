/**
 * Durée de conservation du journal des accès aux datasets.
 *
 * Les conditions (/terms) et la politique de confidentialité (/privacy) annoncent une
 * conservation de 24 mois après l'accès, puis la suppression. Le reaper (src/worker/reaper.ts)
 * appelle `purgeExpiredAccessLogs` à chaque passe : un lot borné des lignes les plus anciennes
 * au-delà de l'échéance est supprimé, la passe suivante reprend le reste. Idempotent : une
 * ligne déjà supprimée ne compte plus, une passe sans ligne échue ne fait rien.
 *
 * Module sans accès base : le stockage est injecté (`AccessLogRetentionStore`), la version
 * Prisma est dans `access-log-store.ts`. Les tests l'exécutent donc sans base.
 */

export const ACCESS_LOG_RETENTION_MONTHS = 24;
/** Lignes supprimées au plus par passe : une passe du reaper reste courte même après un arriéré. */
export const ACCESS_LOG_PURGE_BATCH = 1_000;

export interface AccessLogRetentionStore {
  /** Identifiants des lignes créées strictement avant `before`, les plus anciennes d'abord, au plus `limit`. */
  expiredIds(before: Date, limit: number): Promise<string[]>;
  /** Supprime ces lignes ; rend le nombre réellement supprimé (une ligne déjà partie ne compte pas). */
  deleteIds(ids: string[]): Promise<number>;
}

/**
 * Échéance : `now` moins 24 mois calendaires, en UTC. Un jour absent du mois cible (29 février,
 * 31) se replie sur le dernier jour de ce mois plutôt que de déborder sur le suivant : une
 * ligne n'est jamais supprimée avant ses 24 mois.
 */
export function accessLogCutoff(now: Date, months = ACCESS_LOG_RETENTION_MONTHS): Date {
  const cutoff = new Date(now.getTime());
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  return cutoff;
}

/** Supprime un lot des lignes échues ; rend le nombre de lignes supprimées. */
export async function purgeExpiredAccessLogs(
  store: AccessLogRetentionStore,
  now: Date,
  batch = ACCESS_LOG_PURGE_BATCH,
): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError("Lot de purge invalide");
  const ids = await store.expiredIds(accessLogCutoff(now), batch);
  if (ids.length === 0) return 0;
  return store.deleteIds(ids);
}
