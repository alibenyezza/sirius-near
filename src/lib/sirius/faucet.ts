import "server-only";
import { createWalletClient, formatEther, http, parseEther, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppError } from "@/lib/errors";
import { isDemoDeployment } from "@/lib/deployment-mode";
import { normalizeAddress } from "@/lib/evm/address";
import { usdcAddress } from "@/lib/evm/addresses";
import { getPublicClient } from "@/lib/evm/client";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { USDC_DECIMALS } from "@/lib/evm/usdc";

/**
 * Distribution de fonds de test, réservée aux instances de démonstration.
 *
 * Le bouton « Ajouter des fonds » ouvrait MoonPay, un service d'achat par carte
 * bancaire. Sur un réseau de test, ça n'a pas de sens : MoonPay vend du vrai USDC sur
 * de vraies chaînes, pas le jeton à frappe ouverte déployé ici. Le bouton échouait
 * donc doublement — clés absentes, et opération dénuée d'objet.
 *
 * Or sans fonds, un visiteur ne peut rien faire du produit : il se connecte, découvre
 * un solde nul, et repart. Cette route est ce qui rend l'instance publique utilisable
 * plutôt que seulement regardable.
 *
 * Deux ressources sont servies, parce qu'il en faut deux pour emprunter : l'USDC de
 * test, frappé, et un peu d'ETH natif pour payer le gas — que la frappe ne procure
 * pas. L'ETH sort d'un compte que nous alimentons, il est donc rationné.
 */

const MONTANT_USDC = "1000";
const MONTANT_ETH = "0.0002";
/** En dessous de ce solde, le visiteur ne peut plus payer ses transactions. */
const SEUIL_ETH = parseEther("0.00005");
/** Réserve du distributeur en dessous de laquelle on refuse plutôt que d'échouer à mi-course. */
const RESERVE_MINIMALE = parseEther("0.0005");
/** En dessous, on prévient avant de refuser : le temps de recharger, pas de constater. */
const RESERVE_ALERTE = parseEther("0.004");
let distributionQueue: Promise<void> = Promise.resolve();

function enqueueDistribution<T>(operation: () => Promise<T>): Promise<T> {
  const queued = distributionQueue.catch(() => {}).then(operation);
  distributionQueue = queued.then(() => {}, () => {});
  return queued;
}

function distributeurAccount() {
  // Clé dédiée, sans repli sur celle du vérificateur KYB.
  //
  // Les deux rôles ont longtemps partagé un compte : la maison paie le gas dans les deux
  // cas, et sur une démonstration la distinction paraissait cosmétique. Elle ne l'est
  // pas. Le faucet est la seule dépense qu'un visiteur déclenche librement ; l'attestation
  // KYB est ce qui lui ouvre l'emprunt comme la publication. Les confondre revient à
  // laisser n'importe qui, en vidant la réserve, retirer le KYB à tout le monde — une
  // panne dont la cause n'a aucun rapport visible avec son effet.
  //
  // La séparation devient pressante dès que créer un compte ne demande plus d'installer
  // un portefeuille.
  const key = process.env.SIRIUS_FAUCET_KEY?.trim();
  if (!key) throw new AppError("Distribution indisponible : aucun compte distributeur configuré", 503);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new AppError("Clé du distributeur malformée", 500);
  return privateKeyToAccount(key as Hex);
}

export function faucetAvailable(): boolean {
  return isDemoDeployment() && Boolean(process.env.SIRIUS_FAUCET_KEY?.trim());
}

export interface FaucetResult {
  usdcTxHash: string;
  ethTxHash: string | null;
  usdc: string;
  eth: string | null;
}

async function distribuerFondsDeTestEnSerie(destinataire: string): Promise<FaucetResult> {
  if (!isDemoDeployment()) throw new AppError("Réservé aux instances de démonstration", 403);

  const address = normalizeAddress(destinataire);
  const { chain, rpcUrl } = resolveServerNetwork();
  const publicClient = getPublicClient();
  const account = distributeurAccount();
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // On vérifie la réserve avant d'écrire quoi que ce soit : un distributeur à sec qui
  // frappe l'USDC puis échoue sur l'ETH laisserait le visiteur avec des jetons qu'il
  // ne peut pas dépenser, ce qui est pire que de ne rien lui donner.
  const reserve = await publicClient.getBalance({ address: account.address });
  if (reserve < RESERVE_ALERTE) {
    // Journal seulement : sur un hébergeur serverless c'est le seul canal qui survit à la
    // requête, et une alerte n'a pas à interrompre la distribution en cours.
    console.warn(`[faucet] réserve basse : ${formatEther(reserve)} ETH — recharger ${account.address}`);
  }
  if (reserve < RESERVE_MINIMALE) {
    throw new AppError(
      `Distributeur épuisé (${formatEther(reserve)} ETH) — préviens l'équipe pour qu'elle le recharge`,
      503,
    );
  }

  const mintAbi = [
    {
      name: "mint",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [],
    },
  ] as const;

  const usdcTxHash = await wallet.writeContract({
    address: usdcAddress(),
    abi: mintAbi,
    functionName: "mint",
    args: [address, parseUnits(MONTANT_USDC, USDC_DECIMALS)],
    chain,
    account,
  });
  const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcTxHash, confirmations: 1 });
  if (usdcReceipt.status !== "success") throw new AppError("Frappe rejetée par la chaîne", 502);

  // On n'envoie de l'ETH qu'à qui en manque : le renvoyer à chaque appel viderait la
  // réserve au profit de gens déjà pourvus.
  const soldeEth = await publicClient.getBalance({ address });
  let ethTxHash: Hex | null = null;
  if (soldeEth < SEUIL_ETH) {
    ethTxHash = await wallet.sendTransaction({
      to: address,
      value: parseEther(MONTANT_ETH),
      chain,
      account,
    });
    const ethReceipt = await publicClient.waitForTransactionReceipt({ hash: ethTxHash, confirmations: 1 });
    if (ethReceipt.status !== "success") throw new AppError("Transfert ETH rejeté par la chaîne", 502);
  }

  return {
    usdcTxHash,
    ethTxHash,
    usdc: MONTANT_USDC,
    eth: ethTxHash ? MONTANT_ETH : null,
  };
}

export function distribuerFondsDeTest(destinataire: string): Promise<FaucetResult> {
  return enqueueDistribution(() => distribuerFondsDeTestEnSerie(destinataire));
}
