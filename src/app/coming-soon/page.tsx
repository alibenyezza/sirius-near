import type { Metadata } from "next";
import { LegalLinks } from "@/components/layout/LegalLinks";

/**
 * Page d'attente du passage mainnet.
 *
 * Servie au public par réécriture tant que la porte d'aperçu est fermée
 * (src/lib/preview-gate/gate.ts, src/proxy.ts). Composant serveur sans aucun script de
 * portefeuille : le proxy signale la page à la mise en page racine, qui la rend nue. Texte en
 * anglais, fond sombre du site, lisible à 360 px. Noindex : elle ne doit laisser aucune trace
 * dans les moteurs de recherche une fois le site ouvert.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Something's cooking · Sirius",
  description: "Sirius is going live on Robinhood Chain mainnet very soon.",
  robots: { index: false, follow: false, nocache: true },
};

/** Compte X du projet, le même que sur la page d'accueil. */
const X_HANDLE = "Sirius_data";

export default function ComingSoonPage() {
  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-xs uppercase tracking-[0.18em] text-muted">Sirius</p>
      <h1 className="mt-5 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
        Something&apos;s cooking{" "}
        <span role="img" aria-label="eyes">
          👀
        </span>
      </h1>
      <p className="mt-5 max-w-md text-base leading-relaxed text-muted sm:text-lg">
        Sirius is going live on Robinhood Chain mainnet very soon.
      </p>
      <a
        href={`https://x.com/${X_HANDLE}`}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-10 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-3 text-sm text-foreground transition-colors hover:border-muted"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        <span>Follow @{X_HANDLE} for the launch</span>
      </a>
      <p className="mt-16 text-xs text-muted-foreground">Confidential data lending on EVM.</p>
      {/* Pages légales : en liste blanche de la porte, lisibles avant l'ouverture. */}
      <LegalLinks className="mt-4" />
    </main>
  );
}
