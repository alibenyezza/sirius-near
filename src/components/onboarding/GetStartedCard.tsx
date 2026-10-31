"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { Card } from "@/components/ui/Card";
import { CardTitle } from "@/components/ui/Heading";
import {
  deriveOnboardingProgress,
  showsChecklist,
  type OnboardingLoan,
  type OnboardingStepId,
} from "@/lib/onboarding/steps";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { stepCopy } from "@/lib/onboarding/copy";
import { messageOf } from "@/lib/errors-client";
import { useWalletStore } from "@/stores/wallet";
import { connectAndSignIn, useSignIn } from "@/components/wallet/SignInCta";
import { connectWallet } from "@/components/wallet/WalletConnector";
import { TermsNotice } from "@/components/wallet/TermsNotice";
import {
  chainVerificationAfterSignIn,
  dismissChecklist,
  loadChecklistPreference,
  requestVerification,
  useOnboardingStore,
} from "./onboarding-store";

/** Textes des étapes pour le réseau du site (inliné au build) : pas de « mainnet » sur le testnet. */
const STEP_COPY = stepCopy(resolveClientNetwork());

const PRIMARY ="inline-flex rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50";

/** Étape « Connecte ton wallet » : la connexion seule, la signature est l'étape suivante. */
async function connectFromCard(): Promise<void> {
  if (useSignIn.getState().pending) return;
  useSignIn.setState({ pending: true, error: null });
  try {
    await connectWallet();
  } catch (error) {
    useSignIn.setState({ error: messageOf(error) });
  } finally {
    useSignIn.setState({ pending: false });
  }
}

/** Étape « Connecte-toi » : signature, puis vérification proposée si le wallet n'est pas vérifié. */
async function signInFromCard(): Promise<void> {
  await connectAndSignIn();
  if (useWalletStore.getState().authenticated) await chainVerificationAfterSignIn();
}

interface GetStartedCardProps {
  /** Wallet connecté, ou `null` pour un visiteur qui n'en a pas encore connecté. */
  address: string | null;
  /** Soldes lus par le tableau de bord : `null` tant qu'ils sont inconnus. */
  gasWei: string | null;
  stableAtomic: string | null;
  /** Libellé du jeton de règlement, déjà traduit (USDG sur mainnet). */
  token: string;
  /** Ouvre le parcours « Ajouter des fonds » existant du tableau de bord. */
  onAddFunds: () => void;
  fundsPending: boolean;
}

/**
 * Carte « Get started » du tableau de bord : les étapes d'un premier entraînement, de la
 * connexion du wallet au modèle livré, cochées d'après l'état réel du compte (wallet, session,
 * registre KYB, soldes, prêts), chacune avec son action. Seule l'étape suivante porte le bouton
 * principal, qui fait l'action elle-même. Affichée dès la première visite ; une fois signé, elle
 * est masquable, la fermeture est enregistrée dans le profil et la carte revient depuis
 * « Get started » du menu profil.
 */
