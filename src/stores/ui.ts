import { useEffect, useState, useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Préférences UI contextuelles. `advanced` pilote le niveau de détail (Simple/Avancé,
 * D-19/D-23) : config d'entraînement + blocs de détails on-chain. Défaut Simple,
 * mémorisé en localStorage (par device). Pas de tier de compte.
 */
interface UiState {
  advanced: boolean;
  setAdvanced: (advanced: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (sidebarCollapsed: boolean) => void;
  /** Barre repliée mais dépliée au survol ; jamais mémorisé. */
  sidebarPeek: boolean;
  setSidebarPeek: (sidebarPeek: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      advanced: false,
      setAdvanced: (advanced) => set({ advanced }),
      sidebarCollapsed: false,
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      sidebarPeek: false,
      setSidebarPeek: (sidebarPeek) => set({ sidebarPeek }),
    }),
    {
      name: "sirius-ui",
      skipHydration: true,
      partialize: ({ advanced, sidebarCollapsed }) => ({ advanced, sidebarCollapsed }),
    },
  ),
);

/**
 * Vrai une image après la relecture des préférences depuis le stockage. Les transitions de la
 * barre latérale attendent ce moment : sinon le simple rétablissement d'une barre repliée au
 * chargement serait animé, la transition s'activant dans la même image que le repli.
 */
export function useUiTransitionsReady(): boolean {
  const hydrated = useSyncExternalStore(
    (onChange) => useUiStore.persist.onFinishHydration(onChange),
    () => useUiStore.persist.hasHydrated(),
    () => false,
  );
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!hydrated || ready) return;
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [hydrated, ready]);
  return ready;
}
