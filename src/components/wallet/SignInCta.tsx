"use client";

import { create } from "zustand";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { signInWithWallet } from "@/lib/auth/client";
import { messageOf } from "@/lib/errors-client";
import { useWalletStore } from "@/stores/wallet";
import { connectWallet } from "./WalletConnector";
import { TermsNotice } from "./TermsNotice";

// État partagé : la connexion change la révision du wallet et remonte les parents indexés
// sur elle, alors que la signature attend encore dans le wallet.
export const useSignIn = create<{ pending: boolean; error: string | null }>(() => ({ pending: false, error: null }));

export async function connectAndSignIn(): Promise<void> {
  if (useSignIn.getState().pending) return;
  useSignIn.setState({ pending: true, error: null });
  try {
    if (!useWalletStore.getState().connected) await connectWallet();
    const { connected, authenticated } = useWalletStore.getState();
    if (connected && !authenticated) await signInWithWallet();
  } catch (error) {
    useSignIn.setState({ error: messageOf(error) });
  } finally {
    useSignIn.setState({ pending: false });
  }
}

/** Connexion puis signature en un seul geste : un wallet seulement connecté reste anonyme pour le serveur. */
export function SignInCta({ children }: { children: React.ReactNode }) {
  const connected = useWalletStore((state) => state.connected);
  const pending = useSignIn((state) => state.pending);
  const error = useSignIn((state) => state.error);
  const { t } = useLocale();
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void connectAndSignIn()}
        disabled={pending}
        className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
      >
        {pending ? (connected ? t("Signature…") : t("Connexion…")) : connected ? t("Se connecter") : children}
      </button>
      {connected && !pending && <p className="text-xs text-muted">{t("Signe pour prouver la possession du wallet")}</p>}
      <TermsNotice />
      {error && <p role="alert" className="text-xs text-negative">{t(error)}</p>}
    </div>
  );
}
