import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AppError } from "@/lib/app-error";
import * as provenance from "@/lib/runner/provenance";
import * as addresses from "@/lib/evm/address";
import * as models from "@/lib/models/registry";

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Date, console, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

const provider = `0x${"11".repeat(20)}`;
const borrower = `0x${"22".repeat(20)}`;
const runner = { runnerKind: "PHALA" as const, runnerDeploymentId: `phala:${"33".repeat(32)}` };
const saved = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: "test", EVM_NETWORK: "testnet", TEE_MODE: "phala", RUNNER_URL: "https://runner.example",
    NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: "33".repeat(32),
  });
  delete process.env.DSTACK_SIMULATOR_ENDPOINT;
  delete process.env.SIRIUS_REQUIRE_PHALA;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function fixture() {
  const dataset = {
    id: "dataset", provider, status: "LISTED", ...runner, ipfsCid: "bafyDataset", merkleRoot: "44".repeat(32),
    wrappedKey: "wrapped", runnerReceipt: "receipt", priceUsdcAtomic: "100", evmDatasetId: `0x${"55".repeat(32)}`,
    modelId: "linear_regression", modelVersion: "1.0.0", challengeDays: 7,
  };
  const records: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const create = async ({ data }: { data: Record<string, unknown> }) => {
    const record = { id: "loan", ...data, createdAt: new Date(), updatedAt: new Date() };
    records.push(record);
    return record;
  };
  const update = async ({ data }: { data: Record<string, unknown> }) => ({ ...records[0], ...data });
  const tx = {
    dataset: { updateMany: async () => ({ count: 1 }) },
    loan: { count: async () => 0, create, update, updateMany: async () => ({ count: 0 }) },
    trainingJob: { count: async () => 0, create, updateMany: async () => ({ count: 0 }) },
  };
  const common = {
    "server-only": {}, "@/lib/errors": { AppError },
    "@/lib/runner/provenance": provenance, "@/lib/models/registry": models,
    "@/lib/evm/deployment": { requireCurrentEvmDeployment: async () => {} },
    "@/lib/db": { serializableTransaction: async (fn: (value: typeof tx) => unknown) => fn(tx), prisma: {
      $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
      dataset: { findUnique: async () => dataset },
      trainingJob: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return { count: 1 }; } },
      loan: { update },
    } },
  };
  return { dataset, records, updates, common };
}

test("le self-train persiste le runner choisi et refuse une autre identité avant tout job", async () => {
  const { dataset, records, common } = fixture();
  let executions = 0;
  const api = load<typeof import("./self-train")>("src/lib/sirius/self-train.ts", {
    ...common,
    "@/lib/tee/runner-client": { runSelfTrainingInRunner: async () => {
      executions++;
      return { modelCid: "bafyModel", metrics: {}, runnerReceipt: "job-receipt" };
    } },
    "@/lib/sirius/access": { requireAcceptedKyb: async () => {} },
    "@/lib/sirius/model-storage": { unpinModelUnlessReferenced: async () => {} },
    "@/lib/evm/dataset": { assertDatasetScope: async () => {} },
  });
  await api.runSelfTrain(dataset.id, provider, "job", dataset.runnerReceipt, {} as never);
  assert.equal(records[0].runnerKind, runner.runnerKind);
  assert.equal(records[0].runnerDeploymentId, runner.runnerDeploymentId);
  dataset.runnerDeploymentId = `phala:${"66".repeat(32)}`;
  await assert.rejects(api.runSelfTrain(dataset.id, provider, "other-job", dataset.runnerReceipt, {} as never), /ancien runner/);
  assert.equal(executions, 1);
  assert.equal(records.length, 1);
});

