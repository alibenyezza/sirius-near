"use client";

import { useEffect } from "react";
import { useGuideStore } from "@/components/guide/guide-store";
import { pendingKybAttestation } from "@/lib/kyb/client";
import { shouldPromptVerification } from "@/lib/onboarding/steps";
import { useWalletStore } from "@/stores/wallet";
import {
  loadKybGate,
  markPromptShown,
  promptShownThisSession,
  requestVerification,
  resetOnboardingFor,
  useOnboardingStore,
} from "./onboarding-store";
import { VerificationDialog } from "./VerificationDialog";

/** Fréquence à laquelle on regarde si la place est libre (tuto ou autre fenêtre fermés). */
const PROMPT_POLL_MS = 1_000;

/** Une fenêtre modale du site est-elle déjà ouverte (tuto, ajout de fonds, devis) ? */
function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Porte la fenêtre de vérification pour toute l'application, et la propose une fois par session
 * juste après la connexion quand le wallet n'est pas vérifié et que l'accès instantané est ouvert.
 *
 * Jamais par-dessus une autre fenêtre : la proposition attend que le tuto de bienvenue (qui
 * s'ouvre lui aussi après la première connexion) et toute autre fenêtre modale soient fermés.
 * Neutralisée avec les tutos dans la suite e2e. `autoPrompt` à faux (hôte de démonstration) :
 * la fenêtre ne s'ouvre qu'à la demande d'une garde. Une signature faite depuis la carte
 * « Get started » (`chainedFor`) enchaîne aussi sur la fenêtre, y compris en mode invitation :
 * l'utilisateur suit le parcours, la vérification en est l'étape suivante.
 */
export function OnboardingHost({ autoPrompt = true }: { autoPrompt?: boolean }) {
  const address = useWalletStore((s) => s.address);
  const connected = useWalletStore((s) => s.connected);
  const authenticated = useWalletStore((s) => s.authenticated);
  const signed = connected && authenticated && address ? address.toLowerCase() : null;
  const owner = useOnboardingStore((s) => s.owner);
  const kyb = useOnboardingStore((s) => s.kyb);
  const instantAccess = useOnboardingStore((s) => s.instantAccess);
  const dialog = useOnboardingStore((s) => s.dialog);
  const chained = useOnboardingStore((s) => s.chainedFor !== null && s.chainedFor === signed);

  useEffect(() => {
    resetOnboardingFor(signed);
    if (signed) void loadKybGate();
  }, [signed]);

  useEffect(() => {
    if ((!autoPrompt && !chained) || !signed || owner !== signed || kyb !== "missing" || (!instantAccess && !chained)) return;
    if (promptShownThisSession(signed)) return;
    let attestationSeen = false;
    const timer = setInterval(() => {
      // Attestation automatique en route juste après la connexion : on attend sa fin, puis on
      // relit le statut ; la fenêtre ne se propose que si le wallet n'est toujours pas vérifié.
      if (pendingKybAttestation()) {
        attestationSeen = true;
        return;
      }
      if (attestationSeen) {
        attestationSeen = false;
        void loadKybGate();
        return;
      }
      const guide = useGuideStore.getState();
      if (guide.suppressed) {
        clearInterval(timer);
        return;
      }
      // Guide Sirio en cours (pas passé, pas terminé) ou visite de page affichée : c'est lui qui
      // propose la vérification, avec son explication ; la fenêtre ne s'ouvre pas toute seule par-dessus.
      const guideActive = !guide.hydrated || !(guide.progress.skipped || guide.progress.tourDone) || guide.pageTour !== null;
      const ready = shouldPromptVerification({
        authenticated: true,
        kyb,
        instantAccess: instantAccess || chained,
        shownThisSession: promptShownThisSession(signed),
        overlayOpen: modalOpen() || useOnboardingStore.getState().dialog !== null,
        tourPending: guideActive,
      });
      if (!ready) return;
      clearInterval(timer);
      markPromptShown(signed);
      useOnboardingStore.setState({ chainedFor: null });
      void requestVerification("prompt");
    }, PROMPT_POLL_MS);
    return () => clearInterval(timer);
  }, [autoPrompt, chained, signed, owner, kyb, instantAccess]);

  if (!dialog || !signed || owner !== signed || !address) return null;
  return <VerificationDialog key={dialog.id} requestId={dialog.id} reason={dialog.reason} role={dialog.role} address={address} />;
}
