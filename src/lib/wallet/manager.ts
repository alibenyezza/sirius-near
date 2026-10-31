"use client";

import { chainForNetwork, resolveClientNetwork } from "@/lib/evm/networks";
import { clearSelectedWallet, embeddedSelected, embeddedWallet, selectedProvider, selectedWalletRdns } from "@/lib/wallet/discovery";
import { displayAddress } from "@/lib/evm/address";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

function provider(): Eip1193Provider {
  // Le portefeuille explicitement choisi l'emporte toujours. Sans ce détour, on
  // retombe sur `window.ethereum`, un emplacement unique que plusieurs extensions se
  // disputent : celle qui s'injecte en dernier gagne, et l'utilisateur se voit imposer
  // un portefeuille qu'il n'a pas demandé.
  const choisi = selectedProvider();
  if (choisi?.request) return choisi;

  // Un choix explicite qui ne se résout pas interdit le repli : retomber sur
  // `window.ethereum` ferait signer une extension à la place du portefeuille affiché.
  // Le cas embarqué est nommé à part parce qu'il a une cause et un remède précis —
  // la session sociale s'est fermée, il faut la rouvrir — là où une extension
  // simplement pas encore annoncée ne dit rien de tel à l'utilisateur.
  if (embeddedSelected()) throw new Error("Session Google fermée — reconnecte-toi.");
  if (selectedWalletRdns()) throw new Error("Le wallet sélectionné est indisponible.");

  const candidate = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!candidate?.request) throw new Error("Aucun wallet EVM détecté. Installe Phantom, MetaMask, Rabby ou Coinbase Wallet.");
  return candidate;
}

function chainHex(chainId: number): `0x${string}` {
  return `0x${chainId.toString(16)}`;
}

export function expectedChainId(): string {
  return chainHex(chainForNetwork(resolveClientNetwork()).id);
}

export async function ensureExpectedChain(wallet = provider()): Promise<void> {
  const chain = chainForNetwork(resolveClientNetwork());
  const expected = chainHex(chain.id);
  const current = await wallet.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === expected) return;

  // Le portefeuille embarqué ne connaît que les chaînes déclarées à sa configuration : il
  // n'y a rien à lui ajouter, seulement à désigner laquelle est active. Et il le fait par
  // son SDK, pas par une méthode EIP-1193 que son provider n'expose pas.
  const embarque = embeddedSelected() ? embeddedWallet() : null;
  if (embarque) {
    await embarque.switchChain(expected);
    return;
  }

  try {
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expected }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw new Error("Bascule vers Robinhood Chain refusée par le wallet.");
    await wallet.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: expected,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http,
        blockExplorerUrls: chain.blockExplorers?.default.url ? [chain.blockExplorers.default.url] : [],
      }],
    });
  }
}

/**
 * Demande au portefeuille de présenter son sélecteur de comptes.
 *
 * `eth_requestAccounts` ne demande rien quand le site est déjà autorisé : il rend le
 * compte précédent en silence. Un utilisateur qui gère plusieurs comptes se retrouve
 * donc reconnecté au mauvais, sans qu'aucun écran ne lui propose de changer.
 *
 * `wallet_requestPermissions` rouvre ce choix. Tous les portefeuilles ne la
 * connaissent pas : on distingue alors un refus délibéré, qui doit interrompre la
 * connexion, d'une méthode absente, où l'on retombe sur l'ancien comportement.
 */
async function demanderChoixDuCompte(wallet: Eip1193Provider): Promise<void> {
  // Un portefeuille embarqué n'a qu'un compte, dérivé de l'identité sociale : il n'existe
  // aucun sélecteur à rouvrir. Demander la permission afficherait au mieux rien, au pire
  // une erreur là où l'utilisateur attend une connexion.
  if (embeddedSelected()) return;
  try {
    await wallet.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code === 4001) throw new Error("Connexion annulée dans le wallet.");
    // 4200 « unsupported method », -32601 « method not found » : le portefeuille ne
    // sait pas rouvrir le choix, on poursuit avec ce qu'il autorise déjà.
  }
}

export async function connectExternalWallet(wallet = provider()): Promise<{ address: string; chainId: string }> {
  // Le compte d'abord, le réseau ensuite : MetaMask refuse `wallet_switchEthereumChain` (4100)
  // à un site qu'il n'a pas encore autorisé, sans même ouvrir de fenêtre. Un nouveau visiteur
  // ne passait donc jamais l'étape du réseau.
  await demanderChoixDuCompte(wallet);
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("Le wallet n'a renvoyé aucun compte.");
  await ensureExpectedChain(wallet);
  const chainId = await wallet.request({ method: "eth_chainId" });
  if (typeof chainId !== "string") throw new Error("Réseau EVM indisponible.");
  return { address: accounts[0], chainId };
}

