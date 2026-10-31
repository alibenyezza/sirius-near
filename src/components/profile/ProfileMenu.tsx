"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { logoutCurrentWallet } from "@/components/wallet/logout";
import { TermsNotice } from "@/components/wallet/TermsNotice";
import { connectAndSignIn, useSignIn } from "@/components/wallet/SignInCta";
import { useReducedMotion } from "@/components/ui/useReducedMotion";
import { fetchUsdcBalance } from "@/lib/evm/balance";
import { addressExplorerUrl } from "@/lib/evm/explorer";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { useWalletStore } from "@/stores/wallet";
import { normalizeAddress, shortAddress } from "./address";
import { requestGuidedTour } from "./guided-tour";
import { reopenChecklist } from "@/components/onboarding/onboarding-store";
import { formatTokenAmount, isWrongNetwork, networkBadge, stablecoinSymbol } from "./network";
import { useCopy } from "./useCopy";

const NETWORK = resolveClientNetwork();

const ITEM_CLASS =
  "flex w-full items-center px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none";

/**
 * Bouton profil, en haut à droite de l'application (docs/passage-mainnet/05-wallet.md).
 *
 * Il n'existe que connecté : la connexion reste portée par le bouton de la barre latérale.
 * Il occupe une ligne alignée à droite en tête du contenu, sur ordinateur comme sur mobile.
 * Une position fixe a été écartée : elle aurait recouvert les actions placées à droite de
 * l'en-tête de plusieurs pages (Marketplace, Mes datasets) entre 768 et 1500 px de large,
 * et la barre du haut du mobile est déjà occupée.
 *
 * Le menu est une fenêtre volante, pas un `role="menu"` : il mêle informations (réseau,
 * solde) et actions, ce que le motif ARIA « menu » ne prévoit pas.
 */
export function ProfileMenu() {
  const connected = useWalletStore((state) => state.connected);
  const address = useWalletStore((state) => state.address);
  const walletNetwork = useWalletStore((state) => state.network);
  const authenticated = useWalletStore((state) => state.authenticated);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const checksummed = connected ? normalizeAddress(address) : null;
  const short = shortAddress(checksummed);
  // Rien à montrer sans adresse valide : la barre latérale garde la connexion et la déconnexion.
  if (!checksummed || !short) {
    // Une déconnexion venue du wallet pendant que le menu est ouvert ne doit pas le rouvrir
    // tout seul à la reconnexion. Ajustement d'état pendant le rendu, motif prévu par React.
    if (open) setOpen(false);
    return null;
  }

  const wrongNetwork = isWrongNetwork(NETWORK, walletNetwork);
  const badge = networkBadge(NETWORK);

  return (
    <div className="flex flex-col items-end gap-1.5 px-4 md:px-6">
      <div className="relative flex items-center gap-2">
        <SignInButton authenticated={authenticated} />
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("Menu du profil")}
          data-testid="profile-button"
          className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20"
        >
          {/* Couleur du réseau du site (ambre sur testnet) ; rouge si le wallet est ailleurs. */}
          <span className={`h-2 w-2 rounded-full ${wrongNetwork ? "bg-negative" : badge.dotClassName}`} aria-hidden />
          <span className="font-mono">{short}</span>
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => close()} aria-hidden />
            <ProfilePanel
              key={checksummed}
              address={checksummed}
              short={short}
              wrongNetwork={wrongNetwork}
              authenticated={authenticated}
              onClose={close}
            />
          </>
        )}
      </div>
      {!authenticated && <SignInNotes />}
    </div>
  );
}

/** Durée d'affichage de la coche avant que la pastille ne s'efface. */
const SIGNED_HOLD_MS = 1400;
const SIGNED_FADE_MS = 300;
const SMOOTH = "cubic-bezier(0.65, 0, 0.35, 1)";

type SignInPhase = "idle" | "done" | "fading" | "gone";

/**
 * Connexion signée en un geste, mise en avant tant que la session n'est pas ouverte. Quand la
 * signature réussit, les lettres de « Signing… » convergent vers le centre en tournant, le bouton
 * se resserre en pastille et une coche s'y dessine, puis la pastille s'efface.
 */
