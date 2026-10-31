"use client";

import { sendTransactionExternal, signTypedDataExternal, waitForTransactionExternal } from "@/lib/wallet/manager";
import { useWalletStore } from "@/stores/wallet";

export async function sendActiveTransaction(
  transaction: Record<string, unknown>,
  options: { waitForConfirmation?: boolean; assertCurrent?: () => void } = {},
): Promise<string> {
  const { source, authenticated, address } = useWalletStore.getState();
  if (!source) throw new Error("Connecte un wallet.");
  if (!authenticated) throw new Error("Authentifie-toi avant de signer.");
  if (!address) throw new Error("Adresse du wallet indisponible.");
  options.assertCurrent?.();
  const hash = await sendTransactionExternal(transaction, address, options.assertCurrent);
  if (options.waitForConfirmation) {
    await waitForTransactionExternal(hash);
  }
  return hash;
}

/**
 * Signe une charge EIP-712 avec le wallet actif.
 *
 * Mêmes préalables que pour une transaction : un wallet connecté et une session
 * authentifiée. Une signature de consentement engage son auteur autant qu'un envoi,
 * et rien ne justifierait de l'autoriser plus facilement.
 */
export async function signTypedDataWithActiveWallet(payload: unknown): Promise<string> {
  const { source, authenticated, address } = useWalletStore.getState();
  if (!source) throw new Error("Connecte un wallet.");
  if (!authenticated) throw new Error("Authentifie-toi avant de signer.");
  if (!address) throw new Error("Adresse du wallet indisponible.");
  return signTypedDataExternal(payload, address);
}
