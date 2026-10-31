import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync, chmodSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { keccak256, type Hex } from "viem";
import { BudgetLedger, initializeBudgetLedger, validateBudgetPolicy, type BudgetPolicy } from "./budget-ledger";
import { assertTrialDeployment, assertTrialSubject, budgetFingerprint, runBudgetedOperation, runnerBudget, withWorkflowBudget } from "./budget";
import { classifySendError, sendBudgetedTransaction, type BudgetedTransactionIO } from "./budget-transaction";
import { assertAbandonable, parseTransactionsCommand } from "../../../scripts/runner-transactions";
import { boundedGas, lowGasBalanceAlert } from "./gas-policy";
import { countsAsRunnerFailure, RunnerFinalityPending, RunnerRetryLater } from "./failure-policy";
import { AppError } from "@/lib/app-error";
import { parseBudgetCommand } from "../../../scripts/runner-budget";
import { reconcileRunnerTransactions } from "./transaction-recovery";
import type { PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openRunnerTransaction, sealRunnerTransaction } from "./transaction-journal";

const wallet = `0x${"12".repeat(20)}`;
const directories: string[] = [];
const ledgers: BudgetLedger[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function policy(): BudgetPolicy {
  return {
    version: 1, chainId: 46630, wallet, accountingReference: "fixture-synthetic-not-revenue", validUntil: Date.now() + 60_000,
    earnedMarginUsdMicros: "1000", cashUsdMicros: "1000", fixedReserveUsdMicros: "100",
    costsUsdMicros: { request: "1", seal: "50", training: "100" },
    gas: { totalWei: "200000000000", maxTransactionWei: "100000000000", maxGas: "100000", maxFeePerGasWei: "1000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 2 },
    maxFailures: 3, maxActive: 8,
  };
}

test("changer la source sponsorisée conserve les coûts et refuse une enveloppe sous-financée ou des réservations actives", () => {
  const { ledger, open } = fixture((p) => {
    p.earnedMarginUsdMicros = "0"; p.cashUsdMicros = "0";
    p.sponsored = { funding: "credits", creditsUsdMicros: "1000", cashUsdMicros: "0", ceilingUsdMicros: "900",
      maxOperations: 6, maxOperationsPerWallet: 2, maxConcurrent: 1, origin: "https://demo.example", observedAtMs: Date.now() - 1000 };
  });
  ledger.reserve("train", "input", "training");
  const next = { ...ledger.policy.sponsored!, funding: "sirius" as const, creditsUsdMicros: "0", cashUsdMicros: "900" };
  assert.throws(() => ledger.configureSponsored(next, Date.now(), wallet), /Réconcilie/);
  ledger.finish("train", "input", false);
  const before = ledger.snapshot();
  assert.throws(() => ledger.configureSponsored({ ...next, ceilingUsdMicros: "150" }, Date.now(), wallet), /engagements/);
  ledger.configureSponsored(next, Date.now(), wallet);
  assert.deepEqual(ledger.snapshot(), before);
  const restored = open();
  assert.equal(restored.policy.sponsored?.funding, "sirius");
  assert.deepEqual(restored.snapshot(), before);
});

function fixture(change: (p: BudgetPolicy) => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "sirius-budget-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const path = join(directory, "ledger.sqlite");
  const p = policy();
  change(p);
  initializeBudgetLedger(path, p);
  function open() {
    const ledger = new BudgetLedger(path, p.chainId, p.wallet);
    ledgers.push(ledger);
    return ledger;
  }
  return { path, policy: p, ledger: open(), open };
}

function trialPolicy(p: BudgetPolicy): void {
  p.earnedMarginUsdMicros = p.cashUsdMicros = "0";
  p.trial = { provider: "phala", creditsUsdMicros: "10000", ceilingUsdMicros: "200", observedAtMs: Date.now(),
    escrow: `0x${"34".repeat(20)}`, wallets: [`0x${"56".repeat(20)}`] };
}

test("les crédits d’essai financent une enveloppe persistante sans fabriquer de marge", () => {
  const { ledger, open } = fixture(trialPolicy);
  ledger.reserve("trial", "trial", "training");
  ledger.finish("trial", "trial", true, "{}");
  assert.equal(ledger.policy.earnedMarginUsdMicros, "0");
  assert.equal(ledger.policy.cashUsdMicros, "0");
  assert.equal(open().diagnostics().remainingUsd, BigInt(0));
  assert.throws(() => open().reserve("trial-2", "trial-2", "request"), /insuffisant/);
});

test("ajouter un wallet d’essai conserve le budget engagé, les anciens wallets et le plafond", async () => {
  const { ledger, open, path, policy: p } = fixture(trialPolicy);
  ledger.reserve("trial", "scope", "training");
  ledger.finish("trial", "scope", false);
  const before = ledger.snapshot();
  const added = `0x${"78".repeat(20)}`;
  const execute = promisify(execFile);
  const args = ["--import", "tsx", "scripts/add-runner-trial-wallets.ts", path];
  const env = { ...process.env, RUNNER_VOLUME_ACTION: "add-trial-wallets", SIRIUS_LOCK_AUTHORIZER: wallet,
    SIRIUS_ESCROW_ADDRESS: p.trial!.escrow, RUNNER_ADDITIONAL_TRIAL_WALLETS: JSON.stringify([added]) };
  await assert.rejects(execute(process.execPath, args, { env: { ...env, SIRIUS_ESCROW_ADDRESS: added } }));
  assert.deepEqual(open().policy.trial!.wallets, p.trial!.wallets);
  await execute(process.execPath, args, { env });
  const updated = open();
  assert.deepEqual(updated.policy.trial!.wallets, [...p.trial!.wallets, added]);
  updated.addTrialWallets([added]);
  assert.deepEqual(open().policy.trial!.wallets, [...p.trial!.wallets, added]);
  assert.equal(updated.policy.trial!.ceilingUsdMicros, p.trial!.ceilingUsdMicros);
  assert.deepEqual(updated.snapshot(), before);
  assert.throws(() => updated.addTrialWallets([wallet]));
  assert.throws(() => updated.addTrialWallets(["invalid"]));
  assert.throws(() => updated.reserve("new", "new", "request"), /insuffisant/);
  assert.throws(() => fixture().ledger.addTrialWallets([added]));
});

test("les essais sont liés au testnet, au crédit disponible et au déploiement staging", () => {
  const p = policy(); trialPolicy(p);
  for (const change of [{ chainId: 4663 }, { earnedMarginUsdMicros: "1" }, { cashUsdMicros: "1" },
    { trial: { ...p.trial!, ceilingUsdMicros: "10001" } }, { trial: { ...p.trial!, wallets: [] } },
    { validUntil: Date.now() + 32 * 86400_000 }]) {
    assert.throws(() => validateBudgetPolicy({ ...p, ...change }), /essai/);
  }
  const env = { EVM_NETWORK: "testnet", SIRIUS_BILLING_VERSION: "7", SIRIUS_APP_ORIGIN: "https://sirius-evm-staging.vercel.app", SIRIUS_ESCROW_ADDRESS: p.trial!.escrow };
  assert.doesNotThrow(() => assertTrialDeployment(p, env));
  for (const change of [{ EVM_NETWORK: "mainnet" }, { SIRIUS_APP_ORIGIN: "https://sirius-data.tech" },
    { SIRIUS_ESCROW_ADDRESS: `0x${"78".repeat(20)}` }]) assert.throws(() => assertTrialDeployment(p, { ...env, ...change }));
  assert.doesNotThrow(() => assertTrialSubject(p.trial!.wallets[0], p));
  assert.throws(() => assertTrialSubject(`0x${"78".repeat(20)}`, p), /wallets autorisés/);
});

test("ni liquidités seules, ni dépôts ou crédits futurs ne permettent d’admettre une dépense", () => {
  const { ledger } = fixture((p) => { p.earnedMarginUsdMicros = "0"; p.cashUsdMicros = "1000000000"; });
  assert.throws(() => ledger.reserve("job", "scope", "training"), /Budget runner insuffisant/);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(0));
});

test("un financement sponsorisé explicite reste plafonné et lié à sa démonstration Phala", () => {
  const { ledger, open, policy: p } = fixture((p) => {
    p.earnedMarginUsdMicros = p.cashUsdMicros = "0";
    p.sponsored = { funding: "mixed", creditsUsdMicros: "100", cashUsdMicros: "100", ceilingUsdMicros: "200",
      maxOperations: 10, maxOperationsPerWallet: 2, maxConcurrent: 1,
      origin: "https://confidential.example.com", observedAtMs: Date.now() };
  });
  const env = { SIRIUS_PHALA_DEMO: "true", EVM_NETWORK: "testnet", TEE_MODE: "phala", SIRIUS_APP_ORIGIN: p.sponsored!.origin };
  assert.doesNotThrow(() => assertTrialDeployment(p, env));
  for (const changed of [{ EVM_NETWORK: "mainnet" }, { TEE_MODE: "stub" }, { SIRIUS_PHALA_DEMO: "false" },
    { SIRIUS_APP_ORIGIN: "https://another.example.com" }, { DSTACK_SIMULATOR_ENDPOINT: "http://localhost" }]) {
    assert.throws(() => assertTrialDeployment(p, { ...env, ...changed }));
  }
  ledger.reserve("sponsored", "scope", "training");
  ledger.finish("sponsored", "scope", true, "{}");
  assert.equal(open().diagnostics().remainingUsd, BigInt(0));
  assert.throws(() => open().reserve("another", "scope", "request"), /insuffisant/);
  assert.throws(() => validateBudgetPolicy({ ...p, chainId: 4663 }), /sponsorisé/);
  assert.throws(() => validateBudgetPolicy({ ...p, sponsored: { ...p.sponsored, ceilingUsdMicros: "201" } }), /insuffisant/);
});

test("la réserve de frais fixes et les liquidités limitent toutes les identités clientes ensemble", () => {
  const { ledger } = fixture((p) => { p.cashUsdMicros = "250"; });
  ledger.reserve("wallet-a-job", "a", "training");
  assert.throws(() => ledger.reserve("wallet-b-job", "b", "training"), /Budget runner insuffisant/);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(100));
});

