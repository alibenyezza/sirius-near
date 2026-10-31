import "server-only";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { AppError } from "@/lib/app-error";

const memoryReplay = new Map<string, number>();
const MAX_REPLAY_TTL_MS = 2 * 60 * 60_000;
let cleanupCounter = 0;

interface ReplayDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: (string | number)[]): { changes: number | bigint } };
  close(): void;
}

function cleanupMemory(now: number): void {
  for (const [id, expiry] of memoryReplay) {
    if (expiry <= now) memoryReplay.delete(id);
  }
}

function cleanupLegacy(directory: string, now: number): void {
  const entries = opendirSync(directory);
  try {
    for (let scanned = 0; scanned < 128; scanned++) {
      const entry = entries.readSync();
      if (!entry) break;
      if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        const stat = lstatSync(path);
        // Même un fichier vide bloque pendant la durée maximale de son autorisation.
        if (stat.isFile() && Math.max(stat.mtimeMs, stat.ctimeMs) < now - MAX_REPLAY_TTL_MS) unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally { entries.closeSync(); }
}

function syncDirectory(directory: string): void {
  const tolerable = process.platform === "win32";
  let descriptor: number;
  try {
    descriptor = openSync(directory, "r");
  } catch (error) {
    if (tolerable) return;
    throw error;
  }
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!tolerable) throw error;
  } finally {
    closeSync(descriptor);
  }
}

function openDatabase(path: string): ReplayDatabase {
  const sqlite = process.getBuiltinModule("node:sqlite") as unknown as { DatabaseSync: new (path: string) => ReplayDatabase };
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    return db;
  } catch (error) { db.close(); throw error; }
}

function assertFile(path: string, expected: Stats): void {
  const actual = lstatSync(path);
  if (!actual.isFile() || actual.ino !== expected.ino || actual.dev !== expected.dev || (actual.mode & 0o077) !== 0) {
    throw new AppError("Registre anti-rejeu remplacé ou indisponible", 503);
  }
}

export function initializeRunnerReplay(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "replay.sqlite");
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let db: ReplayDatabase | undefined;
  try {
    const expected = fstatSync(descriptor);
    db = openDatabase(path);
    assertFile(path, expected);
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE claims (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
      CREATE INDEX claims_expiry ON claims(expires_at);
      COMMIT;`);
    assertFile(path, expected);
    syncDirectory(root);
  } finally { db?.close(); closeSync(descriptor); }
}

function withReplayDatabase<T>(root: string, action: (db: ReplayDatabase) => T): T {
  const path = join(root, "replay.sqlite");
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); }
  catch { throw new AppError("Registre anti-rejeu absent ou inaccessible : intervention requise", 503); }
  let db: ReplayDatabase | undefined;
  try {
    const expected = fstatSync(descriptor);
    assertFile(path, expected);
    db = openDatabase(path);
    assertFile(path, expected);
    // Une base vide ou perdue n'est jamais initialisée par une requête métier.
    db.exec("SELECT id, expires_at FROM claims LIMIT 0;");
    const result = action(db);
    assertFile(path, expected);
    return result;
  } finally { db?.close(); closeSync(descriptor); }
}

export function checkRunnerReplay(root: string): void {
  withReplayDatabase(root, () => {});
}

function consumePersistent(root: string, namespace: string, digest: string, expiresAt: number, now: number): boolean {
  return withReplayDatabase(root, (db) => {
    const directory = join(root, namespace);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (cleanupCounter++ % 64 === 0) {
      cleanupLegacy(directory, now);
      db.prepare("DELETE FROM claims WHERE id IN (SELECT id FROM claims WHERE expires_at <= ? LIMIT 256)").run(now);
    }
    try {
      lstatSync(join(directory, digest));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const result = db.prepare(`INSERT INTO claims VALUES (?, ?) ON CONFLICT(id)
      DO UPDATE SET expires_at = excluded.expires_at WHERE claims.expires_at <= ?`).run(digest, expiresAt, now);
    syncDirectory(root);
    return Number(result.changes) === 1;
  });
}

export function consumeRunnerReplay(namespace: "capability" | "grant", id: string, expiresAt: number): boolean {
  const now = Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_REPLAY_TTL_MS || !id || id.length > 512) {
    return false;
  }
  const root = process.env.RUNNER_REPLAY_DIR?.trim();
  const replayId = `${namespace}:${id}`;
  if (!root) {
    cleanupMemory(now);
    if (memoryReplay.has(replayId)) return false;
    memoryReplay.set(replayId, expiresAt);
    return true;
  }
  const digest = createHash("sha256").update(replayId).digest("hex");
  return consumePersistent(root, namespace, digest, expiresAt, now);
}
