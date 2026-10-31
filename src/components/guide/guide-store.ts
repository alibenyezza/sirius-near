"use client";

import { create } from "zustand";
import {
  EMPTY_GUIDE_PROGRESS,
  isEmptyGuideProgress,
  mergeGuideProgress,
  parseProfileGuideProgress,
  readLocalGuideProgress,
  reduceGuideProgress,
  writeLocalGuideProgress,
  type GuideAction,
  type GuideProgress,
  type GuideStorage,
} from "@/lib/guide/machine";
import type { GuidePageKey, GuidePageStepKey } from "@/lib/guide/pages";
import { GUIDED_TOUR_EVENT } from "@/components/profile/guided-tour";
import { useWalletStore } from "@/stores/wallet";

/**
 * État du guide Sirio partagé entre l'hôte (personnage, bulle de dialogue), la bulle flottante
 * et le panneau de chat. La progression est lue en local au démarrage, puis, dès qu'un wallet
 * est signé, lue dans son profil et fusionnée avec la note locale (qui est alors renvoyée au
 * serveur). Chaque action est appliquée tout de suite à l'écran, puis enregistrée. La visite
 * de page en cours (`pageTour`) n'est pas mémorisée : seule la page « vue » l'est.
 */

/** Visite de page en cours : page, arrêt affiché, et si elle a été relancée à la main. */
export interface GuidePageTourState {
  page: GuidePageKey;
  /** Arrêt courant par son ancre (`null` : présentation), jamais par indice dans la liste filtrée. */
  step: GuidePageStepKey;
  manual: boolean;
}

interface GuideState {
  /** Progression lue côté navigateur : avant, rien n'est rendu (pas de rendu serveur divergent). */
  hydrated: boolean;
  /** Guide neutralisé dans la suite e2e, sauf demande explicite du test (marqueur local). */
  suppressed: boolean;
  /** Wallet signé (minuscules) dont la progression vient du profil ; `null` : note locale. */
  owner: string | null;
  /** Progression, état réduit compris (`minimized`), mémorisée comme le reste. */
  progress: GuideProgress;
  panelOpen: boolean;
  pageTour: GuidePageTourState | null;
}

export const useGuideStore = create<GuideState>(() => ({
  hydrated: false,
  suppressed: false,
  owner: null,
  progress: { ...EMPTY_GUIDE_PROGRESS },
  panelOpen: false,
  pageTour: null,
}));

function storage(): GuideStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function signedAddress(): string | null {
  const { authenticated, connected, address } = useWalletStore.getState();
  return authenticated && connected && address ? address.toLowerCase() : null;
}

/** Le guide est neutralisé dans la suite e2e sauf demande explicite du test (marqueur local). */
function guideSuppressedForE2e(): boolean {
  if (process.env.NEXT_PUBLIC_SIRIUS_E2E !== "1") return false;
  try {
    return window.localStorage.getItem("sirius-guide-e2e") !== "1";
  } catch {
    return true;
  }
}

/** Démarrage côté navigateur, idempotent : lit la note locale. */
export function startGuide(): void {
  if (useGuideStore.getState().hydrated) return;
  useGuideStore.setState({ hydrated: true, suppressed: guideSuppressedForE2e(), progress: readLocalGuideProgress(storage()) });
}

async function saveProfileGuide(progress: GuideProgress, owner: string): Promise<void> {
  let saved = false;
  try {
    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { guide: progress } }),
      cache: "no-store",
      credentials: "same-origin",
    });
    saved = response.ok;
  } catch {
    saved = false;
  }
  // Écriture perdue ou refusée : l'affichage de cet onglet suit quand même le choix de
  // l'utilisateur, et la note locale est gardée pour être renvoyée à la prochaine signature.
  // Confirmée pour ce wallet : la note anonyme n'a plus de raison d'être.
  if (saved && useGuideStore.getState().owner === owner) writeLocalGuideProgress(storage(), { ...EMPTY_GUIDE_PROGRESS });
}

/**
 * Wallet signé : lit `settings.guide` du profil, fusionne avec la note locale et, si celle-ci
 * apportait quelque chose, l'enregistre. Une réponse d'un autre wallet (session d'un autre onglet)
 * est ignorée ; le profil illisible laisse la progression locale.
 */