test("une réservation survit à une nouvelle connexion et ne peut changer de paramètres", () => {
  const { ledger, open } = fixture();
  assert.equal(ledger.reserve("job", "scope", "training").fresh, true);
  const restarted = open();
  assert.equal(restarted.reserve("job", "scope", "training").fresh, false);
  assert.throws(() => restarted.reserve("job", "other", "training"), /autres paramètres/);
  assert.equal(restarted.snapshot().allocatedUsd, BigInt(100));
});

test("succès et échec ne recréditent pas automatiquement le coût maximal réservé", () => {
  const { ledger } = fixture();
  ledger.reserve("a", "a", "training");
  ledger.reserve("b", "b", "training");
  ledger.finish("a", "a", true, "{}");
  ledger.finish("b", "b", false);
  ledger.finish("b", "b", false);
  assert.deepEqual(ledger.snapshot(), { allocatedUsd: BigInt(200), allocatedWei: BigInt(0), failures: 1 });
});

test("les échecs ouvrent un coupe-circuit durable, même après un succès", () => {
  const { ledger, open } = fixture((p) => { p.maxFailures = 1; });
  ledger.reserve("good", "good", "training");
  ledger.reserve("bad", "bad", "training");
  ledger.finish("bad", "bad", false);
  ledger.finish("good", "good", true);
  assert.throws(() => open().reserve("new", "new", "request"), /Coupe-circuit/);
});

test("une politique périmée bloque les nouveaux coûts et conserve les opérations existantes", () => {
  const { ledger } = fixture((p) => { p.validUntil = Date.now() - 1; });
  assert.throws(() => ledger.reserve("job", "scope", "training"), /périmée/);
});

test("un registre absent, corrompu, remplacé ou lié à une autre identité ne devient pas vide", () => {
  const { ledger, path } = fixture();
  assert.throws(() => initializeBudgetLedger(path, policy()), /EEXIST/);
  assert.throws(() => new BudgetLedger(path, 4663, wallet), /autre réseau/);
  assert.throws(() => new BudgetLedger(`${path}.missing`, 46630, wallet), /ENOENT/);
  renameSync(path, `${path}.old`);
  writeFileSync(path, "invalid", { mode: 0o600 });
  assert.throws(() => ledger.reserve("a", "a", "request"), /remplacé/);
  assert.throws(() => new BudgetLedger(path, 46630, wallet));
});

test("les registres accessibles aux autres utilisateurs et les budgets mal formés sont refusés", () => {
  const { path } = fixture();
  chmodSync(path, 0o644);
  assert.throws(() => new BudgetLedger(path, 46630, wallet), /privé/);
  for (const invalid of ["-1", "1.2", "1e6", 100, "", "01"]) {
    assert.throws(() => validateBudgetPolicy({ ...policy(), earnedMarginUsdMicros: invalid }), /invalide/);
  }
});

test("les compteurs en unités entières restent exacts au-delà de Number.MAX_SAFE_INTEGER", () => {
  const amount = "900719925474099300";
  const { ledger } = fixture((p) => {
    p.earnedMarginUsdMicros = p.cashUsdMicros = amount;
    p.fixedReserveUsdMicros = "0";
    p.costsUsdMicros.training = amount;
  });
  ledger.reserve("a", "a", "training");
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(amount));
  assert.throws(() => ledger.reserve("b", "b", "request"), /insuffisant/);
});

test("deux processus ne peuvent réserver simultanément la dernière marge disponible", async () => {
  const { path, ledger } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "200"; });
  const script = `import { createRequire } from 'node:module';
    const { BudgetLedger } = createRequire(import.meta.url)(${JSON.stringify(resolve("src/lib/runner/budget-ledger.ts"))});
    const ledger = new BudgetLedger(process.argv[1], 46630, ${JSON.stringify(wallet)});
    try { ledger.reserve(process.argv[2], process.argv[2], 'training'); process.stdout.write('admitted'); }
    catch { process.stdout.write('blocked'); } finally { ledger.close(); }`;
  const run = promisify(execFile);
  const results = await Promise.all(["first", "second"].map((id) => run(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, path, id])));
  assert.deepEqual(results.map((r) => r.stdout).sort(), ["admitted", "blocked"]);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(100));
});