function SignInButton({ authenticated }: { authenticated: boolean }) {
  const { t } = useLocale();
  const pending = useSignIn((state) => state.pending);
  const reduced = useReducedMotion();
  const button = useRef<HTMLButtonElement>(null);
  const letters = useRef<(HTMLSpanElement | null)[]>([]);
  const [phase, setPhase] = useState<SignInPhase>(authenticated && !pending ? "gone" : "idle");
  const [wasPending, setWasPending] = useState(pending);
  const [geometry, setGeometry] = useState<{ width: number; offsets: number[] } | null>(null);
  // Une image après la mesure : la largeur figée est rendue avant de se resserrer, sinon le
  // navigateur n'a pas de valeur de départ à animer.
  const [contracting, setContracting] = useState(false);

  // Fin d'une signature réussie : figer la géométrie du libellé avant de le contracter.
  // Ajustement d'état pendant le rendu, motif prévu par React pour réagir à un changement d'entrée.
  if (pending !== wasPending) {
    setWasPending(pending);
    if (!pending && authenticated && phase === "idle") setPhase("done");
  }
  if (!authenticated && phase !== "idle") {
    setPhase("idle");
    setGeometry(null);
    setContracting(false);
  }

  useLayoutEffect(() => {
    if (phase !== "done" || geometry || !button.current) return;
    const box = button.current.getBoundingClientRect();
    const center = box.left + box.width / 2;
    setGeometry({
      width: button.current.offsetWidth,
      offsets: letters.current.map((el) => {
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        return center - (rect.left + rect.width / 2);
      }),
    });
  }, [phase, geometry]);

  useEffect(() => {
    if (!geometry || contracting) return;
    const frame = requestAnimationFrame(() => setContracting(true));
    return () => cancelAnimationFrame(frame);
  }, [geometry, contracting]);

  useEffect(() => {
    if (phase === "done") {
      const timer = setTimeout(() => setPhase("fading"), SIGNED_HOLD_MS);
      return () => clearTimeout(timer);
    }
    if (phase === "fading") {
      const timer = setTimeout(() => setPhase("gone"), SIGNED_FADE_MS);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  // La session passe à « signée » juste avant la fin du chargement : le bouton reste affiché
  // jusqu'à ce que `pending` retombe et déclenche l'animation de réussite.
  if (phase === "gone" || (authenticated && phase === "idle" && !pending)) return null;

  const signed = phase !== "idle" && geometry !== null && contracting;
  const label = pending || phase !== "idle" ? t("Signature…") : t("Se connecter");

  return (
    <button
      ref={button}
      type="button"
      onClick={() => void connectAndSignIn()}
      disabled={pending || phase !== "idle"}
      data-testid="profile-sign-in"
      data-guide="sign-in"
      // Le libellé est éclaté en lettres pour l'animation : le nom accessible est porté ici.
      aria-label={signed ? t("Authentifié") : label}
      aria-live="polite"
      className="group relative flex h-9 items-center justify-center gap-2 overflow-hidden rounded-xl bg-accent px-4 text-sm font-medium text-background shadow-[0_0_28px_rgba(255,255,255,0.16)] hover:shadow-[0_0_36px_rgba(255,255,255,0.28)] active:scale-[0.97] disabled:cursor-default motion-reduce:transition-none"
      style={{
        width: signed ? 36 : geometry?.width,
        paddingInline: signed ? 0 : undefined,
        borderRadius: signed ? 18 : undefined,
        opacity: phase === "fading" ? 0 : 1,
        transform: phase === "fading" ? "scale(0.6)" : undefined,
        transition: reduced ? "none" : `width 380ms ${SMOOTH} 100ms, border-radius 380ms ${SMOOTH} 100ms, padding 380ms ${SMOOTH} 100ms, opacity ${SIGNED_FADE_MS}ms ${SMOOTH}, transform ${SIGNED_FADE_MS}ms ${SMOOTH}, box-shadow 200ms`,
      }}
    >
      {phase === "idle" && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/60 to-transparent opacity-0 transition-[transform,opacity] duration-700 group-hover:translate-x-[300%] group-hover:opacity-100 motion-reduce:hidden"
        />
      )}
      {pending || phase !== "idle" ? (
        <span
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-background/30 border-t-background"
          style={{ opacity: signed ? 0 : 1, transition: reduced ? "none" : "opacity 160ms linear" }}
        />
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <path d="M10 17l5-5-5-5" />
          <path d="M15 12H3" />
        </svg>
      )}
      <span className="relative flex whitespace-nowrap" aria-hidden>
        {[...label].map((letter, i) => (
          <span
            key={i}
            ref={(el) => {
              letters.current[i] = el;
            }}
            className="inline-block whitespace-pre"
            style={
              signed
                ? {
                    transform: `translateX(${geometry.offsets[i] ?? 0}px) rotate(${90 + i * 20}deg) scale(0.2)`,
                    opacity: 0,
                    transition: reduced ? "none" : `transform 300ms ${SMOOTH} ${i * 15}ms, opacity 200ms linear ${80 + i * 15}ms`,
                  }
                : undefined
            }
          >
            {letter}
          </span>
        ))}
      </span>
      {signed && <span className="sr-only">{t("Authentifié")}</span>}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="absolute"
        style={{ opacity: signed ? 1 : 0, transition: reduced ? "none" : "opacity 120ms linear 380ms" }}
      >
        <path
          d="M5 12.5l4.5 4.5L19 7.5"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={signed ? 0 : 1}
          style={{ transition: reduced ? "none" : `stroke-dashoffset 380ms ${SMOOTH} 420ms` }}
        />
      </svg>
    </button>
  );
}

function SignInNotes() {
  const { t } = useLocale();
  const error = useSignIn((state) => state.error);
  return (
    <div className="flex max-w-xs flex-col items-end gap-1 text-right">
      <TermsNotice className="text-[11px]" />
      {error && <p role="alert" className="text-xs text-negative">{t(error)}</p>}
    </div>
  );
}

type BalanceState = { status: "loading" } | { status: "ready"; text: string } | { status: "error" };

function ProfilePanel({
  address,
  short,
  wrongNetwork,
  authenticated,
  onClose,
}: {
  address: string;
  short: string;
  wrongNetwork: boolean;
  authenticated: boolean;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { t } = useLocale();
  const badge = networkBadge(NETWORK);
  const token = t(stablecoinSymbol(NETWORK));
  const { state: copyState, copy } = useCopy();
  const [balance, setBalance] = useState<BalanceState>({ status: "loading" });
  const [tourUnavailable, setTourUnavailable] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const signingIn = useSignIn((state) => state.pending);
  const signInError = useSignIn((state) => state.error);

  // Lu à l'ouverture seulement : pas d'appel RPC tant que le menu reste fermé. Le panneau est
  // remonté (`key`) si l'adresse change, et `cancelled` écarte la réponse d'un compte remplacé.
  useEffect(() => {
    // `eth_call` part sur la chaîne du wallet : sur un autre réseau, il rendrait le solde d'un
    // autre jeton (ou rien) sous l'étiquette du jeton du site. On ne lit donc rien.
    if (wrongNetwork) return;
    let cancelled = false;
    void fetchUsdcBalance(address)
      .then(({ atomic }) => {
        if (cancelled) return;
        const text = formatTokenAmount(formatUsdcAtomic(atomic));
        setBalance(text ? { status: "ready", text } : { status: "error" });
      })
      .catch(() => {
        if (!cancelled) setBalance({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [address, wrongNetwork]);

  const handleTour = () => {
    // Même page : le focus revient au bouton profil plutôt que de tomber sur `body`.
    if (requestGuidedTour()) onClose(true);
    else setTourUnavailable(true);
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    onClose();
    await logoutCurrentWallet().catch(() => undefined);
  };

  return (
    <div
      role="dialog"
      aria-label={t("Menu du profil")}
      className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
    >
      <div className="border-b border-border px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
          data-testid="network-badge"
          data-network={badge.network}
        >
          {t(badge.label)}
        </span>
        {wrongNetwork && (
          <p role="alert" className="mt-2 text-xs leading-snug text-negative">
            {t("Mauvais réseau — bascule ton wallet sur {network}.", { network: NETWORK })}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm" title={address} data-testid="profile-address">{short}</span>
          <button
            type="button"
            onClick={() => void copy(address)}
            className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:border-white/20"
          >
            {copyState === "copied" ? t("Adresse copiée") : copyState === "failed" ? t("Copie impossible") : t("Copier l’adresse")}
          </button>
          <a
            href={addressExplorerUrl(NETWORK, address)}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:border-white/20"
          >
            {t("Explorateur")}
          </a>
        </div>
      </div>

      {authenticated ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-xs text-positive">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" aria-hidden />
          {t("Authentifié")}
        </div>
      ) : (
        <div className="border-b border-border">
          <button
            type="button"
            onClick={() => void connectAndSignIn()}
            disabled={signingIn}
            className="w-full px-4 py-3 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
          >
            <span className="text-sm font-medium text-foreground">{signingIn ? t("Signature…") : t("Se connecter")}</span>
            <span className="mt-0.5 block text-xs text-muted">{t("Signe pour prouver la possession du wallet")}</span>
          </button>
          <TermsNotice className="px-4 pb-3" />
          {signInError && <p role="alert" className="px-4 pb-3 text-xs text-negative">{t(signInError)}</p>}
        </div>
      )}

      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <span className="text-xs uppercase tracking-wider text-muted">{t("Solde")}</span>
        <span className="text-sm font-medium" data-testid="profile-balance">
          {wrongNetwork
            ? "—"
            : balance.status === "loading" ? "…" : balance.status === "error" ? t("Solde indisponible.") : `${balance.text} ${token}`}
        </span>
      </div>

      <nav className="py-1" aria-label={t("Navigation")}>
        <Link href="/wallet" onClick={() => onClose()} className={ITEM_CLASS}>{t("Wallet")}</Link>
        <Link href="/settings" onClick={() => onClose()} className={ITEM_CLASS}>{t("Réglages")}</Link>
        <Link href="/kyb" onClick={() => onClose()} className={ITEM_CLASS}>{t("Vérification")}</Link>
        {/* Carte « Get started » masquée : elle revient sur le tableau de bord. */}
        {authenticated && (
          <Link
            href="/dashboard"
            onClick={() => {
              reopenChecklist();
              onClose();
            }}
            className={ITEM_CLASS}
            data-testid="profile-get-started"
          >
            {t("Bien démarrer")}
          </Link>
        )}
        <button type="button" onClick={handleTour} className={ITEM_CLASS}>{t("Visite guidée")}</button>
        {tourUnavailable && (
          <p role="status" className="px-4 pb-2 text-xs text-muted">{t("La visite guidée sera bientôt disponible.")}</p>
        )}
      </nav>

      <button
        type="button"
        onClick={() => void handleLogout()}
        disabled={loggingOut}
        className="w-full border-t border-border px-4 py-3 text-left text-sm font-medium text-negative transition-colors hover:bg-negative/10 disabled:opacity-50"
      >
        {t("Se déconnecter")}
      </button>
    </div>
  );
}
