import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import type { Metadata } from "next";
import { loadCertificate } from "@/lib/certificate/load";
import { allowCertificatePage } from "@/lib/certificate/page-guard";
import { isCertificateLoanId, type CertificateResolution } from "@/lib/certificate/resolve";
import { verifyCertificate } from "@/lib/certificate/verification";
import { certificateViewProps } from "@/lib/certificate/display";
import { CertificateBusy, CertificateUnavailable, CertificateView } from "./certificate-view";

/**
 * Certificat d'exécution public d'un entraînement d'emprunt.
 *
 * Comme `/proof/[id]`, la page est hors du groupe `(app)` : sans session, sans JavaScript
 * nécessaire, rendue côté serveur, pour qu'un lien partagé s'ouvre tel quel. Tout le
 * contrôle d'accès est dans `resolveCertificate` : identifiant inconnu ou dataset fermé →
 * 404 indistinct ; prêt non réglé ou sans attestation cohérente → état « pas encore
 * disponible », sans aucun détail.
 *
 * Coût borné : débit plafonné avant toute lecture en base (`page-guard.ts`), vérification
 * de la quote mise en cache et plafonnée (`verification.ts`).
 */

export const runtime = "nodejs";

type Params = { params: Promise<{ loanId: string }> };
type PageState = CertificateResolution | { kind: "busy" };

/** Une seule lecture (et un seul jeton de débit) par requête, métadonnées comprises. */
const certificateFor = cache(async (loanId: string): Promise<PageState> => {
  // Hors format : 404 sans lecture en base ni jeton consommé.
  if (!isCertificateLoanId(loanId)) return { kind: "not-found" };
  if (!allowCertificatePage(await headers())) return { kind: "busy" };
  return loadCertificate(loanId);
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { loanId } = await params;
  const certificate = await certificateFor(loanId);
  // Un lien de certificat se partage ; il n'a pas à être indexé.
  const robots = { index: false, follow: false };
  if (certificate.kind === "not-found") return { title: "Certificate not found", robots };
  if (certificate.kind === "unavailable") return { title: "Certificate not available yet", robots };
  if (certificate.kind === "busy") return { title: "Execution certificate", robots };
  return {
    title: `${certificate.record.dataset.name} — execution certificate`,
    description:
      "Execution certificate of a training run on Sirius: enclave attestation, measurements and on-chain settlement. No account required.",
    robots,
  };
}

export default async function CertificatePage({ params }: Params) {
  const { loanId } = await params;
  const certificate = await certificateFor(loanId);
  if (certificate.kind === "not-found") notFound();
  if (certificate.kind === "busy") return <CertificateBusy />;
  if (certificate.kind === "unavailable") return <CertificateUnavailable />;

  // Une vérification plus lente que le rendu continue après la réponse et remplit le cache.
  const outcome = await verifyCertificate(certificate.record, (pending) => after(() => pending));
  return <CertificateView {...certificateViewProps(certificate.record, outcome)} />;
}
