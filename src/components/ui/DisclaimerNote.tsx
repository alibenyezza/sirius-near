"use client";

import { Fragment } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { CONTACT_EMAIL, DISCLAIMER_IDS, contactMailtoHref, disclaimerText, type DisclaimerId } from "@/lib/copy/disclaimers";

export type DisclaimerVariant = "info" | "warning";

interface DisclaimerNoteProps {
  /** « info » : rappel discret. « warning » : à lire avant d'agir (publier, emprunter). */
  variant?: DisclaimerVariant;
  /** Textes communs à afficher, dans l'ordre. Par défaut : qualité des modèles, puis contact. */
  messages?: readonly DisclaimerId[];
  /** Contenu propre à la page, affiché avant les textes communs. */
  children?: React.ReactNode;
  className?: string;
}

const DEFAULT_MESSAGES: readonly DisclaimerId[] = ["modelQuality", "contactUs"];

const VARIANT_STYLES: Record<DisclaimerVariant, { box: string; icon: string }> = {
  info: { box: "border-border bg-surface/50 text-muted", icon: "text-muted" },
  warning: { box: "border-yellow-400/40 bg-yellow-400/5 text-foreground/90", icon: "text-yellow-400" },
};

/**
 * Coupe un texte traduit autour de l'adresse de contact pour en faire un lien `mailto:`.
 * Le texte est rendu par React (échappé), jamais comme HTML : seule l'adresse constante
 * `CONTACT_EMAIL` devient un lien.
 */
function withContactLink(text: string): React.ReactNode {
  const parts = text.split(CONTACT_EMAIL);
  if (parts.length === 1) return text;
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && (
        <a
          href={contactMailtoHref()}
          className="font-medium text-foreground underline underline-offset-2 hover:text-accent focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {CONTACT_EMAIL}
        </a>
      )}
      {part}
    </Fragment>
  ));
}

/** Encart d'avertissement discret, avec lien vers le contact quand le texte le mentionne. */
export function DisclaimerNote({ variant: requested = "info", messages = DEFAULT_MESSAGES, children, className = "" }: DisclaimerNoteProps) {
  const { t } = useLocale();
  // Une valeur inattendue retombe sur la variante discrète plutôt que de planter la page.
  const variant: DisclaimerVariant = requested === "warning" ? "warning" : "info";
  const styles = VARIANT_STYLES[variant];
  // Identifiants inconnus ignorés, doublons retirés (un texte n'apparaît qu'une fois, clés React uniques).
  const ids = [...new Set(messages)].filter((id) => DISCLAIMER_IDS.includes(id));
  return (
    <aside
      role="note"
      data-variant={variant}
      className={`flex min-w-0 gap-3 rounded-xl border px-4 py-3 text-xs leading-relaxed wrap-anywhere ${styles.box} ${className}`}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        className={`mt-0.5 shrink-0 ${styles.icon}`}
      >
        {variant === "warning" ? (
          <path d="M8 2.5 14.5 13.5h-13L8 2.5Zm0 4v3.5m0 1.75v.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Zm0-6v3.25m0-5.25v.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
      <div className="min-w-0 space-y-1">
        {children && <div>{children}</div>}
        {ids.length > 0 && (
          <p>
            {ids.map((id, index) => (
              <Fragment key={id}>
                {index > 0 && " "}
                {withContactLink(disclaimerText(id, t))}
              </Fragment>
            ))}
          </p>
        )}
      </div>
    </aside>
  );
}
