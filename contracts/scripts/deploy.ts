import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, type Abi, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS, USDC_DECIMALS_BY_NETWORK, type EvmNetwork } from "../../src/lib/evm/networks";
import { deploymentPlan } from "../../scripts/deploy-policy";

/**
 * Déploie les contrats Sirius sur Robinhood Chain.
 *
 *   ROBINHOOD_DEPLOYER_KEY=0x... pnpm contracts:deploy:testnet
 *
 * Écrit en viem pur plutôt qu'avec les aides de `hardhat-viem`, pour deux raisons.
 * D'abord `hardhat-viem` ne connaît que les chaînes livrées dans `viem/chains`, et
 * Robinhood Chain n'en fait pas partie. Ensuite il appelle `getTransaction`
 * immédiatement après l'envoi : sur cette chaîne le RPC public n'a pas encore
 * indexé la transaction à cet instant, et le déploiement échoue alors qu'il a
 * parfaitement réussi on-chain. On attend donc le reçu, avec des tentatives.
 *
 * Les définitions de chaîne viennent de `src/lib/evm/networks.ts`, la même source
 * que l'application, pour qu'elles ne puissent pas diverger.
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

/**
 * Résout un rôle de gouvernance, en refusant qu'il retombe silencieusement sur la clé
 * de déploiement. `SIRIUS_ALLOW_SHARED_ROLES=true` autorise le raccourci pour un
 * déploiement jetable, mais il faut alors l'avoir voulu explicitement.
 */
function requireRole(variable: string, deployer: Hex): Hex {
  const configured = process.env[variable]?.trim();
  if (configured) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(configured)) {
      throw new Error(`${variable} n'est pas une adresse EVM valide`);
    }
    return configured as Hex;
  }
  if (process.env.SIRIUS_ALLOW_SHARED_ROLES === "true") return deployer;
  throw new Error(
    `${variable} manquante. Ce rôle ne doit pas revenir à la clé de déploiement : ` +
      "celle-ci ne paie que le gas et finit souvent partagée, alors que ce rôle gouverne " +
      "le registre KYB. Fournis une adresse dédiée, ou SIRIUS_ALLOW_SHARED_ROLES=true " +
      "pour un déploiement jetable assumé.",
  );
}

function requireAddress(variable: string): Hex {
  const configured = process.env[variable]?.trim();
  if (!configured || !/^0x[0-9a-fA-F]{40}$/.test(configured)) {
    throw new Error(`${variable} doit être une adresse EVM valide`);
  }
  return configured as Hex;
}

function requireCodeHash(variable: string): Hex {
  const configured = process.env[variable]?.trim();
  if (!configured || !/^0x[0-9a-fA-F]{64}$/.test(configured)) {
    throw new Error(`${variable} doit être le keccak256 du bytecode USDC`);
  }
  return configured as Hex;
}

function targetNetwork(): { network: EvmNetwork; chain: Chain } {
  const requested = (process.env.SIRIUS_DEPLOY_NETWORK ?? "testnet") as EvmNetwork;
  const chain = EVM_CHAINS[requested];
  if (!chain) throw new Error(`Réseau inconnu : ${requested} (attendu testnet ou mainnet)`);
  return { network: requested, chain };
}

