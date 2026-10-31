import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_INVITE_PURGE_BATCH, autoInviteCutoff, purgeExpiredAutoInvites, type AutoInviteRetentionStore } from "./auto-invite-retention";

const NOW = new Date("2026-10-06T12:00:00Z");

function memoryStore(rows: { id: string; createdAt: Date }[]) {
  const calls: { before: Date; limit: number }[] = [];
  const store: AutoInviteRetentionStore = {
    expiredIds: async (before, limit) => {
      calls.push({ before, limit });
      return rows.filter((row) => row.createdAt < before).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit).map((row) => row.id);
    },
    deleteIds: async (ids) => {
      let count = 0;
      for (const id of ids) {
        const index = rows.findIndex((row) => row.id === id);
        if (index >= 0) { rows.splice(index, 1); count += 1; }
      }
      return count;
    },
  };
  return { store, rows, calls };
}

test("l'échéance est 48 heures avant l'instant de la passe", () => {
  assert.equal(autoInviteCutoff(NOW).toISOString(), "2026-10-04T12:00:00.000Z");
});

test("seules les lignes de plus de 48 h partent, les plus anciennes d'abord, par lot borné ; une passe vide ne fait rien", async () => {
  const hours = (count: number) => new Date(NOW.getTime() - count * 60 * 60_000);
  const { store, rows, calls } = memoryStore([
    { id: "récent", createdAt: hours(1) }, { id: "limite", createdAt: hours(48) },
    { id: "vieux", createdAt: hours(49) }, { id: "plus-vieux", createdAt: hours(72) }, { id: "ancien", createdAt: hours(200) },
  ]);
  assert.equal(await purgeExpiredAutoInvites(store, NOW, 2), 2);
  assert.deepEqual(rows.map((row) => row.id), ["récent", "limite", "vieux"]);
  assert.equal(await purgeExpiredAutoInvites(store, NOW, 2), 1);
  assert.deepEqual(rows.map((row) => row.id), ["récent", "limite"]);
  assert.equal(await purgeExpiredAutoInvites(store, NOW), 0);
  assert.deepEqual(calls.map((call) => call.limit), [2, 2, AUTO_INVITE_PURGE_BATCH]);
  await assert.rejects(purgeExpiredAutoInvites(store, NOW, 0), RangeError);
});
