import { erc20Abi, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { checkRpcFinality, finalityPolicy } from "../src/lib/evm/finality";
import { fastFinalityConfig } from "../src/lib/evm/fast-finality";
import { siriusescrowv7Abi } from "../src/lib/evm/abi/siriusescrowv7";
import { siriusdatasetregistryAbi } from "../src/lib/evm/abi/siriusdatasetregistry";
import { siriuskybregistryAbi } from "../src/lib/evm/abi/siriuskybregistry";
import { MAINNET_STABLECOIN_ADDRESS } from "../src/lib/evm/stablecoin";

/**
 * USDG (Paxos) sur Robinhood Chain mainnet, 6 décimales, en minuscules pour les
 * comparaisons. C'est un proxy ERC-1967 : son code hash reste stable même si Paxos
 * remplace l'implémentation, voir src/lib/evm/stablecoin.ts.
 */
export const MAINNET_STABLECOIN = MAINNET_STABLECOIN_ADDRESS;
/** @deprecated Nom historique gardé par compatibilité (cahier des charges A8) : vaut l'USDG, pas l'USDC. Aucun importateur hors tests. */
export const MAINNET_USDC = MAINNET_STABLECOIN;

const NETWORKS = {
  testnet: { chainId: 46630, decimals: 18 },
  mainnet: { chainId: 4663, decimals: 6 },
} as const;
type Network = keyof typeof NETWORKS;

export function testnetV7Configuration(env: Record<string, string | undefined>) {
  return v7Configuration(env, "testnet");
}

/**
 * Mainnet : KYB strict (jamais ouvert), USDG de Paxos épinglé, et trésorerie et administration
 * KYB sur le même compte de gouvernance (le Safe), déclaré dans SIRIUS_KYB_ADMIN.
 */
export function mainnetV7Configuration(env: Record<string, string | undefined>) {
  return v7Configuration(env, "mainnet");
}

function v7Configuration(env: Record<string, string | undefined>, network: Network) {
  const kybOk = network === "testnet" ? env.SIRIUS_KYB_MODE === "open" : env.SIRIUS_KYB_MODE !== "open";
  if (env.EVM_NETWORK !== network || env.SIRIUS_BILLING_VERSION !== "7" || !kybOk
    || env.SIRIUS_EVM_FINALITY !== "finalized" || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(env.SIRIUS_EVM_CONFIRMATIONS ?? "")) {
    throw new Error(network === "testnet"
      ? "Testnet, v7, KYB ouvert et finalité explicite requis pour le lot B"
      : "Mainnet, v7, KYB strict et finalité explicite requis");
  }
  // Palier rapide facultatif : bornes lisibles ou refus, `finalized` restant la base ci-dessus.
  fastFinalityConfig(env, NETWORKS[network].decimals);
  const address = (name: string): Address => {
    const value = env[name]?.trim().toLowerCase();
    if (!value || !/^0x(?!0{40}$)[a-f0-9]{40}$/.test(value)) throw new Error(`Adresse requise : ${name}`);
    return value as Address;
  };
  const usdc = address("SIRIUS_USDC_ADDRESS");
  const deployer = address("SIRIUS_DEPLOYER_ADDRESS");
  const runner = address("SIRIUS_LOCK_AUTHORIZER");
  const computeRecipient = address("SIRIUS_COMPUTE_RECIPIENT");
  if (runner === deployer || runner === computeRecipient) throw new Error("Le compte Phala doit rester distinct de la trésorerie et du déployeur");
  const usdcCodeHash = env.SIRIUS_USDC_CODE_HASH;
  if (!usdcCodeHash || !/^0x[a-f0-9]{64}$/i.test(usdcCodeHash)) throw new Error("Empreinte du jeton de règlement requise : SIRIUS_USDC_CODE_HASH");
  const names = ["SIRIUS_ESCROW_ADDRESS", "SIRIUS_DATASET_ADDRESS", "SIRIUS_KYB_ADDRESS"];
  const configured = names.filter((name) => env[name]?.trim()).length;
  if (configured && configured !== names.length) throw new Error("Configuration partielle des nouveaux contrats");
  const contracts = configured ? { escrow: address(names[0]), datasets: address(names[1]), kyb: address(names[2]) } : null;
  if (contracts && (new Set([usdc, ...Object.values(contracts)]).size !== 4
    || Object.values(contracts).some((value) => [runner, deployer, computeRecipient].includes(value)))) {
    throw new Error("Adresses de contrats et comptes incompatibles");
  }
  let kybAdmin: Address | null = null;
  if (network === "mainnet") {
    if (usdc !== MAINNET_STABLECOIN) throw new Error(`Jeton mainnet attendu : USDG de Paxos ${MAINNET_STABLECOIN}, aucun autre jeton (USDC compris)`);
    kybAdmin = address("SIRIUS_KYB_ADMIN");
    if (kybAdmin !== computeRecipient) throw new Error("La trésorerie et l’administration KYB doivent être le même compte de gouvernance");
    if ([runner, deployer].includes(kybAdmin)) throw new Error("Le compte de gouvernance doit rester distinct du runner et du déployeur");
  }
  return { network, ...NETWORKS[network], usdc, usdcCodeHash: usdcCodeHash.toLowerCase() as Hex, deployer, runner, computeRecipient, kybAdmin, contracts };
}

export const checkTestnetV7 = checkV7;
export const checkMainnetV7 = checkV7;

export async function checkV7(client: PublicClient, config: ReturnType<typeof testnetV7Configuration>) {
  if (!finalityPolicy().finalized) throw new Error("Le préflight v7 exige finalized");
  const finality = await checkRpcFinality(client, config.chainId);
  const blockNumber = BigInt(finality.confirmedBlock);
  const [stable, tip, tokenCode, decimals, deployerWei, runnerWei, computeUsdc] = await Promise.all([
    client.getBlock({ blockNumber }), client.getBlock({ blockNumber: BigInt(finality.latestBlock) }),
    client.getBytecode({ address: config.usdc, blockNumber }),
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.getBalance({ address: config.deployer, blockNumber }), client.getBalance({ address: config.runner, blockNumber }),
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [config.computeRecipient], blockNumber }),
  ]);
  // Sur mainnet, `tokenCode` est celui du proxy ERC-1967 d'USDG : l'empreinte prouve qu'on
  // parle au même proxy, pas que la logique de Paxos est inchangée. Les décimales, elles,
  // sont lues à travers le proxy, donc sur l'implémentation courante.
  if (!tokenCode || keccak256(tokenCode) !== config.usdcCodeHash || decimals !== config.decimals) throw new Error("Code ou précision du jeton de règlement inattendu pour ce réseau");
  if (stable.hash !== finality.confirmedHash || tip.timestamp < stable.timestamp) throw new Error("Vue RPC incohérente pendant le préflight");
  const issues: string[] = [];
  if (deployerWei === BigInt(0)) issues.push("deployer.native_balance_zero");
  if (runnerWei === BigInt(0)) issues.push("runner.native_balance_zero");
  const contracts = config.contracts;
  if (!contracts) issues.push("contracts.not_configured");
  else {
    const code = await Promise.all(Object.values(contracts).map((address) => client.getBytecode({ address, blockNumber })));
    if (code.some((value) => !value || value === "0x")) throw new Error("Contrat absent du bloc finalisé");
    const escrowRead = { address: contracts.escrow, abi: siriusescrowv7Abi, blockNumber };
    const datasetRead = { address: contracts.datasets, abi: siriusdatasetregistryAbi, blockNumber };
    const [version, authorizer, token, kyb, datasets, datasetVersion, datasetKyb, linkedEscrow, openKyb] = await Promise.all([
      client.readContract({ ...escrowRead, functionName: "VERSION" }),
      client.readContract({ ...escrowRead, functionName: "lockAuthorizer" }),
      client.readContract({ ...escrowRead, functionName: "usdc" }),
      client.readContract({ ...escrowRead, functionName: "kyb" }),
      client.readContract({ ...escrowRead, functionName: "datasets" }),
      client.readContract({ ...datasetRead, functionName: "VERSION" }),
      client.readContract({ ...datasetRead, functionName: "kyb" }),
      client.readContract({ ...datasetRead, functionName: "escrow" }),
      client.readContract({ address: contracts.kyb, abi: siriuskybregistryAbi, functionName: "isKybValid",
        args: ["0x000000000000000000000000000000000000dEaD"], blockNumber }),
    ]);
    if (version !== "sirius-escrow-usdc-v7" || datasetVersion !== "sirius-dataset-v4"
      || authorizer.toLowerCase() !== config.runner || token.toLowerCase() !== config.usdc || kyb.toLowerCase() !== contracts.kyb
      || datasets.toLowerCase() !== contracts.datasets || datasetKyb.toLowerCase() !== contracts.kyb
      || linkedEscrow.toLowerCase() !== contracts.escrow || openKyb !== (config.network === "testnet")) {
      throw new Error("Versions, liaisons ou mode KYB des contrats incompatibles avec ce réseau");
    }
    if (config.kybAdmin) {
      const admin = await client.readContract({ address: contracts.kyb, abi: siriuskybregistryAbi, functionName: "admin", blockNumber });
      if (admin.toLowerCase() !== config.kybAdmin) throw new Error("Administration KYB hors du compte de gouvernance");
    }
  }
  const canonical = await client.getBlock({ blockNumber });
  if (canonical.hash !== stable.hash) throw new Error("Bloc finalisé modifié pendant le préflight");
  return {
    observedAt: new Date().toISOString(), readOnly: true, activationReady: false,
    chainChecksPassed: issues.length === 0, issues, finality,
    finalityLagSeconds: String(tip.timestamp - stable.timestamp),
    balances: { blockNumber: String(blockNumber), deployer: { address: config.deployer, wei: String(deployerWei) },
      runner: { address: config.runner, wei: String(runnerWei) },
      computeRecipient: { address: config.computeRecipient, usdcAtomic: String(computeUsdc) } },
    usdc: { address: config.usdc, decimals, codeHash: config.usdcCodeHash }, contracts,
    remainingProofs: ["gas_estimates_and_funded_limits", "approved_accounting_and_tariffs", "external_stop_supervisor",
      "restored_runner_volumes", "active_hardware_attestation", "application_migration_and_two_wallet_flow"],
  };
}
