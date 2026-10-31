import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AppError } from "@/lib/app-error";
import * as fastFinality from "@/lib/evm/fast-finality";
import type { FinalityTier } from "@/lib/evm/fast-finality";
import type { FinalityTierStore } from "./finality-tier";

// Même harnais que borrower-exposure.test.ts : le module est exécuté avec ses dépendances
// remplacées (la base n'est jamais ouverte, la politique est injectée).
function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Date, BigInt, console, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

const DECIMALS = 6;
const usdc = (value: string) => (BigInt(value) * BigInt(10) ** BigInt(DECIMALS)).toString();
const { fastFinalityConfig } = fastFinality;
const config = fastFinalityConfig({ SIRIUS_FAST_FINALITY: "true" }, DECIMALS);

const { assignLoanFinalityTier, decideFastTierInTransaction, effectiveLoanFinalityTier, FAST_IN_FLIGHT_STATUSES } = load<typeof import("./finality-tier")>("src/lib/sirius/finality-tier.ts", {
  "server-only": {},
  "@/lib/errors": { AppError },
  "@/lib/db": { prisma: {}, serializableTransaction: async () => { throw new Error("base inattendue"); } },
  "@/lib/evm/finality": { fastFinalityPolicy: () => config },
  "@/lib/evm/fast-finality": fastFinality,
});

// Base en mémoire avec une « transaction sérialisable » : les actions s'exécutent une à la fois,
// ce que Postgres garantit par conflit puis relance (db.ts). Les décisions concurrentes voient donc
// toujours l'écriture de la précédente, jamais un instantané périmé.

interface Row { id: string; status: string; amountUsdcAtomic: string; finalityTier: FinalityTier }

