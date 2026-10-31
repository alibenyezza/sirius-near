import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCESS_LOG_PURGE_BATCH,
  ACCESS_LOG_RETENTION_MONTHS,
  accessLogCutoff,
  purgeExpiredAccessLogs,
  type AccessLogRetentionStore,
} from "./access-log-retention";

/** Journal en mémoire : mêmes règles que la requête Prisma (strictement avant, plus anciens d'abord, lot borné). */
function memoryStore(rows: { id: string; createdAt: Date }[]) {
  const calls: { before: Date; limit: number }[] = [];
  const store: AccessLogRetentionStore = {
    expiredIds: async (before, limit) => {
      calls.push({ before, limit });
      return rows
        .filter((row) => row.createdAt < before)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit)
        .map((row) => row.id);
    },
    deleteIds: async (ids) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) if (ids.includes(rows[i].id)) rows.splice(i, 1);
      return before - rows.length;
    },
  };
  return { store, rows, calls };
}

const NOW = new Date("2026-10-06T12:00:00.000Z");

test("échéance : 24 mois calendaires, jamais moins", () => {
  assert.equal(ACCESS_LOG_RETENTION_MONTHS, 24);
  assert.equal(accessLogCutoff(NOW).toISOString(), "2024-10-06T12:00:00.000Z");
  // Jour absent du mois cible : repli sur le dernier jour, pas de débordement sur le mois suivant.
  assert.equal(accessLogCutoff(new Date("2026-02-28T00:00:00.000Z")).toISOString(), "2024-02-28T00:00:00.000Z");
  assert.equal(accessLogCutoff(new Date("2026-03-31T08:00:00.000Z")).toISOString(), "2024-03-31T08:00:00.000Z");
  assert.equal(accessLogCutoff(new Date("2027-02-28T00:00:00.000Z")).toISOString(), "2025-02-28T00:00:00.000Z");
  assert.equal(accessLogCutoff(new Date("2026-12-31T00:00:00.000Z"), 10).toISOString(), "2026-02-28T00:00:00.000Z");
});

test("purge : seules les lignes de plus de 24 mois partent, les autres restent", async () => {
  const { store, rows } = memoryStore([
    { id: "vieille", createdAt: new Date("2024-10-06T11:59:59.999Z") },
    { id: "pile", createdAt: new Date("2024-10-06T12:00:00.000Z") },
    { id: "recente", createdAt: new Date("2026-01-01T00:00:00.000Z") },
  ]);
  assert.equal(await purgeExpiredAccessLogs(store, NOW), 1);
  assert.deepEqual(rows.map((row) => row.id), ["pile", "recente"]);
});

test("purge : lot borné par passe, les plus anciennes d'abord, reprise à la passe suivante", async () => {
  const old = (i: number) => ({ id: `l${i}`, createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)) });
  const { store, rows, calls } = memoryStore([old(4), old(1), old(3), old(2), old(0)]);
  assert.equal(await purgeExpiredAccessLogs(store, NOW, 2), 2);
  assert.deepEqual(rows.map((row) => row.id).sort(), ["l2", "l3", "l4"]);
  assert.equal(await purgeExpiredAccessLogs(store, NOW, 2), 2);
  assert.equal(await purgeExpiredAccessLogs(store, NOW, 2), 1);
  assert.equal(rows.length, 0);
  assert.ok(calls.every((call) => call.limit === 2));
  assert.equal(ACCESS_LOG_PURGE_BATCH, 1_000);
  await purgeExpiredAccessLogs(store, NOW);
  assert.equal(calls.at(-1)?.limit, ACCESS_LOG_PURGE_BATCH);
});

test("purge idempotente : rien d'échu, aucune suppression demandée", async () => {
  let deletes = 0;
  const { store } = memoryStore([{ id: "recente", createdAt: NOW }]);
  const counted: AccessLogRetentionStore = { ...store, deleteIds: async (ids) => { deletes += 1; return store.deleteIds(ids); } };
  assert.equal(await purgeExpiredAccessLogs(counted, NOW), 0);
  assert.equal(await purgeExpiredAccessLogs(counted, NOW), 0);
  assert.equal(deletes, 0);
  // Une ligne supprimée entre la sélection et la suppression ne compte pas.
  const racing: AccessLogRetentionStore = { expiredIds: async () => ["partie"], deleteIds: async () => 0 };
  assert.equal(await purgeExpiredAccessLogs(racing, NOW), 0);
});

test("purge : lot invalide refusé avant toute requête", async () => {
  const { store, calls } = memoryStore([]);
  for (const batch of [0, -1, 1.5, Number.NaN]) await assert.rejects(purgeExpiredAccessLogs(store, NOW, batch), RangeError);
  assert.equal(calls.length, 0);
});

test("reaper : purge à chaque passe, par l'index createdAt, sans jamais faire échouer la passe", () => {
  const reaper = readFileSync(join(process.cwd(), "src", "worker", "reaper.ts"), "utf8");
  const loop = reaper.slice(reaper.indexOf("while (!arret)"), reaper.indexOf("[reaper] arrêté proprement"));
  const purge = loop.indexOf("purgeExpiredAccessLogs(databaseAccessLogRetention, new Date())");
  assert.ok(purge > loop.indexOf("runLoanReaper()"), "après la passe des prêts");
  assert.ok(purge < loop.indexOf("reaperHeartbeat("), "avant le battement");
  const block = loop.slice(loop.lastIndexOf("try {", purge), loop.indexOf("// Battement lu par check-reaper.sh"));
  assert.match(block, /\} catch \{\s*console\.error\("\[reaper\] purge du journal des accès échouée, reprise à la suivante"\);/);
  assert.match(block, /console\.log\(`\[reaper\] journal des accès purgé : lignes=\$\{purges\}`\)/);
  const store = readFileSync(join(process.cwd(), "src", "lib", "users", "access-log-store.ts"), "utf8");
  assert.match(store, /where: \{ createdAt: \{ lt: before \} \}/);
  assert.match(store, /orderBy: \{ createdAt: "asc" \}/);
  assert.match(store, /take: limit/);
  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const model = schema.slice(schema.indexOf("model DatasetAccessLog"), schema.indexOf("model UserProfile"));
  assert.match(model, /@@index\(\[createdAt\]\)/);
  const migration = readFileSync(join(process.cwd(), "prisma", "migrations", "20261006000000_add_access_log_created_at_index", "migration.sql"), "utf8");
  assert.match(migration, /CREATE INDEX "DatasetAccessLog_createdAt_idx" ON "DatasetAccessLog"\("createdAt"\);/);
});
