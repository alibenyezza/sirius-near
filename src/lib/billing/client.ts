"use client";

import { createPublicClient, custom, encodeFunctionData } from "viem";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { siriusescrowv7Abi } from "@/lib/evm/abi/siriusescrowv7";
import { escrowAddress, usdcAddress } from "@/lib/evm/addresses";
import { chainForNetwork, resolveClientNetwork } from "@/lib/evm/networks";
import { getExternalWallet } from "@/lib/wallet/manager";
import { lockQuotedUsdcTransaction } from "@/lib/evm/transaction";
import { totalQuoteAmount, verifyComputeQuote, type SignedComputeQuote } from "./quote";

export async function verifyBorrowQuote(value: unknown, scope: { loanId: string; datasetId: string; borrower: string }): Promise<SignedComputeQuote> {
  const wallet = getExternalWallet();
  if (!wallet) throw new Error("Wallet déconnecté");
  const chain = chainForNetwork(resolveClientNetwork());
  const client = createPublicClient({ chain, transport: custom(wallet) });
  if (await client.getChainId() !== chain.id) throw new Error("RPC sur un autre réseau");
  const [runner, decimals] = await Promise.all([
    client.readContract({ address: escrowAddress(), abi: siriusescrowv7Abi, functionName: "lockAuthorizer" }),
    client.readContract({ address: usdcAddress(), abi: erc20Abi, functionName: "decimals" }),
  ]);
  const signed = await verifyComputeQuote(value, { chainId: chain.id, escrow: escrowAddress(), runner }, true);
  const quote = signed.quote;
  if (quote.loanId !== scope.loanId || quote.datasetId !== scope.datasetId || quote.borrower !== scope.borrower.toLowerCase()
    || quote.usdc !== usdcAddress().toLowerCase() || quote.usdcDecimals !== Number(decimals)) throw new Error("Devis compute hors scope");
  return signed;
}

export async function escrowBillingVersion(): Promise<6 | 7> {
  const wallet = getExternalWallet();
  if (!wallet) throw new Error("Wallet déconnecté");
  const chain = chainForNetwork(resolveClientNetwork());
  const client = createPublicClient({ chain, transport: custom(wallet) });
  if (await client.getChainId() !== chain.id) throw new Error("RPC sur un autre réseau");
  const version = await client.readContract({ address: escrowAddress(), abi: siriusescrowv7Abi, functionName: "VERSION" });
  if (version === "sirius-escrow-usdc-v7") return 7;
  if (version === "sirius-escrow-usdc-v6") return 6;
  throw new Error("Version d’escrow non prise en charge");
}

export function quotedTransactions(signed: SignedComputeQuote) {
  return {
    approve: {
      to: signed.quote.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [signed.quote.escrow, BigInt(totalQuoteAmount(signed.quote))] }),
    },
    lock: lockQuotedUsdcTransaction(signed),
  };
}