export async function syncGuideWithProfile(address: string): Promise<void> {
  const owner = address.toLowerCase();
  if (useGuideStore.getState().owner === owner) return;
  const local = readLocalGuideProgress(storage());
  let remote: GuideProgress | null = null;
  try {
    const response = await fetch("/api/profile", { cache: "no-store", credentials: "same-origin" });
    if (response.ok) remote = parseProfileGuideProgress(await response.json(), owner);
  } catch {
    remote = null;
  }
  if (signedAddress() !== owner) return;
  const merged = remote ? mergeGuideProgress(local, remote) : mergeGuideProgress(local, useGuideStore.getState().progress);
  useGuideStore.setState({ owner, progress: merged, hydrated: true });
  if (remote && !isEmptyGuideProgress(local)) void saveProfileGuide(merged, owner);
}

/** Déconnexion ou changement de wallet : la progression redevient la note locale. */
export function resetGuideOwner(): void {
  if (useGuideStore.getState().owner === null) return;
  useGuideStore.setState({ owner: null, progress: readLocalGuideProgress(storage()) });
}

/** Action de l'utilisateur sur le guide : à l'écran tout de suite, puis enregistrée. */
export function applyGuideAction(action: GuideAction): void {
  const state = useGuideStore.getState();
  const progress = reduceGuideProgress(state.progress, action);
  useGuideStore.setState({ progress });
  const owner = signedAddress();
  if (owner && state.owner === owner) void saveProfileGuide(progress, owner);
  else writeLocalGuideProgress(storage(), progress);
}

/** Échap ou « Réduire » : rangé dans la bulle, mémorisé comme le reste de la progression. */
export function minimizeGuide(): void {
  applyGuideAction({ type: "minimize" });
}

/** Clic sur la bulle pendant un parcours réduit : reprend là où il en était. */
export function restoreGuide(): void {
  useGuideStore.setState({ panelOpen: false });
  applyGuideAction({ type: "restore" });
}

export function setGuidePanelOpen(panelOpen: boolean): void {
  useGuideStore.setState({ panelOpen });
}

/** « Revoir la visite guidée » : repart de l'accueil, ferme le panneau et toute visite de page. */
export function replayGuide(): void {
  useGuideStore.setState({ panelOpen: false, pageTour: null });
  applyGuideAction({ type: "replay" });
}

/**
 * Ouvre la visite d'une page au premier arrêt : toute seule à la première visite (`manual`
 * faux), ou depuis le bouton « ? » et le panneau (`manual` vrai). Ferme le panneau.
 */
export function startPageTour(page: GuidePageKey, manual = false): void {
  useGuideStore.setState({ pageTour: { page, step: null, manual }, panelOpen: false });
}

export function setPageTourStep(step: GuidePageStepKey): void {
  const current = useGuideStore.getState().pageTour;
  if (!current || current.step === step) return;
  useGuideStore.setState({ pageTour: { ...current, step } });
}

/**
 * Ferme la visite de page. `seen` : terminée, passée ou quittée par navigation — la page est
 * notée vue et ne se rouvrira plus toute seule ; faux quand c'est le site qui la masque.
 */
export function endPageTour(seen: boolean): void {
  const current = useGuideStore.getState().pageTour;
  if (!current) return;
  useGuideStore.setState({ pageTour: null });
  if (seen) applyGuideAction({ type: "page-seen", page: current.page });
}

/**
 * Abonne `restart` à la demande « Visite guidée » du menu profil (`sirius:guided-tour:start`,
 * voir `src/components/profile/guided-tour.ts`). `preventDefault()` sert d'accusé de
 * réception : sans lui le menu afficherait « bientôt disponible ». Renvoie le désabonnement.
 */
export function subscribeGuidedTourRequests(target: EventTarget = window, restart: () => void = replayGuide): () => void {
  const onStart = (event: Event) => {
    event.preventDefault();
    restart();
  };
  target.addEventListener(GUIDED_TOUR_EVENT, onStart);
  return () => target.removeEventListener(GUIDED_TOUR_EVENT, onStart);
}