test("un job terminé restitue le même résultat sans calcul ou upload supplémentaire", async () => {
  const { ledger, open } = fixture();
  let calls = 0;
  const action = async () => { calls++; return { modelCid: "bafy-model", metrics: { mse: 1 } }; };
  const first = await runBudgetedOperation(ledger, "training", "job", "scope", action);
  const second = await runBudgetedOperation(open(), "training", "job", "scope", action);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("une reprise concurrente, interrompue ou échouée ne redémarre pas le calcul", async () => {
  const { ledger, open } = fixture();
  ledger.reserve("crash", "scope", "training");
  const unexpected = async () => { assert.fail("compute relancé"); };
  await assert.rejects(runBudgetedOperation(open(), "training", "crash", "scope", unexpected), /réconciliation/);
  await assert.rejects(runBudgetedOperation(ledger, "training", "failed", "scope", async () => { throw new Error("CPU timeout"); }), /CPU timeout/);
  await assert.rejects(runBudgetedOperation(open(), "training", "failed", "scope", unexpected), /réconciliation/);
});

test("la limite globale de concurrence persiste après interruption", () => {
  const { ledger, open } = fixture((p) => { p.maxActive = 1; });
  ledger.reserve("crash", "crash", "training");
  assert.throws(() => open().reserve("new", "new", "request"), /réconciliation/);
});

test("le fingerprint est indépendant de l’ordre des champs et lié au contenu", () => {
  assert.equal(budgetFingerprint({ a: 1, b: { c: 2, d: 3 } }), budgetFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(budgetFingerprint({ a: 1 }), budgetFingerprint({ a: 2 }));
});

test("l’absence de registre ne peut activer Phala, la production ou le mainnet", () => {
  delete process.env.RUNNER_BUDGET_FILE;
  Object.assign(process.env, { NODE_ENV: "test", TEE_MODE: "stub", EVM_NETWORK: "testnet" });
  assert.equal(runnerBudget(), null);
  for (const [key, value] of [["NODE_ENV", "production"], ["TEE_MODE", "phala"], ["EVM_NETWORK", "mainnet"]]) {
    const previous = process.env[key];
    process.env[key] = value;
    assert.throws(runnerBudget, /RUNNER_BUDGET_FILE obligatoire/);
    process.env[key] = previous;
  }
});

test("le handler et le calcul en processus refusent les opérations de production sans registre", async () => {
  delete process.env.RUNNER_BUDGET_FILE;
  Object.assign(process.env, { NODE_ENV: "production", TEE_MODE: "stub", EVM_NETWORK: "testnet" });
  const { handleRunnerOp } = await import("@/runner/handler");
  const { runTraining } = await import("@/lib/tee/core");
  await assert.rejects(handleRunnerOp("dataset-ingress-key", {}), /RUNNER_BUDGET_FILE obligatoire/);
  await assert.rejects(runTraining({
    datasetId: "test", cid: "bafy-test", wrappedKey: "unused", merkleRoot: "unused",
    priceUsdcAtomic: "1000", challengeDays: 1, modelId: "linear_regression", modelVersion: "1.0.0",
    keyContext: "synthetic", filename: "test.enc",
  }), /RUNNER_BUDGET_FILE obligatoire/);
});

const serialized: Hex = "0x02010203";
const txHash = keccak256(serialized);
function io(overrides: Partial<BudgetedTransactionIO> = {}): BudgetedTransactionIO {
  return {
    prepare: async () => ({ serialized, nonce: 7 }),
    send: async () => txHash,
    confirm: async () => "success",
    ...overrides,
  };
}

test("hash et nonce sont persistés avant envoi ; une reprise confirme sans signer ni renvoyer", async () => {
  const { ledger, open } = fixture();
  let sent = 0;
  await assert.rejects(sendBudgetedTransaction(ledger, "loan", "scope", io({
    send: async () => {
      const pending = open().find("loan", "scope");
      assert.equal(pending?.txHash, txHash);
      assert.equal(pending?.nonce, 7);
      sent++;
      throw new Error("RPC response lost");
    },
    confirm: async () => "pending",
  })), /finalité/);
  assert.throws(() => open().reserve("other-loan", "other", "transaction"), /wallet runner encore incertaine/);
  const recovered = await sendBudgetedTransaction(open(), "loan", "scope", io({
    prepare: async () => { assert.fail("nouveau nonce"); },
    send: async () => { assert.fail("second envoi"); },
  }));
  assert.equal(recovered, txHash);
  assert.equal(sent, 1);
  assert.equal(ledger.snapshot().allocatedWei, BigInt(policy().gas.maxTransactionWei));
});

test("un crash avant persistance du hash interdit également de prendre un nouveau nonce", async () => {
  const { ledger, open } = fixture();
  ledger.reserve("loan", "scope", "transaction");
  await assert.rejects(sendBudgetedTransaction(open(), "loan", "scope", io({ prepare: async () => { assert.fail("signature après crash"); } })), /interrompue/);
  assert.throws(() => ledger.reserve("other", "other", "transaction"), /incertaine/);
});

test("une préparation refusée rend sa réservation et se relance ; un revert n’est pas relancé", async () => {
  const { ledger } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "2000"; });
  await assert.rejects(sendBudgetedTransaction(ledger, "a", "a", io({ prepare: async () => { throw new Error("gas cap"); } })), /avant signature/);
  assert.equal(ledger.find("a", "a"), null, "rien n’a été signé : aucune trace ne bloque la reprise");
  assert.deepEqual(ledger.snapshot(), { allocatedUsd: BigInt(0), allocatedWei: BigInt(0), failures: 0 });
  assert.equal(await sendBudgetedTransaction(ledger, "a", "a", io()), txHash);
  await assert.rejects(sendBudgetedTransaction(ledger, "b", "b", io({ confirm: async () => "reverted" })), /aucune relance/);
  await assert.rejects(sendBudgetedTransaction(ledger, "b", "b", io()), /épuisée/);
  assert.equal(ledger.snapshot().failures, 1, "seul le revert, signé et payé, compte comme échec");
});

test("un timeout estimateGas puis une reprise règlent le prêt sans épuiser le devis", async () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  const timeout = io({ prepare: async () => { throw new Error("estimateGas timeout"); } });
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(withWorkflowBudget(workflow, () => runBudgetedOperation(open(), "request", `settle-${attempt}`, "request-v1",
      () => sendBudgetedTransaction(open(), "release", "release", timeout, workflow))), /avant signature/);
  }
  const resumed = await withWorkflowBudget(workflow, () => runBudgetedOperation(open(), "request", "settle-ok", "request-v1",
    () => sendBudgetedTransaction(open(), "release", "release", io(), workflow)));
  assert.equal(resumed, txHash);
  assert.equal(ledger.snapshot().failures, 0);
  assert.equal(ledger.find("release", "release")?.state, "succeeded");
  ledger.reserve("failure", "failure", "transaction", workflow);
  ledger.finish("failure", "failure", true);
  assert.throws(() => ledger.reserve("third", "third", "transaction", workflow), /épuisé/, "les deux transactions du devis restent les seules");
});

test("deux CSV invalides et vingt grants forgés laissent le coupe-circuit fermé", async () => {
  const { ledger, open } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "5000"; p.maxActive = 32; });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(runBudgetedOperation(ledger, "training", `csv-${i}`, "csv",
      async () => { throw new AppError("Dataset inexploitable pour ce modèle", 422); }), /inexploitable/);
  }
  for (let i = 0; i < 20; i++) {
    await assert.rejects(runBudgetedOperation(ledger, "request", `grant-${i}`, "request-v1",
      async () => { throw new AppError("Signature de grant invalide", 401); }), /grant/);
  }
  assert.equal(open().snapshot().failures, 0);
  assert.equal(ledger.find("csv-0", "csv")?.state, "failed", "l’opération reste close et son coût consommé");
  assert.doesNotThrow(() => open().reserve("next", "next", "request"));
  await assert.rejects(runBudgetedOperation(ledger, "request", "rpc", "request-v1", async () => { throw new Error("RPC down"); }));
  await assert.rejects(runBudgetedOperation(ledger, "request", "ipfs", "request-v1", async () => { throw new AppError("IPFS indisponible", 503); }));
  assert.equal(ledger.snapshot().failures, 2, "une panne côté runner compte toujours");
});

test("le classement des échecs distingue l’appelant, le runner et l’attente", () => {
  assert.equal(countsAsRunnerFailure(new AppError("x", 400)), false);
  assert.equal(countsAsRunnerFailure(new AppError("x", 409)), false);
  assert.equal(countsAsRunnerFailure(new AppError("x", 422)), false);
  assert.equal(countsAsRunnerFailure(new AppError("x", 503)), true);
  assert.equal(countsAsRunnerFailure(new Error("x")), true);
  assert.equal(countsAsRunnerFailure(new RunnerRetryLater("x")), false);
  assert.equal(countsAsRunnerFailure(new RunnerFinalityPending(txHash)), false);
});

