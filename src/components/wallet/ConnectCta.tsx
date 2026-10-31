"use client";

import { Card } from "@/components/ui/Card";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { openWalletModal } from "./WalletConnector";

/** Invite affichée sous l'en-tête d'une page tant qu'aucun wallet n'est connecté. */
export function ConnectPrompt({ message, ...props }: { message: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const { t } = useLocale();
  return (
    <Card className="flex flex-col items-start gap-4" {...props}>
      <p className="text-sm text-muted">{message}</p>
      <ConnectCta>{t("Connecter un wallet")}</ConnectCta>
    </Card>
  );
}

/** CTA de connexion simple (ouvre le modal). Le bouton complet avec dropdown/déco est ConnectButton. */
export function ConnectCta({
  children,
  size = "md",
}: {
  children: React.ReactNode;
  size?: "md" | "lg";
}) {
  const sizeCls = size === "lg" ? "px-8 py-4 text-base" : "px-5 py-2.5 text-sm";
  return (
    <button
      onClick={openWalletModal}
      className={`rounded-xl bg-accent ${sizeCls} font-medium text-background transition-colors hover:bg-accent/90`}
    >
      {children}
    </button>
  );
}
