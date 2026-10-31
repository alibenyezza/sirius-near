/**
 * Porte d'aperçu du passage mainnet.
 *
 * Pendant la mise en production, le public voit une page d'attente sur sirius-data.tech
 * pendant que l'équipe teste le vrai mainnet derrière. La porte est un interrupteur
 * d'environnement (`SIRIUS_PREVIEW_GATE=true`) posé sur le seul projet Vercel de
 * production : absent ou autre valeur, rien ne change. Une clé (`SIRIUS_PREVIEW_KEY`,
 * 32 caractères minimum) ouvre la porte à qui la présente une fois sur `/preview` ; le
 * navigateur reçoit alors un cookie dont la valeur est un HMAC dérivé de la clé, jamais la
 * clé elle-même.
 *
 * Fermée par défaut : interrupteur actif sans clé valide = site fermé à tous, y compris
 * l'équipe. Mieux vaut un site fermé qu'un site ouvert par une faute de frappe.
 *
 * Ce module ne dépend ni de Next ni de `node:crypto` : il s'exécute dans le proxy (runtime
 * Node ou Edge) comme sous `node --test`, avec la seule API Web Crypto.
 */

export const PREVIEW_GATE_FLAG = "SIRIUS_PREVIEW_GATE";
export const PREVIEW_KEY_VARIABLE = "SIRIUS_PREVIEW_KEY";
export const PREVIEW_KEY_MIN_LENGTH = 32;

export const PREVIEW_COOKIE = "sirius_preview";
export const PREVIEW_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Route qui pose le cookie : `GET /preview?key=…`. */
export const PREVIEW_PATH = "/preview";
/** Page d'attente vers laquelle toute page est réécrite tant que la porte est fermée. */
export const WAITING_PAGE = "/coming-soon";
/**
 * En-tête de requête posé par le proxy quand il sert la page d'attente : la mise en page
 * racine l'utilise pour ne monter ni portefeuille, ni blob WebGL, ni réhydratation de store.
 * Toujours réécrit par le proxy, jamais lu tel que le client l'a envoyé.
 */
export const PREVIEW_GATE_HEADER = "x-sirius-preview-gate";
export const PREVIEW_GATE_HEADER_CLOSED = "closed";

/** Réponse des routes API fermées : 503 avec ce corps, et rien d'autre. */
export const CLOSED_API_STATUS = 503;
export const CLOSED_API_BODY = { error: "Sirius ouvre bientôt" } as const;

/** Séparation de domaine du HMAC : changer ce contexte invalide tous les cookies posés. */
const COOKIE_CONTEXT = "sirius/preview-gate/cookie/v1";

/** Les deux variables lues, dans `process.env` ou un objet de test. */
export type PreviewGateEnvironment = { readonly [variable: string]: string | undefined };

export interface PreviewGateConfig {
  /** `SIRIUS_PREVIEW_GATE` vaut exactement `true`. */
  active: boolean;
  /** Clé configurée et assez longue, sinon `null` : la porte reste fermée à tous. */
  key: string | null;
}

export function readPreviewGateConfig(env: PreviewGateEnvironment = process.env): PreviewGateConfig {
  const active = env.SIRIUS_PREVIEW_GATE?.trim() === "true";
  const candidate = env.SIRIUS_PREVIEW_KEY?.trim() ?? "";
  const key = candidate.length >= PREVIEW_KEY_MIN_LENGTH ? candidate : null;
  return { active, key };
}

/**
 * Avertissement de démarrage, sans la clé : une porte active sans clé valide ferme le site
 * à tout le monde, ce que l'opérateur doit voir dans les logs plutôt que deviner.
 */
export function previewGateStartupNotice(env: PreviewGateEnvironment = process.env): string | null {
  const { active, key } = readPreviewGateConfig(env);
  if (!active) return null;
  if (!key) {
    return `[sirius] ${PREVIEW_GATE_FLAG}=true sans ${PREVIEW_KEY_VARIABLE} valide (${PREVIEW_KEY_MIN_LENGTH} caractères minimum) : le site est fermé à tous, /preview répond 404.`;
  }
  return `[sirius] ${PREVIEW_GATE_FLAG}=true : page d'attente servie au public, API fermées (sauf liste blanche), cookie ${PREVIEW_COOKIE} requis.`;
}

