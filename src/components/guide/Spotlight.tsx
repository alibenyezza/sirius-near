"use client";

import { useReducedMotion } from "@/components/ui/useReducedMotion";
import type { AnchorRect } from "./useAnchorRect";

const PADDING = 8;

/**
 * Voile sombre avec une découpe autour de l'élément mis en lumière. La découpe est l'ombre
 * portée d'un rectangle arrondi (`box-shadow` géant) : aucun masque, et tout le voile laisse
 * passer les clics (`pointer-events: none`) : l'utilisateur agit sur le vrai bouton, le site
 * n'est jamais bloqué. Le rectangle suit l'élément en douceur, sauf si les animations sont réduites.
 */
export function Spotlight({ rect, label }: { rect: AnchorRect | null; label: string }) {
  const reduced = useReducedMotion();
  if (!rect) return null;
  return (
    <div
      role="img"
      aria-label={label}
      data-guide-spotlight=""
      className="pointer-events-none fixed rounded-2xl"
      style={{
        left: rect.left - PADDING,
        top: rect.top - PADDING,
        width: rect.width + PADDING * 2,
        height: rect.height + PADDING * 2,
        boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.62), 0 0 0 2px rgba(255,255,255,0.35), 0 0 28px rgba(255,255,255,0.25)",
        transition: reduced ? "none" : "left 500ms cubic-bezier(0.65,0,0.35,1), top 500ms cubic-bezier(0.65,0,0.35,1), width 500ms cubic-bezier(0.65,0,0.35,1), height 500ms cubic-bezier(0.65,0,0.35,1)",
      }}
    />
  );
}
