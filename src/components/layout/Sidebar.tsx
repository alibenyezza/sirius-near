"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useUiStore, useUiTransitionsReady } from "@/stores/ui";
import { useReducedMotion } from "@/components/ui/useReducedMotion";
import { SiriusMark } from "./SiriusMark";

/** Tracés d'icônes 24×24 en trait (style Lucide). */
const NAV = [
  { href: "/dashboard", label: "Tableau de bord", icon: ["M3 3h7v9H3z", "M14 3h7v5h-7z", "M14 12h7v9h-7z", "M3 16h7v5H3z"] },
  { href: "/train", label: "Entraîner", icon: ["M9 3v2", "M15 3v2", "M9 19v2", "M15 19v2", "M3 9h2", "M3 15h2", "M19 9h2", "M19 15h2", "M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M9 9h6v6H9z"] },
  { href: "/phala", label: "Phala", icon: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "M9 12l2 2 4-4"] },
  { href: "/marketplace", label: "Marketplace", icon: ["M3 9l1.5-5h15L21 9", "M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z", "M5 13v8h14v-8", "M10 21v-5h4v5"] },
  { href: "/datasets", label: "Mes datasets", icon: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M3 9h18", "M3 15h18", "M9 9v12"] },
  { href: "/explorer", label: "Explorer", icon: ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M21 21l-4.3-4.3"] },
];

/** Délai avant l'ouverture au survol : un passage rapide de la souris ne déplie pas la barre. */
const PEEK_DELAY_MS = 150;

const MORPH = "transition-[max-width,opacity,transform,filter] duration-300 ease-out motion-reduce:transition-none";

/**
 * Libellé qui devient son glyphe quand la barre se replie, et inversement : le texte se
 * contracte vers la gauche en s'estompant pendant que le glyphe apparaît au même endroit.
 * Le décalage (`delay`) laisse voir le passage de l'un à l'autre dans les deux sens.
 */
function Morph({ expanded, glyph, children }: { expanded: boolean; glyph: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="relative flex min-w-0 items-center">
      <span
        className={`origin-left overflow-hidden whitespace-nowrap ${MORPH} ${
          expanded ? "max-w-48 scale-100 opacity-100 blur-0 delay-75" : "max-w-0 scale-x-25 opacity-0 blur-[3px]"
        }`}
      >
        {children}
      </span>
      <span
        aria-hidden
        className={`absolute left-0 flex ${MORPH} ${expanded ? "scale-50 opacity-0 blur-[3px]" : "scale-100 opacity-100 blur-0 delay-100"}`}
      >
        {glyph}
      </span>
    </span>
  );
}

function Icon({ paths }: { paths: string[] }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/** Mot « Sirius » ouvert, emblème replié ; le mot se contracte en emblème comme les libellés. */
const MARK_SIZE = 34;
const LETTERS = [..."Sirius"];
/** Courbe douce en entrée et en sortie, partagée par les lettres et l'emblème. */
const SMOOTH = "cubic-bezier(0.65, 0, 0.35, 1)";

/** Trajet du « s » final entre sa place et le centre de l'emblème. */
const TRAVEL_MS = 320;
/** Petit rebond quand une lettre réapparaît. */
const POP = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/**
 * « Sirius » ouvert, emblème replié. À la fermeture, le « s » final glisse vers l'emblème en
 * avalant chaque lettre au moment où il la croise, puis pivote d'un quart de tour et laisse place
 * à l'emblème ; à l'ouverture, il ressort vers la droite et redépose les lettres sur son passage.
 * Les positions sont mesurées sur les lettres rendues.
 */
function LogoSlot({ expanded = true }: { expanded?: boolean }) {
  const letters = useRef<(HTMLSpanElement | null)[]>([]);
  const word = useRef<HTMLSpanElement>(null);
  const [offsets, setOffsets] = useState<number[]>(() => LETTERS.map(() => 0));
  const reduced = useReducedMotion();

  // Re-mesure quand le mot change de taille : barre montée masquée (mobile) puis affichée,
  // police chargée après coup.
  useLayoutEffect(() => {
    const measure = () =>
      setOffsets(letters.current.map((el) => (el ? MARK_SIZE / 2 - (el.offsetLeft + el.offsetWidth / 2) : 0)));
    measure();
    void document.fonts?.ready.then(measure);
    const observer = new ResizeObserver(measure);
    if (word.current) observer.observe(word.current);
    return () => observer.disconnect();
  }, []);

  const last = LETTERS.length - 1;
  const travel = -offsets[last];
  // Part du trajet du « s » final avant qu'il atteigne la lettre i (0 : voisine, 1 : première lettre).
  const reached = (i: number) => (travel > 0 ? Math.min(1, (offsets[i] - offsets[last]) / travel) : 0);

  return (
    <Link href="/dashboard" aria-label="Sirius" className="relative flex h-[34px] items-center text-2xl font-semibold tracking-[-0.05em]">
      <span ref={word} aria-hidden className="relative flex whitespace-nowrap pl-[8px]">
        {LETTERS.map((letter, i) => {
          const eater = i === last;
          const delay = Math.round((expanded ? 80 + (1 - reached(i)) * TRAVEL_MS : reached(i) * TRAVEL_MS) * 0.9);
          const style: React.CSSProperties = eater
            ? {
                transform: expanded ? "none" : `translateX(${offsets[i]}px) rotate(90deg) scale(0.4)`,
                opacity: expanded ? 1 : 0,
                transition: reduced
                  ? "none"
                  : expanded
                  ? `transform ${TRAVEL_MS}ms ${SMOOTH} 80ms, opacity 120ms linear 80ms`
                  : `transform ${TRAVEL_MS}ms ${SMOOTH}, opacity 160ms linear ${TRAVEL_MS - 60}ms`,
              }
            : {
                transform: expanded ? "scale(1)" : "scale(0)",
                opacity: expanded ? 1 : 0,
                transition: reduced
                  ? "none"
                  : expanded
                  ? `transform 200ms ${POP} ${delay}ms, opacity 120ms linear ${delay}ms`
                  : `transform 140ms ${SMOOTH} ${delay}ms, opacity 140ms linear ${delay}ms`,
              };
          return (
            <span
              key={i}
              ref={(el) => {
                letters.current[i] = el;
              }}
              className={`inline-block motion-reduce:transition-none ${eater ? "relative z-10" : ""}`}
              style={style}
            >
              {letter}
            </span>
          );
        })}
      </span>
      <span
        aria-hidden
        className="absolute left-0 flex motion-reduce:transition-none"
        style={{
          transform: expanded ? "rotate(-90deg) scale(0.4)" : "rotate(0deg) scale(1)",
          opacity: expanded ? 0 : 1,
          transition: reduced
            ? "none"
            : expanded
            ? `transform 160ms ${SMOOTH}, opacity 140ms linear`
            : `transform 260ms ${SMOOTH} ${TRAVEL_MS - 80}ms, opacity 180ms linear ${TRAVEL_MS - 80}ms`,
        }}
      >
        <SiriusMark size={MARK_SIZE} />
      </span>
    </Link>
  );
}

/** Sortie de l'app vers la landing (icône logout : flèche sortant d'une porte). */
function ExitButton({ className = "" }: { className?: string }) {
  const { t } = useLocale();

  return (
    <Link
      href="/"
      aria-label={t("Quitter vers l'accueil")}
      title={t("Quitter")}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[2rem] text-muted transition-colors hover:bg-background hover:text-foreground ${className}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" x2="9" y1="12" y2="12" />
      </svg>
    </Link>
  );
}

/**
 * Liens de navigation. La pastille de la page active est un seul élément qui glisse d'un lien à
 * l'autre. En vertical, elle occupe toute la largeur de la liste : elle suit le repli de la barre
 * sans mesure ni retard, seul son déplacement vertical est animé.
 */
function NavLinks({ vertical, expanded = true }: { vertical?: boolean; expanded?: boolean }) {
  const pathname = usePathname();
  const { t } = useLocale();
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [animated, setAnimated] = useState(false);
  const activeHref = NAV.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.href ?? null;

  const nav = useRef<HTMLElement>(null);

  // Re-mesure aussi au redimensionnement : une liste montée masquée (barre desktop sur mobile,
  // ou l'inverse) mesure zéro jusqu'à ce qu'elle s'affiche.
  useLayoutEffect(() => {
    const el = activeHref ? links.current.get(activeHref) : undefined;
    if (!el || !nav.current) {
      setPill(null);
      return;
    }
    const measure = () => setPill({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav.current);
    return () => observer.disconnect();
  }, [activeHref]);

  // Barre d'onglets mobile : amène l'onglet actif dans la zone visible, hors du fondu.
  useEffect(() => {
    if (vertical || !activeHref) return;
    links.current.get(activeHref)?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [vertical, activeHref]);

  // Pas de glissement à l'affichage initial : la pastille apparaît directement sous la page active.
  useEffect(() => {
    if (!pill || animated) return;
    const frame = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(frame);
  }, [pill, animated]);

  return (
    // `isolate` borne le mode de fusion des libellés à la pastille : le texte s'inverse là où elle passe.
    <nav ref={nav} aria-label={t("Navigation")} className={`relative isolate ${
        // Espace final : le dernier onglet peut sortir du fondu de droite de la barre mobile.
        vertical ? "flex flex-col gap-2" : "flex w-max items-center gap-2 pr-10"
      }`}>
      <span
        aria-hidden
        className={`pointer-events-none absolute top-0 left-0 rounded-[2rem] bg-accent shadow-[0_8px_24px_rgba(255,255,255,0.1)] motion-reduce:transition-none ${
          vertical ? "right-0" : ""
        } ${animated ? "transition-[transform,width,opacity] duration-300 ease-[cubic-bezier(0.65,0,0.35,1)]" : ""}`}
        style={
          !pill
            ? { opacity: 0 }
            : vertical
              ? { transform: `translateY(${pill.y}px)`, height: pill.h }
              : { transform: `translateX(${pill.x}px)`, width: pill.w, height: pill.h }
        }
      />
      {NAV.map((item) => {
        const active = item.href === activeHref;
        return (
          <Link
            key={item.href}
            ref={(el) => {
              if (el) links.current.set(item.href, el);
              else links.current.delete(item.href);
            }}
            href={item.href}
            aria-current={active ? "page" : undefined}
            data-guide={`nav:${item.href}`}
            title={vertical && !expanded ? t(item.label) : undefined}
            className={`relative rounded-[2rem] font-medium transition-[background-color,color,transform] duration-200 active:scale-[0.96] ${
              vertical ? "flex min-h-14 w-full items-center px-[18px] text-base" : "shrink-0 px-4 py-2.5 text-sm"} ${
              active ? "text-foreground" : "text-muted hover:bg-background hover:text-foreground"
            }`}
          >
            <span className="flex mix-blend-difference">
              {vertical ? (
                <Morph expanded={expanded} glyph={<Icon paths={item.icon} />}>{t(item.label)}</Morph>
              ) : t(item.label)}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Barre latérale desktop. Repliée, elle garde un rail de glyphes ; le survol (ou le focus clavier)
 * la déplie par-dessus la page, sans la décaler, et le bouton d'en-tête l'épingle ouverte.
 */
export function Sidebar() {
  const { t } = useLocale();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const peek = useUiStore((s) => s.sidebarPeek);
  const setPeek = useUiStore((s) => s.setSidebarPeek);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Souris au-dessus de la barre : une perte de focus (menu wallet refermé, fenêtre de signature
  // du wallet) ne doit pas la replier tant que le pointeur y reste.
  const hovering = useRef(false);
  const aside = useRef<HTMLElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  // Menu wallet ouvert, connexion ou signature en cours : la barre ne se replie pas entre-temps,
  // sinon la fenêtre du wallet (qui prend le pointeur et le focus) refermerait ce qu'elle sert.
  const [walletActive, setWalletActive] = useState(false);
  const expanded = !collapsed || peek;
  const hydrated = useUiTransitionsReady();

  useEffect(() => () => {
    clearTimeout(timer.current);
    setPeek(false);
  }, [setPeek]);

  // Fin de l'activité du wallet : repli si ni le pointeur ni le focus ne sont restés sur la barre.
  useEffect(() => {
    if (walletActive || hovering.current || aside.current?.contains(document.activeElement)) return;
    setPeek(false);
  }, [walletActive, setPeek]);

  const openPeek = () => {
    if (!collapsed) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPeek(true), PEEK_DELAY_MS);
  };
  const closePeek = () => {
    clearTimeout(timer.current);
    if (walletActive) return;
    setPeek(false);
  };
  const toggle = () => {
    closePeek();
    setCollapsed(!collapsed);
  };
  const enter = () => {
    hovering.current = true;
    openPeek();
  };
  // Passage entre la marge gauche de l'écran et la barre : ni l'une ni l'autre ne referme.
  const leave = (event: React.MouseEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (aside.current?.contains(next) || edge.current?.contains(next))) return;
    hovering.current = false;
    closePeek();
  };

  return (
    <>
      {/* Marge gauche de l'écran : y amener la souris déplie aussi la barre repliée. */}
      <div ref={edge} aria-hidden onMouseEnter={enter} onMouseLeave={leave} className="fixed inset-y-0 left-0 z-30 hidden w-4 md:block" />
      <aside
        ref={aside}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={() => collapsed && setPeek(true)}
        onBlur={(event) => !hovering.current && !event.currentTarget.contains(event.relatedTarget) && closePeek()}
        className={`fixed inset-y-4 left-4 z-30 hidden flex-col overflow-hidden rounded-[2rem] border border-white/[0.12] p-3 backdrop-blur-2xl md:flex ${
          hydrated ? "transition-[width] duration-300 ease-out motion-reduce:transition-none" : ""
        } ${
          expanded ? "w-[17rem]" : "w-20"
        } bg-surface/55 shadow-[0_18px_60px_rgba(0,0,0,0.38)]`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 pl-[11px]">
          <LogoSlot expanded={expanded} />
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? t("Épingler le menu") : t("Réduire le menu")}
            title={collapsed ? t("Épingler le menu") : t("Réduire le menu")}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition-[opacity,color,background-color] duration-200 hover:bg-background hover:text-foreground ${
              expanded ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="M9 4v16" />
              <path d={collapsed ? "M13 10l2 2-2 2" : "M16 10l-2 2 2 2"} />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-x-hidden overflow-y-auto py-5">
          <NavLinks vertical expanded={expanded} />
        </div>
        {/* Sortie en premier : elle garde la même place, barre repliée ou dépliée. Le bouton wallet
            reste monté (un menu ouvert ou une connexion en cours survit au repli) ; replié, il
            passe en icône et se range sous la sortie, toujours visible pour un visiteur non connecté. */}
        <div className="flex flex-wrap items-center gap-2 rounded-[2rem] bg-background/40 p-2 backdrop-blur-xl">
          <ExitButton />
          <div className={expanded ? "min-w-0 flex-1" : "shrink-0"}>
            <ConnectButton dropUp compact={!expanded} onActivity={setWalletActive} />
          </div>
        </div>
      </aside>

      {/* Mobile : barre horizontale en haut */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-surface/80 px-4 backdrop-blur-sm md:hidden">
        <LogoSlot />
        <div className="flex items-center gap-1">
          <ExitButton />
          <ConnectButton />
        </div>
      </header>
      {/* Le fondu à droite dit que la barre défile ; le `pr-12` laisse le dernier lien sortir du fondu en fin de course. */}
      <div className="fixed inset-x-0 top-16 z-30 overflow-x-auto border-b border-border bg-surface/60 py-2 pl-3 pr-12 backdrop-blur-sm [mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)] md:hidden">
        <NavLinks />
      </div>
    </>
  );
}
