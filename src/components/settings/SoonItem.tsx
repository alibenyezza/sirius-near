"use client";

import { useLocale } from "@/components/i18n/LocaleProvider";

/** Réglage ou fonction à venir : grisé, non interactif, avec la mention « Soon ». */
export function SoonItem({ title, hint }: { title: string; hint: string }) {
  const { t } = useLocale();
  return (
    <li
      data-testid="soon-item"
      className="flex items-start justify-between gap-4 rounded-lg border border-border/60 px-4 py-3 opacity-50"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{t(title)}</p>
        <p className="mt-0.5 text-xs text-muted">{t(hint)}</p>
      </div>
      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted">{t("Soon")}</span>
    </li>
  );
}