test("réarmer le coupe-circuit et rouvrir une transaction sont journalisés et bornés", async () => {
  const { ledger, open } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "2000"; p.maxFailures = 1; });
  await assert.rejects(sendBudgetedTransaction(ledger, "b", "b", io({ confirm: async () => "reverted" })), /aucune relance/);
  assert.throws(() => open().reserve("new", "new", "request"), /Coupe-circuit/);
  assert.throws(() => ledger.resetFailures("", "motif"), /obligatoires/);
  assert.throws(() => ledger.resetFailures("ali", " "), /obligatoires/);
  assert.equal(ledger.resetFailures("ali", "revert diagnostiqué, escrow sain"), 1);
  assert.doesNotThrow(() => open().reserve("new", "new", "request"));
  assert.throws(() => ledger.reopenTransaction("new", "new", "ali", "motif"), /close en échec/);
  ledger.reopenTransaction("b", "b", "ali", "prêt toujours verrouillé on-chain");
  assert.equal(ledger.find("b", "b"), null);
  assert.equal(await sendBudgetedTransaction(open(), "b", "b", io()), txHash);
  assert.deepEqual(open().operatorActions().map(({ action, operationId, actor }) => ({ action, operationId, actor })), [
    { action: "reset-failures", operationId: null, actor: "ali" },
    { action: "reopen", operationId: "b", actor: "ali" },
  ]);
});

test("une transaction rouverte d’un devis récupère son crédit sans dépasser deux envois", async () => {
  const { ledger, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  await assert.rejects(sendBudgetedTransaction(ledger, "release", "release", io({ confirm: async () => "reverted" }), workflow), /aucune relance/);
  ledger.reserve("failure", "failure", "transaction", workflow);
  ledger.finish("failure", "failure", true);
  assert.throws(() => ledger.reserve("third", "third", "transaction", workflow), /épuisé/);
  ledger.reopenTransaction("release", "release", "ali", "revert dû à un gas trop bas");
  assert.equal(await sendBudgetedTransaction(ledger, "release", "release", io(), workflow), txHash);
  assert.throws(() => ledger.reserve("third", "third", "transaction", workflow), /épuisé/);
});

test("le CLI réarme le coupe-circuit seulement avec auteur et motif", () => {
  assert.throws(() => parseBudgetCommand(["reset-failures", "l.sqlite", "p.json"]), /Usage/);
  assert.throws(() => parseBudgetCommand(["reset-failures", "l.sqlite", "p.json", "--actor=ali"]), /Usage/);
  assert.throws(() => parseBudgetCommand(["inspect", "l.sqlite", "p.json", "--actor=ali"]), /Usage/);
  assert.throws(() => parseBudgetCommand(["reopen", "l.sqlite", "p.json", "--actor=ali", "--reason=x"]), /Usage/);
  assert.throws(() => parseBudgetCommand(["reset-failures", "l.sqlite", "p.json", "--force", "--actor=ali", "--reason=x"]), /Usage/);
  assert.deepEqual(parseBudgetCommand(["reopen", "l.sqlite", "p.json", "release:1", "--actor=ali", "--reason=prêt verrouillé"]),
    { command: "reopen", ledgerPath: "l.sqlite", policyPath: "p.json", extra: ["release:1"], actor: "ali", reason: "prêt verrouillé" });
});

test("l’alerte ETH prévient avant que le compte de règlement ne puisse plus payer", () => {
  const gas = policy().gas;
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (line: string) => { lines.push(line); };
  try {
    assert.equal(lowGasBalanceAlert(gas, BigInt(gas.maxTransactionWei) * BigInt(5), wallet), null);
    assert.match(lowGasBalanceAlert(gas, BigInt(gas.maxTransactionWei) * BigInt(4), wallet) ?? "", /\[runner\]\[alerte-eth\]/);
  } finally { console.warn = warn; }
  assert.equal(lines.length, 1);
});

test("le plafond ETH cumulé reste consommé après confirmation", async () => {
  const { ledger } = fixture((p) => { p.gas.totalWei = p.gas.maxTransactionWei; });
  await sendBudgetedTransaction(ledger, "a", "a", io());
  await assert.rejects(sendBudgetedTransaction(ledger, "b", "b", io()), /insuffisant/);
});

test("une politique périmée pendant la préparation empêche l’envoi", async () => {
  const { ledger } = fixture();
  const originalNow = Date.now;
  try {
    await assert.rejects(sendBudgetedTransaction(ledger, "a", "a", io({
      prepare: async () => { Date.now = () => ledger.policy.validUntil + 1; return { serialized, nonce: 1 }; },
      send: async () => { assert.fail("envoi avec prix périmé"); },
    })), /périmée/);
    assert.equal(ledger.find("a", "a")?.state, "failed");
  } finally { Date.now = originalNow; }
});

test("une confirmation reste réconciliable après péremption de la politique", async () => {
  const { ledger, open } = fixture();
  await assert.rejects(sendBudgetedTransaction(ledger, "a", "a", io({ confirm: async () => "pending" })), /finalité/);
  const originalNow = Date.now;
  try {
    Date.now = () => ledger.policy.validUntil + 1;
    assert.equal(await sendBudgetedTransaction(open(), "a", "a", io()), txHash);
  } finally { Date.now = originalNow; }
});

test("un reçu canonique finalisé libère une transaction réservée après timeout", async () => {
  const { ledger, open } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "2000"; });
  const escrow = `0x${"34".repeat(20)}`;
  const loanKey = `0x${"56".repeat(32)}`;
  const id = `release:46630:${escrow}:${loanKey}`;
  const input = "0x1234" as Hex;
  const fingerprint = keccak256(input);
  const hash = `0x${"78".repeat(32)}` as Hex;
  const blockHash = `0x${"9a".repeat(32)}`;
  ledger.reserve(id, fingerprint, "transaction");
  ledger.recordTransaction(id, fingerprint, hash, 7);
  const client = {
    getChainId: async () => 46630,
    getTransactionReceipt: async () => ({ blockNumber: BigInt(10), blockHash, transactionHash: hash,
      from: wallet, to: escrow, status: "success" }),
    getTransaction: async () => ({ from: wallet, to: escrow, nonce: 7, input }),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: blockHash, number: blockNumber }),
    getBlockNumber: async () => BigInt(11),
  } as unknown as PublicClient;
  await reconcileRunnerTransactions(open(), client, 46630, wallet as `0x${string}`);
  assert.equal(ledger.find(id, fingerprint)?.state, "succeeded");
  ledger.reserve("next", "next", "transaction");
});

test("la rediffusion après crash conserve octets, nonce, frais et budget, avec trois envois au maximum", async () => {
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 17).toString("base64");
  const account = privateKeyToAccount(`0x${"17".repeat(32)}`);
  const { ledger, open } = fixture((p) => { p.wallet = account.address.toLowerCase(); });
  const escrow = `0x${"34".repeat(20)}` as Hex;
  const id = `release:46630:${escrow}:0x${"56".repeat(32)}`;
  const data = "0x1234" as Hex;
  const fingerprint = keccak256(data);
  const raw = await account.signTransaction({ chainId: 46630, type: "eip1559", to: escrow, data,
    nonce: 7, gas: BigInt(100), maxFeePerGas: BigInt(1000), maxPriorityFeePerGas: BigInt(0), value: BigInt(0) });
  ledger.reserve(id, fingerprint, "transaction");
  const ciphertext = sealRunnerTransaction(id, fingerprint, raw);
  assert.ok(!ciphertext.includes(raw.slice(2)));
  ledger.recordTransaction(id, fingerprint, keccak256(raw), 7, ciphertext);
  const restarted = open();
  const operation = restarted.find(id, fingerprint)!;
  assert.equal(await openRunnerTransaction(ciphertext, operation, restarted.policy), raw);
  await assert.rejects(openRunnerTransaction(ciphertext, { ...operation, nonce: 8 }, restarted.policy), /Journal/);
  const originalNow = Date.now;
  const snapshot = ledger.snapshot();
  const sent: Hex[] = [];
  const client = {
    getChainId: async () => 46630,
    getTransactionReceipt: async () => { throw new Error("introuvable"); },
  } as unknown as PublicClient;
  try {
    await reconcileRunnerTransactions(restarted, client, 46630, account.address, async (value) => { sent.push(value); return keccak256(value); });
    assert.equal(sent.length, 0);
    for (let attempt = 1; attempt <= 4; attempt++) {
      Date.now = () => operation.createdAt + attempt * 31000;
      await reconcileRunnerTransactions(restarted, client, 46630, account.address, async (value) => { sent.push(value); return keccak256(value); });
    }
    assert.deepEqual(sent, [raw, raw]);
    assert.deepEqual(ledger.snapshot(), snapshot);
    assert.equal(ledger.find(id, fingerprint)?.state, "reserved");
  } finally { Date.now = originalNow; }
});

