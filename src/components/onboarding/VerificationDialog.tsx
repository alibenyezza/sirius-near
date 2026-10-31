"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { KybInviteForm } from "@/components/kyb/KybInviteForm";
import { KYB_CONTACT_EMAIL } from "@/components/settings/settings-logic";
import { AddFundsDialog } from "@/components/wallet/AddFundsDialog";
import { fetchGasBalance } from "@/lib/evm/balance";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { acceptInstantAccess, acceptKybCredential, type KybRole } from "@/lib/kyb/client";
import { verificationIntro } from "@/lib/onboarding/copy";
import { verificationMode } from "@/lib/onboarding/steps";
import { addFunds } from "@/lib/wallet/onramp";
import { closeVerification, markVerified, useOnboardingStore, type VerificationReason } from "./onboarding-store";

const NETWORK = resolveClientNetwork();

/** Éléments qui peuvent recevoir le focus au clavier, dans l'ordre du document. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

type Gas = { status: "loading" } | { status: "ready"; wei: string | null };

/**
 * Fenêtre « Vérifie ton wallet » : accès instantané en une transaction, explication du gas
 * quand le wallet n'a pas d'ETH, ou formulaire d'invitation quand l'accès instantané est coupé.
 *
 * Accessibilité, comme `AddFundsDialog` : `role="dialog"` + `aria-modal`, titre et texte
 * reliés, focus placé sur le titre à l'ouverture et piégé (Tab / Maj+Tab bouclent), Échap
 * ferme, le focus revient à l'élément d'origine. Pas de fermeture au clic sur le fond pendant
 * une transaction : une confirmation en attente dans le wallet ne doit pas perdre sa fenêtre.
 */