export function getExternalWallet(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  // Le portefeuille choisi d'abord : sans ça, la synchronisation et la lecture du
  // solde repartiraient sur `window.ethereum` — donc sur une autre extension que
  // celle avec laquelle l'utilisateur s'est connecté.
  // Un choix explicite interdit le repli, quel qu'il soit : une extension qui ne s'est pas
  // encore annoncée et une session sociale fermée produisent la même situation, et dans les
  // deux cas retomber sur `window.ethereum` ferait signer un compte que rien n'affiche.
  const selected = selectedProvider();
  if (selectedWalletRdns()) return selected;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

export async function disconnectWallet(): Promise<void> {
  // Il n'y a pas de permission à retirer à un portefeuille embarqué — aucune extension ne
  // nous a rien accordé — mais une session du SDK à fermer. Sans cela la révocation
  // échouerait en silence, la session resterait ouverte, et le rechargement suivant
  // reconnecterait l'utilisateur qui venait de partir.
  //
  // Le SDK absent vaut session déjà fermée : c'est le cas d'une reprise qui a échoué, et
  // il n'y a alors rien à fermer. Passer au repli ferait échouer une déconnexion que
  // l'utilisateur a pourtant demandée.
  if (embeddedSelected()) {
    await embeddedWallet()?.logout().catch(() => {});
    // La session sociale est fermée : garder ce choix ferait refuser ensuite toute
    // extension qui ne s'annonce pas en EIP-6963 (« Aucun wallet détecté »).
    clearSelectedWallet();
    return;
  }
  await provider().request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
}

/**
 * Forme d'adresse à présenter au portefeuille.
 *
 * Le projet stocke, compare et signe en minuscules — c'est une règle de sécurité
 * documentée dans `evm/address.ts`, et elle ne change pas. Mais l'adresse passée à
 * `personal_sign`, `eth_signTypedData_v4` ou au champ `from` n'est pas une donnée
 * signée : c'est l'identifiant du compte que l'extension doit retrouver dans sa
 * propre liste, laquelle est en EIP-55. Un portefeuille qui compare littéralement
 * ne trouve alors rien et rejette la demande sans expliquer pourquoi.
 *
 * La frontière avec le portefeuille est donc le seul endroit où l'on repasse en
 * casse mixte, et uniquement pour désigner un compte.
 */
function pourLeWallet(address: string): string {
  try {
    return displayAddress(address);
  } catch {
    // Adresse non conforme : on laisse le portefeuille la refuser lui-même plutôt
    // que d'échouer ici sur une forme qu'il aurait peut-être acceptée.
    return address;
  }
}

function messageHex(message: string): `0x${string}` {
  const bytes = new TextEncoder().encode(message);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function signMessageExternal(message: string, address: string): Promise<{ signature: string }> {
  let signature: unknown;
  try {
    signature = await provider().request({ method: "personal_sign", params: [messageHex(message), pourLeWallet(address)] });
  } catch (error) {
    // Le portefeuille dit toujours pourquoi il refuse — code EIP-1193 et message —
    // mais cette information se perdait ici, et l'utilisateur n'avait qu'un « échec,
    // réessaie » qui ne permet ni de le corriger ni de nous le rapporter.
    throw new Error(descriptionRefus(error));
  }
  if (typeof signature !== "string") throw new Error("Signature EVM refusée par le wallet.");
  return { signature };
}

/** Rend lisible un rejet EIP-1193, dont la forme varie d'une extension à l'autre. */
function descriptionRefus(error: unknown): string {
  const details = error as { code?: unknown; message?: unknown } | null;
  const code = typeof details?.code === "number" ? details.code : null;
  const message = typeof details?.message === "string" ? details.message : String(error);
  if (code === 4001) return "Signature refusée dans le wallet.";
  if (code === 4100) return "Le wallet n'a pas autorisé ce compte pour ce site.";
  if (code === 4901) return "Le wallet n'est connecté à aucun réseau.";
  return code === null ? message : `${message} (code ${code})`;
}

/**
 * Signature EIP-712. Le wallet affiche les champs en clair plutôt qu'un condensé
 * opaque, ce qui permet au signataire de voir ce qu'il approuve — ici son propre
 * consentement KYB, avec le vérificateur et l'échéance nommés.
 */
export async function signTypedDataExternal(payload: unknown, address: string): Promise<string> {
  const wallet = provider();
  await ensureExpectedChain(wallet);
  const signature = await wallet.request({
    method: "eth_signTypedData_v4",
    params: [pourLeWallet(address), JSON.stringify(payload)],
  });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("Signature EIP-712 refusée par le wallet.");
  }
  return signature;
}

export async function sendTransactionExternal(
  transaction: Record<string, unknown>,
  address: string,
  assertCurrent?: () => void,
): Promise<string> {
  const wallet = provider();
  await ensureExpectedChain(wallet);
  assertCurrent?.();
  const hash = await wallet.request({
    method: "eth_sendTransaction",
    params: [{ ...transaction, from: pourLeWallet(address) }],
  });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Transaction EVM refusée par le wallet.");
  return hash;
}

export async function waitForTransactionExternal(
  hash: string,
  pollIntervalMs = 1_000,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Hash de transaction EVM invalide.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Délai de confirmation EVM invalide.");
  const wallet = provider();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const receipt = await wallet.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (receipt && typeof receipt === "object") {
        const status = (receipt as { status?: unknown }).status;
        if (status === "0x1" || status === "0x01") return;
        if (typeof status === "string") throw new Error("Transaction EVM rejetée par la chaîne.");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Transaction EVM rejetée par la chaîne.") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("Transaction EVM toujours en attente de confirmation. Attends avant de relancer l’emprunt.");
    }
    if (pollIntervalMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, pollIntervalMs));
    }
  }
}
