"use client";

import { useLocale } from "@/components/i18n/LocaleProvider";

/**
 * Mention affichée à côté de chaque connexion : se connecter vaut acceptation des conditions.
 * Le lien s'ouvre dans un nouvel onglet pour ne pas interrompre la connexion en cours.
 */
export function TermsNotice({ className = "" }: { className?: string }) {
  const { t } = useLocale();
  return (
    <p className={`text-xs text-muted ${className}`} data-testid="terms-notice">
      {t("En te connectant, tu acceptes les")}{" "}
      <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
        {t("conditions d’utilisation")}
      </a>
      .
    </p>
  );
}
