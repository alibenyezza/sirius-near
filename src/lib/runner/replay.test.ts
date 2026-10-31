import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { checkRunnerReplay, consumeRunnerReplay, initializeRunnerReplay } from "./replay";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";

let replayDirectory: string | undefined;

afterEach(() => {
  mock.restoreAll();
  delete process.env.RUNNER_REPLAY_DIR;
  if (replayDirectory) rmSync(replayDirectory, { recursive: true, force: true });
  replayDirectory = undefined;
});

test("l’anti-rejeu persiste hors mémoire du process", () => {
  replayDirectory = mkdtempSync(join(tmpdir(), "sirius-replay-"));
  initializeRunnerReplay(replayDirectory);
  process.env.RUNNER_REPLAY_DIR = replayDirectory;
  const expiry = Date.now() + 60_000;

  assert.equal(consumeRunnerReplay("capability", "nonce-1", expiry), true);
  assert.equal(consumeRunnerReplay("capability", "nonce-1", expiry), false);
  assert.equal(consumeRunnerReplay("capability", "nonce-1", expiry + 1_000), false);
  assert.equal(consumeRunnerReplay("grant", "nonce-1", expiry), true);
});

test("refuse les expirations non entières ou hors borne", () => {
  const now = Date.now();
  assert.equal(consumeRunnerReplay("grant", "nonce-2", Number.NaN), false);
  assert.equal(consumeRunnerReplay("grant", "nonce-3", now + 3 * 60 * 60_000), false);
  assert.equal(consumeRunnerReplay("grant", "", now + 60_000), false);
});

test("huit processus ne consomment qu’une fois un grant malgré le nettoyage simultané", { timeout: 15000 }, async () => {
  replayDirectory = mkdtempSync(join(tmpdir(), "sirius-replay-"));
  initializeRunnerReplay(replayDirectory);
  mkdirSync(join(replayDirectory, "grant"));
  process.env.RUNNER_REPLAY_DIR = replayDirectory;
  const now = Date.now();
  const clock = mock.method(Date, "now", () => now - 2000);
  try { assert.equal(consumeRunnerReplay("grant", "concurrent", now - 1000), true); }
  finally { clock.mock.restore(); }
  writeFileSync(join(replayDirectory, "grant", "a".repeat(64)), "");
  writeFileSync(join(replayDirectory, "grant", "b".repeat(64)), String(Date.now() - 1));
  const workers = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e",
      `import { createRequire } from 'node:module';
       const { consumeRunnerReplay } = createRequire(import.meta.url)('./src/lib/runner/replay.ts');
       process.send('ready');
       process.once('message', ({ expiry }) => {
         process.send(consumeRunnerReplay('grant', 'concurrent', expiry));
         process.disconnect();
       });`], {
      env: { ...process.env, RUNNER_REPLAY_DIR: replayDirectory }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr!.resume();
    return child;
  });
  try {
    await Promise.all(workers.map((child) => once(child, "message")));
    const results = workers.map((child) => once(child, "message"));
    const exits = workers.map((child) => once(child, "exit"));
    for (const child of workers) child.send({ expiry: Date.now() + 60000 });
    assert.equal((await Promise.all(results)).filter(([result]) => result === true).length, 1);
    for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
    process.env.RUNNER_REPLAY_DIR = replayDirectory;
    assert.equal(consumeRunnerReplay("grant", "concurrent", Date.now() + 60000), false);
  } finally {
    for (const child of workers) if (child.exitCode === null) child.kill();
  }
});


