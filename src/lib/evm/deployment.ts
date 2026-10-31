import "server-only";
import { AppError } from "@/lib/app-error";
import { siriusdatasetregistryAbi } from "./abi/siriusdatasetregistry";
import { siriusescrowAbi } from "./abi/siriusescrow";
import { addressesEqual } from "./address";
import { datasetRegistryAddress, escrowAddress } from "./addresses";
import { getPublicClient } from "./client";
import { billingEnabled } from "@/lib/billing/config";
import { resolveServerNetwork } from "./networks";

const DATASET_VERSION = "sirius-dataset-v4";
const CACHE_MS = 60_000;
let verifiedAt = 0;
let verifiedKey = "";
let verification: { key: string; promise: Promise<void> } | null = null;

async function verifyDeployment(allowPreviousEscrow = false): Promise<void> {
  const client = getPublicClient();
  const escrow = escrowAddress();
  const datasets = datasetRegistryAddress();
  try {
    const [escrowVersion, datasetVersion, linkedDatasets, linkedEscrow] = await Promise.all([
      client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "VERSION" }),
      client.readContract({ address: datasets, abi: siriusdatasetregistryAbi, functionName: "VERSION" }),
      client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "datasets" }),
      client.readContract({ address: datasets, abi: siriusdatasetregistryAbi, functionName: "escrow" }),
    ]);
    if (
      (escrowVersion !== (billingEnabled() ? "sirius-escrow-usdc-v7" : "sirius-escrow-usdc-v6")
        && !(allowPreviousEscrow && ["sirius-escrow-usdc-v5", "sirius-escrow-usdc-v6", "sirius-escrow-usdc-v7"].includes(escrowVersion))) ||
      datasetVersion !== DATASET_VERSION ||
      !addressesEqual(linkedDatasets, datasets) ||
      !addressesEqual(linkedEscrow, escrow)
    ) {
      throw new AppError(allowPreviousEscrow
        ? "Contrats du reaper incompatibles : escrow v5, v6 ou v7 et registre dataset v4 lié requis"
        : "Contrats EVM incompatibles avec la version de facturation configurée", 503);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Contrats EVM Sirius indisponibles ou incompatibles", 503);
  }
}

// La réconciliation reste disponible pendant la migration ; ce contrôle ne valide
// pas le cache utilisé pour autoriser de nouveaux prêts.
export function requireReaperEvmDeployment(): Promise<void> {
  return verifyDeployment(true);
}

export function requireCurrentEvmDeployment(): Promise<void> {
  const { chain, rpcUrl } = resolveServerNetwork();
  const key = JSON.stringify([chain.id, rpcUrl, escrowAddress(), datasetRegistryAddress(), billingEnabled()]);
  if (key === verifiedKey && Date.now() - verifiedAt < CACHE_MS) return Promise.resolve();
  if (verification?.key !== key) {
    const promise = verifyDeployment()
      .then(() => {
        verifiedAt = Date.now();
        verifiedKey = key;
      })
      .finally(() => {
        if (verification?.key === key) verification = null;
      });
    verification = { key, promise };
  }
  return verification.promise;
}
