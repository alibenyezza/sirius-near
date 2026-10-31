import { NextResponse, type NextRequest } from "next/server";
import { DEMO_PAGE, demoOnlyRoute, isDemoOnlyHost } from "@/lib/phala-demo/demo-host";
import {
  CLOSED_API_BODY,
  CLOSED_API_STATUS,
  PREVIEW_COOKIE,
  PREVIEW_GATE_HEADER,
  PREVIEW_GATE_HEADER_CLOSED,
  WAITING_PAGE,
  decidePreviewGate,
  readPreviewGateConfig,
} from "@/lib/preview-gate/gate";

/**
 * Origines du portefeuille embarqué, ajoutées seulement là où il est proposé.
 *
 * Le SDK appelle son API de configuration, le réseau de nœuds qui détiennent les parts de
 * clé, et un service de métadonnées. Ces appels partent du navigateur : sans eux dans
 * `connect-src`, notre propre politique les bloque et l'initialisation échoue sur un
 * « Failed to fetch » qui n'accuse personne.
 *
 * Le joker est scopé à un seul domaine, celui du fournisseur auquel on confie déjà la clé.
 * L'énumération nœud par nœud serait plus étroite d'un cheveu et casserait le jour où ils
 * en ajoutent un.
 *
 * L'authentification passe par des iframes servies depuis ce même domaine — `auth.` et
 * `wallet.` — d'où l'ouverture de `frame-src`. Sans elle le connecteur reste « not ready »
 * et la connexion attend indéfiniment, sans erreur.
 *
 * `cdn.segment.com` reste fermé délibérément : le SDK y envoie de la télémétrie, et un
 * produit bâti sur la confidentialité n'expédie pas les gestes de ses utilisateurs chez un
 * tiers. L'option `disableAnalytics` coupe l'appel à la source.
 *
 * Conditionné au Client ID : une instance qui ne propose pas la connexion sociale garde sa
 * politique d'origine, sans élargissement pour une fonctionnalité qu'elle n'expose pas.
 */
const ORIGINES_EMBARQUEES = process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID?.trim()
  ? " https://*.web3auth.io https://metadata.tor.us"
  : "";

function contentSecurityPolicy(nonce: string): string {
  const development = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-inline'${ORIGINES_EMBARQUEES ? " https://fonts.googleapis.com" : ""}`,
    `img-src 'self' data: blob:${ORIGINES_EMBARQUEES ? " https://*.web3auth.io https://images.toruswallet.io" : ""}`,
    `font-src 'self' data:${ORIGINES_EMBARQUEES ? " https://fonts.gstatic.com" : ""}`,
    `connect-src 'self' https://rpc.mainnet.chain.robinhood.com https://rpc.testnet.chain.robinhood.com https://robinhoodchain.blockscout.com https://explorer.testnet.chain.robinhood.com https://buy.moonpay.com https://buy-sandbox.moonpay.com${ORIGINES_EMBARQUEES}`,
    `frame-src ${ORIGINES_EMBARQUEES ? "https://*.web3auth.io" : "'none'"}`,
    "worker-src 'self' blob:",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(development ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/**
 * Préchargements de `next/link` : ils n'ont pas besoin du nonce, et le matcher les écartait
 * autrefois. Il ne le fait plus, parce que la porte d'aperçu doit les voir : un préchargement
 * est une requête de page comme une autre, et l'écarter aurait servi le payload RSC d'une page
 * fermée à qui ajoute l'en-tête à la main. Hors porte, ils passent inchangés, comme avant.
 */
function isPrefetch(request: NextRequest): boolean {
  return request.headers.has("next-router-prefetch") || request.headers.get("purpose") === "prefetch";
}

/** En-têtes transmis à l'application, avec l'en-tête de la porte toujours réécrit par nous. */
function forwardedHeaders(request: NextRequest, gateClosed: boolean): Headers {
  const headers = new Headers(request.headers);
  headers.delete(PREVIEW_GATE_HEADER);
  if (gateClosed) headers.set(PREVIEW_GATE_HEADER, PREVIEW_GATE_HEADER_CLOSED);
  return headers;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Adresse démo : seule la session de training Phala est servie (src/lib/phala-demo/demo-host.ts).
  //    Avant la porte d'aperçu, et indépendamment d'elle : l'adresse démo est rattachée au
  //    projet staging, où l'interrupteur n'est pas posé ; si les deux s'appliquaient au même
  //    projet, la restriction de l'adresse l'emporterait, puis la porte filtrerait ce qui reste.
  if (isDemoOnlyHost(request.headers.get("host"))) {
    const decision = demoOnlyRoute(pathname);
    if (decision === "block") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (decision === "redirect") return NextResponse.redirect(new URL(DEMO_PAGE, request.url));
  }

  // 2. Porte d'aperçu du passage mainnet (src/lib/preview-gate/gate.ts). Inactive, elle ne
  //    change rien ; active, elle ferme tout sauf la liste blanche à qui n'a pas le cookie.
  const gate = readPreviewGateConfig();
  // `gateClosed` : la page est rendue nue (sans portefeuille) ; `rewriteToWaiting` : elle est
  // en plus remplacée par la page d'attente. La page d'attente est toujours nue, porte active
  // ou non ; `/terms` l'est seulement pour qui n'a pas le cookie (décision `public`).
  let gateClosed = pathname === WAITING_PAGE || pathname === `${WAITING_PAGE}/`;
  let rewriteToWaiting = false;
  if (gate.active) {
    const decision = await decidePreviewGate(gate, pathname, request.cookies.get(PREVIEW_COOKIE)?.value);
    if (decision === "closed") {
      return NextResponse.json(CLOSED_API_BODY, {
        status: CLOSED_API_STATUS,
        headers: { "cache-control": "no-store", "retry-after": "3600" },
      });
    }
    if (decision === "wait") {
      gateClosed = true;
      rewriteToWaiting = true;
    }
    if (decision === "public") gateClosed = true;
  }

  // 3. Préchargements hors porte : inchangés, sans nonce (voir isPrefetch).
  if (!gateClosed && isPrefetch(request)) {
    return NextResponse.next({ request: { headers: forwardedHeaders(request, false) } });
  }

  // 4. Les routes API ne passent ici que pour les restrictions ci-dessus : ailleurs, inchangées.
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const headers = forwardedHeaders(request, gateClosed);
  headers.set("Content-Security-Policy", policy);
  headers.set("x-nonce", nonce);

  let response: NextResponse;
  if (rewriteToWaiting) {
    // Réécriture, pas redirection : l'adresse demandée reste dans la barre du navigateur et
    // le test de fumée du pipeline, qui attend un 200 sur la racine, le reçoit.
    const url = request.nextUrl.clone();
    url.pathname = WAITING_PAGE;
    url.search = "";
    response = NextResponse.rewrite(url, { request: { headers } });
  } else {
    response = NextResponse.next({ request: { headers } });
  }
  response.headers.set("Content-Security-Policy", policy);
  if (gateClosed) {
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-robots-tag", "noindex, nofollow");
  }
  return response;
}

export const config = {
  matcher: ["/api/:path*", "/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