/**
 * Décision du proxy pour une requête :
 * - `open`   : porte inactive, ou cookie valide → comportement habituel ;
 * - `allow`  : porte active, sans cookie, ressource en liste blanche (route de la clé, test
 *              de fumée, chunks, fichiers statiques) → comportement habituel ;
 * - `public` : porte active, sans cookie, page en liste blanche (`/terms`, `/privacy`, `/legal`,
 *              `/coming-soon`) →
 *              servie à son adresse mais rendue nue, sans portefeuille (voir `PUBLIC_PAGES`) ;
 * - `wait`   : porte active, page → réécriture vers la page d'attente ;
 * - `closed` : porte active, route API → 503 JSON.
 */
export type PreviewGateDecision = "open" | "allow" | "public" | "wait" | "closed";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Liste blanche minimale. Chaque entrée répond à un appel extérieur inventorié ; tout ce qui
 * n'y figure pas est fermé.
 *
 * - `/api/auth/challenge` : le job « Fumée » du pipeline (`scripts/smoke-auth.mjs`) le
 *   POSTe sur la production après chaque déploiement et exige un 200 depuis les origines
 *   de la cible et un 403 depuis l'autre. La route ne fait qu'émettre un défi à signer :
 *   sans `/api/auth/verify`, fermé, il ne sert à rien. Le test de fumée reste donc vert avec
 *   la porte active, et personne ne se connecte pour autant.
 * - `/terms` : conditions de la bêta, publiques par engagement ; la page d'attente peut y
 *   renvoyer. Servie nue à qui n'a pas le cookie (`PUBLIC_PAGES`) : le public lit le texte,
 *   sans charger le connecteur de portefeuille ni le store du site.
 * - `/privacy` et `/legal` : politique de confidentialité et mentions légales, publiques au
 *   même titre que les conditions et liées depuis la page d'attente. Servies nues de la même
 *   façon (`PUBLIC_PAGES`).
 * - `/coming-soon` et `/preview` : la page d'attente elle-même et la route qui pose le
 *   cookie. Sans elles, la porte ne s'ouvre à personne.
 * - `/_next/*` : chunks, CSS, polices et optimiseur d'images de la page d'attente. Les
 *   payloads RSC des autres pages passent par les mêmes chemins de page, pas par `/_next/`,
 *   et sont réécrits comme elles.
 * - Fichiers statiques nommés un par un : les fichiers racine de `public/` et les icônes de
 *   métadonnées de `src/app` (`ROOT_FILES`), et les deux dossiers de `public/` réellement
 *   servis (`PUBLIC_DIRECTORIES` : avatars, exemples CSV déjà publics), à condition que le
 *   dernier segment porte une extension. Pas d'heuristique « dernier segment avec
 *   extension » : elle exemptait toute route dynamique et la page 404 pour peu qu'on
 *   ajoute `.png` à l'adresse (`/marketplace/x.png`, `/proof/x.y`, `/dashboard.html`), et le
 *   public voyait alors la coquille entière du site en cuisine. Ajouter un fichier à
 *   `public/` hors de ces dossiers = l'ajouter ici, sinon la porte le réécrit.
 *
 * N'y figurent pas, délibérément : le contrôleur et le moteur (`src/runner`, `src/worker`,
 * `scripts/operations`) n'appellent jamais l'application Next — ils lisent la base et la
 * chaîne, et c'est l'application qui appelle le runner. La surveillance du VPS
 * (`deploy/vps/check-reaper.sh`) inspecte Docker sur place, sans HTTP vers le site. Le
 * contrôleur de démo (`/api/phala-demo/drain`) vise l'adresse de démo, rattachée au projet
 * staging où la porte n'est pas posée. Le script de reprise `ops:verify-model-delivery`
 * passe par les routes de session : il attend la fin de la porte.
 */
export function isPreviewGateExempt(pathname: string): boolean {
  if (isApiPath(pathname)) return pathname === "/api/auth/challenge";
  if (isPublicPage(pathname)) return true;
  if (pathname === PREVIEW_PATH) return true;
  if (pathname.startsWith("/_next/")) return true;
  return isStaticFilePath(pathname);
}

