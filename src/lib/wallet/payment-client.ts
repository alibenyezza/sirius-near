"use client";

import { encodeFunctionData, getAddress } from "viem";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { usdcAddress } from "@/lib/evm/addresses";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";
import { sendActiveTransaction } from "./transaction-client";

interface SendInput {
  destination: string;
  amountUsdc: string;
}

export async function sendPayment(input: SendInput): Promise<string> {
  const amount = priceUsdcToAtomic(input.amountUsdc);
  if (!amount) throw new Error("Montant invalide");
  return sendActiveTransaction({
    to: usdcAddress(),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(input.destination), BigInt(amount)],
    }),
  });
}
