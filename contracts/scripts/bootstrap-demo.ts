import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseUnits,
  type Abi,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS, USDC_DECIMALS_BY_NETWORK, type EvmNetwork } from "../../src/lib/evm/networks";

/**
 * Amorçage d'une instance de démonstration sur réseau de test.
 *
 *   ROBINHOOD_DEPLOYER_KEY=0x... pnpm contracts:bootstrap-demo
 *
 * Déploie un jeton de règlement qu'on contrôle, puis frappe de quoi jouer un prêt.
 * Le trio KYB/escrow/dataset reste déployé par `deploy.ts` : ce script ne fait que
 * ce que celui-ci ne peut pas faire, à savoir créer de la valeur de test.
 *
 * Refuse tout réseau qui ne soit pas un testnet. Le contrat frappé ici a une frappe
 * ouverte à tous — sur un mainnet ce serait une monnaie sans émetteur.
 */

const ARTIFACTS = resolve(__dirname, "..", "artifacts", "src");

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(ARTIFACTS, `${name}.sol`, `${name}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: Hex };
  if (!parsed.bytecode || parsed.bytecode === "0x") {
    throw new Error(`Bytecode absent pour ${name} — lance d'abord \`pnpm contracts:compile\``);
  }
  return parsed;
}

function targetNetwork(): { network: EvmNetwork; chain: Chain } {
  const requested = (process.env.SIRIUS_DEPLOY_NETWORK ?? "testnet") as EvmNetwork;
  const chain = EVM_CHAINS[requested];
  if (!chain) throw new Error(`Réseau inconnu : ${requested}`);
  return { network: requested, chain };
}

/** Adresses à créditer, séparées par des virgules. */
function beneficiaires(): Hex[] {
  const brut = process.env.SIRIUS_DEMO_WALLETS?.trim();
  if (!brut) throw new Error("SIRIUS_DEMO_WALLETS manquante (adresses séparées par des virgules)");
  const liste = brut.split(",").map((a) => a.trim()).filter(Boolean);
  for (const a of liste) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Adresse invalide : ${a}`);
  }
  if (liste.length === 0) throw new Error("SIRIUS_DEMO_WALLETS ne contient aucune adresse");
  return liste as Hex[];
}

async function main() {
  const { network, chain } = targetNetwork();

  // Le jeton frappé ici n'a aucun émetteur : n'importe qui peut s'en créer. Sur un
  // réseau où les montants ont une valeur, ce serait une faille, pas un outil.
  if (network !== "testnet") {
    throw new Error(`Amorçage de démonstration interdit hors testnet (demandé : ${network})`);
  }

  const key = process.env.ROBINHOOD_DEPLOYER_KEY?.trim();
  if (!key) throw new Error("ROBINHOOD_DEPLOYER_KEY manquante");
  const account = privateKeyToAccount(key as Hex);

  const transport = http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const decimales = USDC_DECIMALS_BY_NETWORK[network];
  const wallets = beneficiaires();
  const montant = parseUnits(process.env.SIRIUS_DEMO_MINT ?? "100000", decimales);

  console.log(`réseau        : ${network} (chainId ${chain.id})`);
  console.log(`déployeur     : ${account.address}`);
  console.log(`solde         : ${formatEther(await publicClient.getBalance({ address: account.address }))} ETH`);
  console.log("");

  const { abi, bytecode } = artifact("SiriusTestUsdc");
  const hash = await walletClient.deployContract({ abi, bytecode, args: [], chain, account });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    retryCount: 20,
    retryDelay: 1_500,
    timeout: 120_000,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Déploiement du jeton rejeté (tx ${hash})`);
  }
  const usdc = receipt.contractAddress;
  console.log(`SiriusTestUsdc  ${usdc}  (${receipt.gasUsed.toLocaleString("fr-FR")} gas)`);

  // Contrôle de cohérence : la précision du jeton doit correspondre à celle que
  // l'application déclare pour ce réseau, sinon tous les montants seraient décalés.
  const onChainDecimals = await publicClient.readContract({ address: usdc, abi, functionName: "decimals" });
  if (Number(onChainDecimals) !== decimales) {
    throw new Error(`Précision incohérente : jeton ${onChainDecimals}, application ${decimales}`);
  }

  console.log("");
  for (const beneficiaire of wallets) {
    const mintHash = await walletClient.writeContract({
      address: usdc,
      abi,
      functionName: "mint",
      args: [beneficiaire, montant],
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash, confirmations: 1, retryCount: 20, retryDelay: 1_500 });
    const solde = await publicClient.readContract({ address: usdc, abi, functionName: "balanceOf", args: [beneficiaire] });
    console.log(`frappé  ${formatUnits(solde as bigint, decimales).padStart(12)} USDC → ${beneficiaire}`);
  }

  const explorer = chain.blockExplorers?.default.url;
  console.log("");
  console.log("À reporter dans l'environnement, puis redéployer le trio :");
  console.log(`SIRIUS_USDC_ADDRESS="${usdc}"`);
  console.log(`NEXT_PUBLIC_SIRIUS_USDC_ADDRESS="${usdc}"`);
  console.log("");
  console.log("Empreinte du bytecode, exigée par deploy.ts :");
  const code = await publicClient.getBytecode({ address: usdc });
  const { keccak256 } = await import("viem");
  console.log(`SIRIUS_USDC_CODE_HASH="${keccak256(code!)}"`);
  if (explorer) console.log(`\nExplorateur : ${explorer}/address/${usdc}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