export function VerificationDialog({ requestId, reason, role, address }: {
  /** Ouverture servie par cette fenêtre (`dialog.id` du store). */
  requestId: number;
  reason: VerificationReason;
  role: KybRole;
  address: string;
}) {
  const { t } = useLocale();
  const instantAccess = useOnboardingStore((s) => s.instantAccess);
  const [gas, setGas] = useState<Gas>({ status: "loading" });
  const [gasAttempt, setGasAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [funding, setFunding] = useState(false);
  const [fundsMessage, setFundsMessage] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  const close = useCallback((ok: boolean) => {
    if (busyRef.current) return;
    closeVerification(ok, requestId);
  }, [requestId]);

  // Opération en cours (transaction, formulaire d'invitation, faucet) : Échap et « Plus tard »
  // sont sans effet tant qu'elle n'a pas abouti. Le ref est posé tout de suite, sans attendre
  // le rendu, pour qu'aucun second clic ne passe entre-temps.
  const setWorking = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  // Élément qui avait le focus à l'ouverture (bouton Emprunter, Publier, carte…), capté une
  // seule fois : le passage par la fenêtre d'ajout de fonds ne doit pas le remplacer par `body`.
  // Déclaré avant le piège pour être lu avant que le titre ne prenne le focus.
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  // Solde de gas relu à l'ouverture et après un ajout de fonds.
  useEffect(() => {
    let active = true;
    void fetchGasBalance(address)
      .then((balance) => balance.wei)
      .catch(() => null)
      .then((wei) => {
        if (active) setGas({ status: "ready", wei });
      });
    return () => {
      active = false;
    };
  }, [address, gasAttempt]);

  // Focus sur le titre, piège Tab, Échap ferme. Mis en veille pendant que la fenêtre d'ajout
  // de fonds (qui a son propre piège) est ouverte ; le retour du focus au déclencheur est
  // porté par l'effet précédent, à la fermeture définitive seulement.
  useEffect(() => {
    if (funding) return;
    headingRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableIn(root);
      const current = document.activeElement;
      const inside = current instanceof Node && root.contains(current);
      if (items.length === 0) {
        event.preventDefault();
        headingRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!inside || current === headingRef.current) {
        if (!inside || event.shiftKey) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = overflow;
    };
  }, [funding, close]);

  function succeed() {
    markVerified();
    // Fenêtre déjà fermée ou remplacée (fin tardive) : le statut est à jour, rien d'autre.
    if (useOnboardingStore.getState().dialog?.id !== requestId) return;
    // Action d'origine (Emprunter, Publier) : elle reprend aussitôt, sans étape de plus.
    if (reason === "borrow" || reason === "publish") {
      closeVerification(true, requestId);
      return;
    }
    setVerified(true);
  }

  /**
   * Accès instantané ; ou, hors mainnet et sans accès instantané, l'attestation parrainée des
   * instances de démonstration (`acceptKybCredential` sans code), chemin qu'offraient déjà les
   * boutons « Vérifier mon wallet » remplacés par cette fenêtre.
   */
  async function runInstantAccess(sponsored = false) {
    if (busyRef.current) return;
    setWorking(true);
    setError(null);
    try {
      if (sponsored) await acceptKybCredential(role);
      else await acceptInstantAccess(role);
      setWorking(false);
      succeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Accès instantané refusé");
    } finally {
      setWorking(false);
    }
  }

  async function addGas() {
    if (busyRef.current) return;
    setFundsMessage(null);
    // Mainnet : la fenêtre d'ajout de fonds existante (carte, autre wallet, pont).
    if (NETWORK === "mainnet") {
      setFunding(true);
      return;
    }
    // Testnet : le faucet envoie aussi un peu d'ETH de test.
    setWorking(true);
    try {
      await addFunds();
      setGasAttempt((value) => value + 1);
    } catch (err) {
      setFundsMessage(err instanceof Error ? err.message : "Ajout de fonds indisponible");
    } finally {
      setWorking(false);
    }
  }

  if (funding) {
    return (
      <AddFundsDialog
        network={NETWORK}
        address={address}
        onClose={() => {
          setFunding(false);
          setGas({ status: "loading" });
          setGasAttempt((value) => value + 1);
        }}
      />
    );
  }

  const mode = gas.status === "ready" ? verificationMode({ instantAccess, gasWei: gas.wei }) : null;

  return (
    // z-[60] : au-dessus des fenêtres de page (`Modal`, devis), comme les tutos.
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close(false);
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="verification-dialog"
        data-mode={verified ? "verified" : mode ?? "loading"}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface p-6 shadow-xl wrap-anywhere"
      >
        <div className="text-xs uppercase tracking-wider text-muted">{t("Vérification · une transaction")}</div>
        <h2 ref={headingRef} id={titleId} tabIndex={-1} className="mt-2 text-xl font-semibold tracking-tight focus:outline-none">
          {verified ? t("Ton wallet est vérifié") : t("Vérifie ton wallet")}
        </h2>

        {verified ? (
          <>
            <p id={descriptionId} className="mt-3 text-sm leading-relaxed text-muted">
              {t("Tu peux maintenant prêter et emprunter des datasets. Prochaine étape : ajouter des fonds, puis choisir un dataset.")}
            </p>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => closeVerification(true, requestId)}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t("Continuer")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div id={descriptionId} className="mt-3 space-y-2 text-sm leading-relaxed text-muted">
              <p>{t(verificationIntro(reason, NETWORK))}</p>
              {mode === "instant" && (
                <p>{t("Sirius signe une attestation de 30 jours pour ce wallet ; tu la confirmes dans ton wallet. La transaction coûte un peu d’ETH de gas.")}</p>
              )}
              {mode === "needs-gas" && (
                <p className="text-foreground">
                  {t("Ton wallet n’a pas encore d’ETH sur Robinhood Chain. Il en faut un peu pour payer le gas de la transaction : ajoute-en d’abord, puis reviens ici.")}
                </p>
              )}
              {mode === "invitation" && (
                <p>{t("L’accès instantané n’est pas ouvert en ce moment. Colle le code d’invitation reçu de l’équipe Sirius, ou écris-nous pour en obtenir un.")}</p>
              )}
              {mode === null && <p role="status">{t("Vérification de ton wallet…")}</p>}
            </div>

            {mode === "invitation" && (
              <div className="mt-4 space-y-3">
                <KybInviteForm role={role} onAccepted={succeed} onBusyChange={setWorking} />
                <p className="text-xs text-muted">
                  {t("Pas d’invitation ? Écris-nous :")}{" "}
                  <a href={`mailto:${KYB_CONTACT_EMAIL}`} className="font-medium text-accent underline-offset-2 hover:underline">{KYB_CONTACT_EMAIL}</a>
                </p>
              </div>
            )}

            {error && <p role="alert" className="mt-4 rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">{t(error)}</p>}
            {fundsMessage && <p role="alert" className="mt-4 text-xs text-negative">{t(fundsMessage)}</p>}

            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => close(false)}
                disabled={busy}
                className="rounded-lg px-2 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t("Plus tard")}
              </button>
              <div className="flex flex-col gap-2 sm:flex-row">
                {mode === "needs-gas" && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setGas({ status: "loading" });
                        setGasAttempt((value) => value + 1);
                      }}
                      disabled={busy}
                      className="rounded-xl border border-border px-4 py-2 text-sm font-medium transition-colors hover:border-white/20 disabled:opacity-50"
                    >
                      {t("J’ai ajouté de l’ETH")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void addGas()}
                      disabled={busy}
                      aria-haspopup={NETWORK === "mainnet" ? "dialog" : undefined}
                      className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                    >
                      {busy ? t("Envoi en cours…") : t("Ajouter de l’ETH")}
                    </button>
                  </>
                )}
                {mode === "invitation" && NETWORK !== "mainnet" && (
                  <button
                    type="button"
                    onClick={() => void runInstantAccess(true)}
                    disabled={busy}
                    className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busy ? t("Attestation en cours…") : t("Attestation de démonstration")}
                  </button>
                )}
                {mode === "instant" && (
                  <button
                    type="button"
                    onClick={() => void runInstantAccess()}
                    disabled={busy}
                    data-testid="verification-instant-access"
                    className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busy ? t("Attestation en cours…") : t("Obtenir l’accès instantané")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
