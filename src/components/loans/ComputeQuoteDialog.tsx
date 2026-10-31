"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { Modal } from "@/components/ui/Modal";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useWalletStore } from "@/stores/wallet";
import { totalQuoteAmount, type ComputeQuote } from "@/lib/billing/quote";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { stablecoinSymbol } from "@/lib/evm/stablecoin";

export function useComputeQuoteConfirmation() {
  const [quote, setQuote] = useState<ComputeQuote | null>(null);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const { t } = useLocale();
  const finish = useCallback((accepted: boolean) => {
    resolver.current?.(accepted);
    resolver.current = null;
    setQuote(null);
  }, []);
  useEffect(() => {
    const unsubscribe = useWalletStore.subscribe((state, previous) => {
      if (state.revision !== previous.revision || !state.authenticated) finish(false);
    });
    return () => { unsubscribe(); resolver.current?.(false); resolver.current = null; };
  }, [finish]);
  const confirmQuote = useCallback((next: ComputeQuote) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setQuote(next);
  }), []);
  // « USDG » sur mainnet, « test USDC » sur testnet : le réseau est inliné au build.
  const token = t(stablecoinSymbol(resolveClientNetwork()));
  const money = (amount: string) => `${formatUnits(BigInt(amount), quote!.usdcDecimals)} ${token}`;
  const dialog = (
    <Modal open={quote !== null} onClose={() => finish(false)} title={t("Devis d’entraînement")}>
      {quote && <div className="space-y-5" role="dialog" aria-modal="true" aria-label={t("Devis d’entraînement")}>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-4"><dt>{t("Prix du dataset")}</dt><dd className="font-mono">{money(quote.datasetAmount)}</dd></div>
          <div className="flex justify-between gap-4"><dt>{t("Prix du compute")}</dt><dd className="font-mono">{money(quote.computeAmount)}</dd></div>
          <div className="flex justify-between gap-4 border-t border-border pt-3 font-semibold"><dt>{t("Total à prépayer")}</dt><dd className="font-mono">{money(totalQuoteAmount(quote))}</dd></div>
        </dl>
        <div className="rounded-lg border border-border bg-background/40 p-3 text-xs leading-relaxed text-muted">
          <p>{t("En cas d’échec, le dataset et le compute non consommé sont remboursés. Seuls les frais d’exécution mesurés sont retenus.")}</p>
          <p className="mt-2 font-medium text-foreground">{t("Retenue maximale")} : {money(quote.maxFailureFee)}</p>
          <p className="mt-1">{t("Barème d’exécution, transferts inclus")} : {money(String(BigInt(quote.executionRateAtomicPerMs) * BigInt(1000)))} / s · {t("Durée maximale")} : {quote.maxExecutionMs / 1000} s</p>
        </div>
        <p className="text-xs text-muted">{t("Les frais réseau ETH sont payés séparément dans ton wallet. Aucun supplément automatique.")}</p>
        <p className="text-xs text-muted">{t("Devis valable jusqu’à")} {new Date(quote.expiresAt * 1000).toLocaleTimeString()} · {quote.tariffVersion}</p>
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={() => finish(false)} className="rounded-lg border border-border px-4 py-2 text-sm">{t("Annuler")}</button>
          <button type="button" autoFocus onClick={() => finish(true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background">{t("Accepter et prépayer")}</button>
        </div>
      </div>}
    </Modal>
  );
  return { confirmQuote, quoteDialog: dialog };
}
