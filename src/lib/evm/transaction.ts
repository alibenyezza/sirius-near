import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { erc20Abi } from "./abi/erc20";
import { siriusdatasetregistryAbi } from "./abi/siriusdatasetregistry";
import { siriusescrowAbi } from "./abi/siriusescrow";
import { siriuskybregistryAbi } from "./abi/siriuskybregistry";
import { datasetRegistryAddress, escrowAddress, kybRegistryAddress, usdcAddress } from "./addresses";
import { cidHash, datasetIdHash } from "./dataset-key";
import { loanIdHash } from "./loan-key";
import type { LockAuthorization } from "./lock-authorization";
import { quoteLockTerms, type SignedComputeQuote } from "@/lib/billing/quote";
import { siriusescrowv7Abi } from "./abi/siriusescrowv7";

export interface EvmTransactionRequest {
  to: Address;
  data: Hex;
}

export function lockQuotedUsdcTransaction(signed: SignedComputeQuote): EvmTransactionRequest {
  return {
    to: getAddress(signed.quote.escrow),
    data: encodeFunctionData({ abi: siriusescrowv7Abi, functionName: "lock", args: [quoteLockTerms(signed.quote), signed.authorization] }),
  };
}

export function refundEscrowTransaction(loanKey: Hex, escrow: Address): EvmTransactionRequest {
  return { to: escrow, data: encodeFunctionData({ abi: siriusescrowAbi, functionName: "refund", args: [loanKey] }) };
}

export function approveUsdcTransaction(amount: string): EvmTransactionRequest {
  return {
    to: usdcAddress(),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [escrowAddress(), BigInt(amount)],
    }),
  };
}

export function lockUsdcTransaction(input: {
  provider: string;
  datasetId: Hex;
  amount: string;
  hashlock: Hex;
  challengeDays: number;
  loanId: string;
  trainingProfile: Hex;
  authorization: LockAuthorization;
}): EvmTransactionRequest {
  return {
    to: escrowAddress(),
    data: encodeFunctionData({
      abi: siriusescrowAbi,
      functionName: "lock",
      args: [
        getAddress(input.provider),
        BigInt(input.amount),
        input.hashlock,
        input.challengeDays,
        loanIdHash(input.loanId),
        input.datasetId,
        input.trainingProfile,
        input.authorization,
      ],
    }),
  };
}

export function mintDatasetTransaction(input: {
  datasetId: string;
  cid: string;
  merkleRoot: Hex;
  sizeBytes: number;
  trainingProfile: Hex;
}): EvmTransactionRequest {
  return {
    to: datasetRegistryAddress(),
    data: encodeFunctionData({
      abi: siriusdatasetregistryAbi,
      functionName: "mint",
      args: [datasetIdHash(input.datasetId), cidHash(input.cid), input.merkleRoot, BigInt(input.sizeBytes), input.trainingProfile],
    }),
  };
}

export function destroyDatasetTransaction(datasetId: string): EvmTransactionRequest {
  return {
    to: datasetRegistryAddress(),
    data: encodeFunctionData({
      abi: siriusdatasetregistryAbi,
      functionName: "destroy",
      args: [datasetIdHash(datasetId)],
    }),
  };
}

export function acceptKybTransaction(input: {
  verifier: string;
  expiresAt: number;
  verifierSignature: Hex;
}): EvmTransactionRequest {
  return {
    to: kybRegistryAddress(),
    data: encodeFunctionData({
      abi: siriuskybregistryAbi,
      functionName: "acceptAttestation",
      args: [getAddress(input.verifier), input.expiresAt, input.verifierSignature],
    }),
  };
}