test("les anciens fichiers incomplets restent bloquants puis sont collectés après le TTL maximal", () => {
  replayDirectory = mkdtempSync(join(tmpdir(), "sirius-replay-"));
  initializeRunnerReplay(replayDirectory);
  process.env.RUNNER_REPLAY_DIR = replayDirectory;
  const directory = join(replayDirectory, "grant");
  mkdirSync(directory);
  const digest = createHash("sha256").update("grant:interrupted").digest("hex");
  const incomplete = join(directory, digest);
  const invalid = join(directory, "f".repeat(64));
  writeFileSync(incomplete, "");
  writeFileSync(invalid, "999999999999999999999999999999");
  let now = Date.now();
  mock.method(Date, "now", () => now);
  assert.equal(consumeRunnerReplay("grant", "interrupted", now + 60000), false);
  for (let n = 0; n < 64; n++) consumeRunnerReplay("grant", `recent-${n}`, now + 60000);
  assert.equal(existsSync(incomplete), true);
  now += 2 * 60 * 60_000 + 1000;
  for (let n = 0; n < 64; n++) consumeRunnerReplay("grant", `later-${n}`, now + 60000);
  assert.equal(existsSync(incomplete), false);
  assert.equal(existsSync(invalid), false);
  assert.equal(consumeRunnerReplay("grant", "interrupted", now + 60000), true);
  assert.equal(consumeRunnerReplay("grant", "interrupted", now + 60000), false);
});

test("un registre anti-rejeu corrompu n'est jamais remplacé par un registre vide", () => {
  replayDirectory = mkdtempSync(join(tmpdir(), "sirius-replay-"));
  initializeRunnerReplay(replayDirectory);
  process.env.RUNNER_REPLAY_DIR = replayDirectory;
  writeFileSync(join(replayDirectory, "replay.sqlite"), "incomplete", { mode: 0o600 });
  assert.throws(() => consumeRunnerReplay("grant", "nonce", Date.now() + 60000));
});

test("un registre jamais initialisé bloque le démarrage et les autorisations", () => {
  replayDirectory = mkdtempSync(join(tmpdir(), "sirius-replay-"));
  process.env.RUNNER_REPLAY_DIR = replayDirectory;
  assert.throws(() => checkRunnerReplay(replayDirectory!), /absent ou inaccessible/);
  assert.throws(() => consumeRunnerReplay("grant", "nonce", Date.now() + 60000), /absent ou inaccessible/);
  assert.equal(existsSync(join(replayDirectory, "replay.sqlite")), false);
  initializeRunnerReplay(replayDirectory);
  checkRunnerReplay(replayDirectory);
  assert.equal(consumeRunnerReplay("grant", "nonce", Date.now() + 60000), true);
  assert.throws(() => initializeRunnerReplay(replayDirectory!), /EEXIST/);
  assert.equal(consumeRunnerReplay("grant", "nonce", Date.now() + 60000), false);
});

for (const loss of ["file", "volume"] as const) {
  test(`la perte du ${loss} ne réautorise jamais un grant consommé`, () => {
    replayDirectory = mkdtempSync(join(tmpdir(), "sirius-replay-"));
    initializeRunnerReplay(replayDirectory);
    process.env.RUNNER_REPLAY_DIR = replayDirectory;
    const expiry = Date.now() + 60000;
    assert.equal(consumeRunnerReplay("grant", "consumed", expiry), true);
    const lost = loss === "file" ? join(replayDirectory, "replay.sqlite") : replayDirectory;
    rmSync(lost, { recursive: true });
    for (const nonce of ["consumed", "new"]) {
      assert.throws(() => consumeRunnerReplay("grant", nonce, expiry), /absent ou inaccessible/);
    }
    assert.throws(() => checkRunnerReplay(replayDirectory!), /absent ou inaccessible/);
    assert.equal(existsSync(lost), false);
  });
}

test("un fichier vide remplaçant le registre ne devient pas une base neuve", () => {
  replayDirectory = mkdtempSync(join(tmpdir(), "sirius-replay-"));
  process.env.RUNNER_REPLAY_DIR = replayDirectory;
  const path = join(replayDirectory, "replay.sqlite");
  writeFileSync(path, "", { mode: 0o600 });
  assert.throws(() => checkRunnerReplay(replayDirectory!));
  assert.throws(() => consumeRunnerReplay("capability", "consumed", Date.now() + 60000));
  assert.throws(() => initializeRunnerReplay(replayDirectory!), /EEXIST/);
});
