import "server-only";
import type { Hex } from "viem";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { acceptKybTransaction } from "@/lib/evm/transaction";
import { decodeKybInvitation, invitationSigner, MAX_INVITATION_DAYS } from "@/lib/kyb/invitation";

const KYB_CREDENTIAL_TYPE = "KYB";

async function persistAccepted(subject: string, txHash?: string) {
  const address = normalizeAddress(subject);
  const registry = kybRegistryAddress();
  const attestation = await getPublicClient().readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "attestationOf",
    args: [address],
  });
  return prisma.credential.upsert({
    where: { subject_credType: { subject: address, credType: KYB_CREDENTIAL_TYPE } },
    create: {
      subject: address,
      credType: KYB_CREDENTIAL_TYPE,
      issuer: normalizeAddress(attestation.verifier),
      status: "ACCEPTED",
      txHash,
      acceptedAt: new Date(),
      evmVerifier: normalizeAddress(attestation.verifier),
      evmExpiresAt: new Date(attestation.expiresAt * 1000),
      evmAttestationTxHash: txHash,
    },
    update: {
      issuer: normalizeAddress(attestation.verifier),
      status: "ACCEPTED",
      txHash,
      acceptedAt: new Date(),
      evmVerifier: normalizeAddress(attestation.verifier),
      evmExpiresAt: new Date(attestation.expiresAt * 1000),
      evmAttestationTxHash: txHash,
    },
  });
}

/**
 * Contrôle une invitation KYB contre la chaîne et rend la transaction d'acceptation.
 * Tout ce que le registre vérifiera est vérifié ici d'abord, pour que l'utilisateur ne signe
 * jamais une transaction vouée à échouer : chaîne, registre, adresse, vérificateur actif,
 * époque, nonce courant, expiration et signature.
 */
async function invitationTransaction(subject: string, code: unknown) {
  let invitation;
  try { invitation = decodeKybInvitation(code); } catch { throw new AppError("Code d’invitation invalide", 400); }
  const registry = kybRegistryAddress();
  const { chain } = resolveServerNetwork();
  if (invitation.chainId !== chain.id || !addressesEqual(invitation.registry, registry)) {
    throw new AppError("Invitation KYB émise pour un autre réseau ou un autre registre", 409);
  }
  if (!addressesEqual(invitation.subject, subject)) throw new AppError("Invitation KYB destinée à une autre adresse", 403);
  const now = Math.floor(Date.now() / 1000);
  if (invitation.expiresAt <= now + 3600 || invitation.expiresAt > now + MAX_INVITATION_DAYS * 86_400) {
    throw new AppError("Invitation KYB expirée ou hors durée autorisée", 409);
  }
  const signer = await invitationSigner(invitation).catch(() => null);
  if (!signer || !addressesEqual(signer, invitation.verifier)) throw new AppError("Signature de l’invitation KYB invalide", 400);
  const client = getPublicClient();
  const read = (functionName: "isVerifier" | "verifierEpoch" | "nonces", account: string) =>
    client.readContract({ address: registry, abi: siriuskybregistryAbi, functionName, args: [account as Hex] });
  const [active, epoch, nonce] = await Promise.all([
    read("isVerifier", invitation.verifier), read("verifierEpoch", invitation.verifier), read("nonces", subject),
  ]);
  if (!active) throw new AppError("Vérificateur de l’invitation KYB non autorisé", 409);
  if (String(epoch) !== invitation.verifierEpoch || String(nonce) !== invitation.nonce) {
    throw new AppError("Invitation KYB périmée : demande une nouvelle invitation", 409);
  }
  return acceptKybTransaction({ verifier: invitation.verifier, expiresAt: invitation.expiresAt, verifierSignature: invitation.signature });
}

export async function prepareKybAcceptance(subject: string, invitation?: unknown) {
  const address = normalizeAddress(subject);
  const registry = kybRegistryAddress();
  const publicClient = getPublicClient();
  const alreadyValid = await publicClient.readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [address],
  });
  // Avec une invitation, une attestation encore valide est remplacée (renouvellement) : le
  // registre accepte une nouvelle attestation à tout moment et `kyb-invite.ts` le prévient.
  if (alreadyValid && invitation === undefined) {
    await persistAccepted(address);
    return { subject: address, status: "ACCEPTED" as const, transaction: null };
  }
  if (invitation !== undefined) {
    return { subject: address, status: "PENDING" as const, transaction: await invitationTransaction(address, invitation) };
  }
  throw new AppError("KYB externe requis avant toute attestation on-chain", 503);
}

export async function finalizeKybAcceptance(subject: string, txHash?: string, transactionSender = subject) {
  const address = normalizeAddress(subject);
  const registry = kybRegistryAddress();
  const publicClient = getPublicClient();
  if (txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new AppError("Hash de transaction KYB invalide", 400);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 });
    if (receipt.status !== "success") throw new AppError("Transaction KYB rejetée", 409);
    const transaction = await publicClient.getTransaction({ hash: txHash as Hex });
    if (!addressesEqual(transaction.from, normalizeAddress(transactionSender)) || !addressesEqual(transaction.to ?? "", registry)) {
      throw new AppError("Transaction KYB non émise par le wallet connecté", 403);
    }
  }
  const valid = await publicClient.readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [address],
  });
  if (!valid) throw new AppError("Attestation KYB EVM non confirmée", 409);
  await persistAccepted(address, txHash);
  return { subject: address, status: "ACCEPTED" as const, txHash };
}
