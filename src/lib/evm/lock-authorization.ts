import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type Hex } from "viem";

export interface LockTerms {
  borrower: string;
  provider: string;
  amount: bigint;
  hashlock: Hex;
  challengeDays: number;
  loanIdHash: Hex;
  datasetId: Hex;
  trainingProfile: Hex;
}

export interface LockAuthorization {
  deadline: number;
  signature: Hex;
}

export const LOCK_AUTHORIZATION_TTL_SECONDS = 5 * 60;

export function lockAuthorizationTypedData(
  terms: LockTerms,
  binding: { chainId: number; escrow: string },
  deadline: number,
) {
  const termsHash = keccak256(encodeAbiParameters(
    parseAbiParameters("address, address, uint256, bytes32, uint8, bytes32, bytes32, bytes32"),
    [getAddress(terms.borrower), getAddress(terms.provider), terms.amount, terms.hashlock,
      terms.challengeDays, terms.loanIdHash, terms.datasetId, terms.trainingProfile],
  ));
  return {
    domain: { name: "SiriusEscrow", version: "6", chainId: binding.chainId, verifyingContract: getAddress(binding.escrow) },
    types: { LockAuthorization: [{ name: "termsHash", type: "bytes32" }, { name: "deadline", type: "uint40" }] },
    primaryType: "LockAuthorization",
    message: { termsHash, deadline },
  } as const;
}
