"use client";

import { useId } from "react";
import { useReducedMotion } from "@/components/ui/useReducedMotion";

/** Humeur du personnage : pilote le rythme de respiration, la couronne de particules et le regard. */
export type GuideMood = "idle" | "talking" | "waiting" | "happy";
/** Direction du regard, vers l'élément mis en lumière. */
export type GuideGaze = "left" | "right" | "center" | "up";

const GAZE: Record<GuideGaze, { x: number; y: number }> = {
  left: { x: -3, y: 0 },
  right: { x: 3, y: 0 },
  center: { x: 0, y: 0 },
  up: { x: 0, y: -2.5 },
};

/**
 * Sirio : un orbe abstrait, de la famille du blob de particules de l'accueil (noyau lumineux,
 * halo diffus, couronne de points qui tourne), avec deux yeux pour la vie. Tout est SVG + CSS :
 * aucune dépendance, et `prefers-reduced-motion` fige les animations (le clignement compris).
 */
export function GuideBlob({ size = 96, mood = "idle", gaze = "center", className = "" }: {
  size?: number;
  mood?: GuideMood;
  gaze?: GuideGaze;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const id = useId().replace(/:/g, "");
  const look = GAZE[gaze];
  const animate = !reduced;
  const breathe = mood === "waiting" ? "guide-breathe 4.2s ease-in-out infinite" : mood === "happy" ? "guide-bounce 0.9s ease-in-out infinite" : "guide-breathe 2.8s ease-in-out infinite";
  const spin = mood === "happy" ? "guide-spin 4s linear infinite" : mood === "talking" ? "guide-spin 14s linear infinite" : "guide-spin 26s linear infinite";

  return (
    <svg
      width={size}
      height={size}
      viewBox="-50 -50 100 100"
      aria-hidden
      className={className}
      style={{ overflow: "visible", filter: "drop-shadow(0 0 18px rgba(255,255,255,0.22))" }}
    >
      <defs>
        <radialGradient id={`${id}-core`} cx="42%" cy="38%" r="65%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="55%" stopColor="#d9d9d9" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#8a8a8a" stopOpacity="0.9" />
        </radialGradient>
        <radialGradient id={`${id}-halo`} cx="50%" cy="50%" r="50%">
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Halo diffus, respire avec le noyau. */}
      <circle r="48" fill={`url(#${id}-halo)`} style={{ transformOrigin: "0 0", animation: animate ? breathe : undefined }} />

      {/* Couronne de particules : les points de l'orbe de l'accueil, en orbite lente. */}
      <g style={{ transformOrigin: "0 0", animation: animate ? spin : undefined }} opacity="0.85">
        {Array.from({ length: 18 }, (_, i) => {
          const angle = (i / 18) * Math.PI * 2;
          const radius = 36 + (i % 3) * 3;
          return (
            <circle
              key={i}
              cx={Math.cos(angle) * radius}
              cy={Math.sin(angle) * radius}
              r={i % 4 === 0 ? 1.6 : 1}
              fill="#ffffff"
              opacity={0.35 + ((i * 7) % 10) / 16}
            />
          );
        })}
      </g>

      {/* Noyau : la forme vit par une respiration douce (scale) plutôt qu'un morphing coûteux. */}
      <g style={{ transformOrigin: "0 0", animation: animate ? breathe : undefined }}>
        <circle r="27" fill={`url(#${id}-core)`} />
        <ellipse cx="-8" cy="-11" rx="9" ry="5.5" fill="#ffffff" opacity="0.55" transform="rotate(-25)" />

        {/* Yeux : deux fentes qui clignent et suivent l'élément mis en lumière. */}
        <g transform={`translate(${look.x} ${look.y})`} style={{ transition: animate ? "transform 400ms cubic-bezier(0.65,0,0.35,1)" : undefined }}>
          {[-8, 8].map((x) => (
            <rect
              key={x}
              x={x - 2.4}
              y={-5}
              width="4.8"
              height={mood === "happy" ? 5 : 9}
              rx="2.4"
              fill="#0b0b0b"
              style={{ transformOrigin: `${x}px -0.5px`, animation: animate ? "guide-blink 5.2s ease-in-out infinite" : undefined, transition: "height 200ms" }}
            />
          ))}
          {mood === "happy" && <path d="M-6 6 Q0 11 6 6" stroke="#0b0b0b" strokeWidth="2" strokeLinecap="round" fill="none" />}
        </g>
      </g>
    </svg>
  );
}
