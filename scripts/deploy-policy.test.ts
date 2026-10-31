import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentPlan, MAINNET_CHAIN_ID, MAINNET_STABLECOIN, MAINNET_USDC, TESTNET_CHAIN_ID } from "./deploy-policy";

const deployer = `0x${"d1".repeat(20)}`;
const safe = `0x${"5a".repeat(20)}`;
const verifier = `0x${"7e".repeat(20)}`;
const enclave = `0x${"3b".repeat(20)}`;
/** USDG (Paxos) sur Robinhood Chain mainnet, forme checksummée telle qu'un opérateur la colle. */
const USDG_CHECKSUMMED = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** Ancien USDC natif, refusé depuis le passage à USDG. */
const LEGACY_USDC = "0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8";

function mainnetEnv(change: Record<string, string | undefined> = {}) {
  return {
    SIRIUS_ALLOW_MAINNET: "true", SIRIUS_BILLING_VERSION: "7", SIRIUS_USDC_ADDRESS: USDG_CHECKSUMMED,
    SIRIUS_KYB_ADMIN: safe, SIRIUS_KYB_VERIFIER: verifier, SIRIUS_LOCK_AUTHORIZER: enclave, ...change,
  };
}

test("le jeton mainnet est l'USDG de Paxos, en minuscules, et l'alias historique le suit", () => {
  assert.equal(MAINNET_STABLECOIN, USDG_CHECKSUMMED.toLowerCase());
  assert.equal(MAINNET_USDC, MAINNET_STABLECOIN);
  assert.notEqual(MAINNET_STABLECOIN, LEGACY_USDC.toLowerCase());
});

test("un déploiement mainnet complet passe et exige que l’admin KYB soit un contrat", () => {
  const plan = deploymentPlan(mainnetEnv(), MAINNET_CHAIN_ID, deployer);
  assert.equal(plan.escrowContract, "SiriusEscrowV7");
  assert.equal(plan.kybOpen, false);
  assert.deepEqual(plan.mustBeContracts, [safe]);
  assert.equal(plan.dryRun, false);
  assert.equal(deploymentPlan(mainnetEnv({ SIRIUS_DEPLOY_DRY_RUN: "true" }), MAINNET_CHAIN_ID, deployer).dryRun, true);
});

test("mainnet refuse la v6 implicite ou explicite et l’absence d’autorisation", () => {
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_BILLING_VERSION: undefined }), MAINNET_CHAIN_ID, deployer), /BILLING_VERSION=7/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_BILLING_VERSION: "6" }), MAINNET_CHAIN_ID, deployer), /BILLING_VERSION=7/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_ALLOW_MAINNET: undefined }), MAINNET_CHAIN_ID, deployer), /bloqué/);
});

test("mainnet refuse les raccourcis de testnet", () => {
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_ALLOW_SHARED_ROLES: "true" }), MAINNET_CHAIN_ID, deployer), /interdit hors testnet/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_KYB_MODE: "open" }), MAINNET_CHAIN_ID, deployer), /réservé au testnet/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_USDC_ADDRESS: `0x${"34".repeat(20)}` }), MAINNET_CHAIN_ID, deployer), /USDG/);
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_KYB_ADMIN: undefined }), MAINNET_CHAIN_ID, deployer), /KYB_ADMIN/);
});

test("mainnet n'accepte que l'USDG, quelle que soit sa casse, et refuse l'ancien USDC natif", () => {
  for (const accepted of [USDG_CHECKSUMMED, USDG_CHECKSUMMED.toLowerCase(), USDG_CHECKSUMMED.toUpperCase().replace("0X", "0x"), ` ${USDG_CHECKSUMMED} `]) {
    assert.equal(deploymentPlan(mainnetEnv({ SIRIUS_USDC_ADDRESS: accepted }), MAINNET_CHAIN_ID, deployer).escrowContract, "SiriusEscrowV7", accepted);
  }
  // Jetons bien formés mais différents : refusés par l'épinglage USDG lui-même.
  for (const refused of [LEGACY_USDC, LEGACY_USDC.toLowerCase(), ` ${LEGACY_USDC} `, `0x${"34".repeat(20)}`]) {
    assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_USDC_ADDRESS: refused }), MAINNET_CHAIN_ID, deployer), /USDG/, String(refused));
  }
  // Valeurs mal formées : refusées avant l'épinglage, par la validation d'adresse.
  for (const refused of [`0x${"0".repeat(40)}`, "", "   ", undefined, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d16", "5fc5360d0400a0fd4f2af552add042d716f1d168", "0x5fc5360d 0400a0fd4f2af552add042d716f1d168"]) {
    assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_USDC_ADDRESS: refused }), MAINNET_CHAIN_ID, deployer), /non nulle/, String(refused));
  }
  // Le message désigne le jeton attendu sans jamais refléter la valeur refusée.
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_USDC_ADDRESS: LEGACY_USDC }), MAINNET_CHAIN_ID, deployer),
    (error: Error) => error.message.includes(MAINNET_STABLECOIN) && !error.message.toLowerCase().includes(LEGACY_USDC.toLowerCase()));
  assert.throws(() => deploymentPlan(mainnetEnv({ SIRIUS_LOCK_AUTHORIZER: `0x${"0".repeat(40)}` }), MAINNET_CHAIN_ID, deployer), /non nulle/);
});

test("mainnet exige quatre adresses distinctes, casse ignorée", () => {
  for (const change of [
    { SIRIUS_KYB_ADMIN: deployer }, { SIRIUS_KYB_VERIFIER: deployer }, { SIRIUS_LOCK_AUTHORIZER: deployer },
    { SIRIUS_KYB_VERIFIER: safe }, { SIRIUS_LOCK_AUTHORIZER: verifier.toUpperCase().replace("0X", "0x") },
  ]) {
    assert.throws(() => deploymentPlan(mainnetEnv(change), MAINNET_CHAIN_ID, deployer), /quatre adresses distinctes/, JSON.stringify(change));
  }
});

test("le testnet garde ses raccourcis assumés et n'impose aucun jeton", () => {
  const base = { SIRIUS_USDC_ADDRESS: `0x${"34".repeat(20)}`, SIRIUS_LOCK_AUTHORIZER: enclave };
  for (const token of [LEGACY_USDC, USDG_CHECKSUMMED, `0x${"34".repeat(20)}`]) {
    assert.equal(deploymentPlan({ ...base, SIRIUS_USDC_ADDRESS: token, SIRIUS_KYB_MODE: "open" }, TESTNET_CHAIN_ID, deployer).kybOpen, true, token);
  }
  assert.equal(deploymentPlan({ ...base, SIRIUS_KYB_MODE: "open" }, TESTNET_CHAIN_ID, deployer).kybOpen, true);
  assert.equal(deploymentPlan({ ...base, SIRIUS_ALLOW_SHARED_ROLES: "true" }, TESTNET_CHAIN_ID, deployer).sharedRoles, true);
  assert.equal(deploymentPlan({ ...base, SIRIUS_KYB_ADMIN: safe, SIRIUS_KYB_VERIFIER: verifier }, TESTNET_CHAIN_ID, deployer).escrowContract, "SiriusEscrow");
  assert.throws(() => deploymentPlan(base, TESTNET_CHAIN_ID, deployer), /requis/);
  assert.throws(() => deploymentPlan({ ...base, SIRIUS_KYB_ADMIN: safe, SIRIUS_KYB_VERIFIER: safe }, TESTNET_CHAIN_ID, deployer), /distinctes/);
  assert.throws(() => deploymentPlan(base, 1, deployer), /Réseau inattendu/);
});
