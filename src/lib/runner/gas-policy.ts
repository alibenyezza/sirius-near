import { AppError } from "@/lib/app-error";
import type { BudgetPolicy } from "./budget-ledger";

export function boundedGas(policy: BudgetPolicy["gas"], estimate: bigint, price: bigint, balance: bigint) {
  const gas = (estimate * BigInt(120) + BigInt(99)) / BigInt(100);
  const priceCap = BigInt(policy.maxFeePerGasWei);
  const maxFeePerGas = price * BigInt(2) < priceCap ? price * BigInt(2) : priceCap;
  if (estimate <= BigInt(0) || price <= BigInt(0) || price > priceCap || gas > BigInt(policy.maxGas)
    || gas * maxFeePerGas > BigInt(policy.maxTransactionWei) || balance < BigInt(policy.maxTransactionWei)) {
    throw new AppError("Plafond de gas dépassé ou liquidités ETH insuffisantes", 503);
  }
  return { gas, maxFeePerGas };
}

/** Seuil d'alerte : moins de cinq règlements au plafond de gas restent finançables. */
export const LOW_GAS_BALANCE_SETTLEMENTS = 5;

/**
 * Alerte avant règlement quand le compte de règlement s'approche du vide. Sans ETH, aucun
 * prêt ne peut être réglé et les fournisseurs ne sont pas payés : l'opérateur doit le
 * savoir avant le refus, pas après. La ligne est stable pour être suivie par la supervision.
 */
export function lowGasBalanceAlert(policy: BudgetPolicy["gas"], balance: bigint, wallet: string): string | null {
  const threshold = BigInt(policy.maxTransactionWei) * BigInt(LOW_GAS_BALANCE_SETTLEMENTS);
  if (balance >= threshold) return null;
  const message = `[runner][alerte-eth] solde du compte de règlement ${wallet.toLowerCase()} bas : ${balance} wei, seuil ${threshold} wei`;
  console.warn(message);
  return message;
}
