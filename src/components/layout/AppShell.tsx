"use client";

import { useEffect } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { LegalLinks } from "@/components/layout/LegalLinks";
import { ProfileMenu } from "@/components/profile/ProfileMenu";
import { ActiveLoanIndicator } from "@/components/onboarding/ActiveLoanIndicator";
import { OnboardingHost } from "@/components/onboarding/OnboardingHost";
import { GuideHost } from "@/components/guide/GuideHost";
import { SecureAccountBanner } from "@/components/wallet/SecureAccount";
import { APP_BACKGROUND_BLOB_Z, useBlobStore } from "@/stores/blob";
import { useUiStore, useUiTransitionsReady } from "@/stores/ui";

/** Cadre des pages de l'application. `demoOnly` : adresse démo, sans menu ni visites guidées. */
export function AppShell({ children, demoOnly = false }: { children: React.ReactNode; demoOnly?: boolean }) {
  const setTargetZ = useBlobStore((s) => s.setTargetZ);
  // Le survol d'une barre repliée la déplie par-dessus la page, sans la décaler : seul l'épinglage
  // change la marge, sinon le contenu sauterait à chaque passage de la souris.
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const hydrated = useUiTransitionsReady();

  useEffect(() => {
    setTargetZ(APP_BACKGROUND_BLOB_Z);
    return () => setTargetZ(null);
  }, [setTargetZ]);

  if (demoOnly) {
    return (
      <div className="relative z-10 min-h-full text-foreground">
        <div className="pt-8">
          <ProfileMenu />
          {children}
          <LegalFooter />
        </div>
        {/* Gardes Emprunter / Publier seulement : pas de proposition automatique sur l'hôte de démonstration. */}
        <OnboardingHost autoPrompt={false} />
      </div>
    );
  }

  return (
    <div
      className={`relative z-10 min-h-full text-foreground ${hydrated ? "transition-[padding] duration-300 ease-out motion-reduce:transition-none" : ""} ${
        collapsed ? "md:pl-28" : "md:pl-[19rem]"
      }`}
    >
      <Sidebar />
      <OnboardingHost />
      {/* Guide Sirio : accueil animé, visites de page, puis bulle en bas à droite sur toutes les pages. */}
      <GuideHost />
      {/* décalage pour la barre mobile (top-16 + nav) ; nul en desktop */}
      <div className="pt-32 md:pt-8">
        <ProfileMenu />
        <ActiveLoanIndicator />
        <SecureAccountBanner />
        {children}
        <LegalFooter />
      </div>
    </div>
  );
}

/** Pied de page des pages de l'application : conditions, confidentialité, mentions légales. */
function LegalFooter() {
  return (
    <footer className="mx-auto w-full max-w-6xl px-4 pb-8 sm:px-6">
      <LegalLinks className="justify-start border-t border-border pt-4" />
    </footer>
  );
}
