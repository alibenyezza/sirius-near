"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { LOAN_PHASE_LABEL, LOAN_PHASE_STEPS } from "@/lib/onboarding/copy";
import { activeLoanSummary, type OnboardingLoan } from "@/lib/onboarding/steps";
import { useWalletStore } from "@/stores/wallet";

/** Relecture modeste : un prêt change de phase en minutes, pas en secondes. */
const POLL_MS = 60_000;

/**
 * Indicateur discret, en tête de chaque page : « 1 emprunt : fonds en escrow · lance
 * l’entraînement », avec une petite frise des quatre temps du prêt et un lien vers Train. Affiché
 * seulement avec une session signée et au moins un emprunt payé non terminé (voir `loanPhase`).
 *
 * Lecture de `GET /api/loans` au changement de page, puis toutes les minutes tant que l'onglet
 * est visible. Aucune action ici : la page Train reste le seul endroit où l'on agit sur un prêt.
 */
export function ActiveLoanIndicator() {
  const { t } = useLocale();
  const pathname = usePathname();
  const address = useWalletStore((s) => s.address);
  const connected = useWalletStore((s) => s.connected);
  const authenticated = useWalletStore((s) => s.authenticated);
  const viewer = connected && authenticated && address ? address : null;
  const [state, setState] = useState<{ viewer: string; loans: OnboardingLoan[] } | null>(null);

  useEffect(() => {
    if (!viewer) return;
    let active = true;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      void fetch("/api/loans", { cache: "no-store", credentials: "same-origin" })
        .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
        .then((body) => {
          if (active && Array.isArray(body)) setState({ viewer, loans: body as OnboardingLoan[] });
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [viewer, pathname]);

  // Les prêts d'un autre compte (wallet changé) ne sont jamais affichés.
  const summary = viewer && state?.viewer === viewer ? activeLoanSummary(state.loans, viewer) : null;
  if (!summary) return null;
  const current = LOAN_PHASE_STEPS.indexOf(summary.phase);

  return (
    <div className="mx-auto mb-2 flex w-full max-w-6xl justify-end px-4 sm:px-6">
      <Link
        href="/train"
        data-testid="active-loan-indicator"
        data-phase={summary.phase}
        className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:border-white/20"
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" aria-hidden />
        <span className="font-medium text-foreground">
          {summary.count === 1 ? t("1 emprunt :") : t("{count} emprunts :", { count: summary.count })}
        </span>
        <span className={summary.phase === "attention" ? "font-medium text-negative" : "text-foreground"}>
          {t(LOAN_PHASE_LABEL[summary.phase])}
        </span>
        {/* Frise discrète des quatre temps d'un prêt ; le libellé ci-dessus porte l'information. */}
        {current >= 0 && (
          <span className="ml-0.5 inline-flex items-center gap-1" aria-hidden>
            {LOAN_PHASE_STEPS.map((phase, index) => (
              <span
                key={phase}
                className={`h-1 rounded-full ${index === current ? "w-3 bg-accent" : index < current ? "w-1 bg-positive" : "w-1 bg-border"}`}
              />
            ))}
          </span>
        )}
      </Link>
    </div>
  );
}
