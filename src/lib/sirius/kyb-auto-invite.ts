import "server-only";
import { createWalletClient, http, type Address } from "viem";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/app-error";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";
import { resolveServerNetwork } from "@/lib/evm/networks";
import {
  autoInviteSigner, issueAutoInvitation, prepareSponsoredAttestation, readAutoInviteConfig, revokeAutoAttestation,
  submitSponsoredAttestation,
  type AutoInviteIssuances, type AutoInviteRegistry, type AutoInviteResult, type AutoSponsorChain, type SponsoredAttestationRequest,
} from "@/lib/kyb/auto-invite";
import type { AutoInviteRetentionStore } from "@/lib/kyb/auto-invite-retention";
import { finalizeKybAcceptance } from "@/lib/sirius/kyb";
import { readUserProfile } from "@/lib/users/profile";

/** Branchement de l'accès instantané sur la chaîne et la base ; la logique vit dans `@/lib/kyb/auto-invite`. */

function chainRegistry(): AutoInviteRegistry {
  const client = getPublicClient();
  const address = kybRegistryAddress();
  return {
    version: () => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "VERSION" }),
    isVerifier: (verifier) => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "isVerifier", args: [verifier] }),
    verifierEpoch: (verifier) => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "verifierEpoch", args: [verifier] }),
    nonces: (subject) => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "nonces", args: [subject] }),
    isKybValid: (subject) => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "isKybValid", args: [subject] }),
    attestationOf: async (subject) => {
      const attestation = await client.readContract({ address, abi: siriuskybregistryAbi, functionName: "attestationOf", args: [subject] });
      return { verifier: attestation.verifier, expiresAt: Number(attestation.expiresAt), revoked: attestation.revoked };
    },
  };
}

/** Lignes conservées 48 h au plus (purge du reaper) ; l'IP n'y est que pour le plafond horaire. */
const databaseIssuances: AutoInviteIssuances = {
  record: async (subject, code, ip, issuedAt, expiresAt) =>
    (await prisma.kybAutoInvite.create({ data: { subject, code, ip, createdAt: issuedAt, expiresAt }, select: { id: true } })).id,
  latestForSubjectSince: (subject, since) =>
    prisma.kybAutoInvite.findFirst({ where: { subject, createdAt: { gt: since } }, orderBy: { createdAt: "desc" }, select: { code: true } }),
  countForSubjectSince: (subject, since) => prisma.kybAutoInvite.count({ where: { subject, createdAt: { gt: since } } }),
  countForIpSince: (ip, since) => prisma.kybAutoInvite.count({ where: { ip, createdAt: { gt: since } } }),
  countSince: (since) => prisma.kybAutoInvite.count({ where: { createdAt: { gt: since } } }),
  remove: async (id) => { await prisma.kybAutoInvite.deleteMany({ where: { id } }); },
};

/** Blocage côté site : posé par l'admin dans `UserProfile.blockedAt`, lu par le helper de profil. */
async function profileBlocked(subject: string): Promise<boolean> {
  const profile = await readUserProfile(subject);
  return profile?.blockedAt !== null && profile?.blockedAt !== undefined;
}

/** Invitation pour le wallet de la session : l'adresse ne vient jamais de la requête. */
export function issueSessionAutoInvitation(subject: string, ip: string | null): Promise<AutoInviteResult> {
  return issueAutoInvitation(subject, sessionDependencies(ip));
}

function sessionDependencies(ip: string | null) {
  const { chain } = resolveServerNetwork();
  return {
    config: readAutoInviteConfig(),
    registry: chainRegistry(),
    issuances: databaseIssuances,
    isBlocked: profileBlocked,
    chainId: chain.id,
    registryAddress: kybRegistryAddress() as Address,
    ip,
  };
}

/** Consentement à faire signer par le wallet de la session : l'adresse ne vient jamais de la requête. */
export function prepareSessionSponsoredAttestation(subject: string, ip: string | null): Promise<SponsoredAttestationRequest> {
  return prepareSponsoredAttestation(subject, sessionDependencies(ip));
}

