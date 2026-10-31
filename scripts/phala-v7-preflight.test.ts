import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { keccak256, type PublicClient } from "viem";
import { checkMainnetV7, checkTestnetV7, MAINNET_STABLECOIN, MAINNET_USDC, mainnetV7Configuration, testnetV7Configuration } from "./phala-v7-preflight";

/** Ancien USDC natif de Robinhood Chain mainnet, refusé depuis le passage à USDG. */
const LEGACY_USDC = "0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8";

const saved = { ...process.env };
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

const address = (n: number) => `0x${String(n).repeat(40)}`;
const environment = () => ({ EVM_NETWORK: "testnet", SIRIUS_BILLING_VERSION: "7", SIRIUS_KYB_MODE: "open",
  SIRIUS_EVM_FINALITY: "finalized", SIRIUS_EVM_CONFIRMATIONS: "1", SIRIUS_USDC_ADDRESS: address(1),
  SIRIUS_DEPLOYER_ADDRESS: address(2), SIRIUS_LOCK_AUTHORIZER: address(3), SIRIUS_COMPUTE_RECIPIENT: address(2),
  SIRIUS_USDC_CODE_HASH: keccak256("0x1234"), SIRIUS_ESCROW_ADDRESS: address(4),
  SIRIUS_DATASET_ADDRESS: address(5), SIRIUS_KYB_ADDRESS: address(6) });

function fixture() {
  Object.assign(process.env, environment());
  const config = testnetV7Configuration(environment());
  const state = { chainId: 46630, runnerWei: BigInt(1), decimals: 18, code: "0x1234", version: "sirius-escrow-usdc-v7",
    authorizer: config.runner, datasetEscrow: config.contracts!.escrow, missingFinality: false, missingHistory: false, reorg: false, stableReads: 0 };
  const readBlocks: bigint[] = [];
  const stableHash = `0x${"12".repeat(32)}`;
  const client = {
    getChainId: async () => state.chainId,
    getBlockNumber: async () => BigInt(100),
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      if (blockTag === "finalized" && state.missingFinality) throw new Error("finalized absent");
      const number = blockNumber ?? BigInt(90);
      if (number === BigInt(90)) state.stableReads++;
      return { number, hash: state.reorg && state.stableReads >= 4 ? `0x${"34".repeat(32)}` : stableHash,
        timestamp: number * BigInt(2) };
    },
    getBytecode: async ({ blockNumber }: { blockNumber: bigint }) => { readBlocks.push(blockNumber); return state.code; },
    getBalance: async ({ address: account, blockNumber }: { address: string; blockNumber: bigint }) => {
      readBlocks.push(blockNumber); return account === config.runner ? state.runnerWei : BigInt(100);
    },
    readContract: async ({ address: contract, functionName, blockNumber }: { address: string; functionName: string; blockNumber: bigint }) => {
      if (state.missingHistory) throw new Error("historical state is not available");
      readBlocks.push(blockNumber);
      if (contract === config.usdc) return functionName === "decimals" ? state.decimals : BigInt(20);
      if (contract === config.contracts!.kyb) return true;
      if (contract === config.contracts!.datasets) return { VERSION: "sirius-dataset-v4", kyb: config.contracts!.kyb, escrow: state.datasetEscrow }[functionName];
      return { VERSION: state.version, lockAuthorizer: state.authorizer, usdc: config.usdc, kyb: config.contracts!.kyb, datasets: config.contracts!.datasets }[functionName];
    },
  } as unknown as PublicClient;
  return { client, config, state, readBlocks };
}

test("le préflight B lit un bloc finalisé cohérent sans confondre contrats valides et activation prête", async () => {
  const { client, config, readBlocks } = fixture();
  const result = await checkTestnetV7(client, config);
  assert.equal(result.chainChecksPassed, true);
  assert.equal(result.activationReady, false);
  assert.equal(result.finalityLagSeconds, "20");
  assert.equal(result.balances.computeRecipient.usdcAtomic, "20");
  assert.ok(readBlocks.length > 10);
  assert.ok(readBlocks.every((number) => number === BigInt(90)));
});

test("le préflight B refuse mainnet, configurations partielles et mélange des rôles", () => {
  for (const change of [{ EVM_NETWORK: "mainnet" }, { SIRIUS_BILLING_VERSION: "6" }, { SIRIUS_KYB_MODE: "strict" },
    { SIRIUS_EVM_FINALITY: "confirmations" }, { SIRIUS_EVM_CONFIRMATIONS: "" }, { SIRIUS_USDC_CODE_HASH: "" },
    { SIRIUS_ESCROW_ADDRESS: "" }, { SIRIUS_LOCK_AUTHORIZER: address(2) }, { SIRIUS_USDC_ADDRESS: address(4) }]) {
    assert.throws(() => testnetV7Configuration({ ...environment(), ...change }));
  }
});

test("le préflight B signale le faucet et les contrats manquants avant activation", async () => {
  const { client, state } = fixture();
  state.runnerWei = BigInt(0);
  const config = testnetV7Configuration({ ...environment(), SIRIUS_ESCROW_ADDRESS: "", SIRIUS_DATASET_ADDRESS: "", SIRIUS_KYB_ADDRESS: "" });
  const report = await checkTestnetV7(client, config);
  assert.equal(report.chainChecksPassed, false);
  assert.deepEqual(report.issues, ["runner.native_balance_zero", "contracts.not_configured"]);
});

