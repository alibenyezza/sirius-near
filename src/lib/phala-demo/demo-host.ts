/**
 * Adresse publique réservée à la session de training Phala.
 *
 * `demo.sirius-data.tech` est attachée à un déploiement figé du projet staging : les
 * visiteurs n'y voient que `/phala`, pendant que staging continue d'évoluer à son adresse
 * habituelle. Toute autre page renvoie vers `/phala`, et toute route API dont la session
 * n'a pas besoin répond 404.
 */
export const DEMO_ONLY_HOSTS: readonly string[] = ["demo.sirius-data.tech"];

export const DEMO_PAGE = "/phala";

/** Routes API utilisées par la page de démo : session, connexion, entraînement, livraison du modèle. */
const DEMO_API_PREFIXES = ["/api/phala-demo", "/api/auth", "/api/train", "/api/datasets", "/api/models"] as const;

/**
 * Routes exactes du parcours d'un wallet neuf (audit A-14) : attestation KYB de démo, statut du
 * compte et jetons de test pour le gas du mint. Chemins exacts, pas les préfixes `/api/kyb` ou
 * `/api/account`, pour ne rien ouvrir d'autre.
 */
const DEMO_API_EXACT = ["/api/kyb/demo", "/api/account/status", "/api/faucet"] as const;

export type DemoRouteDecision = "allow" | "redirect" | "block";

export function isDemoOnlyHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return DEMO_ONLY_HOSTS.includes(name);
}

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function demoOnlyRoute(pathname: string): DemoRouteDecision {
  if (pathname.startsWith("/api/") || pathname === "/api") {
    if ((DEMO_API_EXACT as readonly string[]).includes(pathname)) return "allow";
    return DEMO_API_PREFIXES.some((prefix) => underPrefix(pathname, prefix)) ? "allow" : "block";
  }
  if (pathname === DEMO_PAGE || pathname === `${DEMO_PAGE}/`) return "allow";
  // Pages légales : la connexion renvoie aux conditions, le pied de page aux trois.
  if (pathname === "/terms" || pathname === "/privacy" || pathname === "/legal") return "allow";
  if (pathname.startsWith("/_next/")) return "allow";
  // Fichiers statiques de `public/` (exemples CSV, images, polices) : dernier segment avec extension.
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (/^[^.]+\.[a-z0-9]+$/i.test(last) && !pathname.includes("..")) return "allow";
  return "redirect";
}
