import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeRunnerVolume, MAINNET_STABLECOIN, MAINNET_USDC, RUNNER_VOLUME_NETWORKS, runnerVolumeNetwork } from "./initialize-runner-volume";
import { BudgetLedger } from "../src/lib/runner/budget-ledger";
import { checkRunnerReplay } from "../src/lib/runner/replay";

/** Ancien USDC natif de Robinhood Chain mainnet, refusé depuis le passage à USDG. */
const LEGACY_USDC = "0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8";

function policies() {
  const validUntil = Date.now() + 86400000;
  const budget = { version: 1, chainId: 46630, wallet: `0x${"12".repeat(20)}`, accountingReference: "synthetic-test-only",
    validUntil, earnedMarginUsdMicros: "1000000", cashUsdMicros: "1000000", fixedReserveUsdMicros: "1000",
    costsUsdMicros: { request: "1", seal: "10", training: "100" }, maxFailures: 3, maxActive: 8,
    gas: { totalWei: "1000000", maxTransactionWei: "100000", maxGas: "1000", maxFeePerGasWei: "100", ethUsdMicrosUpperBound: "1000", confirmations: 1 } };
  const profile = { computeAmount: "1000", maxFailureFee: "100", executionRateAtomicPerMs: "1", maxExecutionMs: 1000 };
  const billing = { version: 1, chainId: 46630, usdc: `0x${"34".repeat(20)}`, usdcDecimals: 18,
    computeRecipient: `0x${"56".repeat(20)}`, tariffVersion: "synthetic-test-only", costReference: "synthetic-test-only",
    validUntil, minimumComputeAmount: "1000", profiles: { linear_regression: profile, logistic_regression: profile } };
  return { budget, billing };
}

test("l'initialisation explicite prépare deux registres privés, conserve les grants historiques et refuse de recommencer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget"));
  mkdirSync(join(root, "replay", "grant"), { recursive: true });
  const historical = join(root, "replay", "grant", "old");
  writeFileSync(historical, "reserved");
  const { budget, billing } = policies();
  initializeRunnerVolume(root, budget, billing);
  checkRunnerReplay(join(root, "replay"));
  const ledger = new BudgetLedger(join(root, "budget", "ledger.sqlite"), budget.chainId, budget.wallet);
  try { assert.equal(ledger.policy.accountingReference, "synthetic-test-only"); } finally { ledger.close(); }
  assert.equal(readFileSync(historical, "utf8"), "reserved");
  for (const path of ["budget", "replay", "budget/ledger.sqlite", "budget/budget-policy.json", "budget/billing-policy.json", "replay/replay.sqlite"]) {
    assert.equal(statSync(join(root, path)).mode & 0o077, 0);
  }
  assert.throws(() => initializeRunnerVolume(root, budget, billing), /déjà initialisé/);
});

test("une politique invalide ou non financée ne crée aucun fichier", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget")); mkdirSync(join(root, "replay"));
  const { budget, billing } = policies();
  for (const change of [{ chainId: 4663 }, { earnedMarginUsdMicros: "0" }, { cashUsdMicros: "0" },
    { validUntil: Date.now() - 1 }, { wallet: billing.computeRecipient }, { gas: { ...budget.gas, maxTransactionWei: "1" } }]) {
    assert.throws(() => initializeRunnerVolume(root, { ...budget, ...change }, billing));
  }
  for (const change of [{ usdcDecimals: 6 }, { chainId: 4663 }, { computeRecipient: `0x${"0".repeat(40)}` },
    { profiles: { ...billing.profiles, linear_regression: { ...billing.profiles.linear_regression, maxFailureFee: "1001" } } }]) {
    assert.throws(() => initializeRunnerVolume(root, budget, { ...billing, ...change }));
  }
  assert.deepEqual(readdirSync(join(root, "budget")), []);
  assert.deepEqual(readdirSync(join(root, "replay")), []);
});

test("la première installation accepte les crédits Phala sans les transformer en marge", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-trial-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget")); mkdirSync(join(root, "replay"));
  const { budget, billing } = policies();
  const trial = { ...budget, earnedMarginUsdMicros: "0", cashUsdMicros: "0", trial: {
    provider: "phala", creditsUsdMicros: "2000000", ceilingUsdMicros: "1000000", observedAtMs: Date.now(),
    escrow: `0x${"78".repeat(20)}`, wallets: [`0x${"9a".repeat(20)}`],
  } };
  initializeRunnerVolume(root, trial, billing);
  const ledger = new BudgetLedger(join(root, "budget", "ledger.sqlite"), budget.chainId, budget.wallet);
  try {
    assert.equal(ledger.policy.earnedMarginUsdMicros, "0");
    assert.equal(ledger.policy.cashUsdMicros, "0");
    assert.equal(ledger.diagnostics().remainingUsd, BigInt("999000"));
  } finally { ledger.close(); }
});

