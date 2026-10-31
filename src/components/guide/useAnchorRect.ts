"use client";

import { useEffect, useState } from "react";

export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Fréquence de relecture quand aucun événement ne prévient (barre latérale qui se déplie, police chargée). */
const POLL_MS = 400;

function visibleMatch(selector: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.getClientRects().length > 0) return element;
  }
  return null;
}

function sameRect(a: AnchorRect | null, b: AnchorRect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/**
 * Rectangle (viewport) du premier élément visible qui répond au sélecteur, ou `null`. Suivi au
 * défilement, au redimensionnement et par relecture périodique ; `scrollIntoView` à l'apparition
 * pour qu'un onglet de la barre mobile hors champ revienne dans le cadre.
 */
export function useAnchorRect(selector: string | null): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useEffect(() => {
    // Sans sélecteur, rien à suivre : le rectangle rendu est `null` (voir le retour).
    if (!selector) return;
    let scrolled = false;
    const measure = () => {
      const element = visibleMatch(selector);
      if (!element) {
        setRect((current) => (current === null ? current : null));
        return;
      }
      if (!scrolled) {
        scrolled = true;
        element.scrollIntoView({ block: "nearest", inline: "center" });
      }
      const box = element.getBoundingClientRect();
      const next = { left: box.left, top: box.top, width: box.width, height: box.height };
      setRect((current) => (sameRect(current, next) ? current : next));
    };
    measure();
    const timer = setInterval(measure, POLL_MS);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [selector]);

  return selector ? rect : null;
}