test("un prêt complet attend la finalité sans échec compté ni crédit de requête consommé", async () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  let finalized = false;
  const settle = (attempt: number) => withWorkflowBudget(workflow, () => runBudgetedOperation(open(), "request", `settle-${attempt}`, "request-v1",
    () => sendBudgetedTransaction(open(), "release", "release", io({
      confirm: async () => finalized ? "success" : "pending",
      prepare: async () => { assert.equal(attempt, 0, "un seul nonce signé"); return { serialized, nonce: 7 }; },
    }), workflow)));
  for (let attempt = 0; attempt < 40; attempt++) {
    await assert.rejects(settle(attempt), (error: unknown) => error instanceof RunnerFinalityPending && error.transactionHash === txHash);
  }
  finalized = true;
  assert.equal(await settle(40), txHash);
  assert.equal(ledger.snapshot().failures, 0);
  // Seule la requête qui a conclu le règlement est consommée : il en reste quinze.
  for (let i = 0; i < 15; i++) {
    ledger.reserve(`request-${i}`, "scope", "request", workflow);
    ledger.finish(`request-${i}`, "scope", true);
  }
  assert.throws(() => ledger.reserve("request-16", "scope", "request", workflow), /épuisé/, "quarante attentes n’ont rien consommé");
});

test("un second règlement attend son tour sans échec pendant qu’une transaction finalise", async () => {
  const { ledger, open } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "5000"; p.gas.totalWei = "400000000000"; });
  await assert.rejects(sendBudgetedTransaction(ledger, "first", "first", io({ confirm: async () => "pending" })), /finalité/);
  const before = ledger.snapshot();
  for (let i = 0; i < 5; i++) {
    await assert.rejects(runBudgetedOperation(open(), "request", `second-${i}`, "request-v1",
      () => sendBudgetedTransaction(open(), "second", "second", io())), /encore incertaine/);
  }
  assert.deepEqual(ledger.snapshot(), before, "ni échec ni crédit consommé");
  assert.equal(await sendBudgetedTransaction(open(), "first", "first", io()), txHash);
  assert.equal(await sendBudgetedTransaction(open(), "second", "second", io()), txHash);
});

test("les refus de diffusion sont classés sans exposer le message RPC", () => {
  assert.equal(classifySendError(new Error("max fee per gas less than block base fee: maxFeePerGas: 1, baseFee: 2")), "fee-too-low");
  assert.equal(classifySendError(new Error("transaction underpriced")), "fee-too-low");
  assert.equal(classifySendError(new Error("nonce too low")), "nonce-consumed");
  assert.equal(classifySendError(new Error("already known")), "already-known");
  assert.equal(classifySendError(new Error("socket hang up")), "unknown");
});

async function underpricedFixture(latestNonce: number) {
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 17).toString("base64");
  const account = privateKeyToAccount(`0x${"17".repeat(32)}`);
  const { ledger, open } = fixture((p) => { p.wallet = account.address.toLowerCase(); });
  const escrow = `0x${"34".repeat(20)}` as Hex;
  const id = `release:46630:${escrow}:0x${"56".repeat(32)}`;
  const data = "0x1234" as Hex;
  const fingerprint = keccak256(data);
  const sign = (maxFeePerGas: bigint) => account.signTransaction({ chainId: 46630, type: "eip1559", to: escrow, data,
    nonce: 7, gas: BigInt(100), maxFeePerGas, maxPriorityFeePerGas: BigInt(0), value: BigInt(0) });
  const low = await sign(BigInt(1000));
  const high = await sign(BigInt(5000));
  const sent: Hex[] = [];
  const transactionIO = io({
    prepare: async () => ({ serialized: low, nonce: 7 }),
    seal: (raw) => sealRunnerTransaction(id, fingerprint, raw),
    send: async (raw) => {
      sent.push(raw);
      if (raw === low) throw new Error("max fee per gas less than block base fee");
      return keccak256(raw);
    },
    latestNonce: async () => latestNonce,
    resign: async (raw) => { assert.equal(raw, low); return high; },
    confirm: async () => "pending",
  });
  return { ledger, open, account, id, fingerprint, low, high, sent, transactionIO };
}

test("une transaction refusée pour frais trop bas est re-signée au même nonce", async () => {
  const { ledger, open, id, fingerprint, low, high, sent, transactionIO } = await underpricedFixture(7);
  await assert.rejects(sendBudgetedTransaction(ledger, id, fingerprint, transactionIO), (error: unknown) =>
    error instanceof RunnerFinalityPending && error.transactionHash === keccak256(high));
  assert.deepEqual(sent, [low, high]);
  const restarted = open();
  const operation = restarted.find(id, fingerprint)!;
  assert.equal(operation.txHash, keccak256(high));
  assert.equal(operation.nonce, 7);
  assert.equal(restarted.snapshot().failures, 0);
  assert.deepEqual(restarted.operatorActions().map(({ action, actor }) => ({ action, actor })), [{ action: "replace", actor: "runner-auto" }]);
  assert.equal(await sendBudgetedTransaction(restarted, id, fingerprint, io({ confirm: async () => "success" })), keccak256(high));
});

test("un nonce déjà consommé n’est jamais re-signé", async () => {
  const { ledger, id, fingerprint, low, sent, transactionIO } = await underpricedFixture(8);
  await assert.rejects(sendBudgetedTransaction(ledger, id, fingerprint, transactionIO), (error: unknown) =>
    error instanceof RunnerFinalityPending && error.transactionHash === keccak256(low));
  assert.deepEqual(sent, [low]);
  assert.equal(ledger.find(id, fingerprint)?.txHash, keccak256(low));
});

test("un remplacement qui change la cible ou les données est refusé", async () => {
  const { ledger, account, id, fingerprint, transactionIO } = await underpricedFixture(7);
  const other = await account.signTransaction({ chainId: 46630, type: "eip1559", to: `0x${"99".repeat(20)}`, data: "0x1234",
    nonce: 7, gas: BigInt(100), maxFeePerGas: BigInt(5000), maxPriorityFeePerGas: BigInt(0), value: BigInt(0) });
  await assert.rejects(sendBudgetedTransaction(ledger, id, fingerprint, { ...transactionIO, resign: async () => other }), /finalité/);
  assert.equal(ledger.operatorActions().length, 0);
});

test("la réconciliation re-signe une transaction rejetée lors de sa rediffusion", async () => {
  const { ledger, open, account, id, fingerprint, low, high } = await underpricedFixture(7);
  ledger.reserve(id, fingerprint, "transaction");
  ledger.recordTransaction(id, fingerprint, keccak256(low), 7, sealRunnerTransaction(id, fingerprint, low));
  const operation = ledger.find(id, fingerprint)!;
  const sent: Hex[] = [];
  const client = {
    getChainId: async () => 46630,
    getTransactionReceipt: async () => { throw new Error("introuvable"); },
    getTransactionCount: async () => 7,
  } as unknown as PublicClient;
  const originalNow = Date.now;
  try {
    Date.now = () => operation.createdAt + 31000;
    await reconcileRunnerTransactions(open(), client, 46630, account.address, async (raw) => {
      sent.push(raw);
      if (raw === low) throw new Error("max fee per gas less than block base fee");
      return keccak256(raw);
    }, async () => high);
  } finally { Date.now = originalNow; }
  assert.deepEqual(sent, [low, high]);
  assert.equal(open().find(id, fingerprint)?.txHash, keccak256(high));
});

