"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { requestVerification, useOnboardingStore } from "@/components/onboarding/onboarding-store";
import { useReducedMotion } from "@/components/ui/useReducedMotion";
import { connectAndSignIn, useSignIn } from "@/components/wallet/SignInCta";
import { connectWallet } from "@/components/wallet/WalletConnector";
import { fetchGasBalance } from "@/lib/evm/balance";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { stablecoinSymbol } from "@/lib/evm/stablecoin";
import { messageOf } from "@/lib/errors-client";
import {
  GUIDE_ARRIVAL, GUIDE_CONNECT, GUIDE_SIGNIN, GUIDE_TOUR_COPY, GUIDE_TOUR_END, GUIDE_UI, GUIDE_VERIFY, guideVerifyWhy,
} from "@/lib/guide/copy";
import {
  deriveGuidePhase, GUIDE_NAME, GUIDE_PHASES, GUIDE_TOUR_STOPS, guideAnchorSelector, guideVerifyMode, shouldOfferPageTour, type GuidePhase,
} from "@/lib/guide/machine";
import { GUIDE_PAGE_UI, guidePageAnchor, guidePageForPath, guidePageStepBody, resolveGuidePageStep } from "@/lib/guide/pages";
import { useWalletStore } from "@/stores/wallet";
import { AssistantPanel } from "./AssistantPanel";
import { GuideBlob, type GuideGaze, type GuideMood } from "./GuideBlob";
import { GuideBubble } from "./GuideBubble";
import { Spotlight } from "./Spotlight";
import {
  applyGuideAction, endPageTour, minimizeGuide, replayGuide, resetGuideOwner, restoreGuide, setGuidePanelOpen, setPageTourStep, startGuide,
  startPageTour, subscribeGuidedTourRequests, syncGuideWithProfile, useGuideStore,
} from "./guide-store";
import { useAnchorRect, type AnchorRect } from "./useAnchorRect";
import { usePresentAnchors } from "./usePresentAnchors";

const NETWORK = resolveClientNetwork();
const SMOOTH = "cubic-bezier(0.65, 0, 0.35, 1)";
/** Durée d'affichage des félicitations avant l'étape suivante. */
const CELEBRATE_MS = 1_800;
/** Durée du vol vers la bulle à la fin du tour. */
const ENDING_MS = 2_600;
/** Fréquence à laquelle on regarde si une fenêtre modale du site est ouverte. */
const MODAL_POLL_MS = 500;
/** Délai avant qu'une visite de page s'ouvre toute seule : la page a le temps de se charger et de s'ancrer. */
const PAGE_TOUR_DELAY_MS = 900;
const BUBBLE_W = 320;
const BUBBLE_H = 230;
const MARGIN = 16;

const BUTTON = "rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const SECONDARY = "rounded-xl border border-border px-3 py-2 text-sm font-medium transition-colors hover:border-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const SUBTLE = "rounded-lg px-2 py-2 text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const measure = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return size;
}

