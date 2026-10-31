import type { KybGateState } from "@/lib/onboarding/steps";
import { GUIDE_PAGE_KEYS, isGuidePageKey, type GuidePageKey } from "./pages";

/**
 * Guide vivant « Sirio » : logique pure, sans React ni réseau.
 *
 * La phase affichée est déduite de l'état RÉEL du compte (wallet connecté, session signée, statut
 * KYB lu sur le registre), comme la carte « Get started » : rien n'avance parce qu'un bouton a
 * été cliqué, sauf les deux étapes purement narratives (accueil, tour du menu) et le choix de
 * passer, mémorisés dans la progression. Un utilisateur déjà vérifié saute naturellement les
 * phases faites ; un visiteur qui revient reprend là où il en était.
 *
 * Progression : `localStorage` avant la signature (clé anonyme), puis réglage `guide` du profil
 * une fois signé ; la note locale est fusionnée dans le profil à la première signature. Les
 * visites de page (`pages.ts`) y notent, page par page, celles déjà vues.
 */

/** Nom du personnage, en un seul endroit. */
export const GUIDE_NAME = "Sirio";

export const GUIDE_PHASES = ["arrival", "connect", "signin", "verify", "tour", "done"] as const;
export type GuidePhase = (typeof GUIDE_PHASES)[number];

/** Pages visitées par le tour du menu, dans l'ordre demandé ; `href` doit exister dans la barre latérale. */
export const GUIDE_TOUR_STOPS = [
  { key: "marketplace", href: "/marketplace" },
  { key: "train", href: "/train" },
  { key: "datasets", href: "/datasets" },
  { key: "explorer", href: "/explorer" },
  { key: "phala", href: "/phala" },
  { key: "dashboard", href: "/dashboard" },
] as const;
export type GuideTourStopKey = (typeof GUIDE_TOUR_STOPS)[number]["key"];

export const GUIDE_PROGRESS_VERSION = 1;

/** Ce qui est mémorisé : seulement les étapes narratives et le choix de l'utilisateur. */
export interface GuideProgress {
  v: typeof GUIDE_PROGRESS_VERSION;
  /** Bulle d'accueil lue (« C'est parti »). */
  arrivalSeen: boolean;
  /** Arrêt du tour du menu à reprendre (0 = premier). */
  tourIndex: number;
  /** Tour du menu terminé ou passé. */
  tourDone: boolean;
  /** « Passer » : le guide se range dans sa bulle et ne se rouvre pas tout seul. */
  skipped: boolean;
  /** Réduit dans la bulle (Échap, « Réduire ») sans avoir passé : la bulle le rouvre là où il en était. */
  minimized: boolean;
  /** Visites de page déjà vues : elles ne se rouvrent plus toutes seules (relance manuelle toujours possible). */
  pages: GuidePagesSeen;
}

/** Pages dont la visite a été vue (terminée ou passée) ; seules les clés connues sont gardées. */
export type GuidePagesSeen = Partial<Record<GuidePageKey, true>>;

export const EMPTY_GUIDE_PROGRESS: Readonly<GuideProgress> = Object.freeze({
  v: GUIDE_PROGRESS_VERSION,
  arrivalSeen: false,
  tourIndex: 0,
  tourDone: false,
  skipped: false,
  minimized: false,
  pages: Object.freeze({}),
});

