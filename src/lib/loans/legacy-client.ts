"use client";

import { createPublicClient, custom, decodeFunctionData, getAddress, type Hex } from "viem";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { datasetRegistryAddress, escrowAddress } from "@/lib/evm/addresses";
import { datasetIdHash } from "@/lib/evm/dataset-key";
import { loanIdHash } from "@/lib/evm/loan-key";
import { chainForNetwork, resolveClientNetwork } from "@/lib/evm/networks";
import { approveUsdcTransaction, lockUsdcTransaction } from "@/lib/evm/transaction";
import { getExternalWallet } from "@/lib/wallet/manager";

interface LockRequest { to: string; data: Hex }

function lockTerms(value: unknown, loanId: string) {
  const request = value as LockRequest | null;
  if (!request || typeof request.to !== "string" || typeof request.data !== "string"
    || getAddress(request.to) !== escrowAddress()) throw new Error("Transaction de lock invalide");
  const decoded = decodeFunctionData({ abi: siriusescrowAbi, data: request.data });
  if (decoded.functionName !== "lock" || decoded.args[4] !== loanIdHash(loanId)) throw new Error("Transaction de lock hors scope");
  const [provider, amount, hashlock, challengeDays, , onChainDatasetId, trainingProfile, authorization] = decoded.args;
  if (amount <= BigInt(0) || /^0x0{64}$/.test(hashlock) || challengeDays < 1 || challengeDays > 30
    || authorization.deadline <= Math.floor(Date.now() / 1000)
    || authorization.deadline > Math.floor(Date.now() / 1000) + 300) throw new Error("Transaction de lock invalide");
  return { provider, amount, hashlock, challengeDays, onChainDatasetId, trainingProfile, authorization };
}

export async function legacyBorrowTransactions(input: {
  loanId: string;
  datasetId: string;
  priceUsdcAtomic: string;
  initialLock: unknown;
}) {
  const initial = lockTerms(input.initialLock, input.loanId);
  if (!/^[1-9][0-9]*$/.test(input.priceUsdcAtomic) || initial.amount !== BigInt(input.priceUsdcAtomic)) {
    throw new Error("Prix du dataset modifié. Recharge le catalogue.");
  }
  const wallet = getExternalWallet();
  if (!wallet) throw new Error("Wallet déconnecté");
  const chain = chainForNetwork(resolveClientNetwork());
  const client = createPublicClient({ chain, transport: custom(wallet) });
  const [title, onChainId] = await Promise.all([
    client.readContract({ address: datasetRegistryAddress(), abi: siriusdatasetregistryAbi,
      functionName: "getDataset", args: [initial.onChainDatasetId] }),
    client.readContract({ address: datasetRegistryAddress(), abi: siriusdatasetregistryAbi,
      functionName: "datasetIdOf", args: [initial.provider, datasetIdHash(input.datasetId)] }),
  ]);
  if (title.provider.toLowerCase() !== initial.provider.toLowerCase() || title.destroyedAt !== 0
    || title.trainingProfile !== initial.trainingProfile || onChainId !== initial.onChainDatasetId) {
    throw new Error("Titre EVM du dataset incompatible");
  }
  return {
    approve: approveUsdcTransaction(input.priceUsdcAtomic),
    lock(renewedLock: unknown, authorizationDeadline: number) {
      const renewed = lockTerms(renewedLock, input.loanId);
      if (renewed.provider !== initial.provider || renewed.amount !== initial.amount
        || renewed.hashlock !== initial.hashlock || renewed.challengeDays !== initial.challengeDays
        || renewed.trainingProfile !== initial.trainingProfile || renewed.onChainDatasetId !== initial.onChainDatasetId
        || renewed.authorization.deadline !== authorizationDeadline) throw new Error("Transaction de lock modifiée");
      return lockUsdcTransaction({
        provider: initial.provider, datasetId: initial.onChainDatasetId, amount: input.priceUsdcAtomic,
        hashlock: initial.hashlock, challengeDays: initial.challengeDays, loanId: input.loanId,
        trainingProfile: initial.trainingProfile, authorization: renewed.authorization,
      });
    },
  };
}
