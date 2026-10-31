"use client";

import { useLocale } from "@/components/i18n/LocaleProvider";
import { GUIDE_NAME } from "@/lib/guide/machine";
import { GUIDE_UI } from "@/lib/guide/copy";
import { GuideBlob } from "./GuideBlob";

/**
 * Bulle flottante en bas à droite, présente sur toutes les pages de l'application : Sirio en
 * petit, qui ouvre le panneau (chat, relance de la visite). Quand le guide est réduit en plein
 * parcours, un point signale qu'il attend ; le clic le rouvre là où il en était.
 */
export function GuideBubble({ onClick, pending, open, buttonRef }: {
  onClick: () => void;
  /** Guide réduit en cours de parcours : à reprendre. */
  pending: boolean;
  /** Panneau ouvert : la bulle sert alors de bouton de fermeture. */
  open: boolean;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useLocale();
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={t(GUIDE_UI.open, { name: GUIDE_NAME })}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={t(GUIDE_UI.open, { name: GUIDE_NAME })}
      data-testid="guide-bubble"
      className="fixed bottom-4 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full border border-white/15 bg-surface/70 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-transform duration-200 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-95 motion-reduce:transition-none print:hidden"
    >
      <GuideBlob size={44} mood={pending ? "waiting" : "idle"} gaze={open ? "up" : "center"} />
      {pending && <span aria-hidden className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_10px_rgba(255,255,255,0.8)]" />}
    </button>
  );
}
