import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, type Abi, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS, type EvmNetwork } from "../../src/lib/evm/networks";

/**
 * Pose les attestations KYB des comptes de démonstration.
 *
 *   pnpm contracts:attest-kyb
 *
 * `SiriusEscrow.lock` exige une attestation valide pour l'emprunteur ET le
 * fournisseur. Or l'application sait constater une attestation, pas en créer : rien
 * dans l'interface ne mène à ce geste. Sans ce script, tout prêt échouerait au
 * verrouillage.
 *
 * On passe par `attestWithConsent` : le vérificateur envoie la transaction, le sujet
 * fournit sa signature. Un seul compte a donc besoin de gas, au lieu d'un par sujet.
 *
 * Le digest est lu sur le contrat plutôt que reconstruit ici. Le registre l'expose
 * précisément pour ça, et une reconstruction manuelle de l'EIP-712 qui divergerait
 * d'un octet produirait une signature rejetée sans indiquer pourquoi.
 */

const ARTIFACTS = resolve(__dirname, "..", "artifacts", "src");

function abiOf(name: string): Abi {
  const path = resolve(ARTIFACTS, `${name}.sol`, `${name}.json`);
  return (JSON.parse(readFileSync(path, "utf8")) as { abi: Abi }).abi;
}

function requis(nom: string): string {
  const valeur = process.env[nom]?.trim();
  if (!valeur) throw new Error(`${nom} manquante`);
  return valeur;
}

function reseau(): { network: EvmNetwork; chain: Chain } {
  const demande = (process.env.SIRIUS_DEPLOY_NETWORK ?? "testnet") as EvmNetwork;
  const chain = EVM_CHAINS[demande];
  if (!chain) throw new Error(`Réseau inconnu : ${demande}`);
  return { network: demande, chain };
}

/** Durée de validité. Bornée par le contrat, qui refuse une expiration trop lointaine. */
const VALIDITE_JOURS = Number(process.env.SIRIUS_KYB_VALIDITY_DAYS ?? "30");

async function main() {
  const { network, chain } = reseau();
  const registre = requis("SIRIUS_KYB_ADDRESS") as Hex;
  const abi = abiOf("SiriusKybRegistry");

  const verifieur = privateKeyToAccount(requis("SIRIUS_KYB_VERIFIER_KEY") as Hex);
  const sujets = requis("SIRIUS_DEMO_SUBJECT_KEYS")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => privateKeyToAccount(k as Hex));

  const transport = http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account: verifieur, chain, transport });

  console.log(`réseau       : ${network} (chainId ${chain.id})`);
  console.log(`registre KYB : ${registre}`);
  console.log(`vérificateur : ${verifieur.address}`);
  console.log(`solde        : ${formatEther(await publicClient.getBalance({ address: verifieur.address }))} ETH`);

  const inscrit = await publicClient.readContract({
    address: registre,
    abi,
    functionName: "isVerifier",
    args: [verifieur.address],
  });
  if (!inscrit) {
    throw new Error(
      `${verifieur.address} n'est pas vérificateur sur ce registre. ` +
        "L'administrateur doit l'inscrire, ou le déploiement doit le désigner.",
    );
  }

  const expiresAt = Math.floor(Date.now() / 1000) + VALIDITE_JOURS * 86_400;
  console.log(`expiration   : ${new Date(expiresAt * 1000).toISOString()}`);
  console.log("");

  for (const sujet of sujets) {
    const dejaValide = await publicClient.readContract({
      address: registre,
      abi,
      functionName: "isKybValid",
      args: [sujet.address],
    });
    if (dejaValide) {
      console.log(`${sujet.address}  déjà attesté, ignoré`);
      continue;
    }

    const nonce = await publicClient.readContract({ address: registre, abi, functionName: "nonces", args: [sujet.address] });

    // Digest calculé par le contrat lui-même : aucune reconstruction locale de
    // l'EIP-712, donc aucun risque de divergence silencieuse.
    const digest = (await publicClient.readContract({
      address: registre,
      abi,
      functionName: "attestationDigest",
      args: [sujet.address, verifieur.address, expiresAt, nonce],
    })) as Hex;

    const signature = await sujet.sign({ hash: digest });

    const hash = await walletClient.writeContract({
      address: registre,
      abi,
      functionName: "attestWithConsent",
      args: [sujet.address, expiresAt, signature],
      chain,
      account: verifieur,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      retryCount: 20,
      retryDelay: 1_500,
      timeout: 120_000,
    });
    if (receipt.status !== "success") throw new Error(`Attestation rejetée pour ${sujet.address} (tx ${hash})`);

    const valide = await publicClient.readContract({ address: registre, abi, functionName: "isKybValid", args: [sujet.address] });
    console.log(`${sujet.address}  attesté ${valide ? "✓" : "— MAIS isKybValid répond faux"}  (tx ${hash})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
