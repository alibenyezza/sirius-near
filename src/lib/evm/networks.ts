import { defineChain, type Chain } from "viem";

/**
 * Réseaux EVM cibles de Sirius : Robinhood Chain, un L2 Arbitrum Nitro.
 *
 * Valeurs vérifiées en direct le 14/08/2026 par sondes RPC :
 *   testnet 46630 (0xb626) · mainnet 4663 (0x1237)
 *   client `nitro/v3.11.3-rc.9` · gas en ETH natif
 *   baseFee 0,01 gwei et `maxPriorityFeePerGas` à 0 — le séquenceur ordonne en
 *   FCFS strict, donc surenchérir sur le gas n'accélère jamais une inclusion.
 *   Multicall3 déployé à l'adresse canonique.
 *
 * Les deux environnements partagent les mêmes conventions de résolution réseau.
 */

export type EvmNetwork = "mainnet" | "testnet";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const robinhoodMainnet: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: MULTICALL3 },
  },
});

export const robinhoodTestnet: Chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  contracts: {
    multicall3: { address: MULTICALL3 },
  },
  testnet: true,
});

export const EVM_CHAINS: Record<EvmNetwork, Chain> = {
  mainnet: robinhoodMainnet,
  testnet: robinhoodTestnet,
};

export const EVM_CHAIN_IDS: Record<EvmNetwork, number> = {
  mainnet: robinhoodMainnet.id,
  testnet: robinhoodTestnet.id,
};

/**
 * Précision du jeton de règlement de chaque réseau (nom historique : « USDC »).
 *
 * Ce n'est pas une convention universelle : le contrat vérifié du testnet
 * Robinhood expose 18 décimales, là où l'USDG de Paxos retenu pour le mainnet
 * (`0x5fc5…d168`, voir stablecoin.ts) en expose 6 — valeur lue on-chain sur le
 * RPC mainnet le 4 octobre 2026, identique à celle de l'USDC qu'il remplace.
 * Une valeur fausse ici ne lève aucune erreur — elle décale silencieusement tous
 * les montants d'un facteur de puissance de dix, et rend les prêts gratuits.
 *
 * `contracts/scripts/deploy.ts` lit `decimals()` on-chain et refuse de déployer
 * si la valeur ne correspond pas à celle déclarée ici ; `phala-v7-preflight`
 * et le conteneur d'initialisation du runner font le même contrôle. Ce sont ces
 * contrôles, et non cette table, qui font autorité. USDG étant un proxy
 * évolutif, ils relisent la valeur courante à chaque exécution.
 */
export const USDC_DECIMALS_BY_NETWORK: Record<EvmNetwork, number> = {
  mainnet: 6,
  testnet: 18,
};

function parseNetwork(raw: string, variable: string): EvmNetwork {
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`${variable} invalide: "${raw}" (attendu: mainnet, testnet)`);
  }
  return raw;
}

/** Réseau + RPC côté serveur (API routes et runner), pilotés par l'environnement. */
export function resolveServerNetwork(): { network: EvmNetwork; chain: Chain; rpcUrl: string } {
  const network = parseNetwork(process.env.EVM_NETWORK || "testnet", "EVM_NETWORK");
  const chain = EVM_CHAINS[network];
  const rpcUrl = process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0];
  return { network, chain, rpcUrl };
}

/** Réseau attendu côté navigateur. Doit correspondre au serveur, sinon les signatures sont rejetées. */
export function resolveClientNetwork(): EvmNetwork {
  return parseNetwork(process.env.NEXT_PUBLIC_EVM_NETWORK || "testnet", "NEXT_PUBLIC_EVM_NETWORK");
}

export function chainForNetwork(network: EvmNetwork): Chain {
  return EVM_CHAINS[network];
}

/**
 * Précision du jeton de règlement, résolue dans les deux contextes d'exécution.
 *
 * `usdc.ts` est importé aussi bien par les écrans que par le runner : il ne peut
 * donc dépendre d'aucun des deux résolveurs ci-dessus. `EVM_NETWORK` n'est pas
 * inlinée dans le bundle navigateur, où la valeur publique prend le relais ;
 * côté serveur la variable privée l'emporte, pour qu'une valeur publique oubliée
 * ne puisse pas contredire la configuration serveur.
 */
export function resolveUsdcDecimals(): number {
  const server = process.env.EVM_NETWORK?.trim();
  const client = process.env.NEXT_PUBLIC_EVM_NETWORK?.trim();
  const network = server
    ? parseNetwork(server, "EVM_NETWORK")
    : client
      ? parseNetwork(client, "NEXT_PUBLIC_EVM_NETWORK")
      : "testnet";
  return USDC_DECIMALS_BY_NETWORK[network];
}