export function GetStartedCard({ address, gasWei, stableAtomic, token, onAddFunds, fundsPending }: GetStartedCardProps) {
  const { t } = useLocale();
  const connected = useWalletStore((s) => s.connected) && address !== null;
  const authenticated = useWalletStore((s) => s.authenticated);
  const signedIn = connected && authenticated;
  const signPending = useSignIn((s) => s.pending);
  const signError = useSignIn((s) => s.error);
  const owner = useOnboardingStore((s) => s.owner);
  const kyb = useOnboardingStore((s) => s.kyb);
  const instantAccess = useOnboardingStore((s) => s.instantAccess);
  const dismissed = useOnboardingStore((s) => s.dismissed);
  const reopened = useOnboardingStore((s) => s.reopened);
  const [loans, setLoans] = useState<{ address: string | null; list: OnboardingLoan[] } | null>(null);
  // Le statut de vérification, les prêts et la préférence ne se lisent qu'une fois signé.
  const ready = signedIn && address !== null && owner === address.toLowerCase();

  useEffect(() => {
    if (!ready) return;
    void loadChecklistPreference();
  }, [ready]);

  // Une vérification réussie (`kyb` change) peut suivre un emprunt repris : on relit les prêts.
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void fetch("/api/loans", { cache: "no-store", credentials: "same-origin" })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
      .then((body) => {
        if (active) setLoans({ address, list: Array.isArray(body) ? (body as OnboardingLoan[]) : [] });
      })
      .catch(() => {
        if (active) setLoans({ address, list: [] });
      });
    return () => {
      active = false;
    };
  }, [ready, address, kyb]);

  // Une fois signé, rien tant que l'état n'est pas lu : une carte qui coche ses étapes une à une
  // désoriente. Avant, il n'y a rien à lire : la carte s'affiche tout de suite.
  if (signedIn && (!ready || kyb === null || !loans || loans.address !== address)) return null;
  const progress = deriveOnboardingProgress({
    connected,
    authenticated: signedIn,
    kyb,
    gasWei: connected ? gasWei : null,
    stableAtomic: connected ? stableAtomic : null,
    loans: signedIn ? loans?.list ?? null : null,
    viewer: address,
  });
  if (!showsChecklist({ signedIn, dismissed, complete: progress.current === null, reopened })) return null;

  function action(id: OnboardingStepId) {
    switch (id) {
      case "connect":
        return (
          <button type="button" onClick={() => void connectFromCard()} disabled={signPending} className={PRIMARY} data-testid="get-started-connect">
            {signPending ? t("Connexion…") : t("Connecter un wallet")}
          </button>
        );
      case "signin":
        return (
          <button type="button" onClick={() => void signInFromCard()} disabled={signPending} className={PRIMARY} data-testid="get-started-signin">
            {signPending ? t("Signature…") : t("Se connecter")}
          </button>
        );
      case "verify":
        if (kyb === "unknown") {
          return <Link href="/kyb" className={PRIMARY}>{t("Voir mon statut de vérification")}</Link>;
        }
        return (
          <button type="button" onClick={() => void requestVerification("checklist")} aria-haspopup="dialog" className={PRIMARY} data-testid="get-started-verify">
            {instantAccess ? t("Obtenir l’accès instantané") : t("Saisir un code d’invitation")}
          </button>
        );
      case "fund":
        return (
          <button type="button" onClick={onAddFunds} disabled={fundsPending} className={PRIMARY}>
            {fundsPending ? t("Envoi en cours…") : t("Ajouter des fonds")}
          </button>
        );
      case "pick":
      case "borrow":
        return <Link href="/marketplace" className={PRIMARY}>{t("Ouvrir la marketplace")}</Link>;
      case "model":
        return <Link href="/train" className={PRIMARY}>{t("Ouvrir Entraîner")}</Link>;
    }
  }

  const missing = [
    progress.funding.gas ? t("de l’ETH pour le gas") : null,
    progress.funding.token ? t("des {token} pour emprunter", { token }) : null,
  ].filter((item): item is string => item !== null);

  return (
    <Card data-testid="get-started" data-guide="page:dashboard:get-started" aria-labelledby="get-started-title" role="region">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle id="get-started-title">{t("Bien démarrer")}</CardTitle>
          <p className="mt-1 text-xs text-muted">
            {progress.current === null
              ? t("Tout est fait : tu as vérifié ton wallet, emprunté un dataset et récupéré un modèle.")
              : t("{done} étapes sur {total} — de ton wallet à ton premier modèle entraîné.", { done: progress.completed, total: progress.total })}
          </p>
        </div>
        {/* Pas de profil avant la signature : rien où ranger la fermeture, la carte reste. */}
        {signedIn && (
          <button
            type="button"
            onClick={dismissChecklist}
            className="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
          >
            {t("Masquer")}
          </button>
        )}
      </div>

      <div
        className="mt-3 h-1 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label={t("Progression")}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.completed}
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${(progress.completed / progress.total) * 100}%` }} />
      </div>

      <ol className="mt-4 space-y-2">
        {progress.steps.map((step, index) => {
          const current = step.id === progress.current;
          const copy = STEP_COPY[step.id];
          return (
            <li
              key={step.id}
              data-step={step.id}
              data-done={step.done}
              aria-current={current ? "step" : undefined}
              className={`flex gap-3 rounded-xl border p-3 ${current ? "border-accent/40 bg-background/40" : "border-transparent"}`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${
                  step.done ? "border-positive/50 bg-positive/10 text-positive" : current ? "border-accent text-foreground" : "border-border text-muted"
                }`}
              >
                {step.done ? "✓" : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${step.done ? "text-muted" : "text-foreground"}`}>
                  {t(copy.title, { token })}
                  <span className="sr-only">{step.done ? ` — ${t("fait")}` : ""}</span>
                </p>
                {!step.done && <p className="mt-0.5 text-xs leading-relaxed text-muted">{t(copy.body, { token })}</p>}
                {current && step.id === "fund" && missing.length > 0 && (
                  <p className="mt-1 text-xs text-negative">{t("Il te manque : {items}.", { items: missing.join(t(" et ")) })}</p>
                )}
                {current && <div className="mt-2.5">{action(step.id)}</div>}
                {current && (step.id === "connect" || step.id === "signin") && (
                  <>
                    <TermsNotice className="mt-2" />
                    {signError && <p role="alert" className="mt-1 text-xs text-negative">{t(signError)}</p>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
