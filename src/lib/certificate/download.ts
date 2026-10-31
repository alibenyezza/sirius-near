import "server-only";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { certificateExport, isCertificateLoanId, type CertificateResolution } from "./resolve";

/**
 * Téléchargement public de l'attestation brute d'un certificat.
 *
 * Aucune vérification de quote ici : on sert les pièces telles qu'enregistrées, pour une
 * vérification indépendante. La route ne coûte donc qu'une lecture en base, bornée par
 * client et globalement. Tout ce qui n'est pas un certificat prêt — identifiant mal formé,
 * prêt inconnu, dataset fermé, prêt non réglé ou attestation incohérente — rend la même
 * 404, avec le même corps : la route ne dit pas lequel.
 */

export const certificateDownloadLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 20,
  maxGlobal: 240,
});

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export function certificateNotFound(): NextResponse {
  return noStore(NextResponse.json({ error: "Certificate not found" }, { status: 404 }));
}

export async function certificateDownloadResponse(
  req: Request,
  loanId: unknown,
  load: (loanId: string) => Promise<CertificateResolution>,
  limiter: FixedWindowRateLimiter = certificateDownloadLimiter,
): Promise<NextResponse> {
  try {
    enforceRateLimit(limiter, requestClientKey(req));
    if (!isCertificateLoanId(loanId)) return certificateNotFound();
    const certificate = await load(loanId);
    if (certificate.kind !== "ready") return certificateNotFound();
    const body = `${JSON.stringify(certificateExport(certificate.record), null, 2)}\n`;
    return noStore(
      new NextResponse(body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          // L'identifiant est déjà borné à [A-Za-z0-9_-] : rien à échapper dans l'en-tête.
          "content-disposition": `attachment; filename="sirius-certificate-${loanId}.json"`,
        },
      }),
    );
  } catch (error) {
    return noStore(errorResponse(error));
  }
}
