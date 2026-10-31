import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";

/**
 * Invitation KYB : une attestation signée hors ligne par un vérificateur Sirius pour une
 * adresse précise. Le partenaire la colle sur le site et l'accepte lui-même on-chain
 * (`acceptAttestation`) : la clé du vérificateur ne touche jamais un serveur.
 *
 * Le code n'est pas un secret : il ne vaut que pour l'adresse indiquée, ne peut servir
 * qu'une fois (nonce du registre) et expire. Il contient tout ce que le registre vérifie.
 */
export interface KybInvitation {
  v: 1;
  chainId: number;
  registry: Address;
  subject: Address;
  verifier: Address;
  expiresAt: number;
  nonce: string;
  verifierEpoch: string;
  signature: Hex;
}

/** Durée maximale acceptée côté application ; le contrat borne aussi l'expiration. */
export const MAX_INVITATION_DAYS = 365;

export function kybAttestationTypedData(invitation: Omit<KybInvitation, "v" | "signature">) {
  return {
    domain: { name: "SiriusKybRegistry", version: "2", chainId: invitation.chainId, verifyingContract: invitation.registry },
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
      subject: invitation.subject,
      verifier: invitation.verifier,
      expiresAt: invitation.expiresAt,
      nonce: BigInt(invitation.nonce),
      verifierEpoch: BigInt(invitation.verifierEpoch),
    },
  };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function encodeKybInvitation(invitation: KybInvitation): string {
  return `sirius-kyb-${toBase64Url(JSON.stringify(invitation))}`;
}

export function decodeKybInvitation(code: unknown): KybInvitation {
  const invalid = () => new Error("Code d’invitation invalide");
  if (typeof code !== "string" || code.length > 2048 || !code.startsWith("sirius-kyb-")) throw invalid();
  const body = code.slice("sirius-kyb-".length).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw invalid();
  let parsed: Record<string, unknown>;
  try {
    const binary = atob(body.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(body.length / 4) * 4, "="));
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw invalid();
  }
  const { v, chainId, registry, subject, verifier, expiresAt, nonce, verifierEpoch, signature } = parsed;
  if (v !== 1 || !Number.isSafeInteger(chainId) || typeof registry !== "string" || !isAddress(registry)
    || typeof subject !== "string" || !isAddress(subject) || typeof verifier !== "string" || !isAddress(verifier)
    || !Number.isSafeInteger(expiresAt) || typeof nonce !== "string" || !/^[0-9]{1,30}$/.test(nonce)
    || typeof verifierEpoch !== "string" || !/^[0-9]{1,20}$/.test(verifierEpoch)
    || typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw invalid();
  return {
    v: 1, chainId: chainId as number, registry: getAddress(registry), subject: getAddress(subject),
    verifier: getAddress(verifier), expiresAt: expiresAt as number, nonce, verifierEpoch, signature: signature as Hex,
  };
}

/** Vérifie que la signature provient bien du vérificateur annoncé, sans aucune lecture réseau. */
export async function invitationSigner(invitation: KybInvitation): Promise<Address> {
  const { signature, ...fields } = invitation;
  return recoverTypedDataAddress({ ...kybAttestationTypedData(fields), signature });
}
