import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import type { Address, Hex } from "viem";
import { lockAuthorizationTypedData } from "../../../src/lib/evm/lock-authorization";

export type LockArgs = readonly [Address, bigint, Hex, number, Hex, Hex, Hex];

export async function authorizedLockArgs(
  signer: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number],
  escrow: Address,
  borrower: Address,
  args: LockArgs,
  overrides: { deadline?: number; chainId?: number } = {},
) {
  const [provider, amount, hashlock, challengeDays, loanIdHash, datasetId, trainingProfile] = args;
  const deadline = overrides.deadline ?? (await time.latest()) + 300;
  const chainId = overrides.chainId ?? await (await hre.viem.getPublicClient()).getChainId();
  const signature = await signer.signTypedData(lockAuthorizationTypedData(
    { borrower, provider, amount, hashlock, challengeDays, loanIdHash, datasetId, trainingProfile },
    { chainId, escrow }, deadline,
  ));
  return [...args, { deadline, signature }] as const;
}