// Une seule transaction du vérificateur à la fois par instance : deux envois simultanés
// prendraient le même nonce de compte et l'un des deux échouerait.
let sponsorQueue: Promise<void> = Promise.resolve();

function enqueueSponsor<T>(operation: () => Promise<T>): Promise<T> {
  const queued = sponsorQueue.catch(() => {}).then(operation);
  sponsorQueue = queued.then(() => {}, () => {});
  return queued;
}

const sponsorChain: AutoSponsorChain = {
  balanceOf: (address) => getPublicClient().getBalance({ address }),
  attest: (subject, expiresAt, subjectSignature) => enqueueSponsor(async () => {
    const signer = autoInviteSigner();
    if (!signer) throw new AppError("Vérificateur automatique non configuré", 404);
    const registry = kybRegistryAddress();
    const { chain, rpcUrl } = resolveServerNetwork();
    const publicClient = getPublicClient();
    // Simulée d'abord : une signature que le contrat refuserait ne coûte aucun gas.
    const { request } = await publicClient.simulateContract({
      address: registry, abi: siriuskybregistryAbi, functionName: "attestWithConsent",
      args: [subject, expiresAt, subjectSignature], account: signer, chain,
    }).catch(() => { throw new AppError("Attestation refusée par le registre", 409); });
    const wallet = createWalletClient({ account: signer, chain, transport: http(rpcUrl) });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new AppError("Attestation rejetée par la chaîne", 502);
    return hash;
  }),
};

/**
 * Attestation parrainée du wallet de la session, puis le même enregistrement applicatif
 * qu'après une attestation acceptée (`finalizeKybAcceptance`, qui relit `isKybValid`).
 */
export async function submitSessionSponsoredAttestation(subject: string, ip: string | null, expiresAt: number, signature: string) {
  const result = await submitSponsoredAttestation(subject, expiresAt, signature, { ...sessionDependencies(ip), sponsorChain });
  await finalizeKybAcceptance(result.subject, result.txHash, result.verifier);
  return result;
}

/**
 * Révocation par un administrateur d'une attestation du vérificateur automatique : transaction
 * `revoke(subject)` signée par la clé, confirmée, puis relue sur le registre avant de répondre.
 * Le cache applicatif (`Credential`) suit la chaîne, source de vérité.
 */
export async function revokeSessionAutoAttestation(subject: string, admin: string): Promise<{ subject: Address; txHash: `0x${string}` }> {
  const signer = autoInviteSigner();
  const registry = kybRegistryAddress();
  const { chain, rpcUrl } = resolveServerNetwork();
  const publicClient = getPublicClient();
  const result = await revokeAutoAttestation(subject, {
    signer,
    registry: chainRegistry(),
    admin,
    balanceOf: (address) => publicClient.getBalance({ address }),
    sendRevoke: async (target) => {
      if (!signer) throw new AppError("Vérificateur automatique non configuré", 404);
      const wallet = createWalletClient({ account: signer, chain, transport: http(rpcUrl) });
      const hash = await wallet.writeContract({ address: registry, abi: siriuskybregistryAbi, functionName: "revoke", args: [target], chain, account: signer });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new AppError("Révocation rejetée par la chaîne", 502);
      const attestation = await publicClient.readContract({ address: registry, abi: siriuskybregistryAbi, functionName: "attestationOf", args: [target] });
      if (!attestation.revoked) throw new AppError("Révocation posée mais le registre ne la reflète pas", 502);
      return hash;
    },
  });
  await prisma.credential.updateMany({
    where: { subject: result.subject.toLowerCase(), credType: "KYB" },
    data: { status: "REVOKED", txHash: result.txHash },
  });
  return result;
}

/** Stockage Prisma de la purge : sélection bornée par l'index `createdAt`, suppression par clé primaire. */
export const databaseAutoInviteRetention: AutoInviteRetentionStore = {
  expiredIds: async (before, limit) => (await prisma.kybAutoInvite.findMany({
    where: { createdAt: { lt: before } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  })).map((row) => row.id),
  deleteIds: async (ids) => (await prisma.kybAutoInvite.deleteMany({ where: { id: { in: ids } } })).count,
};