async function main() {
  const { network, chain } = targetNetwork();
  const key = process.env.ROBINHOOD_DEPLOYER_KEY?.trim();
  if (!key) throw new Error("ROBINHOOD_DEPLOYER_KEY manquante");
  const account = privateKeyToAccount(key as Hex);

  // Toutes les règles hors réseau d'abord : sur mainnet, v7 explicite, KYB strict, aucun
  // rôle partagé, quatre adresses distinctes et l'USDC natif. Voir scripts/deploy-policy.ts.
  const plan = deploymentPlan(process.env, chain.id, account.address);
  const { billingVersion, escrowContract } = plan;

  const transport = http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`réseau        : ${network} (chainId ${chain.id})`);
  console.log(`déployeur     : ${account.address}`);
  console.log(`solde         : ${formatEther(balance)} ETH`);

  if (balance === 0n && plan.dryRun) {
    console.log("solde nul     : accepté pour une exécution à blanc, refusé pour un vrai déploiement");
  } else if (balance === 0n) {
    throw new Error(
      "Solde nul. Alimente le compte en ETH NATIF via https://faucet.testnet.chain.robinhood.com " +
        "(attention : LINK ne paie pas le gas)",
    );
  }

  // Les rôles ne retombent plus sur le déployeur par défaut. La clé de déploiement ne
  // sert qu'à payer le gas et finit souvent partagée — dans un journal de CI, un
  // transcript, un canal d'équipe. Lui donner l'administration du registre KYB signifie
  // que quiconque la lit peut émettre de fausses attestations d'entreprise vérifiée.
  //
  // Admin et vérificateur sont également séparés l'un de l'autre : l'un décide QUI peut
  // attester, l'autre atteste. Les confondre supprime le contre-pouvoir.
  // Mode ouvert : l'escrow et le registre de datasets reçoivent un registre qui
  // valide tout le monde, au lieu du registre gouverné. Leur source ne change pas —
  // seul l'argument de construction diffère — et revenir au KYB réel consistera à
  // les redéployer sans cette variable.
  const kybOuvert = plan.kybOpen;

  const admin = kybOuvert ? account.address : requireRole("SIRIUS_KYB_ADMIN", account.address);
  const verifier = kybOuvert ? account.address : requireRole("SIRIUS_KYB_VERIFIER", account.address);
  const usdc = requireAddress("SIRIUS_USDC_ADDRESS");
  const lockAuthorizer = requireAddress("SIRIUS_LOCK_AUTHORIZER");
  if (lockAuthorizer === "0x0000000000000000000000000000000000000000") throw new Error("SIRIUS_LOCK_AUTHORIZER ne peut pas être nulle");
  const expectedUsdcCodeHash = requireCodeHash("SIRIUS_USDC_CODE_HASH");
  if (!kybOuvert && admin.toLowerCase() === verifier.toLowerCase()) {
    throw new Error(
      "SIRIUS_KYB_ADMIN et SIRIUS_KYB_VERIFIER doivent être deux adresses distinctes. " +
        "Pour un déploiement jetable, SIRIUS_ALLOW_SHARED_ROLES=true.",
    );
  }

  const usdcCode = await publicClient.getBytecode({ address: usdc });
  if (!usdcCode || usdcCode === "0x") throw new Error("SIRIUS_USDC_ADDRESS ne contient aucun contrat");
  const usdcCodeHash = keccak256(usdcCode);
  if (usdcCodeHash.toLowerCase() !== expectedUsdcCodeHash.toLowerCase()) {
    throw new Error(`Code hash USDC inattendu : ${usdcCodeHash}`);
  }

  // Contrôle de précision. Le hash du bytecode prouve qu'on parle au bon contrat ;
  // il ne dit pas comment ce contrat compte. Plusieurs jetons nommés « USDC »
  // coexistent sur les réseaux de test, certains à 6 décimales et d'autres à 18.
  //
  // Une divergence ici ne casse rien visiblement : elle décale tous les montants
  // d'un facteur de puissance de dix. Un emprunteur qui saisit 100 USDC verrouille
  // alors une poussière, le prêt se règle normalement, et le fournisseur est payé
  // en presque rien. Aucune exception n'est levée nulle part.
  const onChainDecimals = await publicClient.readContract({
    address: usdc,
    abi: [
      {
        type: "function",
        name: "decimals",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }],
      },
    ] as const,
    functionName: "decimals",
  });
  const expectedDecimals = USDC_DECIMALS_BY_NETWORK[network];
  if (Number(onChainDecimals) !== expectedDecimals) {
    throw new Error(
      `Précision USDC incohérente sur ${network} : le contrat ${usdc} expose ` +
        `${onChainDecimals} décimales, l'application en attend ${expectedDecimals}. ` +
        "Corrige USDC_DECIMALS_BY_NETWORK dans src/lib/evm/networks.ts, ou pointe " +
        "SIRIUS_USDC_ADDRESS sur le bon contrat. Ne déploie pas avec cet écart : " +
        "il rendrait tous les prêts gratuits sans lever d'erreur.",
    );
  }
  console.log(`USDC          : ${usdc} (${expectedDecimals} décimales)`);

  // Sur mainnet, l'admin KYB est le Safe : une adresse sans code serait une clé seule.
  for (const governed of plan.mustBeContracts) {
    const code = await publicClient.getBytecode({ address: governed as Hex });
    if (!code || code === "0x") throw new Error(`L'admin KYB ${governed} doit être un contrat (Safe), pas une clé`);
  }

  if (plan.dryRun) {
    console.log("");
    console.log("Exécution à blanc : toutes les vérifications sont passées, aucune transaction envoyée.");
    console.log(`contrats      : ${kybOuvert ? "SiriusOpenKybRegistry" : "SiriusKybRegistry"}, SiriusDatasetRegistry, ${escrowContract}`);
    console.log(`signataire    : ${lockAuthorizer}`);
    if (!kybOuvert) console.log(`admin KYB     : ${admin}\nvérificateur  : ${verifier}`);
    return;
  }

  const deployed: Record<string, Hex> = {};
  let totalGas = 0n;

  async function deploy(name: string, args: unknown[] = []): Promise<Hex> {
    const { abi, bytecode } = artifact(name);
    const hash = await walletClient.deployContract({ abi, bytecode, args, chain, account });

    // `waitForTransactionReceipt` retente tant que le RPC n'a pas indexé la
    // transaction, au lieu d'abandonner au premier « not found ».
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      retryCount: 20,
      retryDelay: 1_500,
      timeout: 120_000,
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`Déploiement de ${name} rejeté (tx ${hash})`);
    }

    totalGas += receipt.gasUsed;
    deployed[name] = receipt.contractAddress;
    console.log(
      `${name.padEnd(22)} ${receipt.contractAddress}  (${receipt.gasUsed.toLocaleString("fr-FR")} gas)`,
    );
    return receipt.contractAddress;
  }

  console.log("");
  const kyb = kybOuvert
    ? await deploy("SiriusOpenKybRegistry")
    : await deploy("SiriusKybRegistry", [admin, verifier]);
  // Ce rôle ne sert qu'à la liaison unique ; le déployeur effectue la transaction.
  const datasets = await deploy("SiriusDatasetRegistry", [kyb, account.address]);
  const escrow = await deploy(escrowContract, [usdc, kyb, datasets, lockAuthorizer]);
  const bindEscrowHash = await walletClient.writeContract({
    address: datasets,
    abi: artifact("SiriusDatasetRegistry").abi,
    functionName: "bindEscrow",
    args: [escrow],
    account,
  });
  const bindEscrowReceipt = await publicClient.waitForTransactionReceipt({ hash: bindEscrowHash, confirmations: 1 });
  if (bindEscrowReceipt.status !== "success") throw new Error("Liaison DatasetRegistry → SiriusEscrow rejetée");
  totalGas += bindEscrowReceipt.gasUsed;

  console.log("");
  console.log(`gas total     : ${totalGas.toLocaleString("fr-FR")}`);
  if (kybOuvert) {
    console.log("registre KYB  : OUVERT — toute adresse est valide, sans vérification");
  } else {
    console.log(`admin KYB     : ${admin}`);
    console.log(`vérificateur  : ${verifier}`);
  }

  // Contrôle de bon sens : chaque contrat répond et part d'un état vierge.
  const escrowAbi = artifact(escrowContract).abi;
  const deployedAuthorizer = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "lockAuthorizer" }) as Hex;
  if (deployedAuthorizer.toLowerCase() !== lockAuthorizer.toLowerCase()) throw new Error("Signataire de lock incorrect");
  const kybAbi = artifact(kybOuvert ? "SiriusOpenKybRegistry" : "SiriusKybRegistry").abi;
  const datasetAbi = artifact("SiriusDatasetRegistry").abi;

  const accounting = (await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "accounting",
  })) as readonly [bigint, bigint, bigint, bigint];
  if (accounting.some((value) => value !== 0n)) {
    throw new Error("SiriusEscrow fraîchement déployé n'est pas dans un état vierge");
  }
  const escrowUsdc = (await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "usdc",
  })) as Hex;
  if (escrowUsdc.toLowerCase() !== usdc.toLowerCase()) {
    throw new Error("SiriusEscrow ne référence pas le contrat USDC configuré");
  }
  const escrowKyb = (await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "kyb",
  })) as Hex;
  if (escrowKyb.toLowerCase() !== kyb.toLowerCase()) {
    throw new Error("SiriusEscrow ne référence pas le registre KYB déployé");
  }
  const escrowDatasets = (await publicClient.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "datasets",
  })) as Hex;
  if (escrowDatasets.toLowerCase() !== datasets.toLowerCase()) {
    throw new Error("SiriusEscrow ne référence pas le registre dataset déployé");
  }

  if (kybOuvert) {
    // Le contrôle utile ici est l'inverse du contrôle habituel : on vérifie que le
    // registre laisse effectivement passer, y compris une adresse qui n'a jamais rien
    // signé. Un faux négatif bloquerait tous les emprunts sans message clair.
    const passeSansAttestation = await publicClient.readContract({
      address: kyb,
      abi: kybAbi,
      functionName: "isKybValid",
      args: ["0x000000000000000000000000000000000000dEaD"],
    });
    if (!passeSansAttestation) throw new Error("Le registre ouvert refuse une adresse — il ne remplit pas son rôle");
  } else {
    const verifierRegistered = await publicClient.readContract({
      address: kyb,
      abi: kybAbi,
      functionName: "isVerifier",
      args: [verifier],
    });
    if (!verifierRegistered) throw new Error("Le premier vérificateur KYB n'a pas été enregistré");
  }

  const linkedKyb = (await publicClient.readContract({
    address: datasets,
    abi: datasetAbi,
    functionName: "kyb",
  })) as Hex;
  if (linkedKyb.toLowerCase() !== kyb.toLowerCase()) {
    throw new Error("Le registre dataset ne pointe pas sur le registre KYB déployé");
  }
  const linkedEscrow = (await publicClient.readContract({
    address: datasets,
    abi: datasetAbi,
    functionName: "escrow",
  })) as Hex;
  if (linkedEscrow.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error("SiriusDatasetRegistry ne référence pas le contrat escrow déployé");
  }

  const explorer = chain.blockExplorers?.default.url;
  console.log("");
  console.log("À reporter dans .env.local :");
  console.log(`SIRIUS_BILLING_VERSION="${billingVersion}"`);
  console.log(`NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS="${escrow}"`);
  console.log(`NEXT_PUBLIC_SIRIUS_USDC_ADDRESS="${usdc}"`);
  console.log(`NEXT_PUBLIC_SIRIUS_KYB_ADDRESS="${kyb}"`);
  console.log(`NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS="${datasets}"`);
  console.log(`SIRIUS_ESCROW_ADDRESS="${escrow}"`);
  console.log(`SIRIUS_USDC_ADDRESS="${usdc}"`);
  console.log(`SIRIUS_KYB_ADDRESS="${kyb}"`);
  console.log(`SIRIUS_DATASET_ADDRESS="${datasets}"`);
  if (explorer) {
    console.log("");
    console.log("Explorateur :");
    for (const [name, address] of [
      [escrowContract, escrow],
      [kybOuvert ? "SiriusOpenKybRegistry" : "SiriusKybRegistry", kyb],
      ["SiriusDatasetRegistry", datasets],
    ] as const) {
      console.log(`  ${name.padEnd(22)} ${explorer}/address/${address}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
