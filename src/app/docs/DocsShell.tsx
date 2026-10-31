"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { useBlobStore } from "@/stores/blob";
import { useLocale } from "@/components/i18n/LocaleProvider";

export interface TocItem {
  id: string;
  label: string;
}

// Les pages de la documentation, dans l'ordre de lecture : groupe du menu, onglet de l'en-tête, page précédente et suivante.
const PAGES = [
  { href: "/docs", group: "Protocol", tab: "Documentation", label: "How Sirius works" },
  { href: "/docs/mcp", group: "For developers", tab: "Developers", label: "MCP server" },
];

/** Section visible en haut de l'écran, pour surligner le sommaire pendant la lecture. */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const sections = ids.map((id) => document.getElementById(id)).filter((section): section is HTMLElement => section !== null);
    if (sections.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "-15% 0px -75% 0px" });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SectionLinks({ toc, tocLabel, active, onPick }: { toc: TocItem[]; tocLabel: (label: string) => string; active: string; onPick?: () => void }) {
  return toc.map((item) => (
    <a
      key={item.id}
      href={`#${item.id}`}
      onClick={onPick}
      aria-current={active === item.id ? "location" : undefined}
      className={`-ml-px block border-l py-1.5 pl-4 pr-2 text-sm transition-colors ${
        active === item.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted hover:text-foreground"
      }`}
    >
      {tocLabel(item.label)}
    </a>
  ));
}

