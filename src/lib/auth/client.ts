"use client";

import { useWalletStore } from "@/stores/wallet";
import { getExternalWallet, signMessageExternal } from "@/lib/wallet/manager";
import { ensureKybAttested } from "@/lib/kyb/client";
import { ensureStarterFunds } from "@/lib/wallet/onramp";
import {
  activateRunnerDelegation,
  beginRunnerDelegation,
  clearRunnerDelegation,
} from "@/lib/runner/authorization-client";

let generation = 0;
let signingIn = false;
let sessionQueue: Promise<void> = Promise.resolve();

// Sérialise les écritures du cookie : un logout tardif ne doit pas effacer le login suivant.
function enqueueSession<T>(operation: () => Promise<T>): Promise<T> {
  const next = sessionQueue.then(operation);
  sessionQueue = next.then(() => {}, () => {});
  return next;
}

export async function signInWithWallet(): Promise<void> {
  const { address, source, revision } = useWalletStore.getState();
  if (!address || !source) throw new Error("Aucun wallet connecté");
  if (signingIn) throw new Error("Une connexion est déjà en cours");
  signingIn = true;
  const attempt = ++generation;
  const provider = getExternalWallet();
  const assertCurrent = () => {
    if (generation !== attempt || useWalletStore.getState().revision !== revision || getExternalWallet() !== provider) {
      throw new Error("Le wallet a changé pendant la connexion. Réessaie.");
    }
  };
  try {
    await enqueueSession(async () => {
      let verificationSent = false;
      try {
        assertCurrent();
        const runnerSessionPublicKey = await beginRunnerDelegation();
        assertCurrent();
        const chalRes = await fetch("/api/auth/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, runnerSessionPublicKey }),
        });
        if (!chalRes.ok) {
          const body = await chalRes.json().catch(() => null);
          throw new Error(typeof body?.error === "string" ? body.error : "Challenge refusé");
        }
        const { challenge } = await chalRes.json();
        assertCurrent();
        const { signature } = await signMessageExternal(challenge, address);
        assertCurrent();
        verificationSent = true;
        const verifyRes = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, signature, message: challenge, source }),
        });
        assertCurrent();
        if (!verifyRes.ok) {
          const body = await verifyRes.json().catch(() => null);
          throw new Error(typeof body?.error === "string" ? body.error : "Authentification refusée");
        }
        await activateRunnerDelegation({ message: challenge, walletSignature: signature, sessionPublicKey: runnerSessionPublicKey });
        assertCurrent();
        useWalletStore.getState().setAuthenticated(true);
      } catch (error) {
        await clearRunnerDelegation();
        useWalletStore.getState().setAuthenticated(false);
        if (verificationSent) await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        throw error;
      }
    });
  } finally {
    signingIn = false;
  }
  // L'ordre compte : l'attestation est parrainée et ne réclame aucun ETH, alors que tout
  // le reste en exige. Financer d'abord marcherait aussi, mais attester d'abord garantit
  // qu'un faucet vide laisse tout de même un compte en règle.
  await ensureKybAttested(address, assertCurrent);
  await ensureStarterFunds(address);
}

export function invalidateWalletSession(): Promise<void> {
  generation++;
  useWalletStore.getState().setAuthenticated(false);
  return enqueueSession(async () => {
    await clearRunnerDelegation();
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  });
}

export function signOut(): Promise<void> {
  return invalidateWalletSession();
}