export interface GuideInput {
  connected: boolean;
  authenticated: boolean;
  /** `null` : pas encore lu (le guide attend avant de parler de vérification). */
  kyb: KybGateState | null;
  progress: GuideProgress;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Pages vues lues d'une valeur quelconque : seules les clés connues, à `true`, sont gardées. */
export function parseGuidePagesSeen(value: unknown): GuidePagesSeen {
  const pages: GuidePagesSeen = {};
  if (!isPlainObject(value)) return pages;
  for (const key of GUIDE_PAGE_KEYS) {
    if (value[key] === true) pages[key] = true;
  }
  return pages;
}

/** Lit une progression (profil ou stockage local) ; toute forme inattendue donne la progression vide. */
export function parseGuideProgress(value: unknown): GuideProgress {
  if (!isPlainObject(value) || value.v !== GUIDE_PROGRESS_VERSION) return { ...EMPTY_GUIDE_PROGRESS };
  const index = typeof value.tourIndex === "number" && Number.isInteger(value.tourIndex) ? value.tourIndex : 0;
  return {
    v: GUIDE_PROGRESS_VERSION,
    arrivalSeen: value.arrivalSeen === true,
    tourIndex: Math.min(Math.max(index, 0), GUIDE_TOUR_STOPS.length - 1),
    tourDone: value.tourDone === true,
    skipped: value.skipped === true,
    minimized: value.minimized === true,
    pages: parseGuidePagesSeen(value.pages),
  };
}

/** Deux progressions du même utilisateur (note locale, profil) : la plus avancée l'emporte champ par champ. */
export function mergeGuideProgress(a: GuideProgress, b: GuideProgress): GuideProgress {
  return {
    v: GUIDE_PROGRESS_VERSION,
    arrivalSeen: a.arrivalSeen || b.arrivalSeen,
    tourIndex: Math.max(a.tourIndex, b.tourIndex),
    tourDone: a.tourDone || b.tourDone,
    skipped: a.skipped || b.skipped,
    minimized: a.minimized || b.minimized,
    pages: { ...a.pages, ...b.pages },
  };
}

export function isEmptyGuideProgress(progress: GuideProgress): boolean {
  return !progress.arrivalSeen && progress.tourIndex === 0 && !progress.tourDone && !progress.skipped && !progress.minimized
    && Object.keys(progress.pages).length === 0;
}

/** Le parcours d'accueil est rangé (terminé ou passé) : les visites de page peuvent se proposer. */
export function guideMainDone(progress: GuideProgress): boolean {
  return progress.skipped || progress.tourDone;
}

/** La visite de cette page peut s'ouvrir toute seule : accueil rangé et page jamais vue. */
export function shouldOfferPageTour(progress: GuideProgress, page: GuidePageKey | null): page is GuidePageKey {
  return page !== null && isGuidePageKey(page) && guideMainDone(progress) && progress.pages[page] !== true;
}

/**
 * Phase à afficher. `done` : le guide est rangé dans sa bulle flottante (rien n'est affiché
 * d'autre). Une relance manuelle remet la progression à zéro (`replay`) et repart de l'accueil.
 */
export function deriveGuidePhase(input: GuideInput): GuidePhase {
  const { progress } = input;
  if (progress.skipped || progress.tourDone) return "done";
  if (!progress.arrivalSeen) return "arrival";
  if (!input.connected) return "connect";
  if (!input.authenticated) return "signin";
  // Statut pas encore lu : on reste sur la vérification en mode « lecture », sans rien affirmer.
  if (input.kyb !== "valid") return "verify";
  if (!progress.tourDone) return "tour";
  return "done";
}

/** Prochaine progression après une action de l'utilisateur sur le guide. */
export type GuideAction =
  | { type: "arrival-continue" }
  | { type: "tour-next" }
  | { type: "tour-previous" }
  | { type: "tour-finish" }
  | { type: "skip" }
  | { type: "minimize" }
  | { type: "restore" }
  | { type: "replay" }
  | { type: "page-seen"; page: GuidePageKey };

/** Toute action sur le guide ouvert le sort de l'état réduit, sauf « réduire » elle-même. */
export function reduceGuideProgress(progress: GuideProgress, action: GuideAction): GuideProgress {
  const open = { ...progress, minimized: false };
  switch (action.type) {
    case "arrival-continue":
      return { ...open, arrivalSeen: true };
    case "tour-next":
      return progress.tourIndex >= GUIDE_TOUR_STOPS.length - 1
        ? { ...open, tourDone: true }
        : { ...open, tourIndex: progress.tourIndex + 1 };
    case "tour-previous":
      return { ...open, tourIndex: Math.max(0, progress.tourIndex - 1) };
    case "tour-finish":
      return { ...open, tourDone: true };
    case "skip":
      return { ...open, skipped: true };
    case "minimize":
      return { ...progress, minimized: true };
    case "restore":
      return open;
    case "replay":
      // Repart de l'accueil ; le choix de passer est effacé pour que la relance s'affiche. Les
      // visites de page déjà vues le restent : elles ne se rouvriront pas toutes en cascade.
      return { ...EMPTY_GUIDE_PROGRESS, pages: { ...progress.pages } };
    case "page-seen":
      // Visite de page terminée ou passée : ne touche pas à l'état réduit du parcours principal.
      return { ...progress, pages: { ...progress.pages, [action.page]: true } };
  }
}

/** Mode de la phase « vérification », selon ce qu'on sait du compte. */
export type GuideVerifyMode = "loading" | "instant" | "needs-gas" | "invitation" | "unknown";

export function guideVerifyMode(input: { kyb: KybGateState | null; instantAccess: boolean; gasWei: string | null }): GuideVerifyMode {
  if (input.kyb === null) return "loading";
  if (input.kyb === "unknown") return "unknown";
  if (!input.instantAccess) return "invitation";
  if (input.gasWei !== null && /^\d+$/.test(input.gasWei) && BigInt(input.gasWei) === BigInt(0)) return "needs-gas";
  return "instant";
}

/** Sélecteurs des éléments que le guide met en lumière (attributs posés dans l'interface). */
export const GUIDE_ANCHOR_ATTRIBUTE = "data-guide";
export function guideAnchorSelector(anchor: "sign-in" | "connect" | `nav:${string}` | `page:${GuidePageKey}:${string}`): string {
  return `[${GUIDE_ANCHOR_ATTRIBUTE}="${anchor}"]`;
}

const LOCAL_KEY = "sirius-guide:anonymous";
const MAX_LOCAL_CHARS = 512;

export type GuideStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Progression anonyme (avant signature) ; vide si absente, illisible ou stockage interdit. */
export function readLocalGuideProgress(storage: GuideStorage | null): GuideProgress {
  if (!storage) return { ...EMPTY_GUIDE_PROGRESS };
  try {
    const raw = storage.getItem(LOCAL_KEY);
    if (typeof raw !== "string" || raw.length > MAX_LOCAL_CHARS) return { ...EMPTY_GUIDE_PROGRESS };
    return parseGuideProgress(JSON.parse(raw));
  } catch {
    return { ...EMPTY_GUIDE_PROGRESS };
  }
}

/** Écrit la progression anonyme ; une progression vide est effacée. Sans effet si le stockage échoue. */
export function writeLocalGuideProgress(storage: GuideStorage | null, progress: GuideProgress): void {
  if (!storage) return;
  try {
    if (isEmptyGuideProgress(progress)) storage.removeItem(LOCAL_KEY);
    else storage.setItem(LOCAL_KEY, JSON.stringify(progress));
  } catch {
    // Stockage plein ou interdit : le guide repartira de zéro à la prochaine visite, rien d'autre.
  }
}

/** Progression lue dans la réponse de `/api/profile` (`settings.guide`), `null` si le profil n'est pas celui attendu. */
export function parseProfileGuideProgress(profile: unknown, expectedAddress: string): GuideProgress | null {
  if (!isPlainObject(profile)) return null;
  const address = profile.address;
  if (typeof address !== "string" || address.toLowerCase() !== expectedAddress.toLowerCase()) return null;
  if (!isPlainObject(profile.settings)) return null;
  return parseGuideProgress(profile.settings.guide);
}
