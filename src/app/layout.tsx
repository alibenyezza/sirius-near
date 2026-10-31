import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import SharedBlob from "@/components/layout/SharedBlob";
import { WalletConnector } from "@/components/wallet/WalletConnector";
import { StoreHydrator } from "@/components/layout/StoreHydrator";
import { E2eWalletBridge } from "@/components/testing/E2eWalletBridge";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { PREVIEW_GATE_HEADER, PREVIEW_GATE_HEADER_CLOSED } from "@/lib/preview-gate/gate";

/**
 * Rendu dynamique imposé à toute l'application.
 *
 * proxy.ts pose une politique de sécurité avec un nonce régénéré à chaque requête.
 * Une page prérendue au build ne peut pas la satisfaire : son HTML est figé, ses
 * scripts en ligne ne portent aucun nonce, et chaque réponse en exige un nouveau.
 * Le navigateur rejette alors tout le JavaScript et l'application ne s'hydrate jamais.
 *
 * On perd la mise en cache du HTML au profit d'une politique de sécurité qui tient
 * réellement. L'inverse — assouplir la politique pour garder le cache — reviendrait à
 * autoriser les scripts en ligne, c'est-à-dire à retirer la protection contre
 * l'injection que cette politique existe pour fournir.
 */
export const dynamic = "force-dynamic";

// Les métadonnées restent en anglais dès le rendu serveur, y compris les aperçus de lien.
const ORIGINE_PAR_DEFAUT = "https://sirius-data.tech";

/**
 * Origine publique du site, pour les aperçus de lien.
 *
 * Elle doit tolérer une valeur illisible. `vercel pull` remplace le contenu des
 * variables marquées « Secret » par la chaîne « [SENSITIVE] » : au moment du build,
 * cette variable ne contient alors pas une URL. Une métadonnée d'aperçu est
 * cosmétique — la laisser interrompre la construction de tout le site serait hors
 * de proportion, et à l'exécution la vraie valeur est bien injectée.
 */
function origineDuSite(): string {
  const configuree = process.env.SIRIUS_APP_ORIGIN?.trim();
  if (!configuree) return ORIGINE_PAR_DEFAUT;
  try {
    return new URL(configuree).origin;
  } catch {
    return ORIGINE_PAR_DEFAUT;
  }
}

const ORIGINE = origineDuSite();
const TITRE = "Sirius — confidential data lending on EVM";
const DESCRIPTION =
  "Lend valuable datasets without ever exposing them. Training inside a TEE, stablecoin settlement, and an audit trail on EVM.";

export const metadata: Metadata = {
  // Sans base, Next rend les URL d'images en relatif — et un réseau social qui lit
  // la page depuis ses propres serveurs ne sait alors pas les résoudre. L'aperçu
  // arrive vide, ce qui est pire qu'une absence d'aperçu : le lien paraît cassé.
  metadataBase: new URL(ORIGINE),
  title: TITRE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Sirius",
    url: ORIGINE,
    title: TITRE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITRE,
    description: DESCRIPTION,
  },
  // Preuve de propriété du domaine demandée par Virtuals Protocol avant de rattacher
  // le site à la page d'agent. Le jeton n'ouvre aucun accès et ne révèle rien : il
  // atteste seulement qu'on peut modifier le contenu servi sur cette origine.
  //
  // Passe par le champ `verification` plutôt qu'une balise écrite à la main : Next
  // rend alors la balise dans le <head> de chaque page, y compris celles ajoutées
  // plus tard, sans que personne ait à y penser.
  verification: {
    other: {
      "virtual-protocol-site-verification": "ccdcd5a78bc4867c2b4b0a4313b6a8e2",
    },
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Page d'attente du passage mainnet (src/lib/preview-gate/gate.ts) : le proxy pose cet
  // en-tête — et l'efface s'il vient du client — quand il sert /coming-soon, ou /terms à qui
  // n'a pas le cookie d'aperçu. La page est alors rendue nue : ni connecteur de portefeuille,
  // ni blob WebGL, ni réhydratation de store, ni titre réécrit côté client. Le public n'a rien
  // à charger de plus qu'une phrase et un lien.
  const gateClosed = (await headers()).get(PREVIEW_GATE_HEADER) === PREVIEW_GATE_HEADER_CLOSED;
  if (gateClosed) {
    return (
      <html lang="en" className="h-full antialiased">
        <body className="min-h-full flex flex-col">{children}</body>
      </html>
    );
  }

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <LocaleProvider>
          <SharedBlob />
          <WalletConnector />
          <E2eWalletBridge />
          <StoreHydrator />
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