test("un RPC du mauvais réseau est refusé avant toute lecture des comptes", async () => {
  const { client, config, state, readBlocks } = fixture();
  state.chainId = 4663;
  await assert.rejects(checkTestnetV7(client, config), /autre réseau/);
  assert.equal(readBlocks.length, 0);
});

test("un bloc finalized disponible sans son état historique ne valide pas le RPC", async () => {
  const { client, config, state } = fixture();
  state.missingHistory = true;
  await assert.rejects(checkTestnetV7(client, config), /historical state/);
});

test("le préflight B bloque un token divergent, un ancien escrow, un autre signataire ou une liaison erronée", async () => {
  for (const change of [{ decimals: 6 }, { code: "0x5678" }, { version: "sirius-escrow-usdc-v6" },
    { authorizer: address(8) }, { datasetEscrow: address(8) }, { missingFinality: true }, { reorg: true }]) {
    const { client, config, state } = fixture();
    Object.assign(state, change);
    await assert.rejects(checkTestnetV7(client, config));
  }
});

const mainnetEnvironment = () => ({ ...environment(), EVM_NETWORK: "mainnet", SIRIUS_KYB_MODE: "strict",
  SIRIUS_USDC_ADDRESS: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", SIRIUS_COMPUTE_RECIPIENT: address(7), SIRIUS_KYB_ADMIN: address(7) });

test("le jeton mainnet du préflight est l'USDG de Paxos, en minuscules, avec son alias historique", () => {
  assert.equal(MAINNET_STABLECOIN, "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  assert.equal(MAINNET_USDC, MAINNET_STABLECOIN);
});

test("le préflight mainnet exige KYB strict, l'USDG de Paxos et un compte de gouvernance unique", () => {
  const config = mainnetV7Configuration(mainnetEnvironment());
  assert.equal(config.chainId, 4663);
  assert.equal(config.decimals, 6);
  assert.equal(config.usdc, MAINNET_STABLECOIN, "l'adresse checksummée est normalisée en minuscules");
  assert.equal(config.kybAdmin, address(7));
  for (const change of [{ SIRIUS_KYB_MODE: "open" }, { EVM_NETWORK: "testnet" },
    { SIRIUS_KYB_ADMIN: "" }, { SIRIUS_KYB_ADMIN: address(8) }, { SIRIUS_KYB_ADMIN: address(2), SIRIUS_COMPUTE_RECIPIENT: address(2) }]) {
    assert.throws(() => mainnetV7Configuration({ ...mainnetEnvironment(), ...change }), JSON.stringify(change));
  }
  // Tout jeton bien formé autre que l'USDG est refusé par l'épinglage lui-même, pas par la forme de l'adresse.
  for (const token of [address(1), LEGACY_USDC, LEGACY_USDC.toLowerCase(), ` ${LEGACY_USDC} `]) {
    assert.throws(() => mainnetV7Configuration({ ...mainnetEnvironment(), SIRIUS_USDC_ADDRESS: token }), /USDG/, token);
  }
  assert.throws(() => testnetV7Configuration(mainnetEnvironment()));
  // Le testnet n'épingle aucun jeton : l'USDG comme l'ancien USDC y passent la configuration.
  for (const token of [LEGACY_USDC, MAINNET_STABLECOIN]) {
    assert.equal(testnetV7Configuration({ ...environment(), SIRIUS_USDC_ADDRESS: token }).decimals, 18, token);
  }
});

function mainnetFixture(overrides: { decimals?: number; openKyb?: boolean; admin?: string } = {}) {
  Object.assign(process.env, mainnetEnvironment());
  const config = mainnetV7Configuration(mainnetEnvironment());
  const stableHash = `0x${"12".repeat(32)}`;
  const client = {
    getChainId: async () => 4663,
    getBlockNumber: async () => BigInt(100),
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? BigInt(90), hash: stableHash, timestamp: (blockNumber ?? BigInt(90)) * BigInt(2) }),
    getBytecode: async () => "0x1234",
    getBalance: async () => BigInt(100),
    readContract: async ({ address: contract, functionName }: { address: string; functionName: string }) => {
      if (contract === config.usdc) return functionName === "decimals" ? (overrides.decimals ?? 6) : BigInt(0);
      if (contract === config.contracts!.kyb) return functionName === "admin" ? (overrides.admin ?? config.kybAdmin) : (overrides.openKyb ?? false);
      if (contract === config.contracts!.datasets) return { VERSION: "sirius-dataset-v4", kyb: config.contracts!.kyb, escrow: config.contracts!.escrow }[functionName];
      return { VERSION: "sirius-escrow-usdc-v7", lockAuthorizer: config.runner, usdc: config.usdc, kyb: config.contracts!.kyb, datasets: config.contracts!.datasets }[functionName];
    },
  } as unknown as PublicClient;
  return { client, config };
}

test("le préflight mainnet valide 6 décimales, un KYB fermé et l'admin attendu", async () => {
  const { client, config } = mainnetFixture();
  assert.equal((await checkMainnetV7(client, config)).chainChecksPassed, true);
});

test("le préflight mainnet refuse 18 décimales, un registre KYB ouvert ou un autre admin", async () => {
  for (const overrides of [{ decimals: 18 }, { openKyb: true }, { admin: address(9) }]) {
    const { client, config } = mainnetFixture(overrides);
    await assert.rejects(checkMainnetV7(client, config));
  }
});