test("le résultat self-train et sa capsule sont persistés ensemble avant livraison", async () => {
  const { dataset, updates, common } = fixture();
  const envelope = { version: 1, ephemeralPublicKey: "public", salt: "salt", iv: "iv", ciphertext: "encrypted" };
  const api = load<typeof import("./self-train")>("src/lib/sirius/self-train.ts", {
    ...common,
    "@/lib/tee/runner-client": { runSelfTrainingInRunner: async (...args: unknown[]) => {
      assert.equal(args[3], "delivery-public-key");
      return { modelCid: "bafyModel", metrics: {}, runnerReceipt: "job-receipt", modelKeyEnvelope: envelope };
    } },
    "@/lib/sirius/access": { requireAcceptedKyb: async () => {} },
    "@/lib/sirius/model-storage": { unpinModelUnlessReferenced: async () => {} },
    "@/lib/evm/dataset": { assertDatasetScope: async () => {} },
  });
  await api.runSelfTrain(dataset.id, provider, "job", dataset.runnerReceipt, {} as never, "delivery-public-key");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "DONE");
  assert.equal(updates[0].deliveryPublicKey, "delivery-public-key");
  assert.equal(JSON.stringify(updates[0].deliveryEnvelope), JSON.stringify(envelope));
  assert.equal(updates[0].modelCid, "bafyModel");
  assert.equal(updates[0].runnerReceipt, "job-receipt");
});

test("le prêt conserve la provenance dès sa préparation et ne réserve pas un dataset d’un autre runner", async () => {
  const { dataset, records, common } = fixture();
  let signatures = 0;
  const api = load<typeof import("./borrower")>("src/lib/sirius/borrower.ts", {
    ...common, "@/lib/evm/address": addresses,
    "@/lib/billing/config": { billingEnabled: () => false },
    "@/lib/billing/quote": {}, "@/lib/billing/loan": {},
    "@/lib/evm/addresses": { datasetRegistryAddress: () => provider },
    "@/lib/evm/abi/siriusdatasetregistry": {},
    "@/lib/evm/client": { getPublicClient: () => ({ readContract: async () => true, getBlockNumber: async () => BigInt(10) }) },
    "@/lib/evm/loan-key": { loanKeyFor: () => `0x${"77".repeat(32)}` },
    "@/lib/evm/escrow": {}, "@/lib/evm/transaction": { approveUsdcTransaction: () => ({}), lockUsdcTransaction: () => ({}) },
    "@/lib/tee/runner-client": { prepareEscrowLockInRunner: async () => {
      signatures++;
      return { hashlock: `0x${"88".repeat(32)}`, authorization: {} };
    } },
    "./lock-policy": { lockAuthorizationDeadline: () => 1 },
    "./access": { requireAcceptedKyb: async () => {}, requireCounterpartyKyb: async () => {} },
    "./provider": { BORROWABLE_STATUSES: ["LISTED", "UNLISTED"], isBorrowableDatasetStatus: () => true },
    "@/lib/datasets/manage": { isListingExpired: () => false },
    "@/lib/tee/evm-binding": { evmEscrowBinding: () => ({ chainId: 46630, escrow: provider }) },
    "./recover-loan": {}, "@/lib/evm/history": {},
    // Testnet sans plafonds configurés : les gardes de la bêta mainnet ne s'appliquent pas.
    "./exposure-limits": { assertAdmissionsOpen: () => {}, exposureLimits: () => null, assertLoanWithinCap: () => {}, assertExposureWithinCap: () => {}, EXPOSED_LOAN_STATUSES: [] },
  });
  await api.prepareLoan(dataset.id, borrower);
  assert.equal(records[0].runnerKind, runner.runnerKind);
  assert.equal(records[0].runnerDeploymentId, runner.runnerDeploymentId);
  dataset.runnerDeploymentId = `phala:${"66".repeat(32)}`;
  await assert.rejects(api.prepareLoan(dataset.id, borrower), /ancien runner/);
  assert.equal(records.length, 1);
  assert.equal(signatures, 1);
});

