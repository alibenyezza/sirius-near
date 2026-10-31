import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/lib/app-error";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { postgresConnectionSummary, preflightErrorMessage } from "./preflight-diagnostics";

test("le préflight distingue SQL, connexion, TLS et RPC sans afficher les secrets", () => {
  const secret = "SECRET_SYNTHETIQUE";
  const sql = Object.assign(new Error(`postgresql://user:${secret}@db.invalid/db`), {
    code: "P2010",
    meta: { code: "42P01", message: secret },
  });
  assert.match(preflightErrorMessage(sql), /P2010.*42P01 : table PostgreSQL absente/);
  const adapter = { meta: { driverAdapterError: { cause: { kind: "TlsConnectionError", reason: secret } } } };
  assert.match(preflightErrorMessage(adapter), /TlsConnectionError : connexion TLS PostgreSQL refusée/);
  const aggregate = new AggregateError([Object.assign(new Error(secret), { code: "ENETUNREACH" })], secret);
  assert.match(preflightErrorMessage(aggregate), /ENETUNREACH : réseau inaccessible/);
  const rpc = Object.assign(new Error(`https://rpc.invalid/${secret}`), { name: "HttpRequestError" });
  assert.match(preflightErrorMessage(rpc), /HttpRequestError : requête HTTP RPC échouée/);
  for (const error of [sql, adapter, aggregate, rpc]) {
    assert.ok(!preflightErrorMessage(error).includes(secret));
  }
});

test("le préflight ignore les codes inconnus et les cycles, et conserve les refus métier", () => {
  const error: Record<string, unknown> = { code: "SECRET_SYNTHETIQUE", kind: "constructor", name: "toString" };
  error.cause = error;
  assert.equal(preflightErrorMessage(error), "Préflight EVM impossible à la dernière étape annoncée — erreur technique non classée");
  assert.equal(preflightErrorMessage(new AppError("Migration bloquée : escrow encore actif", 409)), "Migration bloquée : escrow encore actif");
});

test("les erreurs réelles de l'adaptateur conservent les SQLSTATE absents du dictionnaire", async () => {
  const connectionString = "postgresql://private_owner:private_password@private-host.invalid/private_database?sslmode=require";
  const pool = new pg.Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    for (const code of ["57P03", "08006", "08P01", "XX000", "42601", "42P05"]) {
      const failure = Object.assign(new Error("server unavailable for private_owner on private_database at private-host.invalid"), { code, severity: "FATAL" });
      pool.query = async () => { throw failure; };
      await assert.rejects(prisma.$queryRaw`SELECT to_regclass('public."Loan"') IS NOT NULL AS present`, (error) => {
        const message = preflightErrorMessage(error, connectionString);
        assert.ok(message.includes(code));
        assert.ok(message.includes("server unavailable"));
        assert.ok(!message.includes("private_"));
        assert.ok(!message.includes("private-host"));
        return true;
      });
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
});

test("le motif SQL masque les identifiants encodés, URL et séquences de contrôle", () => {
  const connectionString = "postgresql://secret_user:p%40ss%27word@secret-host.invalid/secret_database?token=secret_token";
  const originalMessage = "failure p@ss'word p@ss''word p%40ss%27word secret_user secret_database secret-host.invalid secret_token https://rpc.invalid/another_token\n::error::injected";
  const error = { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "XX000", originalMessage } } } };
  const message = preflightErrorMessage(error, connectionString);
  for (const privateValue of ["secret_", "secret-host", "p@ss", "p%40ss", "another_token", "\n"]) {
    assert.ok(!message.includes(privateValue));
  }
  assert.ok(!preflightErrorMessage(error, "file:local.db").includes("failure"));
  assert.ok(!preflightErrorMessage({ ...error, code: "P2010", meta: { message: originalMessage } }, connectionString).includes("failure"));
});

test("la configuration décrit l'hébergeur sans publier l'hôte ou les identifiants", () => {
  const summary = postgresConnectionSummary("postgresql://secret_user:secret_password@ep-private-pooler.eu.neon.tech/private_database?sslmode=require");
  assert.match(summary, /hébergeur Neon ; pooler indiqué ; port 5432 ; sslmode require/);
  assert.ok(!summary.includes("secret"));
  assert.ok(!summary.includes("ep-private"));
  assert.match(postgresConnectionSummary("postgresql://user:password@aws-0-eu.pooler.supabase.com:6543/db"), /Supabase.*6543/);
  assert.match(postgresConnectionSummary("postgresql://user:password@db.internal/db"), /non identifié.*pooler non déterminé/);
  assert.throws(() => postgresConnectionSummary("file:local.db"), /URL PostgreSQL valide/);
});
