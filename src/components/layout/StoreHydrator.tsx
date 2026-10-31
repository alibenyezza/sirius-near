"use client";

import { useEffect } from "react";
import { useUiStore } from "@/stores/ui";
import { useFavoritesStore } from "@/stores/favorites";

/**
 * Réhydrate les stores persistés (`skipHydration: true`) APRÈS le montage. Le premier
 * rendu client part ainsi des valeurs par défaut — identiques au HTML SSR — puis lit
 * localStorage, évitant tout mismatch d'hydratation (toggle Simple/Avancé, favoris).
 */
export function StoreHydrator() {
  useEffect(() => {
    useUiStore.persist.rehydrate();
    useFavoritesStore.persist.rehydrate();
  }, []);
  return null;
}