test("abandon refusé tant que le nonce est libre ou qu’un reçu existe", async () => {
  const operation = { id: "release:x", fingerprint: "f", kind: "transaction" as const, state: "reserved" as const,
    result: null, txHash: `0x${"ab".repeat(32)}`, nonce: 7, createdAt: 0 };
  const client = (latest: number, receipt: unknown = null) => ({
    getTransactionReceipt: async () => { if (!receipt) throw new Error("introuvable"); return receipt; },
    getTransactionCount: async () => latest,
  }) as unknown as PublicClient;
  const wallet = `0x${"12".repeat(20)}` as Hex;
  await assert.rejects(assertAbandonable(client(7), wallet, operation), /Nonce encore libre/);
  await assert.rejects(assertAbandonable(client(9, { status: "success" }), wallet, operation), /reconcile/);
  await assert.doesNotReject(assertAbandonable(client(8), wallet, operation));
  await assert.doesNotReject(assertAbandonable(client(0), wallet, { ...operation, txHash: null, nonce: null }));
  await assert.rejects(assertAbandonable(client(8), wallet, { ...operation, state: "failed" }), /encore réservée/);
  assert.throws(() => parseTransactionsCommand(["abandon", "release:x"]), /Usage/);
  assert.equal(parseTransactionsCommand(["abandon", "release:x", "--actor=ali", "--reason=nonce consommé"]).command, "abandon");
  assert.throws(() => parseTransactionsCommand(["reconcile", "--actor=ali"]), /Usage/);
});

test("abandonner une transaction la clôt sans compter d’échec et libère le wallet", () => {
  const { ledger } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "5000"; });
  ledger.reserve("stuck", "stuck", "transaction");
  ledger.recordTransaction("stuck", "stuck", txHash, 7);
  assert.throws(() => ledger.abandonTransaction("stuck", "stuck", "ali", ""), /obligatoires/);
  ledger.abandonTransaction("stuck", "stuck", "ali", "nonce 7 consommé par une autre transaction");
  assert.equal(ledger.find("stuck", "stuck")?.state, "failed");
  assert.equal(ledger.snapshot().failures, 0);
  assert.doesNotThrow(() => ledger.reserve("next", "next", "transaction"));
});

test("résultat et consommation v7 restent récupérables après redémarrage sans clé dataset ni nouvelle exécution", () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  const context = JSON.stringify({ datasetCid: "bafy-dataset", merkleRoot: "abc", deliveryPublicKey: "public" });
  ledger.prepareWorkflowResult(workflow, context);
  assert.throws(() => ledger.prepareWorkflowResult(workflow, "autre"), /hors scope/);
  ledger.reserve("training", "input", "training", workflow);
  const result = JSON.stringify({ modelCid: "bafy-model", metrics: { n: 20 } });
  const evidence = JSON.stringify({ success: true, quoteHash: workflow.fingerprint });
  ledger.recordExecutionEvidence(workflow, evidence, result);
  assert.deepEqual({ ...open().workflowResult(workflow) }, { context, result });
  assert.equal(open().executionEvidence(workflow), evidence);
  assert.equal(open().find("training", "input")?.state, "succeeded");
  assert.equal(open().diagnostics().incompleteJobs, 0);
  assert.throws(() => ledger.recordExecutionEvidence(workflow, "{}", "{}"), /déjà fixée/);
});

async function crashAndRestore(checkpoint: boolean) {
  const account = privateKeyToAccount(`0x${"34".repeat(32)}`);
  const { ledger, path, policy: p } = fixture((p) => {
    p.wallet = account.address.toLowerCase();
    p.earnedMarginUsdMicros = p.cashUsdMicros = "10000";
    p.gas.totalWei = "1000000000000";
    p.validUntil = Date.now() + 300000;
  });
  ledger.close();
  ledgers.splice(ledgers.indexOf(ledger), 1);
  const script = `
    import { createRequire } from 'node:module';
    import { privateKeyToAccount } from 'viem/accounts';
    import { keccak256 } from 'viem';
    const require = createRequire(import.meta.url);
    const { BudgetLedger } = require(${JSON.stringify(resolve("src/lib/runner/budget-ledger.ts"))});
    const { sealRunnerTransaction } = require(${JSON.stringify(resolve("src/lib/runner/transaction-journal.ts"))});
    const account = privateKeyToAccount('0x' + '34'.repeat(32));
    const ledger = new BudgetLedger(process.argv[1], 46630, account.address.toLowerCase());
    const scope = ${JSON.stringify(workflow)};
    ledger.reserveWorkflow(scope, 'signed', ledger.policy.validUntil, BigInt(ledger.policy.gas.totalWei));
    ledger.prepareWorkflowResult(scope, 'public-delivery-context');
    ledger.reserve('training', 'input', 'training', scope);
    if (${checkpoint}) {
      ledger.recordExecutionEvidence(scope, JSON.stringify({ success: true, quoteHash: scope.fingerprint }), JSON.stringify({ modelCid: 'synthetic-model', metrics: { n: 20 } }));
      const target = '0x' + '56'.repeat(20);
      const id = 'release:46630:' + target + ':0x' + '78'.repeat(32);
      const data = '0x1234';
      const fingerprint = keccak256(data);
      const raw = await account.signTransaction({ type: 'eip1559', chainId: 46630, nonce: 7, to: target, data, gas: 50000n, maxFeePerGas: 1000000n, maxPriorityFeePerGas: 0n });
      ledger.reserve(id, fingerprint, 'transaction', scope);
      ledger.recordTransaction(id, fingerprint, keccak256(raw), 7, sealRunnerTransaction(id, fingerprint, raw));
    }
    process.send('ready');
    setInterval(() => {}, 1000);
  `;
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 21).toString("base64");
  process.env.TEE_MODE = "stub";
  const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", script, path],
    { env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<string | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) => resolveExit(signal));
  });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Checkpoint enfant absent")), 15000);
      child.once("message", (message) => {
        clearTimeout(timer);
        if (message === "ready") resolveReady();
        else reject(new Error("Checkpoint invalide"));
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Processus arrêté avant checkpoint")); });
    });
    child.kill("SIGKILL");
    assert.equal(await exited, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
  const source = new BudgetLedger(path, p.chainId, p.wallet);
  const destination = `${path}.restore`;
  try { source.backup(destination); } finally { source.close(); }
  rmSync(path);
  const restored = new BudgetLedger(destination, p.chainId, p.wallet);
  ledgers.push(restored);
  return { restored, path: destination, policy: p };
}

test("SIGKILL avant checkpoint puis restauration conserve le coût sans fabriquer de résultat ni relancer le calcul", async () => {
  const { restored } = await crashAndRestore(false);
  assert.equal(restored.executionEvidence(workflow), null);
  assert.equal(restored.workflowResult(workflow)?.result, null);
  assert.equal(restored.diagnostics().incompleteJobs, 1);
  assert.deepEqual(restored.snapshot(), { allocatedUsd: BigInt(1116), allocatedWei: BigInt("200000000000"), failures: 0 });
  await assert.rejects(withWorkflowBudget(workflow, () => runBudgetedOperation(restored, "training", "training", "input",
    async () => { assert.fail("Calcul répété après restauration"); })), /réconciliation/);
  assert.equal(restored.executionEvidence(workflow), null);
});

test("SIGKILL après checkpoint puis restauration conserve résultat, journal chiffré, nonce et limite de trois envois", async () => {
  const { restored, path, policy: p } = await crashAndRestore(true);
  assert.equal(restored.workflowPayload(workflow.id), "signed");
  assert.equal(restored.diagnostics().incompleteJobs, 0);
  const result = await withWorkflowBudget(workflow, () => runBudgetedOperation(restored, "training", "training", "input",
    async () => { assert.fail("Modèle recalculé après restauration"); }));
  assert.deepEqual(result, { modelCid: "synthetic-model", metrics: { n: 20 } });
  const operation = restored.pendingTransactions()[0];
  assert.equal(operation.nonce, 7);
  assert.equal(restored.diagnostics().pendingTransactions[0].attempts, 1);
  assert.equal(restored.claimTransactionRebroadcast(operation.id, operation.fingerprint), null);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31000;
    const first = restored.claimTransactionRebroadcast(operation.id, operation.fingerprint)!;
    assert.ok(first);
    const raw = await openRunnerTransaction(first, operation, p);
    assert.equal(keccak256(raw), operation.txHash);
    assert.ok(!readFileSync(path).includes(Buffer.from(raw.slice(2), "hex")));
    Date.now = () => realNow() + 62000;
    assert.equal(await openRunnerTransaction(restored.claimTransactionRebroadcast(operation.id, operation.fingerprint)!, operation, p), raw);
    Date.now = () => realNow() + 93000;
    assert.equal(restored.claimTransactionRebroadcast(operation.id, operation.fingerprint), null);
    assert.throws(() => restored.reserve("new-nonce", "new", "transaction"), /incertaine/);
    assert.deepEqual(restored.snapshot(), { allocatedUsd: BigInt(1116), allocatedWei: BigInt("200000000000"), failures: 0 });
    process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 22).toString("base64");
    await assert.rejects(openRunnerTransaction(first, operation, p), /Journal de transaction/);
  } finally { Date.now = realNow; }
});

