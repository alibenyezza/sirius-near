import { createPublicClient, http } from "viem";
import { robinhoodMainnet, robinhoodTestnet } from "../src/lib/evm/networks";
import { checkV7, mainnetV7Configuration, testnetV7Configuration } from "./phala-v7-preflight";

// Usage : node … scripts/check-phala-v7.ts [--network=mainnet]  (testnet par défaut)
async function main() {
  const args = process.argv.slice(2);
  const flag = args.find((arg) => arg.startsWith("--network="))?.slice("--network=".length) ?? "testnet";
  if (args.some((arg) => !arg.startsWith("--network=")) || !["testnet", "mainnet"].includes(flag) || !process.env.EVM_RPC_URL?.trim()) throw new Error();
  const mainnet = flag === "mainnet";
  const config = mainnet ? mainnetV7Configuration(process.env) : testnetV7Configuration(process.env);
  const client = createPublicClient({ chain: mainnet ? robinhoodMainnet : robinhoodTestnet,
    transport: http(process.env.EVM_RPC_URL, { timeout: 15000, retryCount: 1 }) });
  const report = await checkV7(client, config);
  console.log(JSON.stringify(report, null, 2));
  if (!report.chainChecksPassed) process.exitCode = 1;
}

main().catch(() => {
  console.error("Préflight Phala/v7 refusé : vérifier le réseau demandé, la configuration explicite, le RPC archive et son état finalisé, les adresses, le code et les décimales du jeton de règlement (USDG de Paxos sur mainnet) et les contrats. Aucune transaction envoyée.");
  process.exitCode = 1;
});
