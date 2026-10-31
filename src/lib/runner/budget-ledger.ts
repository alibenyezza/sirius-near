import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { AppError } from "@/lib/app-error";
import { parseDemoPolicy, type DemoPolicy } from "@/lib/phala-demo/contract";
import { RunnerRetryLater } from "./failure-policy";

export type BudgetKind = "request" | "seal" | "training" | "transaction";
export interface BudgetPolicy {
  version: 1;
  chainId: number;
  wallet: string;
  accountingReference: string;
  validUntil: number;
  earnedMarginUsdMicros: string;
  cashUsdMicros: string;
  fixedReserveUsdMicros: string;
  trial?: {
    provider: "phala";
    creditsUsdMicros: string;
    ceilingUsdMicros: string;
    observedAtMs: number;
    escrow: string;
    wallets: string[];
  };
  sponsored?: DemoPolicy & { origin: string; observedAtMs: number };
  costsUsdMicros: Record<Exclude<BudgetKind, "transaction">, string>;
  gas: {
    totalWei: string;
    maxTransactionWei: string;
    maxGas: string;
    maxFeePerGasWei: string;
    ethUsdMicrosUpperBound: string;
    confirmations: number;
  };
  maxFailures: number;
  maxActive: number;
}

type SqlValue = string | number | null;
type Row = Record<string, unknown>;
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: SqlValue[]): Row | undefined;
    all(...args: SqlValue[]): Row[];
    run(...args: SqlValue[]): { changes: number | bigint };
  };
  close(): void;
}

function database(path: string): Database {
  // Node 22.13+ fournit SQLite sans module natif à compiler dans la CVM.
  const sqlite = process.getBuiltinModule("node:sqlite") as unknown as {
    DatabaseSync: new (path: string) => Database;
  };
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value);
const positive = (value: unknown): value is string => decimal(value) && BigInt(value) > BigInt(0);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

export function validateBudgetPolicy(value: unknown): BudgetPolicy {
  const p = value as BudgetPolicy | null;
  if (!p || p.version !== 1 || !integer(p.chainId, 1, Number.MAX_SAFE_INTEGER)
    || typeof p.wallet !== "string" || !/^0x[0-9a-f]{40}$/.test(p.wallet)
    || /^0x0{40}$/.test(p.wallet)
    || typeof p.accountingReference !== "string" || !p.accountingReference.trim() || p.accountingReference.length > 256
    || !integer(p.validUntil, 1, Number.MAX_SAFE_INTEGER)
    || !decimal(p.earnedMarginUsdMicros) || !decimal(p.cashUsdMicros) || !decimal(p.fixedReserveUsdMicros)
    || !p.costsUsdMicros || ![p.costsUsdMicros.request, p.costsUsdMicros.seal, p.costsUsdMicros.training].every(positive)
    || !p.gas || !decimal(p.gas.totalWei)
    || ![p.gas.maxTransactionWei, p.gas.maxGas, p.gas.maxFeePerGasWei, p.gas.ethUsdMicrosUpperBound].every(positive)
    || !integer(p.gas.confirmations, 1, 100)
    || !integer(p.maxFailures, 1, 1000) || !integer(p.maxActive, 1, 1000)) {
    throw new AppError("Politique de budget runner invalide", 503);
  }
  if (p.trial !== undefined) {
    const t = p.trial;
    const address = (v: unknown): v is string => typeof v === "string" && /^0x(?!0{40}$)[a-f0-9]{40}$/.test(v);
    if (!t || t.provider !== "phala" || p.chainId !== 46630
      || p.earnedMarginUsdMicros !== "0" || p.cashUsdMicros !== "0"
      || !positive(t.creditsUsdMicros) || !positive(t.ceilingUsdMicros)
      || BigInt(t.ceilingUsdMicros) > BigInt(t.creditsUsdMicros)
      || !integer(t.observedAtMs, 1, Number.MAX_SAFE_INTEGER) || t.observedAtMs > Date.now() + 30_000
      || p.validUntil <= t.observedAtMs || p.validUntil - t.observedAtMs > 31 * 86400_000
      || !address(t.escrow) || !Array.isArray(t.wallets) || !t.wallets.length || t.wallets.length > 10
      || t.wallets.some((w) => !address(w) || w === p.wallet)
      || new Set(t.wallets).size !== t.wallets.length) {
      throw new AppError("Financement d’essai Phala invalide", 503);
    }
  }
  if (p.sponsored !== undefined) {
    const demo = parseDemoPolicy(p.sponsored);
    let origin: URL;
    try { origin = new URL(p.sponsored.origin); }
    catch { throw new AppError("Origine de démonstration invalide", 503); }
    if (p.trial || p.chainId !== 46630 || p.earnedMarginUsdMicros !== "0" || p.cashUsdMicros !== "0"
      || origin.protocol !== "https:" || origin.origin !== p.sponsored.origin
      || !integer(p.sponsored.observedAtMs, 1, Date.now() + 30_000)
      || p.validUntil <= p.sponsored.observedAtMs || p.validUntil - p.sponsored.observedAtMs > 31 * 86400_000) {
      throw new AppError("Financement sponsorisé invalide", 503);
    }
    return structuredClone({ ...p, sponsored: { ...demo, origin: origin.origin, observedAtMs: p.sponsored.observedAtMs } });
  }
  return structuredClone(p);
}

export function fundedBudgetUsd(policy: BudgetPolicy): bigint {
  if (policy.sponsored) return BigInt(policy.sponsored.ceilingUsdMicros);
  if (policy.trial) return BigInt(policy.trial.ceilingUsdMicros);
  const margin = BigInt(policy.earnedMarginUsdMicros);
  const cash = BigInt(policy.cashUsdMicros);
  return margin < cash ? margin : cash;
}

