import "server-only";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppError } from "@/lib/errors";
import { isDemoDeployment } from "@/lib/deployment-mode";
import { normalizeAddress } from "@/lib/evm/address";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";
import { resolveServerNetwork } from "@/lib/evm/networks";

/**
 * Attestation KYB parrainée, réservée aux instances de démonstration.
 *
 * `SiriusEscrow.lock` exige une attestation valide pour les deux parties, et rien dans
 * l'interface ne mène à ce geste : un visiteur connecte son wallet, tente d'emprunter,
 * et bute sur un mur. Sans ce chemin, une instance publique se regarde mais ne
 * s'utilise pas.
 *
 * Le contrat prévoit exactement ce cas — sa documentation parle de « when Sirius
 * sponsors the gas » : le sujet signe son consentement hors chaîne, le vérificateur
 * envoie la transaction et paie. Le visiteur n'a donc besoin d'aucun ETH.
 *
 * Ce que ça signifie, et il faut le nommer : en démonstration, le KYB devient une
 * formalité automatique. Le registre fonctionne toujours — signature EIP-712,
 * consentement explicite, expiration, révocation — mais plus personne ne vérifie
 * d'entreprise derrière. C'est acceptable sur un réseau de test, et ce le serait
 * beaucoup moins ailleurs : `instrumentation-node.ts` interdit d'ailleurs le mode
 * démonstration sur mainnet.
 */

const VALIDITE_JOURS = 30;
let attestationQueue: Promise<void> = Promise.resolve();

function enqueueAttestation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = attestationQueue.catch(() => {}).then(operation);
  attestationQueue = queued.then(() => {}, () => {});
  return queued;
}

function verifierAccount() {
  const key = process.env.SIRIUS_KYB_VERIFIER_KEY?.trim();
  if (!key) {
    throw new AppError("Attestation de démonstration indisponible : aucun vérificateur configuré", 503);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new AppError("SIRIUS_KYB_VERIFIER_KEY malformée", 500);
  }
  return privateKeyToAccount(key as Hex);
}

export function demoAttestationAvailable(): boolean {
  return isDemoDeployment() && Boolean(process.env.SIRIUS_KYB_VERIFIER_KEY?.trim());
}

/**
 * Ce que le navigateur doit signer.
 *
 * Le nonce vient de la chaîne : il change à chaque révocation, ce qui empêche de
 * rejouer une attestation révoquée. Renvoyer le domaine complet évite au client de le
 * reconstruire, et donc de diverger d'un octet sans que rien ne le signale.
 */
export async function prepareDemoAttestation(subject: string) {
  if (!isDemoDeployment()) throw new AppError("Réservé aux instances de démonstration", 403);
  const address = normalizeAddress(subject);
  const registry = kybRegistryAddress();
  const verifier = verifierAccount();
  const { chain } = resolveServerNetwork();

  const client = getPublicClient();
  const version = await client.readContract({ address: registry, abi: siriuskybregistryAbi, functionName: "VERSION" });
  if (version !== "sirius-kyb-v3") throw new AppError("Migration du registre KYB requise", 503);
  const epoch = await client.readContract({ address: registry, abi: siriuskybregistryAbi, functionName: "verifierEpoch", args: [verifier.address] });
  const nonce = await getPublicClient().readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "nonces",
    args: [address],
  });

  const expiresAt = Math.floor(Date.now() / 1000) + VALIDITE_JOURS * 86_400;

  return {
    domain: {
      name: "SiriusKybRegistry",
      version: "2",
      chainId: chain.id,
      verifyingContract: registry,
    },
    types: {
      KybAttestation: [
        { name: "subject", type: "address" },
        { name: "verifier", type: "address" },
        { name: "expiresAt", type: "uint40" },
        { name: "nonce", type: "uint256" },
        { name: "verifierEpoch", type: "uint64" },
      ],
    },
    primaryType: "KybAttestation" as const,
    message: {
      subject: address,
      verifier: normalizeAddress(verifier.address),
      expiresAt,
      nonce: (nonce as bigint).toString(),
      verifierEpoch: epoch.toString(),
    },
  };
}

/** Pose l'attestation on-chain avec la signature du sujet. Le vérificateur paie le gas. */
async function submitDemoAttestationEnSerie(subject: string, expiresAt: number, signature: string) {
  if (!isDemoDeployment()) throw new AppError("Réservé aux instances de démonstration", 403);
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new AppError("Signature malformée", 400);

  const address = normalizeAddress(subject);
  const registry = kybRegistryAddress();
  const verifier = verifierAccount();
  const { chain, rpcUrl } = resolveServerNetwork();
  const publicClient = getPublicClient();

  const dejaValide = await publicClient.readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [address],
  });
  if (dejaValide) return { subject: address, status: "ACCEPTED" as const, txHash: null, verifier: verifier.address };

  const wallet = createWalletClient({ account: verifier, chain, transport: http(rpcUrl) });
  const hash = await wallet.writeContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "attestWithConsent",
    args: [address, expiresAt, signature as Hex],
    chain,
    account: verifier,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new AppError("Attestation rejetée par la chaîne", 502);

  // On relit plutôt que de faire confiance au reçu : une transaction réussie qui
  // laisserait le sujet invalide signalerait un tout autre problème, et le laisser
  // passer produirait un échec incompréhensible au moment du verrouillage.
  const valide = await publicClient.readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [address],
  });
  if (!valide) throw new AppError("Attestation posée mais le registre la juge invalide", 502);

  return { subject: address, status: "ACCEPTED" as const, txHash: hash, verifier: verifier.address };
}

export function submitDemoAttestation(subject: string, expiresAt: number, signature: string) {
  return enqueueAttestation(() => submitDemoAttestationEnSerie(subject, expiresAt, signature));
}
