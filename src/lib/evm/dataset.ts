import "server-only";
import type { Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { normalizeAddress } from "./address";
import { datasetRegistryAddress } from "./addresses";
import { siriusdatasetregistryAbi } from "./abi/siriusdatasetregistry";
import { getPublicClient } from "./client";
import { cidHash, datasetIdHash, merkleRootAsBytes32 } from "./dataset-key";
import { trainingProfileHash, type ModelSelection } from "@/lib/models/registry";

export async function assertDatasetScope(input: {
  datasetId: string;
  provider: string;
  merkleRoot: string;
  cid: string;
  model: ModelSelection;
}): Promise<void> {
  // La racine arrive sous sa forme canonique, sans préfixe : c'est celle que le
  // runner manipule. Le contrat attend un `bytes32`.
  let racineEvm: Hex;
  try {
    racineEvm = merkleRootAsBytes32(input.merkleRoot);
  } catch {
    throw new AppError("Racine Merkle EVM invalide", 409);
  }
  const provider = normalizeAddress(input.provider);
  const client = getPublicClient();
  const registry = datasetRegistryAddress();
  const onChainId = await client.readContract({
    address: registry,
    abi: siriusdatasetregistryAbi,
    functionName: "datasetIdOf",
    args: [provider, datasetIdHash(input.datasetId)],
  });
  const matches = await client.readContract({
    address: registry,
    abi: siriusdatasetregistryAbi,
    functionName: "matchesScope",
    args: [onChainId, provider, racineEvm, cidHash(input.cid), trainingProfileHash(input.model)],
  });
  if (!matches) throw new AppError("Titre EVM du dataset inactif ou hors scope", 409);
}
