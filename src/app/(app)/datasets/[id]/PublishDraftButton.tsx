"use client";

import { useLocale } from "@/components/i18n/LocaleProvider";

interface PublishDraftButtonProps {
  status: string;
  ipfsCid: string | null;
  /** Profil d'entraînement valide (`modelSelection`). Sans lui, la publication est bloquée. */
  modelValid: boolean;
  /** Publication en cours pour ce dataset. */
  pending: boolean;
  /** Une autre action est en cours : le bouton est désactivé sans changer de libellé. */
  disabled?: boolean;
  onPublish: () => void;
  className?: string;
}

/**
 * Publication du titre EVM d'un brouillon (DRAFT) ou réconciliation d'une publication
 * interrompue (LISTING), partagée par la mosaïque et la fiche, avec les règles de l'ancienne
 * liste : bloquée sans profil valide (« Réimport requis ») ou sans fichier envoyé
 * (« Upload incomplet »). Le serveur refait ces contrôles ; ce bouton n'est pas une garde.
 */
export function PublishDraftButton({ status, ipfsCid, modelValid, pending, disabled = false, onPublish, className = "" }: PublishDraftButtonProps) {
  const { t } = useLocale();
  if (status !== "DRAFT" && status !== "LISTING") return null;
  const incomplete = status === "DRAFT" && !ipfsCid;
  return (
    <button
      type="button"
      onClick={onPublish}
      disabled={pending || disabled || !modelValid || incomplete}
      title={incomplete ? t("Upload interrompu : supprime ce brouillon et recommence") : undefined}
      className={`max-w-full rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50 ${className}`}
    >
      {pending
        ? t("Publication…")
        : !modelValid
          ? t("Réimport requis")
          : status === "LISTING"
            ? t("Réconcilier…")
            : ipfsCid
              ? t("Publier le titre")
              : t("Upload incomplet")}
    </button>
  );
}
