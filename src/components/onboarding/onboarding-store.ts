"use client";

import { create } from "zustand";
import { useWalletStore } from "@/stores/wallet";
import type { KybRole } from "@/lib/kyb/client";
import {
  gateDecision,
  parseChecklistDismissed,
  parseKybGate,
  type KybGateState,
} from "@/lib/onboarding/steps";

/**
 * État partagé du parcours d'accueil : statut de vérification du wallet signé, fenêtre de vérification
 * ouverte et préférence « carte Get started fermée ».
 *
 * Une seule lecture de `/api/kyb/status` sert la carte du tableau de bord, la fenêtre proposée
 * après la connexion et les gardes Emprunter / Publier ; une vérification réussie la met à jour
 * pour tous. Tout est rangé avec l'adresse qui l'a lu : après un changement de wallet, rien de
 * l'ancien compte n'est réutilisé.
 */

/** Origine de la fenêtre : un clic sur Emprunter / Publier reprend l'action après la réussite. */
export type VerificationReason = "prompt" | "checklist" | "borrow" | "publish";

interface VerificationRequest {
  reason: VerificationReason;
  role: KybRole;
  /** Change à chaque ouverture : une relance repart d'un état vierge. */
  id: number;
}

interface OnboardingState {
  /** Adresse (minuscules) à laquelle se rapportent `kyb`, `instantAccess` et `dismissed`. */
  owner: string | null;
  kyb: KybGateState | null;
  instantAccess: boolean;
  checkedAt: number;
  dismissed: boolean | null;
  /** Carte rouverte depuis le menu profil : affichée même quand le parcours est terminé. */
  reopened: boolean;
  dialog: VerificationRequest | null;
  /**
   * Wallet (minuscules) qui vient de se signer depuis la carte « Get started » : la fenêtre de
   * vérification lui est proposée même hors accès instantané (formulaire d'invitation). Hors de la
   * remise à zéro par adresse : la signature change le propriétaire juste avant cette demande.
   */
  chainedFor: string | null;
}

export const useOnboardingStore = create<OnboardingState>(() => ({
  owner: null,
  kyb: null,
  instantAccess: false,
  checkedAt: 0,
  dismissed: null,
  reopened: false,
  dialog: null,
  chainedFor: null,
}));

/** Au-delà, la garde relit le registre plutôt que de se fier au statut en mémoire. */
const KYB_FRESH_MS = 30_000;

let openings = 0;
let resolver: ((verified: boolean) => void) | null = null;
const inflight = new Map<string, Promise<KybGateState>>();

function signedAddress(): string | null {
  const { authenticated, connected, address } = useWalletStore.getState();
  return authenticated && connected && address ? address.toLowerCase() : null;
}

/** Repart d'un état vierge pour le wallet signé courant (ou aucun). Ferme la fenêtre ouverte. */
export function resetOnboardingFor(address: string | null): void {
  const owner = address ? address.toLowerCase() : null;
  if (useOnboardingStore.getState().owner === owner) return;
  settle(false);
  useOnboardingStore.setState({ owner, kyb: null, instantAccess: false, checkedAt: 0, dismissed: null, reopened: false, dialog: null });
}

/** Lit le statut de vérification du wallet signé. Les lectures simultanées d'un même wallet sont partagées. */
export function loadKybGate(): Promise<KybGateState> {
  const owner = signedAddress();
  if (!owner) return Promise.resolve("unknown");
  const running = inflight.get(owner);
  if (running) return running;
  const promise = (async (): Promise<KybGateState> => {
    let next: { kyb: KybGateState; instantAccess: boolean } = { kyb: "unknown", instantAccess: false };
    try {
      const response = await fetch("/api/kyb/status", { cache: "no-store", credentials: "same-origin" });
      if (response.ok) next = parseKybGate(await response.json());
    } catch {
      // Lecture en échec : statut inconnu, rien n'est bloqué.
    }
    // Réponse d'un wallet remplacé entre-temps : ignorée.
    if (signedAddress() === owner && useOnboardingStore.getState().owner === owner) {
      useOnboardingStore.setState({ kyb: next.kyb, instantAccess: next.instantAccess, checkedAt: Date.now() });
    }
    return next.kyb;
  })().finally(() => inflight.delete(owner));
  inflight.set(owner, promise);
  return promise;
}

/** Vérification réussie : le statut passe à « vérifié » sans attendre une relecture. */
export function markVerified(): void {
  useOnboardingStore.setState({ kyb: "valid", checkedAt: Date.now() });
}

function settle(verified: boolean): void {
  const pending = resolver;
  resolver = null;
  pending?.(verified);
}

