"use client";

import { useUiStore } from "@/stores/ui";
import { useLocale } from "@/components/i18n/LocaleProvider";

/** Bascule contextuelle Simple/Avancé (défaut Simple, mémorisé localStorage). */
export function ModeToggle() {
  const advanced = useUiStore((s) => s.advanced);
  const setAdvanced = useUiStore((s) => s.setAdvanced);
  const { t } = useLocale();

  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
      <button
        onClick={() => setAdvanced(false)}
        className={`rounded-md px-3 py-1 font-medium transition-colors ${
          !advanced ? "bg-white/10 text-foreground" : "text-muted hover:text-foreground"
        }`}
      >
        {t("Simple")}
      </button>
      <button
        onClick={() => setAdvanced(true)}
        className={`rounded-md px-3 py-1 font-medium transition-colors ${
          advanced ? "bg-white/10 text-foreground" : "text-muted hover:text-foreground"
        }`}
      >
        {t("Avancé")}
      </button>
    </div>
  );
}
