import "server-only";
import { AppError } from "@/lib/app-error";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { datasetRegistryAddress, escrowAddress, kybRegistryAddress, usdcAddress } from "@/lib/evm/addresses";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { getPublicClient } from "@/lib/evm/client";
import { requireCurrentEvmDeployment } from "@/lib/evm/deployment";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { confirmedBlock } from "@/lib/evm/finality";
import { billingEnabled } from "@/lib/billing/config";

export async function verifyRunnerDeployment(settlementAddress: string): Promise<void> {
  const address = normalizeAddress(settlementAddress);
  if (!addressesEqual(address, process.env.SIRIUS_LOCK_AUTHORIZER)) {
    throw new AppError("L’identité du runner diffère de SIRIUS_LOCK_AUTHORIZER", 503);
  }
  await requireCurrentEvmDeployment();
  const client = getPublicClient();
  const escrow = escrowAddress();
  const [chainId, authorizer, kyb, usdc, datasetKyb] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "lockAuthorizer" }),
    client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "kyb" }),
    client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "usdc" }),
    client.readContract({ address: datasetRegistryAddress(), abi: siriusdatasetregistryAbi, functionName: "kyb" }),
  ]);
  if (chainId !== resolveServerNetwork().chain.id || !addressesEqual(authorizer, address) ||
    !addressesEqual(kyb, kybRegistryAddress()) || !addressesEqual(datasetKyb, kybRegistryAddress()) ||
    !addressesEqual(usdc, usdcAddress())) {
    throw new AppError("Le réseau ou les contrats ne correspondent pas à l’identité du runner", 503);
  }
  if (billingEnabled()) await confirmedBlock(client);
}
