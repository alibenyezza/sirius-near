import "server-only";
import type { Hex } from "viem";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { DatasetStatus } from "@/generated/prisma/client";
import { addressesEqual, isZeroAddress, normalizeAddress } from "@/lib/evm/address";
import { datasetRegistryAddress } from "@/lib/evm/addresses";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { getPublicClient } from "@/lib/evm/client";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { requireCurrentEvmDeployment } from "@/lib/evm/deployment";
import { cidHash, datasetIdHash, merkleRootAsBytes32 } from "@/lib/evm/dataset-key";
import { destroyDatasetTransaction, mintDatasetTransaction } from "@/lib/evm/transaction";
import { unpinFromIpfs } from "@/lib/ipfs/pinata";
import { modelSelection, trainingProfileHash } from "@/lib/models/registry";
import { requireAcceptedKyb } from "./access";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { rebasedListingExpiry } from "@/lib/datasets/publication";

export const VISIBILITY_STATES = ["LISTED", "UNLISTED", "PRIVATE"] as const;
export type Visibility = (typeof VISIBILITY_STATES)[number];
export const BORROWABLE_STATUSES = ["LISTED", "UNLISTED"] satisfies readonly DatasetStatus[];

export function isBorrowableDatasetStatus(status: DatasetStatus): boolean {
  return (BORROWABLE_STATUSES as readonly DatasetStatus[]).includes(status);
}

async function ownedDataset(datasetId: string, provider: string) {
  // `wrappedKey` est retirée de toute lecture par le `omit` global de `db.ts`, pour
  // qu'elle ne puisse jamais partir dans une réponse d'API. Les contrôles ci-dessous
  // vérifient qu'elle EXISTE — sur un objet d'où elle vient d'être supprimée, ils
  // échouaient donc systématiquement, et aucun dataset ne pouvait être publié,
  // emprunté ni réglé. On la réinclut ici, comme le prévoit `db.ts` : cet objet ne
  // quitte pas le serveur.
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId }, omit: { wrappedKey: false } });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (!addressesEqual(dataset.provider, provider)) throw new AppError("Wallet ≠ provider du dataset", 403);
  return dataset;
}

function listingTerms(dataset: Awaited<ReturnType<typeof ownedDataset>>) {
  if (!dataset.ipfsCid || !dataset.merkleRoot || !dataset.wrappedKey || !dataset.runnerReceipt || !dataset.sizeBytes) {
    throw new AppError("Dataset incomplet ou reçu runner absent", 409);
  }
  const model = modelSelection(dataset.modelId, dataset.modelVersion);
  if (!model) throw new AppError("Profil d’entraînement du dataset absent ou invalide", 409);
  // Même conversion que partout ailleurs, via la fonction partagée : la dupliquer
  // est précisément ce qui a laissé le contrôle diverger entre deux fichiers.
  let racineEvm: Hex;
  try {
    racineEvm = merkleRootAsBytes32(dataset.merkleRoot);
  } catch {
    throw new AppError("Racine Merkle EVM invalide", 409);
  }
  return {
    datasetId: dataset.id,
    cid: dataset.ipfsCid,
    merkleRoot: racineEvm,
    sizeBytes: dataset.sizeBytes,
    trainingProfile: trainingProfileHash(model),
  };
}

async function onChainDatasetId(terms: ReturnType<typeof listingTerms>, provider: string): Promise<Hex | null> {
  const client = getPublicClient();
  const registry = datasetRegistryAddress();
  const onChainId = await client.readContract({
    address: registry,
    abi: siriusdatasetregistryAbi,
    functionName: "datasetIdOf",
    args: [normalizeAddress(provider), datasetIdHash(terms.datasetId)],
  });
  const live = await client.readContract({
    address: registry,
    abi: siriusdatasetregistryAbi,
    functionName: "isLive",
    args: [onChainId],
  });
  if (!live) {
    const onChainDataset = await client.readContract({
      address: registry,
      abi: siriusdatasetregistryAbi,
      functionName: "getDataset",
      args: [onChainId],
    }).catch(() => null);
    if (!onChainDataset || isZeroAddress(onChainDataset.provider)) return null;
    throw new AppError("Titre EVM déjà détruit : crée un nouveau dataset", 409);
  }
  const matchesScope = await client.readContract({
    address: registry,
    abi: siriusdatasetregistryAbi,
    functionName: "matchesScope",
    args: [onChainId, normalizeAddress(provider), terms.merkleRoot, cidHash(terms.cid), terms.trainingProfile],
  });
  if (!matchesScope) throw new AppError("Titre EVM existant hors scope du dataset", 409);
  return onChainId;
}

