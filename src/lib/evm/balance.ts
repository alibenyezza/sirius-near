"use client";

import { decodeFunctionResult, encodeFunctionData } from "viem";
import { erc20Abi } from "./abi/erc20";
import { usdcAddress } from "./addresses";
import { getExternalWallet } from "@/lib/wallet/manager";

export interface UsdcBalance {
  atomic: string;
}

export async function fetchUsdcBalance(address: string): Promise<UsdcBalance> {
  const wallet = getExternalWallet();
  if (!wallet) throw new Error("Wallet EVM indisponible");
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] });
  const result = await wallet.request({ method: "eth_call", params: [{ to: usdcAddress(), data }, "latest"] });
  if (typeof result !== "string") throw new Error("Solde en stablecoin indisponible");
  const balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result as `0x${string}` });
  return { atomic: balance.toString() };
}

export interface GasBalance {
  /** Solde natif en wei, tel que la chaîne le rend. */
  wei: string;
  /** Forme lisible, arrondie — l'unité n'a de sens ici qu'à quelques décimales. */
  eth: string;
  /** En dessous du seuil, l'utilisateur ne peut plus payer ses transactions. */
  low: boolean;
}

/**
 * Solde natif du compte, celui qui paie le gas.
 *
 * L'USDC est ce qu'on dépense ; l'ETH est ce qui permet de dépenser. Sans lui, une
 * transaction ne part pas — et jusqu'ici rien à l'écran ne l'expliquait : l'utilisateur
 * voyait « transaction refusée » sans jamais apprendre qu'il lui manquait de quoi payer
 * les frais.
 *
 * Plus simple à lire que l'USDC : pas de contrat à interroger, pas d'encodage. Le
 * solde natif est une propriété du compte, pas une entrée dans un registre.
 */
const SEUIL_WEI = BigInt("50000000000000"); // 0,00005 ETH ≈ 80 écritures sur cette chaîne

export async function fetchGasBalance(address: string): Promise<GasBalance> {
  const wallet = getExternalWallet();
  if (!wallet) throw new Error("Wallet EVM indisponible");
  const brut = await wallet.request({ method: "eth_getBalance", params: [address, "latest"] });
  if (typeof brut !== "string" || !/^0x[0-9a-fA-F]*$/.test(brut)) {
    throw new Error("Solde de gas indisponible");
  }
  const wei = BigInt(brut);
  // Quatre décimales suffisent : au-delà, le chiffre cesse d'être lisible sans rien
  // apprendre à personne. Ce qui compte est l'ordre de grandeur et le seuil.
  const eth = (Number(wei) / 1e18).toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return { wei: wei.toString(), eth: eth === "" || eth === "0" ? "0" : eth, low: wei < SEUIL_WEI };
}
