import "@nomicfoundation/hardhat-toolbox-viem";
import type { HardhatUserConfig } from "hardhat/config";

/**
 * Toolchain Solidity de Sirius, isolée sous `contracts/` pour ne pas polluer le
 * `tsc`, l'ESLint ni le build Next de l'application (cf. exclusion dans tsconfig.json).
 *
 * Cible : Robinhood Chain (Arbitrum Nitro). Valeurs vérifiées en direct le 14/08/2026 :
 *   testnet 46630 (0xb626) · mainnet 4663 (0x1237) · client nitro/v3.11.3-rc.9
 *   baseFee = 0,01 gwei · maxPriorityFeePerGas = 0 (séquenceur FCFS, aucun fee-bump possible)
 */

// `paris` volontairement, pas `cancun` : Robinhood ne documente publiquement aucun
// niveau d'EVM (ArbOS 61 sans page de référence). Aucun de nos contrats n'a besoin de
// TSTORE/MCOPY, donc on ne prend pas le risque d'un opcode non supporté à l'exécution.
const EVM_VERSION = "paris";

const deployerKey = process.env.ROBINHOOD_DEPLOYER_KEY?.trim();
const accounts = deployerKey ? [deployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: EVM_VERSION,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: process.env.SIRIUS_LOCAL_BILLING_TEST === "true" ? 46630 : 31337,
      // Le réseau local doit refléter la cible, sinon un test peut passer ici et
      // échouer sur la chaîne réelle. Hardhat nomme « merge » le hardfork que solc
      // appelle « paris » — c'est le même, seule la nomenclature diffère.
      hardfork: "merge",
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts,
    },
    robinhoodMainnet: {
      url: process.env.ROBINHOOD_MAINNET_RPC ?? "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts,
    },
  },
  mocha: {
    // Le premier test paie le démarrage du réseau Hardhat et la compilation ; 40 s
    // par défaut ne suffisent pas sur une machine froide.
    timeout: 180_000,
  },
  etherscan: {
    // Blockscout accepte n'importe quelle clé ; la vérification passe par son endpoint.
    apiKey: {
      robinhoodTestnet: "blockscout",
      robinhoodMainnet: "blockscout",
    },
    customChains: [
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
      {
        network: "robinhoodMainnet",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
};

export default config;
