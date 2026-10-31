"use client";

import { useLocale } from "@/components/i18n/LocaleProvider";
import { Badge } from "./Badge";
import { STATUS_DOT_CLASS, isStatusKind, statusMeta, type StatusKind } from "./status";

interface StatusPillProps {
  /** Valeur inattendue venue de l'API : affichée comme « État inconnu », sans erreur. */
  status: StatusKind;
  className?: string;
}

/** Pastille d'état : un point de couleur et un libellé. Le libellé porte le sens, pas la couleur. */
export function StatusPill({ status, className = "" }: StatusPillProps) {
  const { t } = useLocale();
  const meta = statusMeta(status);
  return (
    <Badge variant={meta.variant} className={className}>
      <span className="inline-flex items-center gap-1.5" data-status={isStatusKind(status) ? status : "unknown"}>
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[meta.variant]}`} />
        {t(meta.labelKey)}
      </span>
    </Badge>
  );
}
