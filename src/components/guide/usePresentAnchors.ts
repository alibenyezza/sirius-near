"use client";

import { useEffect, useState } from "react";
import { GUIDE_ANCHOR_ATTRIBUTE } from "@/lib/guide/machine";
import type { GuidePageKey } from "@/lib/guide/pages";

/** Fréquence de relecture : les ancres apparaissent au fil des chargements (listes, soldes, statut). */
const POLL_MS = 400;

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Ancres de visite (`data-guide="page:<page>:<élément>"`) réellement à l'écran pour la page
 * donnée : un élément vide ou masqué (taille nulle) ne compte pas. L'ensemble renvoyé ne change
 * d'identité que si son contenu change, pour ne pas faire recalculer les arrêts à chaque relecture.
 */
export function usePresentAnchors(page: GuidePageKey | null): ReadonlySet<string> {
  const [present, setPresent] = useState<ReadonlySet<string>>(EMPTY);

  useEffect(() => {
    if (!page) return;
    const prefix = `page:${page}:`;
    const measure = () => {
      const found = new Set<string>();
      for (const element of document.querySelectorAll<HTMLElement>(`[${GUIDE_ANCHOR_ATTRIBUTE}^="${prefix}"]`)) {
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) found.add(element.getAttribute(GUIDE_ANCHOR_ATTRIBUTE)!.slice(prefix.length));
      }
      setPresent((current) => (current.size === found.size && [...found].every((name) => current.has(name)) ? current : found));
    };
    measure();
    const timer = setInterval(measure, POLL_MS);
    return () => clearInterval(timer);
  }, [page]);

  return page ? present : EMPTY;
}
