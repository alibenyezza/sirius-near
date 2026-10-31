import "server-only";
import { FixedWindowRateLimiter } from "@/lib/http/rate-limit";

/**
 * Débit de la page publique `/certificate/[loanId]`.
 *
 * Chaque affichage lit la ligne du prêt (quote et event-log compris) et recalcule l'empreinte
 * des pièces. La route API a son limiteur ; la page, rendue par Next, n'en avait aucun. Même
 * règle que `requestClientKey` : l'adresse client n'est lue que si l'ingress est de confiance
 * (`SIRIUS_TRUST_PROXY_HEADERS=true`), sinon seul le plafond global s'applique.
 */

export const certificatePageLimiter = new FixedWindowRateLimiter({
  windowMs: 60_000,
  maxPerKey: 60,
  maxGlobal: 1_200,
});

const CLIENT_ADDRESS = /^[A-Fa-f0-9:.]{3,64}$/;

/** Clé de débit, ou `null` (plafond global seul). Une adresse invalide partage une clé commune. */
export function certificateClientKey(headers: Pick<Headers, "get">, env: Record<string, string | undefined> = process.env): string | null {
  if (env.SIRIUS_TRUST_PROXY_HEADERS !== "true") return null;
  const value = headers.get("x-real-ip")?.trim();
  if (!value || !CLIENT_ADDRESS.test(value)) return "ip:invalide";
  return `ip:${value.toLowerCase()}`;
}

export function allowCertificatePage(
  headers: Pick<Headers, "get">,
  limiter: FixedWindowRateLimiter = certificatePageLimiter,
): boolean {
  return limiter.consume(certificateClientKey(headers));
}
