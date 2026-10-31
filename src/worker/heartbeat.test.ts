import { test } from "node:test";
import assert from "node:assert/strict";
import { reaperHeartbeat } from "./heartbeat";

const at = new Date("2026-10-05T10:00:00.000Z");
const CHECK = /\[reaper\] passe ok /; // motif exigé par deploy/vps/check-reaper.sh

test("une passe qui lève n'écrit pas de battement sain", () => {
  const beat = reaperHeartbeat(null, at);
  assert.equal(beat.ok, false);
  assert.doesNotMatch(beat.line, CHECK);
  assert.match(beat.line, /passe échouée 2026-10-05T10:00:00.000Z/);
});

test("une passe où chaque prêt examiné échoue n'écrit pas de battement sain", () => {
  const beat = reaperHeartbeat({ examined: 3, failed: 3 }, at);
  assert.equal(beat.ok, false);
  assert.doesNotMatch(beat.line, CHECK);
  assert.match(beat.line, /prêts=3 erreurs=3/);
});

test("une passe réussie, même sans prêt à traiter, écrit passe ok avec le décompte", () => {
  assert.match(reaperHeartbeat({ examined: 0, failed: 0 }, at).line, CHECK);
  const partielle = reaperHeartbeat({ examined: 4, failed: 1 }, at);
  assert.equal(partielle.ok, true);
  assert.equal(partielle.line, "[reaper] passe ok 2026-10-05T10:00:00.000Z prêts=4 erreurs=1");
});