test("le gas signé borne unités, prix, dépense et solde ETH", () => {
  const gas = policy().gas;
  assert.deepEqual(boundedGas(gas, BigInt(50000), BigInt(200000), BigInt(gas.maxTransactionWei)), {
    gas: BigInt(60000), maxFeePerGas: BigInt(400000),
  });
  for (const [units, price, balance] of [[100001, 1, 100000000000], [1, 1000001, 100000000000], [1, 1, 1], [0, 1, 100000000000]]) {
    assert.throws(() => boundedGas(gas, BigInt(units), BigInt(price), BigInt(balance)), /Plafond de gas/);
  }
  assert.throws(() => boundedGas({ ...gas, maxTransactionWei: "10" }, BigInt(100), BigInt(1), BigInt(1000)), /Plafond de gas/);
});

const workflow = { id: "loan:synthetic", fingerprint: "signed-quote" };
function workflowFixture() {
  return fixture((p) => {
    p.earnedMarginUsdMicros = p.cashUsdMicros = "10000";
    p.gas.totalWei = "1000000000000";
    p.maxFailures = 1;
  });
}

test("le devis réserve calcul, requêtes et deux transactions avant toute consommation", () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  const reserved = { allocatedUsd: BigInt(1116), allocatedWei: BigInt("200000000000"), failures: 0 };
  assert.deepEqual(ledger.snapshot(), reserved);
  const resumed = open();
  assert.equal(resumed.workflowPayload(workflow.id), "signed");
  resumed.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(0));
  resumed.reserve("training", "input", "training", workflow);
  resumed.finish("training", "input", true, "{}");
  for (const id of ["release", "failure"]) {
    resumed.reserve(id, id, "transaction", workflow);
    resumed.finish(id, id, true);
  }
  assert.deepEqual(ledger.snapshot(), reserved, "aucune double allocation ou marge recréée");
  assert.throws(() => resumed.reserve("third", "third", "transaction", workflow), /épuisé/);
  assert.throws(() => resumed.reserve("retry-training", "input", "training", workflow), /épuisé/);
});

test("un devis expiré jamais verrouillé restitue exactement son budget réservé", () => {
  const { ledger, open, policy: p } = workflowFixture();
  const payload = JSON.stringify({ quote: { expiresAt: Math.floor(Date.now() / 1000) - 1 } });
  ledger.reserveWorkflow(workflow, payload, p.validUntil, BigInt(p.gas.totalWei));
  assert.equal(open().expiredUnusedWorkflows(Date.now()).length, 1);
  assert.equal(open().releaseUnusedWorkflow(workflow), true);
  assert.deepEqual(ledger.snapshot(), { allocatedUsd: BigInt(0), allocatedWei: BigInt(0), failures: 0 });
  assert.equal(ledger.workflowPayload(workflow.id), null);
  ledger.reserveWorkflow(workflow, payload, p.validUntil, BigInt(p.gas.totalWei));
  ledger.reserve("used", "used", "request", workflow);
  ledger.finish("used", "used", true);
  assert.equal(open().releaseUnusedWorkflow(workflow), false);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(1116));
});

test("un devis non couvert jusqu’à clôture ne consomme aucune réservation partielle", () => {
  const { ledger, policy: p } = workflowFixture();
  assert.throws(() => ledger.reserveWorkflow(workflow, "signed", p.validUntil + 1, BigInt(p.gas.totalWei)), /trop courte/);
  assert.throws(() => ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.maxTransactionWei)), /Liquidités/);
  assert.equal(ledger.workflowPayload(workflow.id), null);
  assert.deepEqual(ledger.snapshot(), { allocatedUsd: BigInt(0), allocatedWei: BigInt(0), failures: 0 });
  const tight = fixture();
  assert.throws(() => tight.ledger.reserveWorkflow(workflow, "signed", tight.policy.validUntil, BigInt(tight.policy.gas.totalWei)), /insuffisant/);
  assert.equal(tight.ledger.snapshot().allocatedUsd, BigInt(0));
});

test("le coupe-circuit refuse les nouveaux devis et préserve les budgets déjà affectés", async () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  ledger.reserve("bad", "bad", "request");
  ledger.finish("bad", "bad", false);
  assert.throws(() => open().reserveWorkflow({ id: "new", fingerprint: "new" }, "new", p.validUntil, BigInt(p.gas.totalWei)), /Coupe-circuit/);
  for (let i = 0; i < 16; i++) {
    ledger.reserve(`request-${i}`, "scope", "request", workflow);
    ledger.finish(`request-${i}`, "scope", true);
  }
  assert.throws(() => ledger.reserve("request-17", "scope", "request", workflow), /épuisé/);
  assert.equal(await sendBudgetedTransaction(open(), "close", "close", io(), workflow), txHash);
});

test("une réservation ne peut pas être détournée vers un autre devis ou prolongée", () => {
  const { ledger, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  ledger.reserve("job", "input", "training", workflow);
  ledger.finish("job", "input", true, "{}");
  assert.throws(() => ledger.reserve("job", "input", "training", { ...workflow, fingerprint: "changed" }), /scope/);
  assert.throws(() => ledger.reserve("job", "input", "training"), /scope/);
  assert.throws(() => ledger.reserveWorkflow(workflow, "changed", p.validUntil, BigInt(p.gas.totalWei)), /scope/);
  const originalNow = Date.now;
  try {
    Date.now = () => p.validUntil + 1;
    assert.throws(() => ledger.reserve("late", "late", "request", workflow), /expiré/);
  } finally { Date.now = originalNow; }
});

test("la mesure et le premier reçu d’échec survivent à une reprise sans changer la signature", () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  assert.equal(ledger.executionEvidence(workflow), null);
  ledger.recordExecutionEvidence(workflow, "measured");
  assert.equal(open().executionEvidence(workflow), "measured");
  assert.throws(() => ledger.recordExecutionEvidence(workflow, "inflated"), /déjà fixée/);
  assert.equal(ledger.fixFailureReceipt(workflow, "first"), "first");
  assert.equal(open().fixFailureReceipt(workflow, "new-timestamp"), "first");
});

test("deux processus ne peuvent promettre la même dernière réserve de clôture", async () => {
  const { path, ledger, policy: p } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "1216"; });
  const script = `import { createRequire } from 'node:module';
    const { BudgetLedger } = createRequire(import.meta.url)(${JSON.stringify(resolve("src/lib/runner/budget-ledger.ts"))});
    const ledger = new BudgetLedger(process.argv[1], 46630, ${JSON.stringify(wallet)});
    try { ledger.reserveWorkflow({id:process.argv[2],fingerprint:process.argv[2]},process.argv[2],${p.validUntil},BigInt(${JSON.stringify(p.gas.totalWei)})); process.stdout.write('admitted'); }
    catch { process.stdout.write('blocked'); } finally { ledger.close(); }`;
  const run = promisify(execFile);
  const results = await Promise.all(["first", "second"].map((id) => run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, path, id])));
  assert.deepEqual(results.map((r) => r.stdout).sort(), ["admitted", "blocked"]);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(1116));
});

