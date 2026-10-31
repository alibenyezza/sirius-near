-- Purge du journal des accès après 24 mois (src/lib/users/access-log-retention.ts) : le reaper
-- sélectionne les lignes les plus anciennes par date de création. Additive : index seul.
CREATE INDEX "DatasetAccessLog_createdAt_idx" ON "DatasetAccessLog"("createdAt");
