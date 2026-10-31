import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { AppError } from "@/lib/app-error";
import { parseDemoPolicy, type DemoCommand, type DemoSession } from "./contract";

type Value = string | number | null;
type Row = Record<string, unknown>;
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: Value[]): Row | undefined;
    run(...values: Value[]): { changes: number | bigint };
  };
  close(): void;
}

/** Le registre contrôle les admissions ; le budget monétaire reste réservé dans le registre runner. */
export class DemoSessionStore {
  private readonly db: Database;
  /** Opérations admises et suivies par CE processus : seules elles peuvent encore se terminer. */
  private readonly live = new Set<string>();

  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error("Chemin absolu requis pour la session Phala");
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error("Répertoire de session privé requis");
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) throw new Error("Registre de session privé requis");
    } finally {
      closeSync(fd);
    }
    const sqlite = process.getBuiltinModule("node:sqlite") as unknown as { DatabaseSync: new (path: string) => Database };
    this.db = new sqlite.DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout = 3000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS demo_session (
          id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL,
          opened INTEGER NOT NULL, opened_at INTEGER, changed_at INTEGER NOT NULL, policy TEXT
        );
        INSERT OR IGNORE INTO demo_session VALUES (1, 0, 0, NULL, 0, NULL);
        CREATE TABLE IF NOT EXISTS demo_operations (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL,
          revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running', 'done', 'failed'))
        );
        CREATE INDEX IF NOT EXISTS demo_operations_revision ON demo_operations(revision, owner, status);
        CREATE TABLE IF NOT EXISTS demo_commands (
          revision INTEGER PRIMARY KEY, actor TEXT NOT NULL, command TEXT NOT NULL, created_at INTEGER NOT NULL
        );`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(): DemoSession {
    const row = this.db.prepare("SELECT * FROM demo_session WHERE id = 1").get()!;
    const active = this.db.prepare("SELECT count(*) AS n FROM demo_operations WHERE status = 'running'").get()!;
    const used = this.db.prepare("SELECT count(*) AS n FROM demo_operations WHERE revision = (SELECT max(revision) FROM demo_commands WHERE command = 'open')").get()!;
    return {
      revision: Number(row.revision), open: row.opened === 1,
      openedAt: row.opened_at === null ? null : Number(row.opened_at), changedAt: Number(row.changed_at),
      policy: row.policy === null ? null : parseDemoPolicy(JSON.parse(String(row.policy))),
      activeOperations: Number(active.n), usedOperations: Number(used.n),
    };
  }

  command(command: DemoCommand, expectedRevision: number, actor: string, policy?: unknown): DemoSession {
    if (!["open", "close"].includes(command) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !/^0x[0-9a-f]{40}$/.test(actor)) throw new AppError("Commande opérateur invalide", 400);
    const parsed = command === "open" ? parseDemoPolicy(policy) : null;
    return this.transaction(() => {
      const current = this.read();
      if (current.revision !== expectedRevision) throw new AppError("La session a changé ; actualise son état", 409);
      if (command === "open" && (current.open || current.activeOperations > 0)) {
        throw new AppError("Ferme la session et termine les opérations en cours avant de rouvrir", 409);
      }
      if (command === "close" && !current.open) return current;
      const now = Date.now();
      const revision = current.revision + 1;
      this.db.prepare("UPDATE demo_session SET revision = ?, opened = ?, opened_at = ?, changed_at = ?, policy = ? WHERE id = 1")
        .run(revision, command === "open" ? 1 : 0, command === "open" ? now : current.openedAt,
          now, parsed ? JSON.stringify(parsed) : JSON.stringify(current.policy));
      this.db.prepare("INSERT INTO demo_commands VALUES (?, ?, ?, ?)").run(revision, actor, command, now);
      return this.read();
    });
  }

  admit(id: string, owner: string, fingerprint: string, expectedRevision?: number): boolean {
    if (!/^[a-zA-Z0-9:_-]{1,180}$/.test(id) || !/^0x[0-9a-f]{40}$/.test(owner)
      || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new AppError("Admission de démonstration invalide", 400);
    return this.transaction(() => {
      const current = this.read();
      if (!current.open || !current.policy) throw new AppError("Démonstration Phala fermée", 403);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new AppError("Session Phala remplacée ; renouvelle l’autorisation", 409);
      const previous = this.db.prepare("SELECT * FROM demo_operations WHERE id = ?").get(id);
      if (previous) {
        if (previous.owner !== owner || previous.fingerprint !== fingerprint) throw new AppError("Opération de démonstration incompatible", 409);
        if (previous.status !== "done") throw new AppError("Opération déjà engagée ; reprise opérateur requise", 409);
        return false;
      }
      const usedByOwner = this.db.prepare("SELECT count(*) AS n FROM demo_operations WHERE revision = ? AND owner = ?")
        .get(current.revision, owner)!;
      if (current.activeOperations >= current.policy.maxConcurrent) throw new AppError("Démonstration occupée ; réessaie dans un instant", 429);
      if (current.usedOperations >= current.policy.maxOperations
        || Number(usedByOwner.n) >= current.policy.maxOperationsPerWallet) throw new AppError("Quota de démonstration atteint", 429);
      this.db.prepare("INSERT INTO demo_operations VALUES (?, ?, ?, ?, 'running')").run(id, owner, fingerprint, current.revision);
      this.live.add(id);
      return true;
    });
  }

  finish(id: string, succeeded: boolean): void {
    this.db.prepare("UPDATE demo_operations SET status = ? WHERE id = ? AND status = 'running'")
      .run(succeeded ? "done" : "failed", id);
    this.live.delete(id);
  }

  /**
   * Une admission `running` qu'aucun processus ne suit plus est orpheline : le runner s'est
   * arrêté pendant l'opération. Sans ce passage en échec, la session ne peut ni se fermer
   * proprement ni se rouvrir. Les opérations encore suivies ici ne sont jamais touchées.
   */
  recoverOrphans(): string[] {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT group_concat(id, char(10)) AS ids FROM demo_operations WHERE status = 'running'").get();
      const orphans = String(rows?.ids ?? "").split("\n").filter((id) => id && !this.live.has(id));
      for (const id of orphans) this.db.prepare("UPDATE demo_operations SET status = 'failed' WHERE id = ? AND status = 'running'").run(id);
      return orphans;
    });
  }
}