async function markDatasetListed(
  dataset: Awaited<ReturnType<typeof ownedDataset>>,
  onChainId: Hex,
  mint?: { txHash: string; blockNumber: bigint },
) {
  // La durée de publication choisie à l'upload court depuis la mise en ligne, pas depuis
  // la création du brouillon : un brouillon scellé peut attendre des jours avant la
  // signature du titre. Même durée, nouveau point de départ (`rebasedListingExpiry`).
  const listedAt = new Date();
  const listingExpiresAt = rebasedListingExpiry(dataset, listedAt);
  const updated = await prisma.dataset.updateMany({
    where: { id: dataset.id, provider: normalizeAddress(dataset.provider), status: "DRAFT", evmDatasetId: null },
    data: {
      status: process.env.SIRIUS_PHALA_DEMO === "true" ? "PRIVATE" : "LISTED",
      ...(process.env.SIRIUS_PHALA_DEMO === "true" ? {} : { listedAt, ...(listingExpiresAt ? { listingExpiresAt } : {}) }),
      evmDatasetId: onChainId,
      evmChainId: resolveServerNetwork().chain.id,
      ...(mint ? { evmMintTxHash: mint.txHash, evmMintBlock: mint.blockNumber.toString() } : {}),
    },
  });
  if (updated.count !== 1) throw new AppError("Publication EVM concurrente", 409);
  return prisma.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
}

export async function prepareDatasetListing(datasetId: string, provider: string) {
  await requireCurrentEvmDeployment();
  const dataset = await ownedDataset(datasetId, provider);
  if (process.env.SIRIUS_PHALA_DEMO === "true" && dataset.status === "PRIVATE" && dataset.evmDatasetId) return { reconciled: true as const };
  if (dataset.status === "LISTED" && dataset.evmDatasetId) throw new AppError("Dataset déjà publié", 409);
  if (dataset.status !== "DRAFT") throw new AppError("Seul un dataset DRAFT rescellé peut être publié", 409);
  await requireAcceptedKyb(provider);
  await assertCurrentRunner(dataset);
  const terms = listingTerms(dataset);
  const onChainId = await onChainDatasetId(terms, provider);
  if (onChainId) {
    await markDatasetListed(dataset, onChainId);
    return { reconciled: true as const };
  }
  return { transaction: mintDatasetTransaction(terms) };
}

export async function finalizeDatasetListing(datasetId: string, provider: string, txHash?: string) {
  await requireCurrentEvmDeployment();
  const dataset = await ownedDataset(datasetId, provider);
  if ((dataset.status === "LISTED" || (process.env.SIRIUS_PHALA_DEMO === "true" && dataset.status === "PRIVATE")) && dataset.evmDatasetId) return dataset;
  if (dataset.status !== "DRAFT") throw new AppError("Seul un dataset DRAFT rescellé peut être publié", 409);
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new AppError("Hash de mint EVM manquant", 400);
  await requireAcceptedKyb(provider);
  await assertCurrentRunner(dataset);
  const terms = listingTerms(dataset);
  const registry = datasetRegistryAddress();
  const publicClient = getPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 });
  const transaction = await publicClient.getTransaction({ hash: txHash as Hex });
  if (receipt.status !== "success" || !addressesEqual(transaction.from, provider) || !addressesEqual(transaction.to ?? "", registry)) {
    throw new AppError("Transaction de titre EVM invalide", 409);
  }
  const onChainId = await onChainDatasetId(terms, provider);
  if (!onChainId) throw new AppError("Titre EVM absent après le mint", 409);
  return markDatasetListed(dataset, onChainId, { txHash, blockNumber: receipt.blockNumber });
}