/**
 * Pages en liste blanche servies à leur adresse, mais rendues nues (sans portefeuille, sans
 * store) à qui n'a pas le cookie : la page d'attente et les pages légales (conditions,
 * confidentialité, mentions légales). Le proxy pose alors l'en-tête `PREVIEW_GATE_HEADER`
 * comme pour une page réécrite. Avec le cookie, les pages légales redeviennent des pages
 * ordinaires du site ; `/coming-soon` reste nue dans tous les cas.
 */
export const PUBLIC_PAGES: ReadonlySet<string> = new Set([
  WAITING_PAGE,
  `${WAITING_PAGE}/`,
  "/terms",
  "/terms/",
  "/privacy",
  "/privacy/",
  "/legal",
  "/legal/",
]);

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.has(pathname);
}

/**
 * Fichiers racine servis tels quels : `public/*.svg` et les icônes de métadonnées de
 * `src/app` (favicon, icône, image d'aperçu de lien). Liste fermée, à tenir à jour avec
 * `public/` et `src/app`.
 */
export const ROOT_FILES: ReadonlySet<string> = new Set([
  "/favicon.ico",
  "/icon.png",
  "/apple-icon.png",
  "/opengraph-image.png",
  "/twitter-image.png",
  "/file.svg",
  "/globe.svg",
  "/next.svg",
  "/vercel.svg",
  "/window.svg",
]);

/** Dossiers de `public/` servis sous la porte, avec la barre finale. */
export const PUBLIC_DIRECTORIES: readonly string[] = ["/images/", "/examples/"];

/**
 * Un fichier sous un dossier de `public/` : chaque segment non vide et sans point initial,
 * le dernier avec une extension. Exclut `..`, `.`, les segments vides et les dossiers.
 */
const PUBLIC_FILE = /^(?:[^/.][^/]*\/)*[^/.]+\.[a-z0-9]+$/i;

/** Fichier statique nommé : fichier racine listé, ou fichier sous un dossier de `public/` servi. */
export function isStaticFilePath(pathname: string): boolean {
  if (ROOT_FILES.has(pathname)) return true;
  for (const directory of PUBLIC_DIRECTORIES) {
    if (pathname.startsWith(directory)) return PUBLIC_FILE.test(pathname.slice(directory.length));
  }
  return false;
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Égalité à temps constant sur des tampons de même longueur ; longueurs différentes = faux. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacSha256(key: string, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

/** Valeur du cookie : HMAC-SHA256 de la clé sur un contexte fixe, en hexadécimal. */
export async function previewCookieValue(key: string): Promise<string> {
  return toHex(await hmacSha256(key, COOKIE_CONTEXT));
}

/**
 * Comparaison à temps constant de deux chaînes, par leurs empreintes SHA-256 : la durée ne
 * dépend ni de la longueur du candidat ni du premier octet qui diffère.
 */
async function constantTimeStringEqual(expected: string, candidate: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  ]);
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}

/** Le cookie présenté est celui dérivé de la clé configurée. */
export async function previewCookieValid(key: string | null, candidate: string | null | undefined): Promise<boolean> {
  if (!key || typeof candidate !== "string" || candidate.length === 0) return false;
  return constantTimeStringEqual(await previewCookieValue(key), candidate);
}

/** La clé présentée sur `/preview` est la clé configurée. */
export async function previewKeyMatches(key: string | null, candidate: string | null | undefined): Promise<boolean> {
  if (!key || typeof candidate !== "string" || candidate.length === 0) return false;
  return constantTimeStringEqual(key, candidate);
}

export async function decidePreviewGate(
  config: PreviewGateConfig,
  pathname: string,
  cookie: string | null | undefined,
): Promise<PreviewGateDecision> {
  if (!config.active) return "open";
  // Le cookie d'abord : l'équipe voit aussi les pages publiques (`/terms`) avec le site complet.
  if (await previewCookieValid(config.key, cookie)) return "open";
  if (isPublicPage(pathname)) return "public";
  if (isPreviewGateExempt(pathname)) return "allow";
  return isApiPath(pathname) ? "closed" : "wait";
}
