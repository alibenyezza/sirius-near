"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { useBlobStore } from "@/stores/blob";
import { useWalletStore } from "@/stores/wallet";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";

gsap.registerPlugin(ScrollTrigger);
// Évite les recalculs de 100vh au show/hide de la barre d'adresse mobile (jank du pin).
ScrollTrigger.config({ ignoreMobileResize: true });

const team = [
  {
    name: "Ali BEN YEZZA",
    image: "/images/image_ali.png",
    imageStyle: "",
  },
  {
    name: "Noe WALES",
    image: "/images/avatar-noe.png",
    imageStyle: "object-[center_15%]",
  },
];

/** Compte X du projet : sa seule présence publique hors du site. */
const X_HANDLE = "Sirius_data";

const X_GLYPH = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

/**
 * Lien vers X. En icône seule en haut de page, où il doit se voir dès l'arrivée sans
 * concurrencer le bouton de connexion ; avec le handle en pied de page, où il y a la place.
 */
function XLink({ variant }: { variant: "icon" | "footer" }) {
  const { t } = useLocale();
  const label = t("Suivre Sirius sur X");
  if (variant === "icon") {
    return (
      <a
        href={`https://x.com/${X_HANDLE}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        title={label}
        className="flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-foreground"
      >
        {X_GLYPH}
      </a>
    );
  }
  return (
    <a
      href={`https://x.com/${X_HANDLE}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 py-2 text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
    >
      {X_GLYPH}
      <span>@{X_HANDLE}</span>
    </a>
  );
}

/** Avatar circulaire. */
function AvatarCard({
  name,
  image,
  imageStyle,
}: {
  name: string;
  image: string;
  imageStyle: string;
}) {
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-[220px] w-[220px] overflow-hidden rounded-full border border-border md:h-[280px] md:w-[280px]">
        <Image
          src={image}
          alt={name}
          fill
          sizes="(min-width: 768px) 280px, 220px"
          className={`object-cover ${imageStyle}`}
        />
      </div>
      <p className="mt-6 text-center text-lg font-medium tracking-tight text-foreground md:text-xl">{name}</p>
    </div>
  );
}

function PageBottom() {
  const { t } = useLocale();
  const networkLine = process.env.NEXT_PUBLIC_EVM_NETWORK === "mainnet" ? t("Bêta mainnet sur Robinhood Chain") : t("Testnet sur Robinhood Chain");
  return (
    <div className="relative">
      <section className="relative z-10 px-8 py-24 md:px-16 md:py-32">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <h2 className="text-4xl font-semibold tracking-tight text-foreground md:text-5xl">{t("About us")}</h2>
            <a
              href="https://devinciblockchain.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 opacity-80 transition-opacity hover:opacity-100"
            >
              <Image
                src="/images/devinci-blockchain.png"
                alt="DeVinci Blockchain"
                width={1228}
                height={1244}
                sizes="56px"
                className="h-12 w-auto md:h-14"
              />
              <span className="text-left text-sm leading-tight text-foreground md:text-base">
                DeVinci
                <br />
                Blockchain
              </span>
            </a>
          </div>

          <div className="mt-20 flex flex-col items-center justify-center gap-16 md:mt-28 md:flex-row md:gap-24 lg:gap-32">
            {team.map((m) => (
              <AvatarCard key={m.name} {...m} />
            ))}
          </div>
        </div>
      </section>

      <div className="relative z-10 mx-auto w-full max-w-2xl px-6 pb-8">
        {/* Avertissement court : limites de la bêta et qualité des modèles. */}
        <DisclaimerNote messages={["betaLimits", "modelQuality"]} />
      </div>

      <footer className="relative z-10 flex flex-col items-center gap-3 border-t border-border px-6 py-8 text-center">
        <div className="flex flex-wrap items-center justify-center gap-x-6">
          <Link href="/docs" className="py-2 text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline">
            {t("Documentation")}
          </Link>
          <Link href="/status" className="py-2 text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline">
            {t("État du protocole")}
          </Link>
          <Link href="/terms" className="py-2 text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline">
            {t("Conditions d’utilisation")}
          </Link>
          <Link href="/privacy" className="py-2 text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline">
            {t("Confidentialité")}
          </Link>
          <Link href="/legal" className="py-2 text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline">
            {t("Mentions légales")}
          </Link>
          <XLink variant="footer" />
        </div>
        <p className="text-xs tracking-widest text-muted">{t("Sirius — data lending confidentiel sur EVM")}</p>
        <p className="text-xs text-muted">{networkLine}</p>
      </footer>
    </div>
  );
}

export default function Home() {
  const { t } = useLocale();
  const connected = useWalletStore((s) => s.connected);
  const heroRef = useRef<HTMLDivElement>(null);
  const connectRef = useRef<HTMLDivElement>(null);
  const uiOverlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { setScrollDriven, setScrollProgress } = useBlobStore.getState();
    setScrollDriven(true);

    window.history.scrollRestoration = "manual";
    window.scrollTo({ top: 0, behavior: "instant" });
    document.documentElement.scrollTop = 0;

    // a11y : pas de scroll fluide forcé pour les utilisateurs "réduire les animations"
    // (risque vestibulaire). On retombe sur le scroll natif ; le zoom reste scroll-piloté.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let lenis: Lenis | null = null;
    let rafFn: ((time: number) => void) | null = null;
    if (!reduced) {
      lenis = new Lenis({
        duration: 1.4,
        easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      });
      lenis.stop();
      lenis.scrollTo(0, { immediate: true });
      lenis.start();
      lenis.on("scroll", ScrollTrigger.update);
      rafFn = (time: number) => lenis!.raf(time * 1000);
      gsap.ticker.add(rafFn);
      gsap.ticker.lagSmoothing(0);
    }

    const trigger = ScrollTrigger.create({
      trigger: heroRef.current,
      start: "top top",
      end: "bottom bottom",
      pin: ".hero-pin",
      scrub: 0.8,
      onUpdate: (self) => {
        setScrollProgress(self.progress);

        const raw = Math.min(1, Math.max(0, (self.progress - 0.03) / 0.77));
        if (uiOverlayRef.current) {
          const zoom = 1 + raw * raw * 8;
          uiOverlayRef.current.style.transform = `scale(${zoom})`;
        }
        if (connectRef.current) {
          const btnProgress = Math.min(1, Math.max(0, (self.progress - 0.6) / 0.1));
          connectRef.current.style.opacity = String(btnProgress);
          connectRef.current.style.pointerEvents = self.progress >= 0.65 ? "auto" : "none";
        }
      },
    });

    return () => {
      setScrollDriven(false);
      setScrollProgress(0);
      if (lenis) {
        lenis.stop();
        lenis.destroy();
      }
      if (rafFn) {
        gsap.ticker.remove(rafFn);
        gsap.ticker.lagSmoothing(500, 33); // restaure le défaut GSAP
      }
      trigger.kill();
      ScrollTrigger.getAll().forEach((t) => t.kill());
      ScrollTrigger.clearScrollMemory();
      ScrollTrigger.refresh();
      document.querySelectorAll(".pin-spacer").forEach((el) => {
        const child = el.firstElementChild;
        if (child) el.parentNode?.replaceChild(child, el);
        else el.remove();
      });
      window.history.scrollRestoration = "auto";
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
  }, []);

  return (
    <main className="relative z-10 text-foreground">
      <div className="fixed right-0 top-0 z-30 flex items-center gap-2 p-6 sm:p-8">
        <XLink variant="icon" />
        <ConnectButton />
      </div>

      <div ref={heroRef} className="relative h-[700vh]">
        <div className="hero-pin pointer-events-none relative h-screen w-screen overflow-hidden">
          <div
            ref={uiOverlayRef}
            className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between"
            style={{ transformOrigin: "center center" }}
          >
            <div className="flex items-start justify-between p-8 md:p-12">
              <h1 className="text-4xl font-semibold tracking-tight text-foreground md:text-5xl">Sirius</h1>
            </div>
          </div>

          <div
            ref={connectRef}
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6"
            style={{ opacity: 0 }}
          >
            <div className="flex max-w-xl flex-col items-center text-center">
              <h2 className="text-6xl font-semibold tracking-tight text-foreground md:text-7xl">Sirius</h2>
              <p className="mt-6 text-lg leading-snug text-muted md:text-xl">
                {t("Vos données, exploitables sans jamais les exposer.")}
              </p>
              <div className="mt-12 flex flex-col items-center gap-5">
                {connected ? (
                  <Link
                    href="/dashboard"
                    className="rounded-xl bg-accent px-8 py-4 text-base font-medium text-background transition-colors hover:bg-accent/90"
                  >
                    {t("Accéder à l’app")}
                  </Link>
                ) : (
                  <ConnectCta size="lg">{t("Connecter un wallet")}</ConnectCta>
                )}
                <Link
                  href="/docs"
                  className="py-2 text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {t("Lire la documentation")}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      <PageBottom />
    </main>
  );
}