export function DocsShell({ title, lead, actions, toc, tocLabel, children }: {
  title: string;
  lead: React.ReactNode;
  actions?: React.ReactNode;
  toc: TocItem[];
  tocLabel: (label: string) => string;
  children: React.ReactNode;
}) {
  const { t } = useLocale();
  const hero = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const ids = useMemo(() => toc.map((item) => item.id), [toc]);
  const active = useActiveSection(ids);
  const [menuOpen, setMenuOpen] = useState(false);

  // Comme sur l'accueil : la sphère entière derrière l'en-tête de page, puis la caméra entre dedans au défilement.
  useEffect(() => {
    const { setScrollDriven, setScrollProgress } = useBlobStore.getState();
    setScrollDriven(true);
    const update = () => {
      const span = hero.current?.offsetHeight || window.innerHeight;
      setScrollProgress(Math.min(1, Math.max(0, window.scrollY / span)));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("scroll", update);
      setScrollDriven(false);
      setScrollProgress(0);
    };
  }, []);

  const index = Math.max(0, PAGES.findIndex((page) => page.href === pathname));
  const current = PAGES[index];
  const previous = PAGES[index - 1];
  const next = PAGES[index + 1];

  const nav = (onPick?: () => void) => PAGES.map((page) => {
    const open = page.href === current.href;
    return (
      <div key={page.href}>
        <p className="mb-2 px-4 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">{page.group}</p>
        <Link
          href={page.href}
          onClick={onPick}
          aria-current={open ? "page" : undefined}
          className={`flex items-center justify-between rounded-[2rem] px-4 py-2 text-sm transition-colors ${
            open ? "bg-accent font-medium text-background shadow-[0_8px_24px_rgba(255,255,255,0.1)]" : "text-muted hover:bg-white/[0.04] hover:text-foreground"
          }`}
        >
          {page.label}
          <Chevron open={open} />
        </Link>
        {open && toc.length > 0 && (
          <nav aria-label={t("Sommaire")} className="ml-5 mt-2 border-l border-white/10">
            <SectionLinks toc={toc} tocLabel={tocLabel} active={active} onPick={onPick} />
          </nav>
        )}
      </div>
    );
  });

  return (
    <div className="relative z-10 min-h-full text-foreground">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-background/40 backdrop-blur-xl">
        <div className="flex h-16 items-center justify-between px-4 sm:px-8">
          <div className="flex items-baseline gap-2">
            <Link href="/" className="text-xl font-semibold tracking-[-0.04em]">Sirius</Link>
            <span className="text-sm font-medium text-muted">{t("Documentation")}</span>
          </div>
          <ConnectButton />
        </div>
        <div className="flex gap-6 overflow-x-auto px-4 [scrollbar-width:none] sm:px-8">
          {PAGES.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              className={`-mb-px whitespace-nowrap border-b-2 pb-3 text-sm font-medium transition-colors ${
                page.href === current.href ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {page.tab}
            </Link>
          ))}
        </div>
      </header>

      <div ref={hero} className="relative isolate flex min-h-[calc(100svh-6.75rem)] flex-col items-center justify-center px-6 py-16 text-center">
        {/* Voile sombre derrière le texte : il reste lisible là où l'anneau de la sphère le croise. */}
        <div aria-hidden className="absolute left-1/2 top-1/2 -z-10 h-[34rem] w-[min(54rem,100%)] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(closest-side,rgba(11,11,11,0.9),rgba(11,11,11,0.6)_65%,transparent)]" />
        <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
          <span>{current.group}</span>
          <Chevron open={false} />
          <span className="text-foreground">{current.label}</span>
        </p>
        <h1 className="mt-5 max-w-3xl text-5xl font-semibold tracking-tight text-foreground [text-shadow:0_2px_24px_rgba(0,0,0,0.8)] md:text-6xl">{title}</h1>
        <div className="mt-6 max-w-xl text-lg leading-relaxed text-muted [text-shadow:0_1px_12px_rgba(0,0,0,0.9)]">{lead}</div>
        {actions && <div className="mt-10 flex flex-wrap items-center justify-center gap-3">{actions}</div>}
        <a href={toc[0] ? `#${toc[0].id}` : "#"} aria-label={toc[0] ? tocLabel(toc[0].label) : undefined} className="absolute bottom-8 text-muted transition-colors hover:text-foreground">
          <svg viewBox="0 0 16 16" aria-hidden className="h-5 w-5 animate-bounce motion-reduce:animate-none" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3.5 6 8 10.5 12.5 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </a>
      </div>

      <div className="mx-auto flex w-full max-w-[90rem] gap-10 px-4 sm:px-8">
        <aside className="hidden w-64 shrink-0 lg:block">
          <div className="sticky top-[6.75rem] max-h-[calc(100vh-6.75rem)] space-y-8 overflow-y-auto py-10 pr-2">{nav()}</div>
        </aside>

        <main className="min-w-0 flex-1 py-10">
          <div className="mx-auto max-w-3xl">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              className="mb-6 flex w-full items-center justify-between rounded-[2rem] border border-white/10 bg-surface/50 px-5 py-2.5 text-sm font-medium backdrop-blur-xl lg:hidden"
            >
              {t("Sommaire")}
              <Chevron open={menuOpen} />
            </button>
            {menuOpen && <div className="mb-8 space-y-6 rounded-[2rem] border border-white/10 bg-surface/50 p-4 backdrop-blur-xl lg:hidden">{nav(() => setMenuOpen(false))}</div>}

            <div>{children}</div>

            <div className="mt-16 grid gap-3 border-t border-border pt-8 sm:grid-cols-2">
              {previous ? (
                <Link href={previous.href} className="rounded-[2rem] border border-white/10 bg-surface/40 px-6 py-4 backdrop-blur-xl transition-colors hover:border-white/25">
                  <span className="text-xs text-muted">Previous</span>
                  <span className="mt-1 block font-medium text-foreground">{previous.label}</span>
                </Link>
              ) : <span className="hidden sm:block" />}
              {next && (
                <Link href={next.href} className="rounded-[2rem] border border-white/10 bg-surface/40 px-6 py-4 text-right backdrop-blur-xl transition-colors hover:border-white/25">
                  <span className="text-xs text-muted">Next</span>
                  <span className="mt-1 block font-medium text-foreground">{next.label}</span>
                </Link>
              )}
            </div>
          </div>
        </main>

        {toc.length > 0 && (
          <aside className="hidden w-56 shrink-0 xl:block">
            <div className="sticky top-[6.75rem] py-10">
              <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">On this page</p>
              <nav className="border-l border-border">
                <SectionLinks toc={toc} tocLabel={tocLabel} active={active} />
              </nav>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

// Boutons de l'en-tête de page, comme ceux de l'accueil : pilule blanche, puis pilule de verre.
export const HERO_PRIMARY = "rounded-[2rem] bg-accent px-6 py-3 text-sm font-medium text-background shadow-[0_8px_24px_rgba(255,255,255,0.12)] transition-[background-color,transform] hover:bg-accent/90 active:scale-[0.96]";
export const HERO_SECONDARY = "rounded-[2rem] border border-white/15 bg-surface/40 px-6 py-3 text-sm font-medium text-foreground backdrop-blur-xl transition-colors hover:border-white/30";

/** Une section de la documentation : titre ancré, texte courant. */
export function DocSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-32 pt-12 first:pt-0">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground">
        <a href={`#${id}`} className="decoration-border underline-offset-8 hover:underline">{title}</a>
      </h2>
      <div className="mt-4 space-y-4 text-[15px] leading-7 text-foreground/75">{children}</div>
    </section>
  );
}

/** Encadré d'information, comme les « hints » d'une documentation GitBook. */
export function Hint({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="note" className="flex gap-3 rounded-[2rem] border border-white/10 bg-surface/50 p-6 backdrop-blur-xl">
      <svg viewBox="0 0 20 20" aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="10" cy="10" r="8" />
        <path d="M10 9v5M10 6.2v.1" strokeLinecap="round" />
      </svg>
      <div className="min-w-0 space-y-2 text-sm leading-relaxed text-muted">
        <h2 className="font-semibold text-foreground">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ value, label, copiedLabel, primary = false }: { value: string; label: string; copiedLabel: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined)}
      className={`shrink-0 rounded-[2rem] px-4 py-1.5 text-xs font-medium transition-[background-color,color,transform] active:scale-[0.96] ${
        primary ? "bg-accent text-background hover:bg-white/80" : "border border-border text-muted hover:text-foreground"
      }`}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

export function CodeBlock({ code, copy, copied }: { code: string; copy: string; copied: string }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-[1.25rem] border border-white/10 bg-background/60 p-4 backdrop-blur-xl">
      <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">{code}</pre>
      <CopyButton value={code} label={copy} copiedLabel={copied} />
    </div>
  );
}
