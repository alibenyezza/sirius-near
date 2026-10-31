import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Favoris marketplace (⭐), par device en localStorage (D-23). */
interface FavoritesState {
  ids: string[];
  toggle: (id: string) => void;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set) => ({
      ids: [],
      toggle: (id) =>
        set((s) => ({
          ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id],
        })),
    }),
    { name: "sirius-favorites", skipHydration: true },
  ),
);