/** Ouvre la fenêtre de vérification. Résout `true` après une vérification réussie, `false` sinon. */
export function requestVerification(reason: VerificationReason, role: KybRole = reason === "publish" ? "provider" : "borrower"): Promise<boolean> {
  settle(false);
  useOnboardingStore.setState({ dialog: { reason, role, id: ++openings } });
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

/**
 * Ferme la fenêtre ; `verified` dit si l'action d'origine peut reprendre. `id` : ouverture
 * concernée. Une fin tardive d'une fenêtre déjà remplacée (formulaire d'invitation qui aboutit
 * après la fermeture) ne ferme pas la nouvelle et ne reprend pas son action.
 */
export function closeVerification(verified: boolean, id?: number): void {
  const current = useOnboardingStore.getState().dialog;
  if (id !== undefined && current?.id !== id) return;
  useOnboardingStore.setState({ dialog: null });
  settle(verified);
}

/**
 * Garde au point d'action (Emprunter, Publier). Sans session signée, laisse passer : le parcours
 * de connexion existant s'en charge. Statut frais en mémoire, sinon relu. « Non vérifié » ouvre la
 * fenêtre et attend son issue ; statut illisible : l'action part, le serveur tranche.
 */
export async function ensureVerifiedFor(reason: "borrow" | "publish"): Promise<boolean> {
  const owner = signedAddress();
  if (!owner) return true;
  const state = useOnboardingStore.getState();
  const fresh = state.owner === owner && state.kyb !== null && Date.now() - state.checkedAt < KYB_FRESH_MS;
  const kyb = fresh && state.kyb !== null ? state.kyb : await loadKybGate();
  if (gateDecision(kyb) === "proceed") return true;
  return requestVerification(reason);
}

/** Préférence « carte fermée » du wallet signé, lue dans le profil. */
export async function loadChecklistPreference(): Promise<void> {
  const owner = signedAddress();
  if (!owner) return;
  // Déjà lue (ou choisie) pour ce wallet : la mémoire de l'onglet suffit.
  const known = useOnboardingStore.getState();
  if (known.owner === owner && known.dismissed !== null) return;
  try {
    const response = await fetch("/api/profile", { cache: "no-store", credentials: "same-origin" });
    const dismissed = response.ok ? parseChecklistDismissed(await response.json(), owner) : null;
    if (signedAddress() !== owner || useOnboardingStore.getState().owner !== owner) return;
    // Choix fait dans cet onglet pendant la lecture (rouverte depuis le menu) : il l'emporte.
    if (useOnboardingStore.getState().reopened) return;
    // Profil illisible : la carte reste masquée plutôt que d'apparaître puis disparaître.
    useOnboardingStore.setState({ dismissed: dismissed ?? true });
  } catch {
    const state = useOnboardingStore.getState();
    if (state.owner === owner && !state.reopened) useOnboardingStore.setState({ dismissed: true });
  }
}

async function saveChecklistDismissed(dismissed: boolean): Promise<void> {
  try {
    await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { onboardingDismissed: dismissed } }),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    // Écriture perdue : l'affichage de cet onglet suit quand même le choix de l'utilisateur.
  }
}

/** « Masquer » sur la carte : immédiat à l'écran, puis enregistré dans le profil. */
export function dismissChecklist(): void {
  useOnboardingStore.setState({ dismissed: true, reopened: false });
  if (signedAddress()) void saveChecklistDismissed(true);
}

/** « Get started » du menu profil : la carte réapparaît sur le tableau de bord. */
export function reopenChecklist(): void {
  useOnboardingStore.setState({ dismissed: false, reopened: true });
  if (signedAddress()) void saveChecklistDismissed(false);
}

const PROMPT_PREFIX = "sirius-onboarding-prompt:";

/** Wallets à qui la fenêtre a été proposée dans cet onglet, si `sessionStorage` est interdit. */
const shownHere = new Set<string>();

/** La fenêtre d'après connexion a-t-elle déjà été proposée à ce wallet dans cet onglet ? */
export function promptShownThisSession(address: string): boolean {
  const key = address.toLowerCase();
  if (shownHere.has(key)) return true;
  try {
    return window.sessionStorage.getItem(PROMPT_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

export function markPromptShown(address: string): void {
  const key = address.toLowerCase();
  shownHere.add(key);
  try {
    window.sessionStorage.setItem(PROMPT_PREFIX + key, "1");
  } catch {
    // Stockage interdit : la mémoire du module suffit pour l'onglet.
  }
}

/**
 * Signature réussie depuis la carte « Get started » : enchaîner sur la vérification si le wallet
 * n'est pas vérifié. Le statut est relu (la connexion a pu attester le wallet entre-temps), puis
 * `OnboardingHost` ouvre la fenêtre quand la place est libre, une seule fois par session.
 */
export async function chainVerificationAfterSignIn(): Promise<void> {
  const owner = signedAddress();
  if (!owner || promptShownThisSession(owner)) return;
  // L'hôte remet normalement l'état à zéro pour ce wallet ; sans effet s'il l'a déjà fait.
  resetOnboardingFor(owner);
  const kyb = await loadKybGate();
  if (kyb !== "missing" || signedAddress() !== owner) return;
  useOnboardingStore.setState({ chainedFor: owner });
}
