import { hashMessage, recoverAddress, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { addressesEqual, normalizeAddress, type CanonicalAddress } from "./address";

/**
 * Vérification des signatures de wallet EVM. `ecrecover` reconstruit l'adresse
 * depuis la seule signature EIP-191 ; aucun export de clé publique n'est requis.
 */

/** Signature EIP-191 : 65 octets (r‖s‖v) en hexadécimal. */
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

export interface WalletSignatureInput {
  /** Adresse revendiquée par le client. */
  address: unknown;
  /** Signature `personal_sign` du message exact. */
  signature: unknown;
  /** Message signé, littéralement celui renvoyé par `/api/auth/challenge`. */
  message: string;
}

function assertSignatureShape(signature: unknown): Hex {
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    throw new AppError("Signature invalide", 401);
  }
  return signature as Hex;
}

/**
 * Récupère l'adresse signataire d'un message EIP-191.
 * Purement local : aucun appel réseau, donc utilisable depuis l'enclave TEE
 * sans lui ouvrir d'accès sortant.
 */
export async function recoverWalletAddress(message: string, signature: unknown): Promise<CanonicalAddress> {
  const hex = assertSignatureShape(signature);
  let recovered: string;
  try {
    recovered = await recoverAddress({ hash: hashMessage(message), signature: hex });
  } catch {
    throw new AppError("Signature invalide", 401);
  }
  return normalizeAddress(recovered);
}

/**
 * Prouve que `address` a signé `message`. Lève une 401 sinon.
 * Équivalent EOA de `verifyWalletSignature`, sans clé publique à fournir.
 */
export async function verifyWalletSignature({
  address,
  signature,
  message,
}: WalletSignatureInput): Promise<CanonicalAddress> {
  const claimed = normalizeAddress(address);
  const recovered = await recoverWalletAddress(message, signature);
  if (!addressesEqual(claimed, recovered)) throw new AppError("Signature invalide", 401);
  return claimed;
}

/** Le login doit produire la même preuve EOA que les délégations du runner. */
export async function verifyLoginSignature(input: WalletSignatureInput): Promise<CanonicalAddress> {
  try {
    return await verifyWalletSignature(input);
  } catch {
    throw new AppError("Le wallet doit signer directement avec ce compte. Les comptes contractuels ne sont pas pris en charge.", 401);
  }
}
