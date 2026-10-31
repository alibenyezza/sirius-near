import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Tests par inspection de source, comme pour les conditions : la page d'attente et le proxy
 * sont des modules Next, on vérifie leur texte et leur câblage plutôt que de les exécuter.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const page = read("./page.tsx").replace(/\s+/g, " ");
const proxy = read("../../proxy.ts");
const layout = read("../layout.tsx");
const route = read("../preview/route.ts");

test("page d'attente : texte annoncé, lien X, noindex", () => {
  assert.match(page, /Something&apos;s cooking/);
  assert.match(page, /👀/);
  assert.match(page, /Sirius is going live on Robinhood Chain mainnet very soon\./);
  assert.match(page, /https:\/\/x\.com\/\$\{X_HANDLE\}/);
  assert.match(page, /const X_HANDLE = "Sirius_data"/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(page, /robots: \{ index: false, follow: false/);
});

test("page d'attente : aucun script de portefeuille, aucun composant client", () => {
  assert.doesNotMatch(page, /"use client"/);
  assert.doesNotMatch(page, /wallet|Wallet|web3auth|viem|useLocale|LocaleProvider|ConnectButton/);
  // Le proxy signale la page à la mise en page racine, qui la rend sans ses fournisseurs.
  assert.match(layout, /PREVIEW_GATE_HEADER\) === PREVIEW_GATE_HEADER_CLOSED/);
  const bare = layout.slice(layout.indexOf("if (gateClosed)"), layout.indexOf("<LocaleProvider>"));
  assert.match(bare, /<body[^>]*>\{children\}<\/body>/);
  assert.doesNotMatch(bare, /WalletConnector|SharedBlob|StoreHydrator|E2eWalletBridge/);
});

test("proxy : l'adresse démo est tranchée avant la porte, la porte avant le passage des API", () => {
  const demo = proxy.indexOf("isDemoOnlyHost(request.headers.get(\"host\"))");
  const gate = proxy.indexOf("readPreviewGateConfig()");
  const api = proxy.indexOf('pathname.startsWith("/api/")) return NextResponse.next()');
  assert.ok(demo > 0 && gate > demo && api > gate, `ordre : démo ${demo} < porte ${gate} < API ${api}`);
  // L'en-tête de la porte est toujours réécrit, jamais relayé tel quel depuis le client.
  assert.match(proxy, /headers\.delete\(PREVIEW_GATE_HEADER\)/);
  // Les préchargements ne contournent plus le proxy : le matcher ne les exclut plus.
  assert.doesNotMatch(proxy, /next-router-prefetch"\s*\}/);
  assert.match(proxy, /matcher: \["\/api\/:path\*", "\/\(\(\?!api\|_next\/static\|_next\/image\|favicon\.ico\)\.\*\)"\]/);
  // Réécriture (pas redirection) vers la page d'attente, 503 JSON pour les API.
  assert.match(proxy, /if \(rewriteToWaiting\) \{[\s\S]{0,400}NextResponse\.rewrite\(url/);
  assert.match(proxy, /status: CLOSED_API_STATUS/);
  // Pages publiques (/terms sans cookie) : rendues nues, mais jamais réécrites.
  assert.match(proxy, /if \(decision === "wait"\) \{\s*gateClosed = true;\s*rewriteToWaiting = true;/);
  assert.match(proxy, /if \(decision === "public"\) gateClosed = true;/);
  assert.doesNotMatch(proxy, /decision === "public".*rewriteToWaiting/);
});

test("conditions : page serveur sans composant client, lisible sans les fournisseurs du site", () => {
  const terms = read("../terms/page.tsx");
  assert.doesNotMatch(terms, /"use client"/);
  // Le texte parle de portefeuille ; ce sont les imports et les hooks qui ne doivent pas y être.
  assert.doesNotMatch(terms, /from "@\/components\/wallet|web3auth|viem|useLocale|LocaleProvider|ConnectButton|useStore|useEffect|useState/);
});

test("route /preview : déléguée au module testé, jamais de journalisation", () => {
  assert.match(route, /handlePreviewRequest\(request\)/);
  const anyConsoleCall = /\bconsole\.\w+\(/;
  assert.doesNotMatch(route, anyConsoleCall);
  assert.doesNotMatch(read("../../lib/preview-gate/preview-route.ts"), anyConsoleCall);
  assert.doesNotMatch(read("../../lib/preview-gate/gate.ts"), anyConsoleCall);
});