function assertPrivatePath(path: string): void {
  if (!isAbsolute(path)) throw new AppError("Chemin absolu requis pour le budget runner", 503);
  const dir = lstatSync(dirname(path));
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0) throw new AppError("Répertoire privé requis pour le budget runner", 503);
}

export function initializeBudgetLedger(path: string, value: unknown): void {
  const policy = validateBudgetPolicy(value);
  assertPrivatePath(path);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  fsyncSync(fd);
  closeSync(fd);
  const db = database(path);
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE budget (
        id INTEGER PRIMARY KEY CHECK(id = 1), policy TEXT NOT NULL,
        allocated_usd TEXT NOT NULL, allocated_wei TEXT NOT NULL, failures INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE operations (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved', 'succeeded', 'failed')),
        usd TEXT NOT NULL, wei TEXT NOT NULL, result TEXT,
        tx_hash TEXT, nonce INTEGER, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX pending_wallet ON operations(kind) WHERE kind = 'transaction' AND state = 'reserved';
      CREATE INDEX active_operations ON operations(state) WHERE state = 'reserved';`);
    db.prepare("INSERT INTO budget VALUES (1, ?, '0', '0', 0)").run(JSON.stringify(policy));
    db.exec("COMMIT; PRAGMA wal_checkpoint(FULL);");
  } finally {
    db.close();
  }
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export interface BudgetOperation {
  id: string;
  fingerprint: string;
  kind: BudgetKind;
  state: "reserved" | "succeeded" | "failed";
  result: string | null;
  txHash: string | null;
  nonce: number | null;
  createdAt: number;
}

export interface WorkflowBudget { id: string; fingerprint: string }
export interface UnusedWorkflow extends WorkflowBudget { payload: string }
const WORKFLOW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, valid_until INTEGER NOT NULL,
    requests INTEGER NOT NULL, training INTEGER NOT NULL, transactions INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS operation_workflows (
    operation_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS execution_evidence (
    workflow_id TEXT PRIMARY KEY, payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS failure_receipts (
    workflow_id TEXT PRIMARY KEY, payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS workflow_results (
    workflow_id TEXT PRIMARY KEY, context TEXT NOT NULL, result TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS transaction_payloads (
    operation_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS operator_actions (
    id INTEGER PRIMARY KEY, action TEXT NOT NULL, operation_id TEXT, actor TEXT NOT NULL,
    reason TEXT NOT NULL, at INTEGER NOT NULL, previous TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS fast_exposure (
    workflow_id TEXT PRIMARY KEY, amount TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;`;

export type OperatorAction = "reset-failures" | "reopen" | "abandon" | "replace" | "interrupted";

export class BudgetLedger {
  private readonly db: Database;
  private readonly inode: number;
  private readonly device: number;
  readonly policy: BudgetPolicy;

  constructor(private readonly path: string, chainId: number, wallet: string) {
    assertPrivatePath(path);
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new AppError("Registre de budget privé requis", 503);
      this.inode = stat.ino;
      this.device = stat.dev;
    } finally { closeSync(fd); }
    this.db = database(path);
    try {
      this.policy = validateBudgetPolicy(JSON.parse(String(this.db.prepare("SELECT policy FROM budget WHERE id = 1").get()?.policy)));
      if (this.policy.chainId !== chainId || this.policy.wallet !== wallet.toLowerCase()) {
        throw new AppError("Budget lié à un autre réseau ou wallet", 503);
      }
      this.assertFile();
      this.db.exec(WORKFLOW_SCHEMA);
      this.db.prepare("UPDATE operations SET result = NULL WHERE kind = 'seal' AND result IS NOT NULL").run();
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  addTrialWallets(wallets: string[]): void {
    const policy = this.atomic(() => {
      const current = validateBudgetPolicy(JSON.parse(String(this.db.prepare("SELECT policy FROM budget WHERE id = 1").get()?.policy)));
      if (!current.trial || !Array.isArray(wallets) || !wallets.length) throw new Error("Liste de wallets d’essai requise");
      const next = validateBudgetPolicy({ ...current, trial: { ...current.trial, wallets: [...new Set([...current.trial.wallets, ...wallets])] } });
      this.db.prepare("UPDATE budget SET policy = ? WHERE id = 1").run(JSON.stringify(next));
      return next;
    });
    Object.assign(this.policy, policy);
  }

  configureSponsored(value: DemoPolicy, observedAtMs: number, actor: string): void {
    const policy = this.atomic(() => {
      const current = validateBudgetPolicy(JSON.parse(String(this.db.prepare("SELECT policy FROM budget WHERE id = 1").get()?.policy)));
      if (!current.sponsored || !/^0x[0-9a-f]{40}$/.test(actor)) throw new AppError("Financement sponsorisé requis", 409);
      if (this.db.prepare("SELECT id FROM operations WHERE state = 'reserved'").get()) throw new AppError("Réconcilie les opérations avant de changer le financement", 409);
      const next = validateBudgetPolicy({ ...current, sponsored: { ...parseDemoPolicy(value), origin: current.sponsored.origin, observedAtMs } });
      if (fundedBudgetUsd(next) < this.accounting().allocatedUsd + BigInt(next.fixedReserveUsdMicros)) {
        throw new AppError("Le plafond ne couvre pas les engagements existants", 409);
      }
      this.db.exec("CREATE TABLE IF NOT EXISTS sponsored_policy_changes (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, changed_at INTEGER NOT NULL, previous_policy TEXT NOT NULL, next_policy TEXT NOT NULL)");
      this.db.prepare("INSERT INTO sponsored_policy_changes (actor, changed_at, previous_policy, next_policy) VALUES (?, ?, ?, ?)")
        .run(actor, Date.now(), JSON.stringify(current), JSON.stringify(next));
      this.db.prepare("UPDATE budget SET policy = ? WHERE id = 1").run(JSON.stringify(next));
      return next;
    });
    Object.assign(this.policy, policy);
  }

  private assertFile(): void {
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.ino !== this.inode || stat.dev !== this.device) {
      throw new AppError("Registre de budget remplacé ou indisponible", 503);
    }
  }

  private atomic<T>(action: () => T): T {
    this.assertFile();
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

  private accounting() {
    const row = this.db.prepare("SELECT allocated_usd, allocated_wei, failures FROM budget WHERE id = 1").get();
    if (!row || !decimal(row.allocated_usd) || !decimal(row.allocated_wei) || !integer(row.failures, 0, Number.MAX_SAFE_INTEGER)) {
      throw new AppError("Comptabilité runner indisponible", 503);
    }
    return { allocatedUsd: BigInt(row.allocated_usd), allocatedWei: BigInt(row.allocated_wei), failures: row.failures };
  }

  private assertAdmission(): void {
    if (Date.now() >= this.policy.validUntil) throw new AppError("Politique de coûts runner périmée", 503);
    if (this.accounting().failures >= this.policy.maxFailures) throw new AppError("Coupe-circuit financier runner ouvert", 503);
  }

  find(id: string, fingerprint: string): BudgetOperation | null {
    this.assertFile();
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new AppError("Opération déjà réservée avec d’autres paramètres", 409);
    return {
      id, fingerprint, kind: row.kind as BudgetKind, state: row.state as BudgetOperation["state"],
      result: row.result as string | null, txHash: row.tx_hash as string | null, nonce: row.nonce as number | null,
      createdAt: row.created_at as number,
    };
  }

  /** Lecture opérateur par identifiant seul ; les écritures repassent par `find`. */
  operation(id: string): BudgetOperation | null {
    this.assertFile();
    const row = this.db.prepare("SELECT fingerprint FROM operations WHERE id = ?").get(id);
    return row ? this.find(id, String(row.fingerprint)) : null;
  }

  reserve(id: string, fingerprint: string, kind: BudgetKind, workflow?: WorkflowBudget): { fresh: boolean; operation: BudgetOperation } {
    return this.atomic(() => {
      const existing = this.find(id, fingerprint);
      if (existing) {
        if (existing.kind !== kind) throw new AppError("Opération déjà réservée avec d’autres paramètres", 409);
        if (workflow) this.workflow(workflow);
        const owner = this.db.prepare("SELECT workflow_id FROM operation_workflows WHERE operation_id = ?").get(id);
        if ((owner?.workflow_id ?? undefined) !== workflow?.id) throw new AppError("Budget de clôture hors scope", 409);
        return { fresh: false, operation: existing };
      }
      if (!workflow) this.assertAdmission();
      const active = Number(this.db.prepare("SELECT count(*) AS n FROM operations WHERE state = 'reserved'").get()?.n);
      if ((!workflow || kind === "training") && active >= this.policy.maxActive) throw new AppError("Réservations runner en attente de réconciliation", 503);
      if (kind === "transaction" && this.db.prepare("SELECT id FROM operations WHERE kind = 'transaction' AND state = 'reserved'").get()) {
        // Une seule transaction en vol par wallet : les autres règlements attendent leur tour
        // sans compter d'échec ni consommer de crédit.
        throw new RunnerRetryLater("Transaction du wallet runner encore incertaine");
      }
      const wei = kind === "transaction" ? BigInt(this.policy.gas.maxTransactionWei) : BigInt(0);
      const scale = BigInt("1000000000000000000");
      const usd = kind === "transaction"
        ? (wei * BigInt(this.policy.gas.ethUsdMicrosUpperBound) + scale - BigInt(1)) / scale
        : BigInt(this.policy.costsUsdMicros[kind]);
      if (workflow) {
        const row = this.workflow(workflow);
        const column = kind === "request" ? "requests" : kind === "training" ? "training" : kind === "transaction" ? "transactions" : null;
        if (!column || Number(row[column]) < 1 || Date.now() >= Number(row.valid_until)) {
          throw new AppError("Budget de clôture épuisé ou expiré", 503);
        }
        this.db.prepare(`UPDATE workflows SET ${column} = ${column} - 1 WHERE id = ?`).run(workflow.id);
        this.db.prepare("INSERT INTO operation_workflows VALUES (?, ?)").run(id, workflow.id);
      } else this.allocate(usd, wei);
      this.db.prepare("INSERT INTO operations (id, fingerprint, kind, state, usd, wei, created_at) VALUES (?, ?, ?, 'reserved', ?, ?, ?)")
        .run(id, fingerprint, kind, String(usd), String(wei), Date.now());
      return { fresh: true, operation: this.find(id, fingerprint)! };
    });
  }

  recordTransaction(id: string, fingerprint: string, hash: string, nonce: number, ciphertext?: string): void {
    this.atomic(() => {
      const owner = this.db.prepare("SELECT workflow_id FROM operation_workflows WHERE operation_id = ?").get(id);
      if (!owner) this.assertAdmission();
      else {
        const row = this.db.prepare("SELECT valid_until FROM workflows WHERE id = ?").get(String(owner.workflow_id));
        if (!row || Date.now() >= Number(row.valid_until)) throw new AppError("Budget de clôture épuisé ou expiré", 503);
      }
      const operation = this.find(id, fingerprint);
      if (!operation || operation.kind !== "transaction" || operation.state !== "reserved" || operation.txHash
        || !/^0x[0-9a-f]{64}$/.test(hash) || !integer(nonce, 0, Number.MAX_SAFE_INTEGER)) {
        throw new AppError("Intention de transaction runner invalide", 503);
      }
      this.db.prepare("UPDATE operations SET tx_hash = ?, nonce = ? WHERE id = ?").run(hash, nonce, id);
      if (ciphertext !== undefined) {
        if (!ciphertext || Buffer.byteLength(ciphertext) > 16384) throw new AppError("Transaction scellée invalide", 503);
        this.db.prepare("INSERT INTO transaction_payloads VALUES (?, ?, 1, ?)").run(id, ciphertext, Date.now() + 30000);
      }
    });
  }

  claimTransactionRebroadcast(id: string, fingerprint: string): string | null {
    return this.atomic(() => {
      const operation = this.find(id, fingerprint);
      if (operation?.state !== "reserved" || operation.kind !== "transaction" || !operation.txHash) return null;
      const row = this.db.prepare("SELECT * FROM transaction_payloads WHERE operation_id = ?").get(id);
      if (!row || Number(row.attempts) >= 3 || Number(row.next_attempt_at) > Date.now()) return null;
      this.db.prepare("UPDATE transaction_payloads SET attempts = attempts + 1, next_attempt_at = ? WHERE operation_id = ?")
        .run(Date.now() + 30000, id);
      return String(row.ciphertext);
    });
  }

  pendingTransactions(): BudgetOperation[] {
    this.assertFile();
    const rows = this.db.prepare("SELECT id, fingerprint FROM operations WHERE kind = 'transaction' AND state = 'reserved'").all() as Array<{ id: string; fingerprint: string }>;
    return rows.map(({ id, fingerprint }) => this.find(id, fingerprint)!);
  }

  failUnsentTransaction(id: string, fingerprint: string, minimumAgeMs = 0): boolean {
    return this.atomic(() => {
      const operation = this.find(id, fingerprint);
      if (!operation || operation.kind !== "transaction" || operation.state !== "reserved" || operation.txHash
        || Date.now() - operation.createdAt < minimumAgeMs) return false;
      this.db.prepare("UPDATE operations SET state = 'failed' WHERE id = ?").run(id);
      this.db.prepare("UPDATE budget SET failures = failures + 1 WHERE id = 1").run();
      return true;
    });
  }

  /**
   * `countFailure` vaut faux quand l'échec revient à l'appelant (requête invalide, grant
   * refusé, dataset inexploitable) : l'opération reste close et son coût consommé, mais le
   * coupe-circuit, qui protège la plateforme d'une panne de SON côté, n'en est pas affecté.
   */
  finish(id: string, fingerprint: string, succeeded: boolean, result: string | null = null, countFailure = true): void {
    if (result !== null && Buffer.byteLength(result) > 65536) throw new AppError("Résultat runner trop volumineux", 503);
    this.atomic(() => {
      const operation = this.find(id, fingerprint);
      if (!operation) throw new AppError("Réservation runner introuvable", 503);
      if (operation.state !== "reserved") return;
      this.db.prepare("UPDATE operations SET state = ?, result = ? WHERE id = ?")
        .run(succeeded ? "succeeded" : "failed", result, id);
      if (!succeeded && countFailure) this.db.prepare("UPDATE budget SET failures = failures + 1 WHERE id = 1").run();
      // Le maximum alloué reste consommé : ni timeout, ni succès ne recrée de marge.
    });
  }

  /**
   * Rend une réservation qui n'a rien engagé : aucune transaction signée, aucun journal de
   * diffusion. Le crédit revient au workflow ou au budget global, et une nouvelle tentative
   * repart d'une réservation neuve. Renvoie faux si l'opération a déjà engagé quelque chose
   * (hash durable, opération close) : elle reste alors telle quelle.
   */
  releaseReservation(id: string, fingerprint: string): boolean {
    return this.atomic(() => {
      const operation = this.find(id, fingerprint);
      if (!operation || operation.state !== "reserved" || operation.txHash) return false;
      if (this.db.prepare("SELECT operation_id FROM transaction_payloads WHERE operation_id = ?").get(id)) return false;
      this.unreserve(id);
      return true;
    });
  }

  private unreserve(id: string): void {
    const row = this.db.prepare("SELECT kind, usd, wei FROM operations WHERE id = ?").get(id);
    if (!row || !decimal(row.usd) || !decimal(row.wei)) throw new AppError("Réservation runner introuvable", 503);
    const owner = this.db.prepare("SELECT workflow_id FROM operation_workflows WHERE operation_id = ?").get(id);
    if (owner) {
      const column = row.kind === "request" ? "requests" : row.kind === "training" ? "training" : row.kind === "transaction" ? "transactions" : null;
      if (!column) throw new AppError("Réservation runner introuvable", 503);
      this.db.prepare(`UPDATE workflows SET ${column} = ${column} + 1 WHERE id = ?`).run(String(owner.workflow_id));
      this.db.prepare("DELETE FROM operation_workflows WHERE operation_id = ?").run(id);
    } else {
      const { allocatedUsd, allocatedWei } = this.accounting();
      const usd = BigInt(row.usd);
      const wei = BigInt(row.wei);
      if (allocatedUsd < usd || allocatedWei < wei) throw new AppError("Comptabilité runner indisponible", 503);
      this.db.prepare("UPDATE budget SET allocated_usd = ?, allocated_wei = ? WHERE id = 1")
        .run(String(allocatedUsd - usd), String(allocatedWei - wei));
    }
    this.db.prepare("DELETE FROM transaction_payloads WHERE operation_id = ?").run(id);
    this.db.prepare("DELETE FROM operations WHERE id = ?").run(id);
  }

  private journal(action: OperatorAction, operationId: string | null, actor: string, reason: string, previous: unknown): void {
    if (!actor.trim() || actor.length > 128 || !reason.trim() || reason.length > 512) {
      throw new AppError("Auteur et motif obligatoires pour une action opérateur", 409);
    }
    this.db.prepare("INSERT INTO operator_actions (action, operation_id, actor, reason, at, previous) VALUES (?, ?, ?, ?, ?, ?)")
      .run(action, operationId, actor.trim(), reason.trim(), Date.now(),
        JSON.stringify(previous, (_key, value) => typeof value === "bigint" ? String(value) : value));
  }

  /**
   * Démonstration sponsorisée uniquement, au démarrage du runner : une requête, un scellement
   * ou un entraînement hors devis encore réservé appartenait au processus précédent, arrêté en
   * cours de route. Il passe en échec, coût conservé, sans compter dans le coupe-circuit. Les
   * transactions et les opérations d'un devis v7 gardent leur reprise dédiée.
   */
  failInterruptedOperations(actor: string, reason: string): string[] {
    if (!this.policy.sponsored) throw new AppError("Reprise réservée à la démonstration sponsorisée", 409);
    return this.atomic(() => {
      const rows = this.db.prepare(`SELECT o.id FROM operations o LEFT JOIN operation_workflows w ON w.operation_id = o.id
        WHERE o.state = 'reserved' AND o.kind IN ('request', 'seal', 'training') AND w.operation_id IS NULL`).all();
      const ids = rows.map((row) => String(row.id));
      if (!ids.length) return ids;
      this.journal("interrupted", null, actor, reason, { operations: ids });
      for (const id of ids) this.db.prepare("UPDATE operations SET state = 'failed' WHERE id = ? AND state = 'reserved'").run(id);
      return ids;
    });
  }

  /** Réarme le coupe-circuit après diagnostic. Journalisé, jamais automatique. */
  resetFailures(actor: string, reason: string): number {
    return this.atomic(() => {
      const { failures } = this.accounting();
      this.journal("reset-failures", null, actor, reason, { failures });
      this.db.prepare("UPDATE budget SET failures = 0 WHERE id = 1").run();
      return failures;
    });
  }

  /**
   * Rouvre une transaction close en échec pour qu'un nouveau règlement soit possible. Le
   * règlement qui suit relit d'abord l'escrow on-chain : un prêt déjà réglé ou remboursé
   * n'est jamais renvoyé.
   */
  reopenTransaction(id: string, fingerprint: string, actor: string, reason: string): void {
    this.atomic(() => {
      const operation = this.find(id, fingerprint);
      if (!operation || operation.kind !== "transaction" || operation.state !== "failed") {
        throw new AppError("Seule une transaction close en échec peut être rouverte", 409);
      }
      this.journal("reopen", id, actor, reason, operation);
      const owner = this.db.prepare("SELECT workflow_id FROM operation_workflows WHERE operation_id = ?").get(id);
      if (owner) {
        this.db.prepare("UPDATE workflows SET transactions = transactions + 1 WHERE id = ?").run(String(owner.workflow_id));
        this.db.prepare("DELETE FROM operation_workflows WHERE operation_id = ?").run(id);
      }
      this.db.prepare("DELETE FROM transaction_payloads WHERE operation_id = ?").run(id);
      this.db.prepare("DELETE FROM operations WHERE id = ?").run(id);
    });
  }

  /**
   * Abandonne une transaction encore réservée. L'appelant DOIT avoir prouvé on-chain que son
   * nonce est consommé par une autre transaction, ou qu'elle n'a jamais été signée : le
   * registre ne voit pas la chaîne. L'abandon n'est pas compté dans le coupe-circuit.
   */
  abandonTransaction(id: string, fingerprint: string, actor: string, reason: string): void {
    this.atomic(() => {
      const operation = this.find(id, fingerprint);
      if (!operation || operation.kind !== "transaction" || operation.state !== "reserved") {
        throw new AppError("Seule une transaction encore réservée peut être abandonnée", 409);
      }
      this.journal("abandon", id, actor, reason, operation);
      this.db.prepare("UPDATE operations SET state = 'failed' WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM transaction_payloads WHERE operation_id = ?").run(id);
    });
  }

  /**
   * Remplace une transaction signée par sa version re-signée au même nonce avec des frais à
   * jour, quand le séquenceur a refusé l'originale. Même cible, mêmes données : seuls les
   * frais changent, ce que `openRunnerTransaction` revérifie à chaque réouverture.
   */
  replaceTransaction(id: string, fingerprint: string, hash: string, nonce: number, ciphertext: string, actor: string, reason: string): void {
    this.atomic(() => {
      const operation = this.find(id, fingerprint);
      if (!operation || operation.kind !== "transaction" || operation.state !== "reserved" || !operation.txHash
        || operation.nonce !== nonce || !/^0x[0-9a-f]{64}$/.test(hash) || hash === operation.txHash
        || !ciphertext || Buffer.byteLength(ciphertext) > 16384) {
        throw new AppError("Remplacement de transaction runner invalide", 409);
      }
      this.journal("replace", id, actor, reason, operation);
      this.db.prepare("UPDATE operations SET tx_hash = ? WHERE id = ?").run(hash, id);
      this.db.prepare(`INSERT INTO transaction_payloads VALUES (?, ?, 1, ?)
        ON CONFLICT(operation_id) DO UPDATE SET ciphertext = excluded.ciphertext, attempts = 1, next_attempt_at = excluded.next_attempt_at`)
        .run(id, ciphertext, Date.now() + 30000);
    });
  }

  operatorActions(): Array<{ action: OperatorAction; operationId: string | null; actor: string; reason: string; at: number }> {
    this.assertFile();
    return this.db.prepare("SELECT action, operation_id, actor, reason, at FROM operator_actions ORDER BY id").all().map((row) => ({
      action: row.action as OperatorAction, operationId: row.operation_id as string | null,
      actor: String(row.actor), reason: String(row.reason), at: Number(row.at),
    }));
  }

  snapshot() {
    this.assertFile();
    return this.accounting();
  }

  diagnostics(now = Date.now()) {
    const accounting = this.snapshot();
    const remainingUsd = fundedBudgetUsd(this.policy) - BigInt(this.policy.fixedReserveUsdMicros) - accounting.allocatedUsd;
    const remainingWei = BigInt(this.policy.gas.totalWei) - accounting.allocatedWei;
    const pendingTransactions = this.pendingTransactions().map((operation) => {
      const journal = this.db.prepare("SELECT attempts FROM transaction_payloads WHERE operation_id = ?").get(operation.id);
      const attempts = Number(journal?.attempts ?? 0);
      return {
        id: operation.id, hash: operation.txHash, nonce: operation.nonce, ageMs: Math.max(0, now - operation.createdAt),
        attempts, journalAvailable: Boolean(journal),
        recovery: !operation.txHash ? "unsigned" : !journal ? "journal-missing" : attempts >= 3 ? "attempts-exhausted" : "awaiting-receipt",
      };
    });
    const incompleteJobs = Number(this.db.prepare("SELECT count(*) AS n FROM operations WHERE kind = 'training' AND state = 'reserved'").get()?.n);
    const allocation = this.workflowAllocation();
    return {
      ...accounting, remainingUsd, remainingWei, pendingTransactions, incompleteJobs,
      expired: now >= this.policy.validUntil,
      circuitOpen: accounting.failures >= this.policy.maxFailures,
      canQuote: now < this.policy.validUntil && accounting.failures < this.policy.maxFailures
        && remainingUsd >= allocation.usd && remainingWei >= allocation.wei && pendingTransactions.length === 0,
    };
  }

  accountingExport(now = Date.now()) {
    return this.atomic(() => {
      const diagnostics = this.diagnostics(now);
      const allocation = this.workflowAllocation();
      const operations = this.db.prepare(`SELECT o.id, o.fingerprint, o.kind, o.state, o.usd, o.wei,
        o.tx_hash, o.nonce, o.created_at, w.workflow_id, t.attempts
        FROM operations o LEFT JOIN operation_workflows w ON w.operation_id = o.id
        LEFT JOIN transaction_payloads t ON t.operation_id = o.id ORDER BY o.created_at, o.id`).all().map((row) => ({
        id: String(row.id), fingerprint: String(row.fingerprint), kind: row.kind as BudgetKind,
        state: row.state as BudgetOperation["state"], createdAtMs: Number(row.created_at),
        workflowId: row.workflow_id as string | null,
        budgetUsdMicros: String(row.usd), budgetWei: String(row.wei),
        transactionHash: row.tx_hash as string | null, nonce: row.nonce as number | null,
        broadcastAttempts: row.attempts as number | null,
      }));
      const workflows = this.db.prepare(`SELECT w.id, w.fingerprint, w.valid_until, w.requests, w.training, w.transactions,
        e.payload AS evidence, f.payload AS failure_receipt, r.workflow_id IS NOT NULL AS prepared,
        r.result IS NOT NULL AS has_result FROM workflows w
        LEFT JOIN execution_evidence e ON e.workflow_id = w.id
        LEFT JOIN failure_receipts f ON f.workflow_id = w.id
        LEFT JOIN workflow_results r ON r.workflow_id = w.id ORDER BY w.id`).all().map((row) => {
        const measurement = row.evidence === null ? null : JSON.parse(String(row.evidence)) as Row;
        if (row.evidence !== null && (!measurement || measurement.version !== 1 || measurement.quoteHash !== row.fingerprint
          || typeof measurement.success !== "boolean" || !integer(measurement.elapsedMs, 0, 30000)
          || !integer(measurement.startedAt, 0, Number.MAX_SAFE_INTEGER))) {
          throw new AppError("Mesure comptable runner invalide", 503);
        }
        const failure = row.failure_receipt === null ? null : JSON.parse(String(row.failure_receipt)) as Row;
        if (row.failure_receipt !== null && (!failure || !decimal(failure.consumedCompute) || failure.finalFailure !== true
          || !integer(failure.observedAt, 0, Number.MAX_SAFE_INTEGER)
          || typeof failure.evidenceHash !== "string" || !/^0x[0-9a-f]{64}$/.test(failure.evidenceHash))) {
          throw new AppError("Reçu comptable runner invalide", 503);
        }
        return {
          id: String(row.id), fingerprint: String(row.fingerprint), validUntilMs: Number(row.valid_until),
          budgetUsdMicros: String(allocation.usd), budgetWei: String(allocation.wei),
          remaining: { requests: Number(row.requests), training: Number(row.training), transactions: Number(row.transactions) },
          checkpoint: measurement ? measurement.success && Boolean(row.has_result) ? "result-durable"
            : measurement.success ? "result-missing" : "failure-measured" : row.prepared ? "uncertain" : "not-started",
          measurement: measurement ? { elapsedMs: measurement.elapsedMs as number, startedAtMs: measurement.startedAt as number,
            success: measurement.success as boolean } : null,
          failureClaim: failure ? { consumedComputeAtomic: failure.consumedCompute as string,
            evidenceHash: failure.evidenceHash as string, observedAtSeconds: failure.observedAt as number } : null,
        };
      });
      return {
        version: 1 as const, generatedAtMs: now, chainId: this.policy.chainId, wallet: this.policy.wallet,
        accountingReference: this.policy.accountingReference,
        totals: { allocatedUsdMicros: String(diagnostics.allocatedUsd), allocatedWei: String(diagnostics.allocatedWei),
          remainingUsdMicros: String(diagnostics.remainingUsd), remainingWei: String(diagnostics.remainingWei), failures: diagnostics.failures },
        pendingTransactions: diagnostics.pendingTransactions, operations, workflows,
      };
    });
  }

  backup(destination: string): void {
    this.assertFile();
    assertPrivatePath(destination);
    const descriptor = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    closeSync(descriptor);
    this.db.prepare("VACUUM INTO ?").run(destination);
    const output = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(output); } finally { closeSync(output); }
    const dir = openSync(dirname(destination), constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }

  sanitizeKeyCache(): void {
    this.assertFile();
    this.db.prepare("UPDATE operations SET result = NULL WHERE kind = 'seal'").run();
    this.db.exec("VACUUM");
    const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0) throw new AppError("Nettoyage du registre incomplet : arrêter les autres processus", 503);
  }

  private allocate(usd: bigint, wei: bigint): void {
    const { allocatedUsd, allocatedWei } = this.accounting();
    const ceiling = fundedBudgetUsd(this.policy) - BigInt(this.policy.fixedReserveUsdMicros);
    if (allocatedUsd + usd > ceiling || allocatedWei + wei > BigInt(this.policy.gas.totalWei)) {
      throw new AppError("Budget runner insuffisant : nouvelle dépense bloquée", 503);
    }
    this.db.prepare("UPDATE budget SET allocated_usd = ?, allocated_wei = ? WHERE id = 1")
      .run(String(allocatedUsd + usd), String(allocatedWei + wei));
  }

  private workflowAllocation(): { usd: bigint; wei: bigint } {
    const wei = BigInt(this.policy.gas.maxTransactionWei) * BigInt(2);
    const scale = BigInt("1000000000000000000");
    const gasUsd = ((BigInt(this.policy.gas.maxTransactionWei) * BigInt(this.policy.gas.ethUsdMicrosUpperBound) + scale - BigInt(1)) / scale) * BigInt(2);
    return { usd: BigInt(this.policy.costsUsdMicros.training) + BigInt(this.policy.costsUsdMicros.request) * BigInt(16) + gasUsd, wei };
  }

  private workflow(scope: WorkflowBudget): Row {
    const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(scope.id);
    if (!row || row.fingerprint !== scope.fingerprint) throw new AppError("Budget de clôture hors scope", 409);
    return row;
  }

  workflowPayload(id: string): string | null {
    this.assertFile();
    return this.db.prepare("SELECT payload FROM workflows WHERE id = ?").get(id)?.payload as string | undefined ?? null;
  }

  expiredUnusedWorkflows(now: number, limit = 32): UnusedWorkflow[] {
    this.assertFile();
    return this.db.prepare(`SELECT w.id, w.fingerprint, w.payload FROM workflows w
      WHERE CAST(json_extract(w.payload, '$.quote.expiresAt') AS INTEGER) * 1000 < ?
      AND NOT EXISTS (SELECT 1 FROM operation_workflows o WHERE o.workflow_id = w.id)
      ORDER BY json_extract(w.payload, '$.quote.expiresAt') LIMIT ?`).all(now, limit) as unknown as UnusedWorkflow[];
  }

  releaseUnusedWorkflow(scope: WorkflowBudget): boolean {
    return this.atomic(() => {
      this.workflow(scope);
      if (this.db.prepare("SELECT operation_id FROM operation_workflows WHERE workflow_id = ?").get(scope.id)) return false;
      const { allocatedUsd, allocatedWei } = this.accounting();
      const allocation = this.workflowAllocation();
      if (allocatedUsd < allocation.usd || allocatedWei < allocation.wei) throw new AppError("Comptabilité runner indisponible", 503);
      this.db.prepare("DELETE FROM workflows WHERE id = ? AND fingerprint = ?").run(scope.id, scope.fingerprint);
      this.db.prepare("UPDATE budget SET allocated_usd = ?, allocated_wei = ? WHERE id = 1")
        .run(String(allocatedUsd - allocation.usd), String(allocatedWei - allocation.wei));
      return true;
    });
  }

  reserveWorkflow(scope: WorkflowBudget, payload: string, validUntil: number, availableGasWei: bigint): void {
    this.atomic(() => {
      const old = this.workflowPayload(scope.id);
      if (old !== null) {
        if (old !== payload) throw new AppError("Budget de clôture hors scope", 409);
        this.workflow(scope);
        return;
      }
      this.assertAdmission();
      if (Buffer.byteLength(payload) > 16384 || !integer(validUntil, Date.now() + 1, this.policy.validUntil)) {
        throw new AppError("Politique de coûts trop courte pour clôturer le prêt", 503);
      }
      const { usd, wei } = this.workflowAllocation();
      if (this.accounting().allocatedWei + wei > availableGasWei) throw new AppError("Liquidités ETH insuffisantes pour réserver la clôture", 503);
      this.allocate(usd, wei);
      this.db.prepare("INSERT INTO workflows VALUES (?, ?, ?, ?, 16, 1, 2)")
        .run(scope.id, scope.fingerprint, payload, validUntil);
    });
  }

  executionEvidence(scope: WorkflowBudget): string | null {
    this.assertFile();
    this.workflow(scope);
    return this.db.prepare("SELECT payload FROM execution_evidence WHERE workflow_id = ?").get(scope.id)?.payload as string | undefined ?? null;
  }

  prepareWorkflowResult(scope: WorkflowBudget, context: string): void {
    this.atomic(() => {
      this.workflow(scope);
      if (Buffer.byteLength(context) > 4096) throw new AppError("Contexte de reprise invalide", 409);
      this.db.prepare("INSERT OR IGNORE INTO workflow_results VALUES (?, ?, NULL)").run(scope.id, context);
      if (this.workflowResult(scope)?.context !== context) throw new AppError("Contexte de reprise hors scope", 409);
    });
  }

  workflowResult(scope: WorkflowBudget): { context: string; result: string | null } | null {
    this.assertFile();
    this.workflow(scope);
    return this.db.prepare("SELECT context, result FROM workflow_results WHERE workflow_id = ?").get(scope.id) as
      { context: string; result: string | null } | undefined ?? null;
  }

  recordExecutionEvidence(scope: WorkflowBudget, payload: string, result?: string, countFailure = true): void {
    this.atomic(() => {
      this.workflow(scope);
      if (Buffer.byteLength(payload) > 4096 || this.executionEvidence(scope) !== null) throw new AppError("Preuve de consommation déjà fixée ou invalide", 409);
      if (result !== undefined) {
        if (Buffer.byteLength(result) > 65536 || !this.workflowResult(scope)) throw new AppError("Résultat de reprise invalide", 409);
        this.db.prepare("UPDATE workflow_results SET result = ? WHERE workflow_id = ?").run(result, scope.id);
      }
      this.db.prepare("INSERT INTO execution_evidence VALUES (?, ?)").run(scope.id, payload);
      const operation = this.db.prepare(`SELECT o.id FROM operations o JOIN operation_workflows w ON w.operation_id = o.id
        WHERE w.workflow_id = ? AND o.kind = 'training' AND o.state = 'reserved'`).get(scope.id);
      if (operation) {
        const evidence = JSON.parse(payload) as { success: boolean; quoteHash: string };
        if (evidence.quoteHash !== scope.fingerprint || evidence.success !== (result !== undefined)) {
          throw new AppError("Preuve de consommation hors scope", 409);
        }
        this.db.prepare("UPDATE operations SET state = ?, result = ? WHERE id = ?")
          .run(evidence.success ? "succeeded" : "failed", result ?? null, String(operation.id));
        if (!evidence.success && countFailure) this.db.prepare("UPDATE budget SET failures = failures + 1 WHERE id = 1").run();
      }
    });
  }

  /**
   * Exposition rapide de l'enclave (fast-finality.ts) : somme des prêts admis au palier rapide,
   * verrouillés et pas encore libérés. Réserve la part de ce prêt si la somme, ce prêt compris,
   * reste sous `capAtomic` ; idempotent pour un même workflow. Les lignes dont l'échéance du prêt
   * est passée (`expiresAtMs`, remboursable par l'emprunteur) sont purgées d'abord : un prêt
   * remboursé ou jamais réglé libère sa part sans que l'enclave observe la chaîne. Renvoie faux
   * quand le plafond est atteint : l'appelant retombe sur la finalité complète.
   *
   * Compteur d'exposition, pas une dépense : il ne passe ni par l'admission (coupe-circuit,
   * politique périmée) ni par l'allocation du budget, et n'exige pas de ligne `workflows` — le
   * devis a déjà été vérifié par l'appelant (`runnerComputeQuote`) avant d'arriver ici.
   */
  reserveFastExposure(scope: WorkflowBudget, amountAtomic: bigint, capAtomic: bigint, expiresAtMs: number, now = Date.now()): boolean {
    return this.atomic(() => {
      if (amountAtomic <= BigInt(0) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) return false;
      this.db.prepare("DELETE FROM fast_exposure WHERE expires_at <= ?").run(now);
      if (this.db.prepare("SELECT workflow_id FROM fast_exposure WHERE workflow_id = ?").get(scope.id)) return true;
      if (this.fastExposureAtomic() + amountAtomic > capAtomic) return false;
      this.db.prepare("INSERT INTO fast_exposure VALUES (?, ?, ?, ?)").run(scope.id, String(amountAtomic), expiresAtMs, now);
      return true;
    });
  }

  /** Release ou remboursement confirmé : la part de ce prêt ne pèse plus sur le plafond rapide. */
  releaseFastExposure(scope: WorkflowBudget): void {
    this.atomic(() => { this.db.prepare("DELETE FROM fast_exposure WHERE workflow_id = ?").run(scope.id); });
  }

  fastExposureAtomic(): bigint {
    this.assertFile();
    return (this.db.prepare("SELECT amount FROM fast_exposure").all() as { amount: string }[])
      .reduce<bigint>((sum, row) => sum + BigInt(row.amount), BigInt(0));
  }

  fixFailureReceipt(scope: WorkflowBudget, payload: string): string {
    return this.atomic(() => {
      this.workflow(scope);
      if (Buffer.byteLength(payload) > 4096) throw new AppError("Preuve de consommation déjà fixée ou invalide", 409);
      this.db.prepare("INSERT OR IGNORE INTO failure_receipts VALUES (?, ?)").run(scope.id, payload);
      return String(this.db.prepare("SELECT payload FROM failure_receipts WHERE workflow_id = ?").get(scope.id)!.payload);
    });
  }
}

export type RunnerAccountingExport = ReturnType<BudgetLedger["accountingExport"]>;
