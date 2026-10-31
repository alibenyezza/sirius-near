"use client";

import { useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { acceptInstantAccess } from "@/lib/kyb/client";

/**
 * Accès instantané : le serveur signe une invitation de 30 jours pour le wallet connecté,
 * que le wallet accepte on-chain en une transaction — le même geste qu'avec un code collé.
 * Un clic répété après un refus dans le wallet ressert la même invitation côté serveur.
 */
export function KybInstantAccess({ role, renewal, onAccepted }: { role: "provider" | "borrower"; renewal: boolean; onAccepted: () => void }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await acceptInstantAccess(role);
      onAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Accès instantané refusé");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-surface p-4" data-testid="kyb-instant-access">
      <p className="text-sm font-medium">{renewal ? t("Renouvellement instantané") : t("Accès instantané")}</p>
      <p className="text-xs text-muted">
        {t("Sirius signe pour ce wallet une attestation de 30 jours, renouvelable dans ses 7 derniers jours. Une seule transaction à confirmer dans ton wallet.")}
      </p>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
      >
        {busy ? t("Attestation en cours…") : renewal ? t("Renouveler maintenant") : t("Obtenir l’accès instantané")}
      </button>
      {error && <p role="alert" className="text-xs text-negative">{t(error)}</p>}
    </div>
  );
}
