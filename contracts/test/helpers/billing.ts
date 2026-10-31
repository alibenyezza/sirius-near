import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export interface BillingTerms {
  provider: Address;
  computeRecipient: Address;
  datasetAmount: bigint;
  computeAmount: bigint;
  maxFailureFee: bigint;
  hashlock: Hex;
  challengeDays: number;
  loanIdHash: Hex;
  datasetId: Hex;
  trainingProfile: Hex;
  quoteHash: Hex;
}

export interface ExecutionReceipt {
  consumedCompute: bigint;
  evidenceHash: Hex;
  observedAt: number;
  finalFailure: boolean;
}

type Signer = Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
interface DomainOverrides { chainId?: number; version?: string }

export function billingTermsHash(borrower: Address, terms: BillingTerms): Hex {
  return keccak256(encodeAbiParameters([
    { type: "address" },
    { type: "tuple", components: [
      { name: "provider", type: "address" },
      { name: "computeRecipient", type: "address" },
      { name: "datasetAmount", type: "uint256" },
      { name: "computeAmount", type: "uint256" },
      { name: "maxFailureFee", type: "uint256" },
      { name: "hashlock", type: "bytes32" },
      { name: "challengeDays", type: "uint8" },
      { name: "loanIdHash", type: "bytes32" },
      { name: "datasetId", type: "bytes32" },
      { name: "trainingProfile", type: "bytes32" },
      { name: "quoteHash", type: "bytes32" },
    ] },
  ], [borrower, terms]));
}

async function domain(escrow: Address, overrides: DomainOverrides) {
  return { name: "SiriusEscrow", version: overrides.version ?? "7",
    chainId: overrides.chainId ?? await (await hre.viem.getPublicClient()).getChainId(), verifyingContract: escrow };
}

export async function authorizeBillingLock(
  signer: Signer, escrow: Address, borrower: Address, terms: BillingTerms,
  overrides: DomainOverrides & { deadline?: number } = {},
) {
  const deadline = overrides.deadline ?? (await time.latest()) + 300;
  const signature = await signer.signTypedData({
    domain: await domain(escrow, overrides),
    types: { LockAuthorization: [{ name: "termsHash", type: "bytes32" }, { name: "deadline", type: "uint40" }] },
    primaryType: "LockAuthorization",
    message: { termsHash: billingTermsHash(borrower, terms), deadline },
  });
  return { deadline, signature };
}

export async function attestExecution(
  signer: Signer, escrow: Address, loanKey: Hex, termsHash: Hex, receipt: ExecutionReceipt,
  overrides: DomainOverrides = {},
) {
  return signer.signTypedData({
    domain: await domain(escrow, overrides),
    types: { ExecutionReceipt: [
      { name: "loanKey", type: "bytes32" },
      { name: "termsHash", type: "bytes32" },
      { name: "consumedCompute", type: "uint256" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "observedAt", type: "uint40" },
      { name: "finalFailure", type: "bool" },
    ] },
    primaryType: "ExecutionReceipt",
    message: { loanKey, termsHash, ...receipt },
  });
}
