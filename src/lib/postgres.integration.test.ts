import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { hashOperatorCode } from "./phala-demo/operator-code";

// Mesuré à 56 s sur le runner CI de staging : 60 s ne laissait aucune marge.
test("migrations additives et quotas sur PostgreSQL entre huit processus", { timeout: 120000 }, async (t) => {
  const configured = process.env.SIRIUS_TEST_DATABASE_URL;
  assert.ok(configured, "SIRIUS_TEST_DATABASE_URL doit désigner une instance PostgreSQL locale jetable");
  const url = new URL(configured);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Les tests refusent les bases distantes");
  const database = `sirius_test_${randomBytes(8).toString("hex")}`;
  const admin = new Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.href });
  await client.connect();
  t.after(async () => {
    await client.end();
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
  });
  const migrations = readdirSync("prisma/migrations").filter((name) => /^\d/.test(name)).sort();
  const cutoff = migrations.indexOf("20260919000000_track_runner_provenance");
  assert.ok(cutoff > 0);
  for (const migration of migrations.slice(0, cutoff)) await client.query(readFileSync(join("prisma/migrations", migration, "migration.sql"), "utf8"));
  const provider = `0x${"12".repeat(20)}`;
  await client.query(`INSERT INTO "Dataset" (id, name, provider, "priceUsdcAtomic", "updatedAt") VALUES ('history', 'synthetic', $1, '1000', now())`, [provider]);
  await client.query(`INSERT INTO "Loan" (id, "datasetId", borrower, provider, "amountUsdcAtomic", status, "modelCid", "updatedAt")
    VALUES ('history-loan', 'history', $1, $2, '1000', 'SETTLED', 'bafy-history', now())`, [`0x${"34".repeat(20)}`, provider]);
  for (const migration of migrations.slice(cutoff)) await client.query(readFileSync(join("prisma/migrations", migration, "migration.sql"), "utf8"));
  const historical = (await client.query('SELECT "billingQuote", "runnerKind", "modelCid", "amountUsdcAtomic" FROM "Loan" WHERE id = $1', ["history-loan"])).rows[0];
  assert.deepEqual(historical, { billingQuote: null, runnerKind: "UNKNOWN", modelCid: "bafy-history", amountUsdcAtomic: "1000" });
  // Socle A1 : la base tient l'invariant « adresse en minuscules » sur les tables créées, que Prisma ne voit pas.
  for (const [table, columns, values] of [["UserProfile", "(address)", "($1)"], ["DatasetAccessLog", '(id, "datasetId", address)', "('log-check', 'history', $1)"]] as const) {
    await assert.rejects(client.query(`INSERT INTO "${table}" ${columns} VALUES ${values}`, [`0x${"AB".repeat(20)}`]), (error: unknown) =>
      (error as { constraint?: string }).constraint === `${table}_address_lowercase`, `${table} doit refuser une adresse en casse mixte`);
    await client.query(`INSERT INTO "${table}" ${columns} VALUES ${values}`, [`0x${"ab".repeat(20)}`]);
  }
  assert.equal((await client.query('SELECT count(*)::int AS n FROM "UserProfile"')).rows[0].n, 1);
  assert.deepEqual((await client.query('SELECT "featureTours", "settings" FROM "UserProfile"')).rows[0], { featureTours: {}, settings: {} });

  const operatorCodeHash = hashOperatorCode("correct-operator-code");
  async function race(providers: string[], task: "ingest" | "loan" | "training" | "operator-code" = "ingest") {
    const workers = providers.map(() => spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/test/postgres-worker.ts"], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: url.href, DATABASE_POOL_MAX: "2",
        TEE_MODE: "stub", EVM_NETWORK: "testnet", SIRIUS_KYB_ADDRESS: `0x${"56".repeat(20)}`,
        SIRIUS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        SIRIUS_ESCROW_ADDRESS: `0x${"11".repeat(20)}`, SIRIUS_DATASET_ADDRESS: `0x${"22".repeat(20)}`,
        SIRIUS_USDC_ADDRESS: `0x${"33".repeat(20)}`, RUNNER_URL: "http://runner.test.invalid",
        RUNNER_TRANSPORT_SECRET: Buffer.alloc(32, 9).toString("base64"), SIRIUS_DEMO_OPERATOR_CODE_HASH: operatorCodeHash },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }));
    try {
      for (const child of workers) child.stderr!.resume();
      await Promise.all(workers.map((child) => once(child, "message")));
      const results = workers.map((child) => once(child, "message"));
      const exits = workers.map((child) => once(child, "exit"));
      workers.forEach((child, i) => child.send({ provider: providers[i], task }));
      const responses = (await Promise.all(results)).map(([result]) => result as { accepted: boolean; code?: string | number });
      if (task === "training") {
        // Les workers refusés ferment déjà leur canal ; seul le calcul admis attend la barrière.
        await Promise.all(workers.flatMap((child, i) => responses[i].accepted
          ? [new Promise<void>((resolve, reject) => child.send("release", (error) => error ? reject(error) : resolve()))]
          : []));
      }
      for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
      if (task === "operator-code") return responses;
      for (const result of responses.filter((item) => !item.accepted)) assert.ok([429, "P2034", "quota"].includes(result.code!), `Échec inattendu : ${result.code}`);
      assert.equal(responses.filter((result) => result.accepted).length, 1);
      return responses;
    } finally { for (const child of workers) if (child.exitCode === null) child.kill(); }
  }
  await client.query(`INSERT INTO "Dataset" (id, name, provider, "priceUsdcAtomic", "updatedAt")
    SELECT 'draft-' || n, 'synthetic', $1, '1000', now() FROM generate_series(1, 3) n`, [provider]);
  await race(Array(8).fill(provider));
  assert.equal(Number((await client.query('SELECT count(*) FROM "Dataset" WHERE provider = $1 AND status = \'DRAFT\'', [provider])).rows[0].count), 5);
  await client.query(`INSERT INTO "Dataset" (id, name, provider, "priceUsdcAtomic", "updatedAt")
    SELECT 'global-' || n, 'synthetic', $1, '1000', now() FROM generate_series(1, 194) n`, [provider]);
  await race(Array.from({ length: 8 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}`));
  assert.equal(Number((await client.query('SELECT count(*) FROM "Dataset"')).rows[0].count), 200);
  await client.query(`UPDATE "Dataset" SET status = 'LISTED', "ipfsCid" = 'bafy-synthetic', "wrappedKey" = 'synthetic',
    "runnerReceipt" = 'synthetic', "merkleRoot" = $1, "evmDatasetId" = $2,
    "modelId" = 'linear_regression', "modelVersion" = '1.0.0' WHERE id = 'history'`, ["ab".repeat(32), `0x${"67".repeat(32)}`]);
  const borrower = `0x${"78".repeat(20)}`;
  // Quatre prêts déjà payés (hash de lock) : un PENDING sans hash serait remplacé par la préparation
  // suivante du même emprunteur au lieu d'être compté (audit du 5 octobre, A-06).
  await client.query(`INSERT INTO "Loan" (id, "datasetId", borrower, provider, "amountUsdcAtomic", "evmLockTxHash", "updatedAt")
    SELECT 'pending-' || n, 'history', $1, $2, '1000', '0x' || lpad(n::text, 64, '0'), now() FROM generate_series(1, 4) n`, [borrower, provider]);
  await race(Array(8).fill(borrower), "loan");
  assert.equal(Number((await client.query('SELECT count(*) FROM "Loan" WHERE borrower = $1 AND status = \'PENDING\'', [borrower])).rows[0].count), 5);
  await race(Array(8).fill(provider), "training");
  assert.equal(Number((await client.query('SELECT count(*) FROM "TrainingJob" WHERE status = \'DONE\'')).rows[0].count), 1);

  // Code opérateur : huit instances concurrentes ne vérifient jamais plus de codes faux que le reliquat de
  // la fenêtre, y compris quand quatre échecs sont déjà inscrits ; seuls les échecs vérifiés restent.
  for (const [operator, seeded] of [[`0x${"9a".repeat(20)}`, 0], [`0x${"9b".repeat(20)}`, 4]] as const) {
    await client.query(`INSERT INTO "OperatorCodeAttempt" (id, address, "createdAt")
      SELECT 'seed-' || $1 || '-' || n, $1, now() FROM generate_series(1, $2::int) n`, [operator, seeded]);
    const guesses = await race(Array(8).fill(operator), "operator-code");
    const verified = guesses.filter((result) => result.code === 403).length;
    assert.ok(verified <= 5 - seeded, `vérifications : ${verified} après ${seeded} échecs`);
    assert.equal(guesses.filter((result) => result.code === 429).length, 8 - verified);
    assert.equal(Number((await client.query('SELECT count(*) FROM "OperatorCodeAttempt" WHERE address = $1', [operator])).rows[0].count), seeded + verified);
  }
});
