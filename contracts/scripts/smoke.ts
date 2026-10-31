import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, parseUnits, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS } from "../../src/lib/evm/networks";
import { datasetIdHash } from "../../src/lib/evm/dataset-key";
import { hashlockOf, loanIdHash, loanKeyFor } from "../../src/lib/evm/loan-key";
import { lockAuthorizationTypedData } from "../../src/lib/evm/lock-authorization";
import { DEFAULT_MODEL_SELECTION, modelSelectionForId, trainingProfileHash } from "../../src/lib/models/registry";

const ARTIFACTS = resolve(__dirname, "..", "artifacts", "src");

function abiOf(name: string): Abi {
  return (JSON.parse(readFileSync(resolve(ARTIFACTS, `${name}.sol`, `${name}.json`), "utf8")) as { abi: Abi }).abi;
}

function required(name: string): Hex {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} manquante`);
  return value as Hex;
}

function requiredText(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} manquante`);
  return value;
}

function requiredAddress(name: string): `0x${string}` {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} doit être une adresse EVM valide`);
  return value as `0x${string}`;
}

async function main() {
  const chain = EVM_CHAINS.testnet;
  const transport = http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]);
  const account = privateKeyToAccount(required("ROBINHOOD_DEPLOYER_KEY"));
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const escrow = required("NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS");
  const datasets = required("NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS");
  const usdc = required("NEXT_PUBLIC_SIRIUS_USDC_ADDRESS");
  const kyb = required("NEXT_PUBLIC_SIRIUS_KYB_ADDRESS");
  const escrowAbi = abiOf("SiriusEscrow");
  const datasetAbi = abiOf("SiriusDatasetRegistry");
  const version = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "VERSION" });
  if (version !== "sirius-escrow-usdc-v6") throw new Error("Ce smoke écrit uniquement sur escrow v6. Pour v7, utiliser test:billing en local puis le parcours applicatif dédié.");
  const authorizer = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "lockAuthorizer" }) as Hex;
  if (authorizer.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("Ce smoke exige un escrow testnet dédié dont le déployeur autorise les locks. Pour l'escrow du runner, valider le parcours applicatif sans exporter sa clé.");
  }
  const kybAbi = abiOf("SiriusKybRegistry");
  const usdcAbi = [
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  ] as const;

  const provider = requiredAddress("SIRIUS_SMOKE_PROVIDER_ADDRESS");
  const smokeDatasetId = requiredText("SIRIUS_SMOKE_DATASET_ID");
  const smokeModel = modelSelectionForId(process.env.SIRIUS_SMOKE_MODEL_ID ?? DEFAULT_MODEL_SELECTION.modelId);
  if (!smokeModel) throw new Error("SIRIUS_SMOKE_MODEL_ID doit être linear_regression ou logistic_regression");
  const trainingProfile = trainingProfileHash(smokeModel);
  const onChainDatasetId = await publicClient.readContract({
    address: datasets,
    abi: datasetAbi,
    functionName: "datasetIdOf",
    args: [provider, datasetIdHash(smokeDatasetId)],
  }) as Hex;
  const onChainDataset = await publicClient.readContract({
    address: datasets,
    abi: datasetAbi,
    functionName: "getDataset",
    args: [onChainDatasetId],
  }) as { provider: `0x${string}`; destroyedAt: bigint; trainingProfile: Hex };
  if (
    onChainDataset.provider.toLowerCase() !== provider.toLowerCase() ||
    onChainDataset.destroyedAt !== 0n ||
    onChainDataset.trainingProfile.toLowerCase() !== trainingProfile.toLowerCase()
  ) {
    throw new Error("Le dataset smoke doit être un titre EVM live du provider, avec le profil demandé");
  }
  // Montant dérivé de la précision du réseau, jamais écrit en dur : l'USDC du
  // testnet a 18 décimales là où celui de référence en a 6. Un littéral figé passait
  // sous le plancher de l'escrow et faisait échouer le verrouillage sans que la
  // raison soit lisible dans l'erreur.
  const usdcDecimals = await publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "decimals" });
  const amount = parseUnits("2", Number(usdcDecimals));
  const preimage = randomBytes(32);
  const hashlock = hashlockOf(preimage);
  const loanId = `smoke-${randomBytes(6).toString("hex")}`;
  const loanKey = loanKeyFor(account.address, loanId);

  const step = async (label: string, hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, retryCount: 20, retryDelay: 1_500, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${label} rejeté (${hash})`);
    console.log(`✓ ${label} · bloc ${receipt.blockNumber}`);
    return receipt;
  };

  const nativeBalance = await publicClient.getBalance({ address: account.address });
  const [borrowerUsdc, providerUsdcBefore, borrowerKyb, providerKyb, escrowKyb, linkedDatasets, linkedEscrow] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [provider] }),
    publicClient.readContract({ address: kyb, abi: kybAbi, functionName: "isKybValid", args: [account.address] }),
    publicClient.readContract({ address: kyb, abi: kybAbi, functionName: "isKybValid", args: [provider] }),
    publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "kyb" }),
    publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "datasets" }),
    publicClient.readContract({ address: datasets, abi: datasetAbi, functionName: "escrow" }),
  ]) as [bigint, bigint, boolean, boolean, `0x${string}`, `0x${string}`, `0x${string}`];
  if (borrowerUsdc < amount) throw new Error(`USDC insuffisant : ${borrowerUsdc} < ${amount}`);
  if (!borrowerKyb || !providerKyb) throw new Error("Borrower et provider doivent avoir un KYB EVM valide");
  if (escrowKyb.toLowerCase() !== kyb.toLowerCase()) throw new Error("Escrow et registre KYB incohérents");
  if (linkedDatasets.toLowerCase() !== datasets.toLowerCase()) throw new Error("Escrow et registre dataset incohérents");
  if (linkedEscrow.toLowerCase() !== escrow.toLowerCase()) throw new Error("Registre dataset et escrow incohérents");
  console.log(`gas      : ${formatEther(nativeBalance)} ETH`);
  console.log(`USDC     : ${borrowerUsdc}`);
  console.log(`profil   : ${smokeModel.modelId} ${smokeModel.modelVersion}`);

  await step("Approbation USDC", await wallet.writeContract({ address: usdc, abi: usdcAbi, functionName: "approve", args: [escrow, amount], chain, account }));
  const deadline = Number((await publicClient.getBlock()).timestamp) + 300;
  const signature = await account.signTypedData(lockAuthorizationTypedData({
    borrower: account.address, provider, amount, hashlock, challengeDays: 7,
    loanIdHash: loanIdHash(loanId), datasetId: onChainDatasetId, trainingProfile,
  }, { chainId: chain.id, escrow }, deadline));
  await step("Lock USDC", await wallet.writeContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "lock",
    args: [provider, amount, hashlock, 7, loanIdHash(loanId), onChainDatasetId, trainingProfile, { deadline, signature }],
    chain,
    account,
  }));

  const locked = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "getLoan", args: [loanKey] }) as {
    status: number;
    amount: bigint;
    hashlock: Hex;
    datasetId: Hex;
    trainingProfile: Hex;
  };
  if (
    locked.status !== 1 ||
    locked.amount !== amount ||
    locked.hashlock !== hashlock ||
    locked.datasetId.toLowerCase() !== onChainDatasetId.toLowerCase() ||
    locked.trainingProfile.toLowerCase() !== trainingProfile.toLowerCase()
  ) {
    throw new Error("Le lock USDC ne correspond pas aux termes attendus");
  }

  await step("Release", await wallet.writeContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "release",
    args: [loanKey, `0x${preimage.toString("hex")}` as Hex],
    chain,
    account,
  }));
  const [revealed, published] = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "preimageOf", args: [loanKey] }) as [boolean, Hex];
  if (!revealed || published.toLowerCase() !== `0x${preimage.toString("hex")}`) throw new Error("Préimage non publié");

  await step("Retrait provider", await wallet.writeContract({ address: escrow, abi: escrowAbi, functionName: "withdrawFor", args: [provider], chain, account }));
  const providerUsdc = await publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [provider] });
  if (providerUsdc !== providerUsdcBefore + amount) throw new Error("Le provider n'a pas reçu les USDC exacts");
  console.log(`fair-exchange USDC validé · hashlock ${createHash("sha256").update(preimage).digest("hex")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