test("un volume partiel ou un journal orphelin n'est jamais réinitialisé", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-partial-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget")); mkdirSync(join(root, "replay"));
  writeFileSync(join(root, "budget", "ledger.sqlite-wal"), "historical");
  const { budget, billing } = policies();
  assert.throws(() => initializeRunnerVolume(root, budget, billing), /incomplet/);
  assert.equal(readFileSync(join(root, "budget", "ledger.sqlite-wal"), "utf8"), "historical");
  assert.deepEqual(readdirSync(join(root, "replay")), []);
});

test("la commande vérifie les comptes de la cible avant d'initialiser les volumes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget")); mkdirSync(join(root, "replay"));
  const { budget, billing } = policies();
  const env = { PATH: process.env.PATH, NODE_ENV: "production" as const, RUNNER_VOLUME_ACTION: "initialize-new-v7-volume", EVM_NETWORK: "testnet",
    SIRIUS_LOCK_AUTHORIZER: budget.wallet, SIRIUS_USDC_ADDRESS: billing.usdc, SIRIUS_COMPUTE_RECIPIENT: billing.computeRecipient,
    RUNNER_INITIAL_BUDGET_POLICY: JSON.stringify(budget), RUNNER_INITIAL_BILLING_POLICY: JSON.stringify(billing) };
  const args = ["--conditions=react-server", "--import", "tsx", "scripts/initialize-runner-volume.ts", root];
  const execute = promisify(execFile);
  await assert.rejects(execute(process.execPath, args, { env: { ...env, SIRIUS_LOCK_AUTHORIZER: billing.computeRecipient }, timeout: 10000 }), { code: 1 });
  await assert.rejects(execute(process.execPath, args, { env: { ...env, EVM_NETWORK: "" }, timeout: 10000 }), { code: 1 });
  await assert.rejects(execute(process.execPath, args, { env: { ...env, EVM_NETWORK: "mainnet" }, timeout: 10000 }), { code: 1 });
  assert.deepEqual(readdirSync(join(root, "budget")), []);
  assert.deepEqual(readdirSync(join(root, "replay")), []);
  const result = await execute(process.execPath, args, { env, timeout: 10000 });
  assert.match(result.stdout, /Volumes v7 initialisés/);
  checkRunnerReplay(join(root, "replay"));
});

function mainnetPolicies() {
  const { budget, billing } = policies();
  return {
    budget: { ...budget, chainId: 4663 },
    billing: { ...billing, chainId: 4663, usdc: MAINNET_STABLECOIN, usdcDecimals: 6 },
  };
}

test("le jeton mainnet du runner est l'USDG de Paxos, en minuscules, avec son alias historique", () => {
  assert.equal(MAINNET_STABLECOIN, "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  assert.equal(MAINNET_USDC, MAINNET_STABLECOIN);
});

test("la cible réseau vient de la configuration, jamais des politiques à valider", () => {
  assert.deepEqual(runnerVolumeNetwork("mainnet"), { network: "mainnet", chainId: 4663, usdcDecimals: 6 });
  assert.deepEqual(runnerVolumeNetwork("testnet"), { network: "testnet", chainId: 46630, usdcDecimals: 18 });
  for (const value of [undefined, "", "Mainnet", "4663"]) assert.throws(() => runnerVolumeNetwork(value), /EVM_NETWORK/);
});

test("un volume mainnet exige la chaîne 4663, l’USDG à six décimales et un financement réel", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sirius-volume-mainnet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget")); mkdirSync(join(root, "replay"));
  const { budget, billing } = mainnetPolicies();
  const mainnet = RUNNER_VOLUME_NETWORKS.mainnet;
  assert.throws(() => initializeRunnerVolume(root, budget, billing), "une politique mainnet ne passe pas sur la cible testnet");
  // L'ancien USDC natif ou un jeton quelconque : refusés par l'épinglage USDG ; l'USDG sous une
  // casse que la politique validée ne produit jamais : refusé par la validation. Le volume reste vide.
  for (const usdc of [LEGACY_USDC, `0x${"34".repeat(20)}`]) {
    assert.throws(() => initializeRunnerVolume(root, budget, { ...billing, usdc }, mainnet), /USDG/, usdc);
  }
  for (const change of [{ usdc: MAINNET_STABLECOIN.toUpperCase().replace("0X", "0x") }, { usdcDecimals: 18 }, { chainId: 46630 }]) {
    assert.throws(() => initializeRunnerVolume(root, budget, { ...billing, ...change }, mainnet), Error, JSON.stringify(change));
  }
  for (const change of [{ chainId: 46630 }, { earnedMarginUsdMicros: "0" }, { cashUsdMicros: "0" }]) {
    assert.throws(() => initializeRunnerVolume(root, { ...budget, ...change }, billing, mainnet), Error, JSON.stringify(change));
  }
  const testnet = policies();
  assert.throws(() => initializeRunnerVolume(root, testnet.budget, testnet.billing, mainnet), "une politique testnet ne passe pas sur mainnet");
  assert.deepEqual(readdirSync(join(root, "budget")), []);
  initializeRunnerVolume(root, budget, billing, mainnet);
  const ledger = new BudgetLedger(join(root, "budget", "ledger.sqlite"), 4663, budget.wallet);
  try { assert.equal(ledger.policy.chainId, 4663); } finally { ledger.close(); }
});