test("la sauvegarde capture le WAL sans réinitialiser les engagements et refuse tout écrasement", () => {
  const { ledger, path, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  ledger.reserve("running", "scope", "training", workflow);
  const destination = `${path}.backup`;
  ledger.backup(destination);
  assert.throws(() => ledger.backup(destination), /EEXIST/);
  const backup = new BudgetLedger(destination, p.chainId, p.wallet);
  ledgers.push(backup);
  assert.deepEqual(backup.snapshot(), ledger.snapshot());
  assert.equal(backup.find("running", "scope")?.state, "reserved");
  assert.equal(backup.diagnostics().incompleteJobs, 1);
  assert.equal(backup.workflowPayload(workflow.id), "signed");
});

test("le nettoyage hors service retire un ancien résultat de scellement sans effacer les engagements", () => {
  const { ledger, path, open } = fixture();
  const sentinel = "synthetic-old-wrapped-key-cache";
  ledger.reserve("old-seal", "scope", "seal");
  ledger.finish("old-seal", "scope", true, JSON.stringify({ wrappedKey: sentinel }));
  const before = ledger.snapshot();
  ledger.sanitizeKeyCache();
  assert.equal(open().find("old-seal", "scope")?.result, null);
  assert.deepEqual(ledger.snapshot(), before);
  assert.equal(readFileSync(path).includes(Buffer.from(sentinel)), false);
});


test("l’export comptable conserve les engagements sans doubler le coût des opérations du devis", () => {
  const { ledger, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "SECRET_SIGNED_QUOTE", p.validUntil, BigInt(p.gas.totalWei));
  ledger.prepareWorkflowResult(workflow, "SECRET_DELIVERY_CONTEXT");
  ledger.reserve("training", "input", "training", workflow);
  ledger.reserve("standalone", "request", "request");
  const before = ledger.snapshot();
  const uncertain = ledger.accountingExport();
  assert.equal(uncertain.workflows[0].checkpoint, "uncertain");
  assert.equal(uncertain.workflows[0].measurement, null);
  const startedAt = Date.now();
  ledger.recordExecutionEvidence(workflow, JSON.stringify({ version: 1, quoteHash: workflow.fingerprint, startedAt,
    elapsedMs: 25, success: true }), "SECRET_MODEL_RESULT");
  ledger.reserve("release", "data", "transaction", workflow);
  ledger.recordTransaction("release", "data", txHash, 7, "SECRET_ENCRYPTED_TRANSACTION");
  ledger.finish("release", "data", true);
  const exported = ledger.accountingExport();
  assert.equal(exported.version, 1);
  assert.equal(exported.totals.allocatedUsdMicros, String(before.allocatedUsd));
  const standalone = exported.operations.filter((op) => op.workflowId === null)
    .reduce((sum, op) => sum + BigInt(op.budgetUsdMicros), BigInt(0));
  const workflows = exported.workflows.reduce((sum, row) => sum + BigInt(row.budgetUsdMicros), BigInt(0));
  assert.equal(standalone + workflows, before.allocatedUsd);
  assert.equal(exported.workflows[0].checkpoint, "result-durable");
  assert.deepEqual(exported.workflows[0].measurement, { elapsedMs: 25, startedAtMs: startedAt, success: true });
  assert.equal(exported.operations.find((op) => op.id === "release")?.transactionHash, txHash);
  assert.ok(!JSON.stringify(exported).includes("SECRET_"));
  assert.deepEqual(ledger.snapshot(), before);
});

test("l’export distingue la consommation d’échec de son règlement encore incertain", () => {
  const { ledger, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  ledger.prepareWorkflowResult(workflow, "context");
  ledger.reserve("training", "input", "training", workflow);
  ledger.recordExecutionEvidence(workflow, JSON.stringify({ version: 1, quoteHash: workflow.fingerprint,
    startedAt: Date.now(), elapsedMs: 100, success: false }));
  ledger.fixFailureReceipt(workflow, JSON.stringify({ consumedCompute: "90071992547409930", evidenceHash: txHash,
    observedAt: 123, finalFailure: true }));
  ledger.reserve("failure", "data", "transaction", workflow);
  ledger.recordTransaction("failure", "data", txHash, 7);
  const exported = ledger.accountingExport();
  assert.equal(exported.workflows[0].checkpoint, "failure-measured");
  assert.equal(exported.workflows[0].failureClaim?.consumedComputeAtomic, "90071992547409930");
  assert.equal(exported.pendingTransactions[0].recovery, "journal-missing");
  assert.equal(exported.operations.find((op) => op.id === "failure")?.state, "reserved");
});

test("un ancien journal incomplet reste réservé sans rediffusion ni nonce supplémentaire", async () => {
  const { ledger, open } = fixture();
  const id = `release:46630:0x${"34".repeat(20)}:0x${"56".repeat(32)}`;
  ledger.reserve(id, "input", "transaction");
  ledger.recordTransaction(id, "input", txHash, 7);
  const before = ledger.snapshot();
  const client = { getChainId: async () => 46630,
    getTransactionReceipt: async () => { throw new Error("introuvable"); } } as unknown as PublicClient;
  await reconcileRunnerTransactions(open(), client, 46630, wallet as Hex, async () => { assert.fail("nouvelle transaction"); });
  assert.equal(ledger.diagnostics().pendingTransactions[0].recovery, "journal-missing");
  assert.equal(ledger.find(id, "input")?.state, "reserved");
  assert.throws(() => ledger.reserve("new", "new", "transaction"), /incertaine/);
  assert.deepEqual(ledger.snapshot(), before);
});

test("le CLI export produit le contrat JSON sans modifier les engagements", async () => {
  const { path, ledger, policy: p } = fixture();
  ledger.reserve("reserved", "scope", "training");
  const policyPath = `${path}.policy.json`;
  writeFileSync(policyPath, JSON.stringify(p), { mode: 0o600 });
  const before = ledger.snapshot();
  const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--import", "tsx",
    "scripts/runner-budget.ts", "export", path, policyPath]);
  const result = JSON.parse(stdout);
  assert.equal(result.version, 1);
  assert.equal(result.totals.allocatedUsdMicros, "100");
  assert.equal(result.operations[0].id, "reserved");
  assert.deepEqual(ledger.snapshot(), before);
});

test("au redémarrage d’une démonstration, les opérations interrompues hors devis passent en échec sans compter", () => {
  const { ledger, open, policy: p } = fixture((policy) => {
    policy.earnedMarginUsdMicros = "0"; policy.cashUsdMicros = "0";
    policy.sponsored = { funding: "credits", creditsUsdMicros: "5000", cashUsdMicros: "0", ceilingUsdMicros: "4000",
      maxOperations: 6, maxOperationsPerWallet: 2, maxConcurrent: 1, origin: "https://demo.example", observedAtMs: Date.now() - 1000 };
  });
  ledger.reserve("training:crash", "input", "training");
  ledger.reserve("seal:crash", "input", "seal");
  ledger.reserve("training:done", "input", "training");
  ledger.finish("training:done", "input", true, "{}");
  assert.equal(ledger.diagnostics().incompleteJobs, 1);
  const before = ledger.snapshot();
  const restarted = open();
  assert.deepEqual(restarted.failInterruptedOperations("runner-startup", "redémarrage").sort(), ["seal:crash", "training:crash"]);
  assert.equal(restarted.diagnostics().incompleteJobs, 0);
  assert.deepEqual(restarted.snapshot(), before, "coût conservé, aucun échec compté");
  assert.deepEqual(restarted.failInterruptedOperations("runner-startup", "redémarrage"), []);
  assert.equal(restarted.operatorActions().filter(({ action }) => action === "interrupted").length, 1);
  void p;
});

test("la reprise après redémarrage est refusée hors démonstration sponsorisée", () => {
  const { ledger } = fixture();
  ledger.reserve("training:prod", "input", "training");
  assert.throws(() => ledger.failInterruptedOperations("runner-startup", "redémarrage"), /démonstration sponsorisée/);
  assert.equal(ledger.find("training:prod", "input")?.state, "reserved");
});
