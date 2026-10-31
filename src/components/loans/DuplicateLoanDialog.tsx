"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useWalletStore } from "@/stores/wallet";
import { duplicateLoanNotice } from "@/lib/train/loan-display";

/**
 * Confirmation avant d'emprunter un dataset sur lequel ce compte a déjà un emprunt payé
 * (`activeLoanOnDataset`). Incident du lancement : un emprunteur, refusé par l'attente de
 * finalité au clic sur « Lancer le job », a ré-emprunté quatre fois le même dataset. Le serveur
 * accepte toujours un second emprunt (ré-entraîner est légitime) ; ici on s'assure seulement que
 * c'est voulu, et on renvoie vers la page Train où l'emprunt existant attend ou s'entraîne.
 *
 * Même contrat que `useComputeQuoteConfirmation` : `confirmDuplicate(existing)` rend `true` si
 * l'emprunteur maintient, `false` s'il annule, ferme la fenêtre ou change de wallet.
 */
export function useDuplicateLoanConfirmation() {
  const [existing, setExisting] = useState<{ status: string } | null>(null);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  const { t } = useLocale();
  const finish = useCallback((accepted: boolean) => {
    resolver.current?.(accepted);
    resolver.current = null;
    setExisting(null);
  }, []);
  useEffect(() => {
    const unsubscribe = useWalletStore.subscribe((state, previous) => {
      if (state.revision !== previous.revision || !state.authenticated) finish(false);
    });
    return () => { unsubscribe(); resolver.current?.(false); resolver.current = null; };
  }, [finish]);
  const confirmDuplicate = useCallback((loan: { status: string }) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setExisting({ status: loan.status });
  }), []);
  const dialog = (
    <Modal open={existing !== null} onClose={() => finish(false)} title={t("Emprunt déjà en cours")}>
      {existing && <div className="space-y-5" role="dialog" aria-modal="true" aria-label={t("Emprunt déjà en cours")} data-testid="duplicate-loan-dialog">
        <p className="text-sm leading-relaxed">{t(duplicateLoanNotice(existing.status))}</p>
        <p className="text-xs text-muted">
          <Link href="/train" className="font-medium text-foreground underline underline-offset-2" onClick={() => finish(false)}>
            {t("Voir mes entraînements")}
          </Link>
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" autoFocus onClick={() => finish(false)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background">{t("Annuler")}</button>
          <button type="button" onClick={() => finish(true)} className="rounded-lg border border-border px-4 py-2 text-sm">{t("Emprunter quand même")}</button>
        </div>
      </div>}
    </Modal>
  );
  return { confirmDuplicate, duplicateDialog: dialog };
}
