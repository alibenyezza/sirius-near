"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "failed";

/**
 * Copie dans le presse-papiers avec un retour visuel temporaire. Ne lève jamais :
 * l'API peut manquer (contexte non sécurisé) ou être refusée par le navigateur, et un échec
 * est annoncé plutôt que silencieux.
 */
export function useCopy(): { state: CopyState; copy: (text: string) => Promise<void> } {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    let next: CopyState = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "failed";
    }
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  }, []);

  return { state, copy };
}