interface Layout {
  blob: { x: number; y: number; size: number; scale: number };
  bubble: { x: number; y: number } | "sheet";
  gaze: GuideGaze;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Ce que l'hôte affiche : une phase du parcours d'accueil, ou la visite de la page. */
type Showing = GuidePhase | "page";

/** Où posent le personnage et sa bulle, selon l'élément mis en lumière et la taille de l'écran. */
function layoutFor(showing: Showing, rect: AnchorRect | null, vw: number, vh: number, ending: boolean): Layout {
  const mobile = vw < 768;
  if (ending) {
    // Vol vers la bulle flottante (bas droite, 56 px).
    return { blob: { x: vw - MARGIN - 56 + 6, y: vh - MARGIN - 56 + 6, size: 96, scale: 0.46 }, bubble: mobile ? "sheet" : { x: vw - MARGIN - BUBBLE_W, y: vh - MARGIN - 56 - 12 - BUBBLE_H }, gaze: "up" };
  }
  if (mobile) {
    return { blob: { x: MARGIN + 4, y: vh - 96 - 96, size: 72, scale: 1 }, bubble: "sheet", gaze: rect ? "up" : "center" };
  }
  if (showing === "arrival") {
    const size = 128;
    return { blob: { x: vw / 2 - size / 2, y: vh / 2 - size - 60, size, scale: 1 }, bubble: { x: vw / 2 - BUBBLE_W / 2, y: vh / 2 - 40 }, gaze: "center" };
  }
  const size = 96;
  if (!rect) {
    // Sans ancre (vérification, présentation d'une page) : posé en bas à droite, au-dessus de la bulle flottante.
    const x = vw - MARGIN - size;
    const y = vh - MARGIN - 56 - 24 - size;
    return { blob: { x, y, size, scale: 1 }, bubble: { x: x - 12 - BUBBLE_W, y: clamp(y + size - BUBBLE_H, MARGIN, vh - BUBBLE_H - MARGIN) }, gaze: "left" };
  }
  const centerY = rect.top + rect.height / 2;
  const onLeft = rect.left + rect.width / 2 < vw / 2;
  const y = clamp(centerY - size / 2, MARGIN, vh - size - MARGIN);
  // Élément large (carte, grille) : le personnage se pose sous lui plutôt qu'à côté, hors du cadre sinon.
  const wide = rect.width > vw * 0.6;
  if (wide) {
    const below = rect.top + rect.height + 20 + size + MARGIN < vh;
    const by = below ? rect.top + rect.height + 20 : clamp(rect.top - 20 - size, MARGIN, vh - size - MARGIN);
    const bx = clamp(rect.left + rect.width - size, MARGIN, vw - size - MARGIN);
    return { blob: { x: bx, y: by, size, scale: 1 }, bubble: { x: clamp(bx - 12 - BUBBLE_W, MARGIN, vw - BUBBLE_W - MARGIN), y: clamp(by + size / 2 - 70, MARGIN, vh - BUBBLE_H - MARGIN) }, gaze: below ? "up" : "center" };
  }
  if (onLeft) {
    const x = rect.left + rect.width + 20;
    return { blob: { x, y, size, scale: 1 }, bubble: { x: clamp(x + size + 12, MARGIN, vw - BUBBLE_W - MARGIN), y: clamp(centerY - 70, MARGIN, vh - BUBBLE_H - MARGIN) }, gaze: "left" };
  }
  const x = rect.left - 20 - size;
  return { blob: { x, y, size, scale: 1 }, bubble: { x: clamp(x - 12 - BUBBLE_W, MARGIN, vw - BUBBLE_W - MARGIN), y: clamp(centerY - 70, MARGIN, vh - BUBBLE_H - MARGIN) }, gaze: "right" };
}

/**
 * Sirio, le guide vivant : un personnage qui accueille, se place à côté du bouton à cliquer, met
 * l'élément en lumière, attend que l'action réelle soit faite (état du wallet, de la session, du
 * registre KYB), félicite, fait le tour du menu, puis se range dans sa bulle en bas à droite.
 * Ensuite, à la première ouverture de chaque page, il en fait la visite — élément par élément,
 * mêmes mécaniques — et la note vue ; le bouton « ? » et le panneau la rejouent à la demande.
 *
 * Il ne bloque jamais le site : le voile laisse passer les clics, « Passer » est toujours là,
 * Échap le réduit dans sa bulle (ou clôt la visite de page). Il s'efface derrière toute fenêtre
 * modale du site (vérification, ajout de fonds) pour ne jamais superposer deux fenêtres, et une
 * visite de page attend que le parcours d'accueil soit rangé.
 */
export function GuideHost() {
  const { t } = useLocale();
  const reduced = useReducedMotion();
  const pathname = usePathname();
  const address = useWalletStore((s) => s.address);
  const connected = useWalletStore((s) => s.connected) && address !== null;
  const authenticated = useWalletStore((s) => s.authenticated);
  const signPending = useSignIn((s) => s.pending);
  const signError = useSignIn((s) => s.error);
  const signed = connected && authenticated && address ? address.toLowerCase() : null;
  const kybOwner = useOnboardingStore((s) => s.owner);
  const kyb = useOnboardingStore((s) => s.kyb);
  const instantAccess = useOnboardingStore((s) => s.instantAccess);
  const dialog = useOnboardingStore((s) => s.dialog);
  const hydrated = useGuideStore((s) => s.hydrated);
  const progress = useGuideStore((s) => s.progress);
  const minimized = progress.minimized;
  const panelOpen = useGuideStore((s) => s.panelOpen);
  const suppressed = useGuideStore((s) => s.suppressed);
  const pageTour = useGuideStore((s) => s.pageTour);
  const [modal, setModal] = useState(false);
  const [celebrate, setCelebrate] = useState<GuidePhase | null>(null);
  const [ending, setEnding] = useState(false);
  const [gasWei, setGasWei] = useState<string | null>(null);
  const previousPhase = useRef<GuidePhase | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const bubbleButtonRef = useRef<HTMLButtonElement>(null);
  const { width: vw, height: vh } = useViewport();
  const pageKey = guidePageForPath(pathname);

  useEffect(() => {
    startGuide();
  }, []);

  // Bouton « Visite guidée » du menu profil : l'abonné accuse réception de la demande.
  useEffect(() => subscribeGuidedTourRequests(), []);

  useEffect(() => {
    if (signed) void syncGuideWithProfile(signed);
    else resetGuideOwner();
  }, [signed]);

  // Fenêtre modale du site ouverte : le guide s'efface, sans perdre sa place.
  useEffect(() => {
    const timer = setInterval(() => setModal(modalOpen()), MODAL_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const kybKnown = signed && kybOwner === signed ? kyb : null;
  const phase: GuidePhase | null = hydrated && vw > 0
    ? deriveGuidePhase({ connected, authenticated: signed !== null, kyb: kybKnown, progress })
    : null;

  // Étape réussie par l'action réelle : félicitations, puis fin du tour en vol vers la bulle.
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (!before || !phase || before === phase) return;
    const advanced = GUIDE_PHASES.indexOf(phase) > GUIDE_PHASES.indexOf(before);
    if (!advanced) return;
    if (before === "tour" && phase === "done" && progress.tourDone) {
      setEnding(true);
      const timer = setTimeout(() => setEnding(false), reduced ? 600 : ENDING_MS);
      return () => {
        clearTimeout(timer);
        setEnding(false);
      };
    }
    if (before === "connect" || before === "signin" || before === "verify") {
      setCelebrate(before);
      const timer = setTimeout(() => setCelebrate(null), CELEBRATE_MS);
      // Une phase qui change avant la fin des félicitations ne doit pas laisser l'ancien message.
      return () => {
        clearTimeout(timer);
        setCelebrate(null);
      };
    }
  }, [phase, progress.tourDone, reduced]);

  // Solde de gas, pour expliquer le besoin d'ETH avant la transaction de vérification.
  useEffect(() => {
    if (phase !== "verify" || !address || dialog !== null) return;
    let active = true;
    void fetchGasBalance(address).then((balance) => balance.wei).catch(() => null).then((wei) => {
      if (active) setGasWei(wei);
    });
    return () => {
      active = false;
    };
  }, [phase, address, dialog]);

  const visible = phase !== null && phase !== "done" && !minimized && !modal && dialog === null && !suppressed;
  const mainShowing: GuidePhase | null = ending ? "done" : visible ? phase : null;

  // ── Visite de la page ────────────────────────────────────────────────────────────────────────
  // Quitter la page en cours de visite la clôt et la note vue : elle ne reviendra pas d'elle-même.
  useEffect(() => {
    if (pageTour && pageTour.page !== pageKey) endPageTour(true);
  }, [pageTour, pageKey]);

  const pageIdle = pageTour === null && phase === "done" && !ending && !modal && dialog === null && !panelOpen && !suppressed;
  const offerPage = pageIdle && shouldOfferPageTour(progress, pageKey) ? pageKey : null;
  useEffect(() => {
    if (!offerPage) return;
    const timer = setTimeout(() => {
      // L'état peut avoir changé pendant le délai (fenêtre ouverte, autre page) : relu au moment de partir.
      const state = useGuideStore.getState();
      if (state.pageTour === null && !state.panelOpen && !modalOpen() && shouldOfferPageTour(state.progress, offerPage)) startPageTour(offerPage, false);
    }, PAGE_TOUR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [offerPage]);

  const present = usePresentAnchors(pageTour && pageTour.page === pageKey ? pageTour.page : null);
  const { steps: pageSteps, index: pageIndex } = pageTour ? resolveGuidePageStep(pageTour.page, present, pageTour.step) : { steps: [], index: 0 };
  const pageStep = pageSteps[pageIndex] ?? null;
  const pageVisible = mainShowing === null && pageTour !== null && pageTour.page === pageKey && pageStep !== null
    && !modal && dialog === null && !panelOpen && !suppressed && hydrated && vw > 0;
  const showing: Showing | null = mainShowing ?? (pageVisible ? "page" : null);

  const stop = GUIDE_TOUR_STOPS[Math.min(progress.tourIndex, GUIDE_TOUR_STOPS.length - 1)];
  const selector = showing === "connect" ? guideAnchorSelector("connect")
    : showing === "signin" ? guideAnchorSelector("sign-in")
    : showing === "tour" && !celebrate ? guideAnchorSelector(`nav:${stop.href}`)
    : showing === "page" && pageTour && pageStep?.anchor ? guideAnchorSelector(guidePageAnchor(pageTour.page, pageStep.anchor))
    : null;
  const rect = useAnchorRect(selector);

  // Échap réduit le guide, ou clôt la visite de page (jamais pendant une fenêtre du site, qui a sa propre touche Échap).
  useEffect(() => {
    if (!visible && !pageVisible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const current = document.activeElement;
      if (current && current !== document.body && !current.closest("[data-guide-host]")) return;
      event.preventDefault();
      if (pageVisible) endPageTour(true);
      else minimizeGuide();
      bubbleButtonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, pageVisible]);

  // Focus sur l'action principale à l'accueil, au tour et à chaque arrêt de page, seulement si le focus est libre.
  useEffect(() => {
    if (!showing || (showing !== "arrival" && showing !== "tour" && showing !== "page")) return;
    const current = document.activeElement;
    if (!current || current === document.body || current.closest("[data-guide-host]")) primaryRef.current?.focus();
  }, [showing, pageIndex]);

  const onBubble = useCallback(() => {
    if (minimized && phase !== null && phase !== "done") restoreGuide();
    else setGuidePanelOpen(!useGuideStore.getState().panelOpen);
  }, [minimized, phase]);

  const closePanel = useCallback(() => {
    setGuidePanelOpen(false);
    bubbleButtonRef.current?.focus();
  }, []);

  const replayPage = useCallback(() => {
    if (pageKey) startPageTour(pageKey, true);
  }, [pageKey]);

  async function connect() {
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

  if (suppressed || phase === null) return null;

  const token = t(stablecoinSymbol(NETWORK));
  const pending = minimized && phase !== "done";
  const layout = showing ? layoutFor(showing, rect, vw, vh, ending) : null;
  const verifyMode = guideVerifyMode({ kyb: kybKnown, instantAccess, gasWei });
  const mood: GuideMood = celebrate || ending ? "happy" : showing === "connect" || showing === "signin" || (showing === "verify" && verifyMode === "loading") ? "waiting" : "talking";
  const mobile = vw < 768;

  function content() {
    if (ending) return { title: t(GUIDE_TOUR_END.title), body: [t(GUIDE_TOUR_END.body)], actions: null };
    if (celebrate === "connect") return { title: t(GUIDE_CONNECT.done), body: [], actions: null };
    if (celebrate === "signin") return { title: t(GUIDE_SIGNIN.done), body: [], actions: null };
    if (celebrate === "verify") return { title: t(GUIDE_VERIFY.done), body: [], actions: null };
    switch (showing) {
      case "arrival":
        return {
          title: t(GUIDE_ARRIVAL.title, { name: GUIDE_NAME }),
          body: GUIDE_ARRIVAL.body.map((line) => t(line)),
          actions: (
            <button ref={primaryRef} type="button" onClick={() => applyGuideAction({ type: "arrival-continue" })} className={BUTTON} data-testid="guide-start">
              {t(GUIDE_UI.start)}
            </button>
          ),
        };
      case "connect":
        return {
          title: t(GUIDE_CONNECT.title),
          body: [t(GUIDE_CONNECT.body)],
          actions: (
            <button ref={primaryRef} type="button" onClick={() => void connect()} disabled={signPending} className={BUTTON} data-testid="guide-connect">
              {signPending ? t("Connexion…") : t("Connecter un wallet")}
            </button>
          ),
          hint: signError ?? GUIDE_UI.waiting,
        };
      case "signin":
        return {
          title: t(GUIDE_SIGNIN.title),
          body: [t(GUIDE_SIGNIN.body)],
          actions: (
            <button ref={primaryRef} type="button" onClick={() => void connectAndSignIn()} disabled={signPending} className={BUTTON} data-testid="guide-signin">
              {signPending ? t("Signature…") : t("Se connecter")}
            </button>
          ),
          hint: signError ?? GUIDE_UI.waiting,
        };
      case "verify":
        return {
          title: t(GUIDE_VERIFY.title),
          body: [t(guideVerifyWhy(NETWORK)), t(GUIDE_VERIFY.mode[verifyMode])],
          actions: verifyMode === "loading" ? null : verifyMode === "unknown" ? (
            <Link href="/kyb" className={BUTTON}>{t(GUIDE_VERIFY.action.unknown)}</Link>
          ) : (
            <button ref={primaryRef} type="button" onClick={() => void requestVerification("checklist")} aria-haspopup="dialog" className={BUTTON} data-testid="guide-verify">
              {t(GUIDE_VERIFY.action[verifyMode])}
            </button>
          ),
        };
      case "tour": {
        const copy = GUIDE_TOUR_COPY[stop.key];
        const index = progress.tourIndex;
        const last = index === GUIDE_TOUR_STOPS.length - 1;
        return {
          eyebrow: t(GUIDE_UI.stepOf, { current: index + 1, total: GUIDE_TOUR_STOPS.length }),
          title: t(copy.title),
          body: [t(copy.body, { token })],
          actions: (
            <>
              {index > 0 && (
                <button type="button" onClick={() => applyGuideAction({ type: "tour-previous" })} className={SECONDARY}>
                  {t(GUIDE_UI.previous)}
                </button>
              )}
              <button ref={primaryRef} type="button" onClick={() => applyGuideAction({ type: last ? "tour-finish" : "tour-next" })} className={BUTTON} data-testid="guide-next">
                {last ? t(GUIDE_UI.finish) : t(GUIDE_UI.next)}
              </button>
            </>
          ),
          link: mobile ? stop.href : null,
        };
      }
      case "page": {
        if (!pageStep) return null;
        const last = pageIndex === pageSteps.length - 1;
        return {
          eyebrow: t(GUIDE_UI.stepOf, { current: pageIndex + 1, total: pageSteps.length }),
          title: t(pageStep.title),
          body: [t(guidePageStepBody(pageStep, NETWORK), { token })],
          dots: { current: pageIndex, total: pageSteps.length },
          actions: (
            <>
              {pageIndex > 0 && (
                <button type="button" onClick={() => setPageTourStep(pageSteps[pageIndex - 1]?.anchor ?? null)} className={SECONDARY} data-testid="guide-page-previous">
                  {t(GUIDE_UI.previous)}
                </button>
              )}
              <button ref={primaryRef} type="button" onClick={() => (last ? endPageTour(true) : setPageTourStep(pageSteps[pageIndex + 1]?.anchor ?? null))} className={BUTTON} data-testid="guide-page-next">
                {last ? t(GUIDE_UI.finish) : t(GUIDE_UI.next)}
              </button>
            </>
          ),
        };
      }
      default:
        return null;
    }
  }

  const bubble = showing ? content() : null;
  const transition = reduced ? "none" : `left 700ms ${SMOOTH}, top 700ms ${SMOOTH}, transform 700ms ${SMOOTH}, opacity 400ms linear`;
  const pageMode = showing === "page";
  const showHelp = pageKey !== null && !ending && !pageVisible;

  return (
    <>
      {layout && bubble && (
        <div data-guide-host="" className="pointer-events-none fixed inset-0 z-[55] print:hidden">
          <Spotlight rect={ending || celebrate ? null : rect} label={t(GUIDE_UI.spotlight)} />
          <div
            aria-hidden
            className="fixed"
            style={{
              left: layout.blob.x,
              top: layout.blob.y,
              width: layout.blob.size,
              height: layout.blob.size,
              transform: `scale(${layout.blob.scale})`,
              transformOrigin: "center",
              opacity: ending ? 0.9 : 1,
              transition,
            }}
          >
            <GuideBlob size={layout.blob.size} mood={mood} gaze={layout.gaze} />
          </div>
          <section
            role="region"
            aria-label={t(GUIDE_UI.bubbleLabel, { name: GUIDE_NAME })}
            data-testid="guide-bubble-text"
            data-phase={showing}
            data-page={pageMode && pageTour ? pageTour.page : undefined}
            className={`pointer-events-auto fixed rounded-2xl border border-white/15 bg-surface/90 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl animate-fade-in wrap-anywhere ${
              layout.bubble === "sheet" ? "inset-x-4 bottom-[5.5rem] pl-24" : ""
            }`}
            style={layout.bubble === "sheet" ? { paddingBottom: "max(1rem, env(safe-area-inset-bottom))" } : { left: layout.bubble.x, top: layout.bubble.y, width: BUBBLE_W, transition: reduced ? "none" : `left 500ms ${SMOOTH}, top 500ms ${SMOOTH}` }}
          >
            <div aria-live="polite">
              {"eyebrow" in bubble && bubble.eyebrow && <div className="text-[11px] uppercase tracking-wider text-muted">{bubble.eyebrow}</div>}
              <h2 className="text-base font-semibold tracking-tight">{bubble.title}</h2>
              {bubble.body.map((line) => (
                <p key={line} className="mt-1.5 text-sm leading-relaxed text-muted">{line}</p>
              ))}
              {"hint" in bubble && bubble.hint && (
                <p role={bubble.hint === GUIDE_UI.waiting ? "status" : "alert"} className={`mt-1.5 text-xs ${bubble.hint === GUIDE_UI.waiting ? "text-muted" : "text-negative"}`}>
                  {t(bubble.hint)}
                </p>
              )}
              {"link" in bubble && bubble.link && (
                <Link href={bubble.link} className="mt-1.5 inline-block text-xs text-foreground underline-offset-2 hover:underline">{bubble.title} →</Link>
              )}
            </div>
            {"dots" in bubble && bubble.dots && (
              <div className="mt-3 flex items-center gap-1.5" aria-hidden>
                {Array.from({ length: bubble.dots.total }, (_, i) => (
                  <span key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === bubble.dots.current ? "w-4 bg-accent" : "w-1.5 bg-white/25"}`} />
                ))}
              </div>
            )}
            {!ending && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                {pageMode ? (
                  <button type="button" onClick={() => { endPageTour(true); bubbleButtonRef.current?.focus(); }} className={SUBTLE} data-testid="guide-page-skip">{t(GUIDE_PAGE_UI.skip)}</button>
                ) : (
                  <button type="button" onClick={() => applyGuideAction({ type: "skip" })} className={SUBTLE} data-testid="guide-skip">{t(GUIDE_UI.skip)}</button>
                )}
                <div className="flex items-center gap-2">
                  {!pageMode && (
                    <button type="button" onClick={() => { minimizeGuide(); bubbleButtonRef.current?.focus(); }} aria-label={t(GUIDE_UI.minimize)} title={t(GUIDE_UI.minimize)} className={SUBTLE}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M5 12h14" /></svg>
                    </button>
                  )}
                  {bubble.actions}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
      {showHelp && (
        <button
          type="button"
          onClick={replayPage}
          aria-label={t(GUIDE_PAGE_UI.help)}
          title={t(GUIDE_PAGE_UI.help)}
          data-testid="guide-page-help"
          // À gauche de la bulle (bas droite, 56 px) ; le panneau plein écran du mobile le recouvre.
          className="fixed bottom-[1.4rem] right-[4.75rem] z-30 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface/80 text-sm font-semibold text-muted shadow-lg backdrop-blur-sm transition-colors hover:border-white/20 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent print:hidden"
        >
          <span aria-hidden="true">?</span>
        </button>
      )}
      {!ending && <GuideBubble onClick={onBubble} pending={pending} open={panelOpen} buttonRef={bubbleButtonRef} />}
      {/* Le panneau reste monté derrière une fenêtre modale (conversation et saisie conservées), seulement masqué. */}
      {panelOpen && (
        <div className={modal ? "hidden" : "contents"} aria-hidden={modal || undefined}>
          <AssistantPanel onClose={closePanel} onReplay={replayGuide} onReplayPage={pageKey ? replayPage : null} />
        </div>
      )}
    </>
  );
}