test("le dépôt conserve l’identité d’ingestion et refuse un changement de clé avant l’upload", async () => {
  let stored: Record<string, unknown> = {};
  let seals = 0;
  const datasetStore = {
    count: async () => 0, deleteMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      stored = { ...data, id: "dataset", status: "DRAFT", ipfsCid: null, wrappedKey: null, keyDestroyedAt: null };
      return stored;
    },
    findUnique: async () => stored, findUniqueOrThrow: async () => stored,
    updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(stored, data);
      return { count: 1 };
    },
  };
  const api = load<typeof import("./pipeline")>("src/lib/sirius/pipeline.ts", {
    "server-only": {}, "@/lib/app-error": { AppError }, "@/lib/models/registry": models,
    "@/lib/runner/provenance": provenance, "@/lib/sirius/access": { requireAcceptedKyb: async () => {} },
    "@/lib/ipfs/pinata": { unpinFromIpfs: async () => {} },
    "@/lib/db": { serializableTransaction: async (fn: (tx: unknown) => unknown) => fn({ dataset: datasetStore }), prisma: { dataset: datasetStore, $transaction: async (fn: (tx: unknown) => unknown) => fn({ dataset: datasetStore }) } },
    "@/lib/tee/runner-client": {
      datasetIngressKeyInRunner: async () => ({ publicKey: "public-key" }),
      sealDatasetInRunner: async () => {
        seals++;
        return { cid: "bafyDataset", wrappedKey: "wrapped", merkleRoot: "11".repeat(32), metrics: {}, sizeBytes: 1200, runnerReceipt: "receipt" };
      },
    },
  });
  await api.beginDatasetIngestion({ name: "Dataset", provider, sizeBytes: 1200, priceUsdcAtomic: "100", challengeDays: 7,
    model: { modelId: "linear_regression", modelVersion: "1.0.0" } });
  assert.equal(stored.runnerKind, runner.runnerKind);
  assert.equal(stored.runnerDeploymentId, runner.runnerDeploymentId);
  const upload = await api.authorizeDatasetUpload("dataset", provider);
  process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256 = "66".repeat(32);
  await assert.rejects(api.completeDatasetIngestion(upload, {} as never, {} as never), /ancien runner/);
  assert.equal(seals, 0);
  process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256 = "33".repeat(32);
  await api.completeDatasetIngestion(upload, {} as never, {} as never);
  assert.equal(seals, 1);
  assert.equal(stored.runnerDeploymentId, runner.runnerDeploymentId);
});

test("le préflight de bascule refuse les ressources actives et compte les modèles historiques sans écrire", async () => {
  let blocked: "dataset" | "trainingJob" | "loan" | null = null;
  let escrowChecks = 0;
  const counters = Object.fromEntries(["dataset", "trainingJob", "loan"].map(name => [name, {
    count: async ({ where }: { where: { status: string | { in: string[] }; OR: unknown[] } }) => {
      assert.ok(where.OR.length > 0, "les ressources d’un autre runner doivent être prises en compte");
      if (where.status === "DONE") return 2;
      if (where.status === "SETTLED") return 3;
      return name === blocked ? 1 : 0;
    },
  }]));
  const api = load<typeof import("./runner-migration")>("src/lib/sirius/runner-migration.ts", {
    "server-only": {}, "@/lib/app-error": { AppError }, "@/lib/runner/provenance": provenance,
    "@/lib/db": { prisma: counters },
    "@/lib/runner/config": { assertApplicationRunnerConfiguration: () => {}, requiresPhalaRunner: () => true },
    "./escrow-upgrade": { checkEscrowUpgrade: async () => { escrowChecks++; } },
  });
  for (const name of ["dataset", "trainingJob", "loan"] as const) {
    blocked = name;
    await assert.rejects(api.checkRunnerMigration(), /Bascule Phala bloquée/);
  }
  blocked = null;
  const result = await api.checkRunnerMigration();
  assert.equal(result.historicalJobs, 2);
  assert.equal(result.historicalLoans, 3);
  assert.equal(escrowChecks, 4);
});
