/**
 * État KYB affiché sur la page /kyb. La source de vérité reste le contrat
 * (`SiriusKybRegistry`) : cette logique ne fait que traduire sa réponse en état d'affichage.
 */

export type KybView =
  | { state: "verified"; expiresAt: number | null }
  | { state: "expired"; expiresAt: number }
  | { state: "revoked" }
  /** Attestation non expirée ni révoquée mais refusée par le contrat (ex. vérificateur retiré). */
  | { state: "inactive" }
  | { state: "none" }
  /** Lecture impossible : on ne prétend ni « vérifié » ni « non vérifié ». */
  | { state: "unknown" };

/** Réponse de `GET /api/kyb/status` (session requise). */
export interface KybStatusResponse {
  valid: boolean;
  /** Expiration de l'attestation en secondes Unix ; `null` sans attestation. */
  expiresAt: number | null;
  revoked: boolean;
  /** L'instance propose l'accès instantané (drapeau serveur) ; absent sur les anciennes réponses. */
  instantAccess?: boolean;
}

/** L'accès instantané n'est proposé que si le serveur le dit explicitement. */
export function parseInstantAccess(body: unknown): boolean {
  return Boolean(body) && typeof body === "object" && (body as { instantAccess?: unknown }).instantAccess === true;
}

/** Jours avant l'expiration pendant lesquels l'accès instantané renouvelle une attestation valide. */
export const INSTANT_ACCESS_RENEWAL_DAYS = 7;

/** Attestation valide mais proche du terme : le renouvellement instantané a un sens. */
export function offersRenewal(view: KybView, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  return view.state === "verified" && view.expiresAt !== null && view.expiresAt - nowSeconds <= INSTANT_ACCESS_RENEWAL_DAYS * 86_400;
}

/** Lit la réponse du serveur sans lui faire confiance : tout ce qui est mal formé est « inconnu ». */
export function parseKybStatus(body: unknown, nowSeconds: number = Math.floor(Date.now() / 1000)): KybView {
  if (!body || typeof body !== "object") return { state: "unknown" };
  const { valid, expiresAt, revoked } = body as Record<string, unknown>;
  if (typeof valid !== "boolean" || typeof revoked !== "boolean") return { state: "unknown" };
  if (expiresAt !== null && !(typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt >= 0)) {
    return { state: "unknown" };
  }
  const expiry = typeof expiresAt === "number" && expiresAt > 0 ? expiresAt : null;
  if (valid) return revoked ? { state: "unknown" } : { state: "verified", expiresAt: expiry };
  if (revoked) return { state: "revoked" };
  if (expiry !== null) return expiry <= nowSeconds ? { state: "expired", expiresAt: expiry } : { state: "inactive" };
  return { state: "none" };
}

/** Repli sans session : `/api/account/status` ne donne que « attesté ou non », sans date. */
export function parsePublicKybStatus(body: unknown): KybView {
  if (!body || typeof body !== "object") return { state: "unknown" };
  const { known } = body as { known?: unknown };
  if (known === true) return { state: "verified", expiresAt: null };
  if (known === false) return { state: "none" };
  return { state: "unknown" };
}

/** Le formulaire d'invitation n'a de sens que si le wallet n'est pas (ou plus) valide. */
export function showsInvitationForm(view: KybView): boolean {
  return view.state === "none" || view.state === "expired" || view.state === "revoked" || view.state === "inactive";
}

/** Date lisible, en UTC pour ne pas dépendre du fuseau de l'appareil ; `null` si hors bornes. */
export function formatKybDate(expiresAtSeconds: number, locale = "en-US"): string | null {
  const date = new Date(expiresAtSeconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