function database(rows: Row[]) {
  const writes: string[] = [];
  const store: FinalityTierStore = {
    loan: {
      findMany: async ({ where }) => rows
        .filter((row) => row.finalityTier === where.finalityTier && where.status.in.includes(row.status) && (!where.id || row.id !== where.id.not))
        .map((row) => ({ amountUsdcAtomic: row.amountUsdcAtomic })),
      updateMany: async ({ where, data }) => {
        const row = rows.find((candidate) => candidate.id === where.id && candidate.status === where.status && candidate.finalityTier === where.finalityTier);
        if (!row) return { count: 0 };
        row.finalityTier = data.finalityTier;
        writes.push(row.id);
        return { count: 1 };
      },
      findUnique: async ({ where }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        return row ? { finalityTier: row.finalityTier } : null;
      },
    },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const transaction = <T,>(action: (tx: FinalityTierStore) => Promise<T>): Promise<T> => {
    const run = queue.then(() => action(store));
    queue = run.catch(() => undefined);
    return run;
  };
  return { rows, store, writes, transaction };
}

const escrowed = (id: string, amount: string, finalityTier: FinalityTier = "FULL", status = "ESCROWED"): Row => ({ id, status, amountUsdcAtomic: usdc(amount), finalityTier });

test("course sur le plafond : deux lancements simultanés, un seul prêt passe en rapide, l'autre garde la finalité complète", async () => {
  // 60 déjà en cours en rapide ; deux prêts de 25 arrivent ensemble : 85 passe, 110 non.
  const db = database([escrowed("en-cours", "60", "FAST", "TRAINING"), escrowed("a", "25"), escrowed("b", "25")]);
  const verified: string[] = [];
  const verify = (id: string) => async () => { verified.push(id); return true; };
  const [a, b] = await Promise.all([
    assignLoanFinalityTier({ id: "a", amountUsdcAtomic: usdc("25"), finalityTier: "FULL" }, verify("a"), { config, transaction: db.transaction }),
    assignLoanFinalityTier({ id: "b", amountUsdcAtomic: usdc("25"), finalityTier: "FULL" }, verify("b"), { config, transaction: db.transaction }),
  ]);
  assert.deepEqual([a, b].sort(), ["FAST", "FULL"]);
  assert.equal(db.writes.length, 1, "une seule ligne marquée");
  assert.deepEqual(verified.sort(), ["a", "b"], "le montant on-chain est relu avant toute décision rapide");
  // Relance du perdant : le plafond n'a pas bougé, il reste en finalité complète, sans écriture.
  const loser = a === "FAST" ? "b" : "a";
  assert.equal(await assignLoanFinalityTier({ id: loser, amountUsdcAtomic: usdc("25"), finalityTier: "FULL" }, verify(loser), { config, transaction: db.transaction }), "FULL");
  assert.equal(db.writes.length, 1);
  // Le plafond se libère (prêt en cours réglé) : la relance suivante passe en rapide.
  db.rows[0].status = "SETTLED";
  assert.equal(await assignLoanFinalityTier({ id: loser, amountUsdcAtomic: usdc("25"), finalityTier: "FULL" }, verify(loser), { config, transaction: db.transaction }), "FAST");
  assert.equal(db.writes.length, 2);
});

test("un palier rapide acquis est conservé sans relecture ; un prêt hors seuil ne touche ni la chaîne ni la base", async () => {
  const db = database([escrowed("gros", "26"), escrowed("petit", "5", "FAST")]);
  let chainReads = 0;
  const verify = async () => { chainReads++; return true; };
  assert.equal(await assignLoanFinalityTier({ id: "petit", amountUsdcAtomic: usdc("5"), finalityTier: "FAST" }, verify, { config, transaction: db.transaction }), "FAST");
  assert.equal(await assignLoanFinalityTier({ id: "gros", amountUsdcAtomic: usdc("26"), finalityTier: "FULL" }, verify, { config, transaction: db.transaction }), "FULL");
  assert.equal(chainReads, 0);
  assert.deepEqual(db.writes, []);
  // Coupe-circuit fermé : finalité complète pour tous, sans lecture, même pour une ligne déjà FAST
  // (comportement historique retrouvé partout, la ligne garde son palier).
  const closed = fastFinalityConfig({}, DECIMALS);
  assert.equal(await assignLoanFinalityTier({ id: "gros", amountUsdcAtomic: usdc("5"), finalityTier: "FULL" }, verify, { config: closed, transaction: db.transaction }), "FULL");
  assert.equal(await assignLoanFinalityTier({ id: "petit", amountUsdcAtomic: usdc("5"), finalityTier: "FAST" }, verify, { config: closed, transaction: db.transaction }), "FULL");
  assert.equal(chainReads, 0);
  assert.equal(effectiveLoanFinalityTier("FAST", closed), "FULL");
  assert.equal(effectiveLoanFinalityTier("FAST", config), "FAST");
  assert.equal(effectiveLoanFinalityTier("FULL", config), "FULL");
});

test("lecture seule (dryRun) : le palier candidat est rendu sans marquer la ligne, le plafond n'est pas occupé", async () => {
  const db = database([escrowed("en-cours", "80", "FAST", "TRAINING"), escrowed("a", "20"), escrowed("b", "20")]);
  const verify = async () => true;
  assert.equal(await assignLoanFinalityTier({ id: "a", amountUsdcAtomic: usdc("20"), finalityTier: "FULL" }, verify, { config, transaction: db.transaction, dryRun: true }), "FAST");
  assert.equal(await assignLoanFinalityTier({ id: "b", amountUsdcAtomic: usdc("20"), finalityTier: "FULL" }, verify, { config, transaction: db.transaction, dryRun: true }), "FAST", "rien d'occupé par la lecture précédente");
  assert.deepEqual(db.writes, []);
  // Le marquage réel, lui, tranche : un seul des deux tient sous le plafond.
  assert.equal(await assignLoanFinalityTier({ id: "a", amountUsdcAtomic: usdc("20"), finalityTier: "FULL" }, verify, { config, transaction: db.transaction }), "FAST");
  assert.equal(await assignLoanFinalityTier({ id: "b", amountUsdcAtomic: usdc("20"), finalityTier: "FULL" }, verify, { config, transaction: db.transaction }), "FULL");
  assert.deepEqual(db.writes, ["a"]);
});

test("montant on-chain différent du montant enregistré : refus explicite avant tout marquage", async () => {
  const db = database([escrowed("a", "5")]);
  await assert.rejects(
    assignLoanFinalityTier({ id: "a", amountUsdcAtomic: usdc("5"), finalityTier: "FULL" }, async () => false, { config, transaction: db.transaction }),
    (error: unknown) => error instanceof AppError && error.status === 409 && /on-chain/.test(error.message),
  );
  assert.deepEqual(db.writes, []);
});

test("dans la transaction : le prêt qui n'est plus ESCROWED n'est pas marqué, un prêt déjà marqué par un concurrent est lu FAST", async () => {
  const db = database([escrowed("parti", "5", "FULL", "TRAINING"), escrowed("deja", "5", "FAST")]);
  assert.equal(await decideFastTierInTransaction(db.store, { id: "parti", amountUsdcAtomic: usdc("5"), finalityTier: "FULL" }, config), "FULL");
  assert.equal(await decideFastTierInTransaction(db.store, { id: "deja", amountUsdcAtomic: usdc("5"), finalityTier: "FULL" }, config), "FAST");
  assert.deepEqual(db.writes, []);
  // Seuls ESCROWED, TRAINING et SETTLING pèsent sur le plafond : un prêt réglé ou annulé le libère.
  assert.deepEqual([...FAST_IN_FLIGHT_STATUSES], ["ESCROWED", "TRAINING", "SETTLING"]);
  const full = database([escrowed("x", "100", "FAST", "SETTLED"), escrowed("y", "100", "FAST", "CANCELLED"), escrowed("z", "25")]);
  assert.equal(await decideFastTierInTransaction(full.store, { id: "z", amountUsdcAtomic: usdc("25"), finalityTier: "FULL" }, config), "FAST");
});
