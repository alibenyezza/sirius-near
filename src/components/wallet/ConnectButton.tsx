"use client";

import { useEffect, useState } from "react";
import { useWalletStore } from "@/stores/wallet";
import { chooseExternalWallet, embeddedConfigured, waitForWallets, type WalletInfo } from "@/lib/wallet/discovery";
import { signInWithWallet } from "@/lib/auth/client";
import { messageOf } from "@/lib/errors-client";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { openEmbeddedWallet, openWalletModal } from "./WalletConnector";
import { logoutCurrentWallet } from "./logout";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { TermsNotice } from "./TermsNotice";

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const EXPECTED_NETWORK = resolveClientNetwork();

/** dropUp : ouvre le menu vers le haut (footer de sidebar, sinon clippé en bas de viewport). */
/** `menuAlign` : bord du bouton sur lequel le menu s'aligne (gauche quand le bouton est en début de ligne). */
/** `compact` : déclencheur rond en icône seule (rail replié de la barre latérale), même nom accessible. */
/** `onActivity` : vrai tant que le menu est ouvert ou qu'une connexion ou une signature est en cours. */
export function ConnectButton({
  dropUp = false,
  menuAlign = "right",
  compact = false,
  onActivity,
}: {
  dropUp?: boolean;
  menuAlign?: "left" | "right";
  compact?: boolean;
  onActivity?: (active: boolean) => void;
}) {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const network = useWalletStore((s) => s.network);
  const authenticated = useWalletStore((s) => s.authenticated);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectPending, setConnectPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const wrongNetwork = !!network && network !== EXPECTED_NETWORK;
  const menuPos = dropUp ? "bottom-full mb-2" : "mt-2";
  // En sidebar (dropUp) le conteneur est étroit : bouton pleine largeur centré + menu
  // calé sur la largeur du footer (sinon w-64/w-72 déborde de la colonne).
  const triggerFull = dropUp ? "w-full justify-center" : "";
  const menuWidth = dropUp ? "inset-x-0" : menuAlign === "left" ? "left-0" : "right-0";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const active = open || connectPending || authPending;
  useEffect(() => {
    if (!onActivity) return;
    onActivity(active);
    return () => onActivity(false);
  }, [active, onActivity]);

  const handleSignIn = async () => {
    setAuthPending(true);
    setAuthError(null);
    try {
      await signInWithWallet();
      setOpen(false);
    } catch (error) {
      console.error("[sirius] authentification échouée", error);
      setAuthError(messageOf(error));
    } finally {
      setAuthPending(false);
    }
  };

  // Portefeuilles réellement installés, annoncés via EIP-6963. Interrogés à
  // l'ouverture du menu plutôt qu'au montage : une extension peut s'installer ou se
  // déverrouiller pendant la visite, et la liste doit alors refléter le présent.
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [scanning, setScanning] = useState(false);

  // La recherche part du clic plutôt que d'un effet : c'est une conséquence directe
  // du geste de l'utilisateur, pas une synchronisation avec un état extérieur.
  const toggleMenu = () => {
    const ouvrir = !open;
    setOpen(ouvrir);
    if (!ouvrir || connected) return;
    setScanning(true);
    void waitForWallets()
      .then(setWallets)
      .finally(() => setScanning(false));
  };

  // Le SDK social n'est chargé qu'au clic, dans `openEmbeddedWallet`. Le menu se ferme
  // avant : la fenêtre Google s'ouvre par-dessus, et laisser le menu derrière elle donnait
  // l'impression que le clic n'avait rien déclenché.
  const handleEmbedded = async () => {
    setConnectPending(true);
    setConnectError(null);
    try {
      await openEmbeddedWallet();
      setOpen(false);
    } catch (error) {
      setConnectError(messageOf(error));
    } finally {
      setConnectPending(false);
    }
  };

  const handleExternal = (rdns?: string) => {
    // Le choix est enregistré avant d'ouvrir la connexion : c'est lui qui décide
    // quel portefeuille recevra la demande, au lieu de laisser `window.ethereum`
    // désigner le gagnant de la course d'injection. Sans extension désignée, l'ancien
    // choix est effacé : il bloquerait le repli sur `window.ethereum`.
    chooseExternalWallet(rdns);
    setOpen(false);
    openWalletModal();
  };

  const handleDisconnect = async () => {
    setOpen(false);
    await logoutCurrentWallet();
  };

  const handleCopyAddress = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  if (!connected || !address) {
    return (
      <div className="relative">
        <button
          onClick={toggleMenu}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={compact ? t("Connexion") : undefined}
          title={compact ? t("Connexion") : undefined}
          data-guide="connect"
          className={
            compact
              ? "flex h-10 w-10 items-center justify-center rounded-full bg-accent text-background transition-colors hover:bg-accent/90"
              : `${dropUp ? "rounded-[2rem]" : "rounded-xl"} bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 ${triggerFull}`
          }
        >
          {compact ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
          ) : (
            t("Connexion")
          )}
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div role="menu" className={`absolute z-50 ${menuPos} ${menuWidth} ${dropUp ? "rounded-[2rem]" : "w-72 rounded-xl"} overflow-hidden border border-border bg-surface shadow-xl`}>
              {embeddedConfigured() && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleEmbedded()}
                    disabled={connectPending}
                    className="block w-full px-4 py-3 text-left transition-colors hover:bg-white/5 disabled:opacity-60"
                  >
                    <span className="text-sm font-medium text-foreground">
                      {connectPending ? t("Connexion…") : t("Continuer avec Google")}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{t("Sans crypto, en un clic")}</span>
                  </button>
                  {connectError && (
                    <p role="alert" className="px-4 pb-3 text-xs text-negative">{t(connectError)}</p>
                  )}
                  <div className="border-t border-border" />
                </>
              )}
              {scanning && wallets.length === 0 && (
                <div className="px-4 py-3 text-xs text-muted">{t("Recherche des wallets…")}</div>
              )}

              {wallets.map((wallet) => (
                <button
                  key={wallet.rdns}
                  onClick={() => handleExternal(wallet.rdns)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
                >
                  {wallet.icon && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={wallet.icon} alt="" aria-hidden className="h-6 w-6 shrink-0 rounded-md" />
                  )}
                  <span className="text-sm font-medium text-foreground">{wallet.name}</span>
                </button>
              ))}

              {!scanning && wallets.length === 0 && (
                <button
                  onClick={() => handleExternal()}
                  className="block w-full px-4 py-3 text-left transition-colors hover:bg-white/5"
                >
                  <span className="text-sm font-medium text-foreground">{t("Wallet externe")}</span>
                  <span className="mt-0.5 block text-xs text-muted">Phantom, MetaMask, Rabby, Coinbase Wallet…</span>
                </button>
              )}
              <TermsNotice className="border-t border-border px-4 py-3" />
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? truncate(address) : undefined}
        title={compact ? address : undefined}
        className={
          compact
            ? "flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface transition-colors hover:border-white/20"
            : `flex items-center gap-2 ${dropUp ? "rounded-[2rem]" : "rounded-xl"} border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20 ${triggerFull}`
        }
      >
        <span className={`rounded-full ${compact ? "h-2.5 w-2.5" : "h-2 w-2"} ${wrongNetwork ? "bg-negative" : "bg-positive"}`} />
        {!compact && <span className="font-mono">{truncate(address)}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" className={`absolute z-50 ${menuPos} ${menuWidth} ${dropUp ? "rounded-[2rem]" : "w-64 rounded-xl"} overflow-hidden border border-border bg-surface shadow-xl`}>
            <button
              type="button"
              onClick={handleCopyAddress}
              className="group flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-white/5"
              aria-label={copied ? t("Adresse copiée") : t("Copier l’adresse")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-sm text-foreground" title={address}>{address}</span>
                <span
                  className={`mt-1 block text-xs uppercase tracking-wider ${wrongNetwork ? "text-negative" : "text-muted"}`}
                >
                  Robinhood Chain · {network ?? "—"}
                </span>
              </span>
              <span className={`shrink-0 transition-colors ${copied ? "text-positive" : "text-muted group-hover:text-foreground"}`} aria-hidden>
                {copied ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </span>
            </button>
            {copied && <p className="px-4 pt-2 text-xs text-positive">{t("Adresse copiée")}</p>}

            {/*
              Certains portefeuilles — Phantom notamment — gardent le choix du compte
              dans leur extension et refusent qu'un site rouvre leur sélecteur. Sans
              cette phrase, l'utilisateur clique « Déconnecter », se reconnecte, retombe
              sur le même compte, et n'a aucun moyen de deviner où le changer.
            */}
            <p className="border-b border-border px-4 py-3 text-xs leading-snug text-muted">
              {t("Pour changer de compte, sélectionne-le directement dans ton wallet — l'application suivra.")}
            </p>
            {wrongNetwork && (
              <div className="px-4 pt-2 text-xs leading-snug text-negative">
                {t("Mauvais réseau — bascule ton wallet sur {network}.", { network: EXPECTED_NETWORK })}
              </div>
            )}
            {authenticated ? (
              <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-xs text-positive">
                <span className="h-1.5 w-1.5 rounded-full bg-positive" />
                {t("Authentifié")}
              </div>
            ) : (
              <button
                onClick={handleSignIn}
                disabled={authPending}
                className="w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
              >
                <span className="text-sm font-medium text-foreground">
                  {authPending ? t("Signature…") : t("Se connecter")}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {t("Signe pour prouver la possession du wallet")}
                </span>
              </button>
            )}
            {!authenticated && <TermsNotice className="border-b border-border px-4 py-3" />}
            {authError && <p role="alert" className="px-4 py-3 text-xs text-negative">{t(authError)}</p>}
            <button
              onClick={handleDisconnect}
              className="w-full px-4 py-3 text-left text-sm font-medium text-negative transition-colors hover:bg-negative/10"
            >
              {t("Déconnecter")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
