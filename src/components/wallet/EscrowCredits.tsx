"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useWalletStore } from "@/stores/wallet";
import { sendActiveTransaction } from "@/lib/wallet/transaction-client";
import { guardWithdrawTransaction } from "@/lib/wallet/transaction-guard";
import { getExternalWallet } from "@/lib/wallet/manager";
import { truncate } from "@/lib/format";
import { messageOf } from "@/lib/errors-client";
import { stablecoinTicker } from "@/lib/evm/stablecoin";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { CardTitle } from "@/components/ui/Heading";

const TOKEN = stablecoinTicker(resolveClientNetwork());

interface Credit {
  escrow: string;
  historical: boolean;
  available: boolean;
  atomic?: string;
  amount?: string;
  transaction?: Record<string, unknown>;
}

/** `guideAnchor` : ancre de la visite de page (`data-guide`), posée sur la carte quand elle s'affiche. */
export function EscrowCredits({ onWithdraw, guideAnchor }: { onWithdraw: () => Promise<void>; guideAnchor?: string }) {
  const authenticated = useWalletStore((state) => state.authenticated);
  const { t } = useLocale();
  const [identity] = useState(() => ({ revision: useWalletStore.getState().revision, provider: getExternalWallet() }));
  const [credits, setCredits] = useState<Credit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!authenticated || !mounted.current) return;
    const { revision, address } = useWalletStore.getState();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/wallet/credits", { cache: "no-store" });
      const body = await response.json() as { subject?: string; credits?: Credit[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Crédits escrow indisponibles");
      if (!mounted.current || revision !== useWalletStore.getState().revision) return;
      if (body.subject !== address || !body.credits) throw new Error("La session ne correspond pas au wallet connecté");
      setCredits(body.credits);
    } catch (error) {
      if (mounted.current) { setCredits([]); setError(messageOf(error)); }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [authenticated]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function withdraw(credit: Credit) {
    if (!credit.transaction || pending.current || !mounted.current) return;
    const assertCurrent = () => {
      if (!mounted.current || identity.provider !== getExternalWallet() || identity.revision !== useWalletStore.getState().revision) {
        throw new Error("Le wallet a changé. Relance l’opération.");
      }
    };
    pending.current = true;
    setWithdrawing(credit.escrow);
    setError(null);
    try {
      const account = useWalletStore.getState().address ?? "";
      await sendActiveTransaction(guardWithdrawTransaction(credit.transaction, account), { waitForConfirmation: true, assertCurrent });
      assertCurrent();
      await Promise.all([refresh(), onWithdraw()]);
    } catch (error) {
      if (mounted.current) setError(messageOf(error));
    } finally {
      pending.current = false;
      if (mounted.current) setWithdrawing(null);
    }
  }

  // Un crédit illisible reste affiché : le masquer pourrait cacher des fonds réels.
  const visible = credits.filter((credit) => !credit.available || BigInt(credit.atomic ?? 0) > BigInt(0));
  if (!authenticated || (!error && visible.length === 0)) return null;
  return (
    <Card data-guide={guideAnchor}>
      <div className="flex items-center justify-between gap-4">
        <CardTitle>{t("{token} à retirer", { token: TOKEN })}</CardTitle>
        <button onClick={() => void refresh()} disabled={loading || Boolean(withdrawing)} className="text-xs text-accent disabled:opacity-50">{t("Actualiser")}</button>
      </div>
      <p className="mt-2 text-xs text-muted">{t("Les règlements et remboursements sont crédités ici. Retire-les pour les recevoir dans ton wallet ; le gas est à ta charge.")}</p>
      {error && <p role="alert" className="mt-4 text-sm text-negative">{t(error)}</p>}
      <div className="mt-4 flex flex-col gap-3">
        {visible.map((credit) => (
          <div key={credit.escrow} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{credit.available ? `${credit.amount} ${TOKEN}` : t("Crédits escrow indisponibles")}</p>
              <p title={credit.escrow} className="mt-1 font-mono text-xs text-muted">{credit.historical ? t("Ancien escrow") : t("Escrow courant")} · {truncate(credit.escrow)}</p>
            </div>
            <button onClick={() => void withdraw(credit)} disabled={!credit.available || !credit.atomic || BigInt(credit.atomic) === BigInt(0) || Boolean(withdrawing) || loading} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-background disabled:opacity-40">
              {withdrawing === credit.escrow ? t("Retrait en cours…") : t("Retirer")}
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}
