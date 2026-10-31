"use client";

import { createContext, useContext, useEffect } from "react";
import { translateEnglish, type TranslationVariables } from "@/lib/i18n/english";

export type Locale = "fr" | "en";

interface LocaleContextValue {
  locale: Locale;
  t: (key: string, variables?: TranslationVariables) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  // Le site est en anglais, sans alternative. Le public visé — investisseurs,
  // réseaux d'agents, développeurs de l'écosystème — ne lit pas le français, et un
  // sélecteur de langue sur une page d'accueil coûte plus en hésitation qu'il ne
  // rapporte en confort.
  //
  // Les messages métier restent inchangés ; seul leur affichage est traduit.
  const locale: Locale = "en";
  const t = translateEnglish;

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("Sirius — data lending confidentiel sur EVM");
    // Un choix mémorisé lors d'une visite précédente ne doit pas ressusciter une
    // langue que le site ne propose plus.
    window.localStorage.removeItem("sirius.locale");
  }, [locale, t]);

  return <LocaleContext value={{ locale, t }}>{children}</LocaleContext>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used within LocaleProvider");
  return value;
}