export async function prepareDatasetDestruction(datasetId: string, provider: string) {
  const dataset = await ownedDataset(datasetId, provider);
  const activeLoan = await prisma.loan.findFirst({
    where: { datasetId, status: { in: ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] } },
    select: { id: true },
  });
  if (activeLoan) throw new AppError("Suppression impossible : emprunt actif", 409);
  if (!dataset.evmDatasetId) {
    if (dataset.status === "DRAFT" || dataset.status === "DELETED") return null;
    throw new AppError("Titre EVM absent", 409);
  }
  await requireCurrentEvmDeployment();
  const live = await getPublicClient().readContract({
    address: datasetRegistryAddress(),
    abi: siriusdatasetregistryAbi,
    functionName: "isLive",
    args: [dataset.evmDatasetId as Hex],
  });
  if (!live) return null;
  return destroyDatasetTransaction(datasetId);
}

export async function deleteDataset(datasetId: string, provider: string, txHash?: string) {
  const dataset = await ownedDataset(datasetId, provider);
  if (!dataset.evmDatasetId && (txHash || (dataset.status !== "DRAFT" && dataset.status !== "DELETED"))) {
    throw new AppError("Titre EVM absent", 409);
  }
  if (dataset.evmDatasetId) {
    await requireCurrentEvmDeployment();
    const registry = datasetRegistryAddress();
    const publicClient = getPublicClient();
    if (txHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new AppError("Hash de tombstone EVM invalide", 400);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 });
      const transaction = await publicClient.getTransaction({ hash: txHash as Hex });
      if (receipt.status !== "success" || !addressesEqual(transaction.from, provider) || !addressesEqual(transaction.to ?? "", registry)) {
        throw new AppError("Transaction de tombstone EVM invalide", 409);
      }
    }
    const datasetIdOnChain = dataset.evmDatasetId as Hex;
    const live = await publicClient.readContract({
      address: registry,
      abi: siriusdatasetregistryAbi,
      functionName: "isLive",
      args: [datasetIdOnChain],
    });
    if (live) throw new AppError("Tombstone EVM non confirmé", 409);
  }

  if (dataset.status === "DELETED") {
    if (dataset.deletionReconciledAt && (!txHash || dataset.evmDestroyTxHash)) return dataset;
    const finalized = await prisma.dataset.updateMany({
      where: {
        id: datasetId,
        provider: normalizeAddress(provider),
        status: "DELETED",
        evmDestroyTxHash: dataset.evmDestroyTxHash,
        deletionReconciledAt: dataset.deletionReconciledAt,
        loans: { none: { status: { in: ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] } } },
      },
      // Un titre absent du registre courant ne prouve pas sa destruction sur un ancien registre.
      data: {
        deletionReconciledAt: dataset.deletionReconciledAt ?? new Date(),
        ...(txHash && !dataset.evmDestroyTxHash ? { evmDestroyTxHash: txHash } : {}),
      },
    });
    if (finalized.count !== 1) throw new AppError("Finalisation du titre EVM concurrente", 409);
    return prisma.dataset.findUniqueOrThrow({ where: { id: datasetId } });
  }

  const deleted = await prisma.dataset.updateMany({
    where: {
      id: datasetId,
      provider: normalizeAddress(provider),
      status: dataset.status,
      loans: { none: { status: { in: ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] } } },
    },
    data: {
      wrappedKey: null,
      status: "DELETED",
      keyDestroyedAt: new Date(),
      deletionReconciledAt: new Date(),
      ...(txHash ? { evmDestroyTxHash: txHash } : {}),
    },
  });
  if (deleted.count !== 1) throw new AppError("Suppression impossible : emprunt actif ou état modifié", 409);
  if (dataset.ipfsCid) {
    await unpinFromIpfs(dataset.ipfsCid).catch(() => console.error(`[dataset] unpin ${datasetId} échoué`));
  }
  return prisma.dataset.findUniqueOrThrow({ where: { id: datasetId } });
}

export async function setDatasetVisibility(datasetId: string, provider: string, visibility: Visibility) {
  if (!VISIBILITY_STATES.includes(visibility)) throw new AppError("Visibilité invalide", 400);
  const updated = await prisma.dataset.updateMany({
    where: {
      id: datasetId,
      provider: normalizeAddress(provider),
      status: { in: [...VISIBILITY_STATES] },
      loans: { none: { status: { in: ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] } } },
    },
    data: { status: visibility, ...(visibility === "LISTED" ? { listedAt: new Date() } : {}) },
  });
  if (updated.count !== 1) throw new AppError("Visibilité impossible : dataset non publié ou emprunt actif", 409);
  return prisma.dataset.findUniqueOrThrow({ where: { id: datasetId } });
}
