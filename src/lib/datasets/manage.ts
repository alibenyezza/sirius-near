/**
 * Gestion d'un dataset par son fournisseur (slice N1 « Mes datasets ») : état affiché,
 * règles de transition (pause, remise en ligne, prolongation, retrait du consentement),
 * validation des réglages et statistiques d'emprunt.
 *
 * Le module ne dépend ni de `server-only` ni du client Prisma à l'exécution : la mosaïque
 * (navigateur) et les routes (serveur) partagent exactement les mêmes règles. Les fonctions
 * qui écrivent reçoivent leur client de base en paramètre ; les routes passent `prisma`.
 *
 * Toute écriture est conditionnelle (`updateMany` avec l'état attendu dans le `where`) :
 * la vérification faite en lecture est rejouée par la base au moment d'écrire, donc deux
 * requêtes concurrentes ne peuvent pas produire une transition que les règles refusent.
 */
import { AppError } from "@/lib/app-error";
import { addressesEqual, normalizeAddress, tryNormalizeAddress } from "@/lib/evm/address";
import { publicDatasetMetrics } from "@/lib/sirius/metrics";
import type { StatusKind } from "@/components/ui/status";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

export const DATASET_STATUSES = ["DRAFT", "LISTING", "LISTED", "UNLISTED", "PRIVATE", "SUSPENDED", "DELETED"] as const;
export type DatasetStatusValue = (typeof DATASET_STATUSES)[number];

export const LOAN_STATUSES = ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "SETTLED", "CANCELLED"] as const;
export type LoanStatusValue = (typeof LOAN_STATUSES)[number];

/**
 * Prêts dont le blocage USDC est confirmé et pas encore résolu : « emprunt en cours ».
 * SUBMITTING en est exclu : la transaction de blocage peut encore échouer et le prêt
 * revenir à PENDING (`borrower.ts`), ce n'est pas encore un emprunt.
 */
export const IN_FLIGHT_LOAN_STATUSES: readonly LoanStatusValue[] = ["ESCROWED", "TRAINING", "SETTLING"];

/** Durées de prolongation proposées par la fiche (07-upload.md : 7, 30 ou 90 jours). */
export const LISTING_EXTENSION_DAYS = [7, 30, 90] as const;
export type ListingExtensionDays = (typeof LISTING_EXTENSION_DAYS)[number];

/** Une annonce ne peut pas être prolongée au-delà de cet horizon, compté depuis maintenant. */
export const MAX_LISTING_HORIZON_DAYS = 365;

/** Mêmes bornes que la création (`POST /api/datasets`). */
export const MAX_DATASET_NAME_LENGTH = 120;
export const MAX_DATASET_DESCRIPTION_LENGTH = 2_000;

/** Nombre de semaines glissantes renvoyées par les statistiques. */
export const STATS_WEEKS = 8;

/** Plafond de prêts lus pour les statistiques d'un dataset ; au-delà, `truncated` est vrai. */
export const MAX_STATS_LOANS = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Identifiant de dataset tel qu'émis par Prisma (cuid) ; tout le reste est refusé en 404. */
const DATASET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Montant atomique : entier décimal positif ou nul, sans signe ni exposant. */
const ATOMIC_RE = /^(0|[1-9][0-9]{0,77})$/;

// Caractères refusés dans le nom et la description : contrôles C0 (hors tabulation et sauts
// de ligne pour la description), DEL, C1 ; marques et contrôles bidirectionnels (U+061C,
// U+200E-F, U+202A-E, U+2066-9) qui affichent un texte différent de celui stocké ;
// caractères invisibles ou de format (U+200B, U+2028-9, U+2060-4, U+206A-F, U+FEFF,
// U+FFF9-B, remplissages hangul, étiquettes U+E0000-E007F). U+200C et U+200D (ZWNJ, ZWJ)
// restent admis : le persan, les langues indiennes et les emojis composés en ont besoin.
// Sont aussi refusés U+034F et U+17B4-5 (invisibles). Le nom refuse en plus U+00AD, U+180E
// et U+2800 (invisibles dans un titre court), que la description admet (césure allemande,
// mongol, braille).
const INVISIBLE_CHARS = "\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u200B\\u200E\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\u3164\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}";
const FORBIDDEN_DESCRIPTION_CHARS = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F${INVISIBLE_CHARS}]`, "u");
const FORBIDDEN_NAME_CHARS = new RegExp(`[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u180E\\u2800${INVISIBLE_CHARS}]`, "u");
/** Demi-paire de substitution UTF-16 isolée : chaîne mal formée. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Un nom doit contenir au moins une lettre ou un chiffre visible. */
const VISIBLE_NAME = /[\p{L}\p{N}]/u;

// ---------------------------------------------------------------------------
// Dates

function toTime(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Date UTC « AAAA-MM-JJ », identique au serveur et au navigateur ; « — » si illisible. */
export function formatUtcDate(value: Date | string | null | undefined): string {
  const time = toTime(value);
  return time === null ? "—" : new Date(time).toISOString().slice(0, 10);
}

/** Date et heure UTC « AAAA-MM-JJ HH:MM UTC » ; « — » si illisible. */
export function formatUtcDateTime(value: Date | string | null | undefined): string {
  const time = toTime(value);
  if (time === null) return "—";
  const text = new Date(time).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

/**
 * Annonce expirée : date d'expiration posée et atteinte. Une date absente (dataset publié
 * avant le champ) n'expire jamais ; une date illisible est traitée comme expirée, pour ne
 * jamais présenter comme en ligne une annonce dont on ne sait pas lire la fin.
 */
export function isListingExpired(listingExpiresAt: Date | string | null | undefined, now: number = Date.now()): boolean {
  if (listingExpiresAt === null || listingExpiresAt === undefined) return false;
  const time = toTime(listingExpiresAt);
  return time === null || time <= now;
}

// ---------------------------------------------------------------------------
// État affiché

export interface DisplayStatusInput {
  status: string;
  listingExpiresAt?: Date | string | null;
  /** Prêts en cours (voir `IN_FLIGHT_LOAN_STATUSES`). Inconnu : `null`. */
  inFlightLoans?: number | null;
}

/**
 * État de la pastille d'un dataset de Mes datasets.
 *
 * - DELETED → détruit ; SUSPENDED (archivé par Sirius) → échoué ; DRAFT et LISTING → en attente ;
 * - LISTED, UNLISTED ou PRIVATE avec un emprunt en cours → emprunté (l'information la plus
 *   urgente pour le fournisseur ; la fiche précise si l'annonce est par ailleurs en pause) ;
 * - UNLISTED et PRIVATE → en pause (hors marketplace) ;
 * - LISTED dont l'annonce a expiré → expiré ; sinon → en ligne.
 *
 * Un statut inconnu retombe sur « en attente » plutôt que sur « en ligne ».
 */
export function displayStatus(input: DisplayStatusInput, now: number = Date.now()): StatusKind {
  switch (input.status) {
    case "DELETED":
      return "destroyed";
    case "SUSPENDED":
      return "failed";
    case "LISTED":
    case "UNLISTED":
    case "PRIVATE": {
      if (typeof input.inFlightLoans === "number" && input.inFlightLoans > 0) return "borrowed";
      if (input.status !== "LISTED") return "paused";
      return isListingExpired(input.listingExpiresAt, now) ? "expired" : "online";
    }
    default:
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Transitions

export type ListingAction = "pause" | "resume" | "extend";

export interface ListingState {
  status: string;
  listingExpiresAt: Date | null;
  evmDatasetId?: string | null;
}

export interface TransitionOptions {
  /**
   * Déploiement de démonstration Phala : les datasets y sont créés PRIVATE (`provider.ts`,
   * `markDatasetListed`) et rien n'y repasse en ligne. Hors démo, tout dataset doté d'un titre
   * EVM a été publié LISTED à sa création : un PRIVATE ou UNLISTED titré a donc déjà été public
   * (`listedAt` ne le dit pas pour les datasets antérieurs à la migration du 27 septembre).
   */
  demoMode?: boolean;
}

export interface VisibilityTransition {
  from: readonly DatasetStatusValue[];
  to: "LISTED" | "UNLISTED";
}

/**
 * Pause : LISTED → UNLISTED uniquement. Remise en ligne : UNLISTED ou PRIVATE → LISTED, hors
 * déploiement de démo, si le titre EVM existe et si l'annonce n'est pas expirée. DRAFT,
 * LISTING, SUSPENDED et DELETED n'ont aucune transition ici : un dataset détruit, suspendu ou
 * en cours de publication ne peut pas être remis en ligne depuis la fiche.
 */
export function visibilityTransition(
  action: "pause" | "resume",
  state: ListingState,
  now: number = Date.now(),
  options: TransitionOptions = {},
): VisibilityTransition {
  if (action === "pause") {
    if (state.status !== "LISTED") throw new AppError("Seul un dataset en ligne peut être mis en pause", 409);
    return { from: ["LISTED"], to: "UNLISTED" };
  }
  if (state.status !== "UNLISTED" && state.status !== "PRIVATE") {
    throw new AppError("Remise en ligne impossible pour ce dataset", 409);
  }
  if (!state.evmDatasetId) throw new AppError("Remise en ligne impossible pour ce dataset", 409);
  // En démo Phala, rien ne repasse en ligne.
  if (options.demoMode) {
    throw new AppError("Remise en ligne impossible pour ce dataset", 409);
  }
  if (isListingExpired(state.listingExpiresAt, now)) {
    throw new AppError("Annonce expirée : prolonge-la avant de la remettre en ligne", 409);
  }
  return { from: [state.status as DatasetStatusValue], to: "LISTED" };
}

/**
 * Statuts dont l'annonce peut être prolongée : en ligne, en pause, ou privé (sinon un
 * dataset privé dont l'annonce a expiré ne pourrait plus jamais être remis en ligne).
 */
export const EXTENSIBLE_STATUSES: readonly DatasetStatusValue[] = ["LISTED", "UNLISTED", "PRIVATE"];

export function parseExtensionDays(value: unknown): ListingExtensionDays {
  if (typeof value !== "number" || !(LISTING_EXTENSION_DAYS as readonly number[]).includes(value)) {
    throw new AppError("Durée de prolongation invalide (7, 30 ou 90 jours)", 400);
  }
  return value as ListingExtensionDays;
}

/**
 * Nouvelle date d'expiration : la durée s'ajoute à la date actuelle si elle est future,
 * à maintenant sinon (une annonce expirée repart d'aujourd'hui). Une annonce sans date
 * (publiée avant le champ) n'expire pas : la prolonger lui imposerait une fin, c'est refusé.
 */
export function extendedListingExpiry(state: ListingState, days: ListingExtensionDays, now: number = Date.now()): Date {
  if (!(EXTENSIBLE_STATUSES as readonly string[]).includes(state.status)) {
    throw new AppError("Prolongation impossible pour ce dataset", 409);
  }
  if (state.listingExpiresAt === null) throw new AppError("Cette annonce n'a pas de date d'expiration", 409);
  const current = toTime(state.listingExpiresAt);
  const base = current !== null && current > now ? current : now;
  const next = base + days * DAY_MS;
  if (next > now + MAX_LISTING_HORIZON_DAYS * DAY_MS) {
    throw new AppError("Prolongation limitée à 365 jours à l'avance", 409);
  }
  return new Date(next);
}

/**
 * Contrôle d'un changement de visibilité par la route existante `PATCH /api/datasets/[id]`
 * (sélecteur Public / Semi-privé / Privé) avec les mêmes règles que la fiche :
 * - vers LISTED : celles de la remise en ligne (`visibilityTransition`), sauf LISTED → LISTED,
 *   laissé tel quel (rafraîchit `listedAt`, comme avant la slice) ;
 * - PRIVATE → UNLISTED : refusé en démo (le dataset deviendrait empruntable par lien direct,
 *   puis public en deux appels) et sans titre EVM.
 * Les autres passages (vers PRIVATE, LISTED → UNLISTED) restent régis par `setDatasetVisibility`.
 */
export function assertVisibilityChange(target: string, state: ListingState, now: number = Date.now(), options: TransitionOptions = {}): void {
  if (target === "LISTED" && state.status !== "LISTED") {
    visibilityTransition("resume", state, now, options);
  }
  if (target === "UNLISTED" && state.status === "PRIVATE" && (options.demoMode || !state.evmDatasetId)) {
    throw new AppError("Visibilité impossible pour ce dataset", 409);
  }
}

/**
 * Prolonger une annonce LISTED déjà expirée la remet de fait sur la marketplace : la route
 * exige alors le même grant que la remise en ligne (`set-dataset-visibility`, cible LISTED).
 */
export function extensionRelists(state: ListingState, now: number = Date.now()): boolean {
  return state.status === "LISTED" && isListingExpired(state.listingExpiresAt, now);
}

/** Corps de `POST /api/datasets/[id]/settings/listing`, validé strictement. */
export type ListingRequest =
  | { action: "pause" | "resume"; authorization: unknown }
  | { action: "extend"; days: ListingExtensionDays; authorization?: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new AppError("Champ de réglage inconnu", 400);
  }
}

export function parseListingRequest(input: unknown): ListingRequest {
  if (!isPlainObject(input)) throw new AppError("JSON invalide", 400);
  const action = input.action;
  if (action === "pause" || action === "resume") {
    assertOnlyKeys(input, ["action", "authorization"]);
    if (!isPlainObject(input.authorization)) throw new AppError("Confirmation wallet requise", 400);
    return { action, authorization: input.authorization };
  }
  if (action === "extend") {
    assertOnlyKeys(input, ["action", "days", "authorization"]);
    const days = parseExtensionDays(input.days);
    if (!Object.hasOwn(input, "authorization")) return { action, days };
    if (!isPlainObject(input.authorization)) throw new AppError("Confirmation wallet requise", 400);
    return { action, days, authorization: input.authorization };
  }
  throw new AppError("Action de publication inconnue", 400);
}

/** Corps de `POST /api/datasets/[id]/settings/consent` : seul le retrait existe. */
export function parseConsentRequest(input: unknown): { action: "revoke" } {
  if (!isPlainObject(input)) throw new AppError("JSON invalide", 400);
  assertOnlyKeys(input, ["action"]);
  if (input.action !== "revoke") throw new AppError("Action de consentement inconnue", 400);
  return { action: "revoke" };
}

// ---------------------------------------------------------------------------
// Nom et description

export interface DetailsPatch {
  name?: string;
  description?: string | null;
}

/** Statuts dont le nom et la description restent modifiables. */
export const EDITABLE_STATUSES: readonly DatasetStatusValue[] = ["DRAFT", "LISTING", "LISTED", "UNLISTED", "PRIVATE"];

/**
 * Validation stricte de `PATCH /api/datasets/[id]/settings`. Clés admises : `name`,
 * `description`. Le prix a son propre refus explicite : il est inscrit dans le reçu signé
 * par l'enclave au scellement et ne peut pas changer sans re-sceller le dataset.
 */
export function validateDetailsPatch(input: unknown): DetailsPatch {
  if (!isPlainObject(input)) throw new AppError("JSON invalide", 400);
  const patch: DetailsPatch = {};
  for (const key of Object.keys(input)) {
    if (key === "priceUsdcAtomic" || key === "priceUsdc" || key === "price") {
      throw new AppError("Le prix n'est pas modifiable : il est inscrit dans le reçu signé par l'enclave", 400);
    }
    if (key !== "name" && key !== "description") throw new AppError("Champ de dataset non modifiable", 400);
  }
  if (Object.hasOwn(input, "name")) {
    const name = input.name;
    if (typeof name !== "string") throw new AppError("Nom manquant", 400);
    if (LONE_SURROGATE.test(name)) throw new AppError("Nom invalide : caractères invisibles ou de contrôle interdits", 400);
    const trimmed = name.normalize("NFC").trim();
    if (trimmed === "") throw new AppError("Nom manquant", 400);
    if (trimmed.length > MAX_DATASET_NAME_LENGTH) throw new AppError("Nom trop long (120 caractères maximum)", 400);
    if (FORBIDDEN_NAME_CHARS.test(trimmed)) throw new AppError("Nom invalide : caractères invisibles ou de contrôle interdits", 400);
    if (!VISIBLE_NAME.test(trimmed)) throw new AppError("Nom invalide : au moins une lettre ou un chiffre", 400);
    patch.name = trimmed;
  }
  if (Object.hasOwn(input, "description")) {
    const description = input.description;
    if (description === null) {
      patch.description = null;
    } else {
      if (typeof description !== "string") throw new AppError("Description invalide", 400);
      if (LONE_SURROGATE.test(description)) throw new AppError("Description invalide : caractères invisibles ou de contrôle interdits", 400);
      const trimmed = description.normalize("NFC").trim();
      if (trimmed.length > MAX_DATASET_DESCRIPTION_LENGTH) {
        throw new AppError("Description trop longue (2 000 caractères maximum)", 400);
      }
      if (FORBIDDEN_DESCRIPTION_CHARS.test(trimmed)) {
        throw new AppError("Description invalide : caractères invisibles ou de contrôle interdits", 400);
      }
      patch.description = trimmed === "" ? null : trimmed;
    }
  }
  if (!Object.hasOwn(patch, "name") && !Object.hasOwn(patch, "description")) {
    throw new AppError("Aucune modification de dataset", 400);
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Statistiques

export interface LoanForStats {
  status: string;
  createdAt: Date | string;
  amountUsdcAtomic: string;
  datasetAmountUsdcAtomic?: string | null;
  cancelTxHash?: string | null;
}

export interface WeeklyBorrows {
  /** Début de la fenêtre (inclus), ISO 8601. */
  start: string;
  /** Fin de la fenêtre (exclue), ISO 8601. */
  end: string;
  count: number;
}

export interface LoanStats {
  /** Emprunts dont l'USDC a été bloqué : en cours, réglés, ou remboursés après blocage. */
  borrowCount: number;
  /** Emprunts en cours (`IN_FLIGHT_LOAN_STATUSES`). */
  inFlightCount: number;
  /** Entraînements livrés et payés (prêts SETTLED). */
  trainingsSucceeded: number;
  /** Prêts remboursés après blocage : entraînement échoué ou délai dépassé. */
  trainingsRefunded: number;
  /** Part du fournisseur sur les prêts réglés, en unités atomiques. */
  earnedAtomic: string;
  /** Part du fournisseur bloquée dans l'escrow, pas encore gagnée. */
  inEscrowAtomic: string;
  /** Prêts dont le montant n'a pas pu être lu ; exclus des sommes. */
  unreadableAmounts: number;
  /** Date du dernier emprunt compté, ISO 8601, ou `null`. */
  lastBorrowAt: string | null;
  /** `STATS_WEEKS` semaines glissantes, la plus ancienne en premier. */
  weekly: WeeklyBorrows[];
}

/**
 * Un prêt compte comme emprunt dès que l'USDC est parti du wallet de l'emprunteur :
 * en cours, réglé, ou annulé avec une transaction de remboursement confirmée (le blocage a
 * donc eu lieu). Une réservation PENDING, ou annulée sans remboursement, n'est pas un emprunt.
 */
export function isCountedBorrow(loan: Pick<LoanForStats, "status" | "cancelTxHash">): boolean {
  if ((IN_FLIGHT_LOAN_STATUSES as readonly string[]).includes(loan.status)) return true;
  if (loan.status === "SETTLED") return true;
  return loan.status === "CANCELLED" && typeof loan.cancelTxHash === "string" && loan.cancelTxHash !== "";
}

/**
 * Part du fournisseur : `datasetAmountUsdcAtomic` pour un prêt v7 (le calcul va à
 * l'enclave), sinon le montant total (prêts antérieurs au devis, sans frais de calcul).
 */
export function providerShareAtomic(loan: Pick<LoanForStats, "amountUsdcAtomic" | "datasetAmountUsdcAtomic">): bigint | null {
  const raw = loan.datasetAmountUsdcAtomic ?? loan.amountUsdcAtomic;
  return typeof raw === "string" && ATOMIC_RE.test(raw) ? BigInt(raw) : null;
}

export function aggregateLoanStats(loans: readonly LoanForStats[], now: number = Date.now()): LoanStats {
  let borrowCount = 0;
  let inFlightCount = 0;
  let trainingsSucceeded = 0;
  let trainingsRefunded = 0;
  let earned = BigInt(0);
  let inEscrow = BigInt(0);
  let unreadableAmounts = 0;
  let last: number | null = null;
  const weekly: WeeklyBorrows[] = [];
  for (let index = STATS_WEEKS - 1; index >= 0; index--) {
    const end = now - index * WEEK_MS;
    weekly.push({ start: new Date(end - WEEK_MS).toISOString(), end: new Date(end).toISOString(), count: 0 });
  }
  const windowStart = now - STATS_WEEKS * WEEK_MS;

  for (const loan of loans) {
    if (!isCountedBorrow(loan)) continue;
    borrowCount += 1;
    const created = toTime(loan.createdAt);
    if (created !== null) {
      if (last === null || created > last) last = created;
      if (created >= windowStart && created < now) {
        const slot = STATS_WEEKS - 1 - Math.floor((now - 1 - created) / WEEK_MS);
        if (slot >= 0 && slot < STATS_WEEKS) weekly[slot].count += 1;
      }
    }
    const inFlight = (IN_FLIGHT_LOAN_STATUSES as readonly string[]).includes(loan.status);
    if (inFlight) inFlightCount += 1;
    if (loan.status === "SETTLED") trainingsSucceeded += 1;
    if (loan.status === "CANCELLED") trainingsRefunded += 1;
    if (loan.status === "SETTLED" || inFlight) {
      const share = providerShareAtomic(loan);
      if (share === null) unreadableAmounts += 1;
      else if (loan.status === "SETTLED") earned += share;
      else inEscrow += share;
    }
  }

  return {
    borrowCount,
    inFlightCount,
    trainingsSucceeded,
    trainingsRefunded,
    earnedAtomic: earned.toString(),
    inEscrowAtomic: inEscrow.toString(),
    unreadableAmounts,
    lastBorrowAt: last === null ? null : new Date(last).toISOString(),
    weekly,
  };
}

// ---------------------------------------------------------------------------
// Tri de la mosaïque

export type DatasetSort = "date" | "revenue" | "borrows";
export const DATASET_SORTS: readonly DatasetSort[] = ["date", "revenue", "borrows"];

export interface SortableDataset {
  id: string;
  createdAt: Date | string;
  /** Revenus en unités atomiques ; inconnus : `null` (classés en dernier). */
  earnedAtomic: string | null;
  /** Nombre d'emprunts ; inconnu : `null` (classé en dernier). */
  borrowCount: number | null;
}

function compareBigIntDesc(left: string | null, right: string | null): number {
  const a = left !== null && ATOMIC_RE.test(left) ? BigInt(left) : null;
  const b = right !== null && ATOMIC_RE.test(right) ? BigInt(right) : null;
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : a < b ? 1 : 0;
}

function compareNumberDesc(left: number | null, right: number | null): number {
  const a = typeof left === "number" && Number.isFinite(left) ? left : null;
  const b = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function compareDateDesc(left: Date | string, right: Date | string): number {
  return compareNumberDesc(toTime(left), toTime(right));
}

/** Tri stable, décroissant ; à égalité, le plus récent d'abord, puis l'identifiant. */
export function sortDatasets<T extends SortableDataset>(datasets: readonly T[], sort: DatasetSort): T[] {
  return [...datasets].sort((a, b) => {
    const primary = sort === "revenue"
      ? compareBigIntDesc(a.earnedAtomic, b.earnedAtomic)
      : sort === "borrows"
        ? compareNumberDesc(a.borrowCount, b.borrowCount)
        : 0;
    if (primary !== 0) return primary;
    const byDate = compareDateDesc(a.createdAt, b.createdAt);
    if (byDate !== 0) return byDate;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export function isDatasetSort(value: unknown): value is DatasetSort {
  return typeof value === "string" && (DATASET_SORTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Accès à la base (serveur). Le client est injecté : les routes passent `prisma`.

/** Champs lus pour décider ; jamais renvoyés tels quels au client. */
const OWNER_CHECK_SELECT = {
  id: true,
  provider: true,
  status: true,
  listingExpiresAt: true,
  evmDatasetId: true,
} as const;

interface OwnerCheckRow {
  id: string;
  provider: string;
  status: string;
  listingExpiresAt: Date | null;
  evmDatasetId: string | null;
}

/** Sous-ensemble du client Prisma utilisé ici ; les tests le simulent. */
export type ManageDb = Pick<PrismaClient, "dataset" | "loan">;

export function assertDatasetId(id: unknown): string {
  if (typeof id !== "string" || !DATASET_ID_RE.test(id)) throw new AppError("Dataset introuvable", 404);
  return id;
}

/**
 * Contrôle de propriété. Un dataset absent et le dataset d'un autre wallet donnent la
 * même réponse (404 « Dataset introuvable ») : une route privée ne révèle pas l'existence
 * d'un identifiant à qui n'en est pas propriétaire.
 */
export async function loadOwnedDataset(db: ManageDb, id: unknown, owner: string): Promise<OwnerCheckRow> {
  const datasetId = assertDatasetId(id);
  const provider = tryNormalizeAddress(owner);
  if (!provider) throw new AppError("Dataset introuvable", 404);
  // Le propriétaire est dans la requête : la ligne d'un autre wallet n'est jamais lue.
  const row: OwnerCheckRow | null = await db.dataset.findFirst({ where: { id: datasetId, provider }, select: { ...OWNER_CHECK_SELECT } });
  if (!row || !addressesEqual(row.provider, owner)) throw new AppError("Dataset introuvable", 404);
  return row;
}

const CONCURRENT_CHANGE = "Dataset modifié entre-temps : recharge la page";

/** Applique une pause ou une remise en ligne déjà autorisée (grant vérifié par la route). */
export async function applyVisibility(db: ManageDb, row: OwnerCheckRow, transition: VisibilityTransition, now: number = Date.now()): Promise<void> {
  const where: Prisma.DatasetWhereInput = {
    id: row.id,
    provider: normalizeAddress(row.provider),
    status: { in: [...transition.from] },
  };
  if (transition.to === "LISTED") {
    where.evmDatasetId = { not: null };
    // L'expiration est rejouée par la base : une annonce qui expire entre la lecture et
    // l'écriture n'est pas remise en ligne.
    where.OR = [{ listingExpiresAt: null }, { listingExpiresAt: { gt: new Date(now) } }];
  }
  const data: Prisma.DatasetUpdateManyMutationInput = { status: transition.to };
  if (transition.to === "LISTED") data.listedAt = new Date(now);
  const { count } = await db.dataset.updateMany({ where, data });
  if (count !== 1) throw new AppError(CONCURRENT_CHANGE, 409);
}

/**
 * Prolonge l'annonce. `grantChecked` indique que la route a vérifié le grant de remise en
 * ligne ; sans lui, la base refuse d'écrire si l'annonce LISTED a expiré entre la décision
 * de la route et l'écriture (la prolongation la remettrait en ligne sans signature).
 */
export async function applyExtension(
  db: ManageDb,
  row: OwnerCheckRow,
  days: ListingExtensionDays,
  now: number = Date.now(),
  options: { grantChecked?: boolean } = {},
): Promise<Date> {
  const next = extendedListingExpiry(row, days, now);
  const unexpiredGuard: Prisma.DatasetWhereInput[] = row.status === "LISTED" && !options.grantChecked
    ? [{ listingExpiresAt: { gt: new Date(now) } }]
    : [];
  const { count } = await db.dataset.updateMany({
    where: {
      id: row.id,
      provider: normalizeAddress(row.provider),
      // Statut exact lu : un dataset passé de UNLISTED à LISTED entre-temps ne serait plus
      // couvert par la décision « grant requis ou non » prise par la route.
      status: row.status as DatasetStatusValue,
      // Égalité stricte avec la date lue : deux prolongations simultanées ne s'additionnent
      // pas en silence, la seconde reçoit un 409 et l'utilisateur voit la nouvelle date.
      listingExpiresAt: row.listingExpiresAt,
      ...(unexpiredGuard.length > 0 ? { AND: unexpiredGuard } : {}),
    },
    data: { listingExpiresAt: next },
  });
  if (count !== 1) throw new AppError(CONCURRENT_CHANGE, 409);
  return next;
}

export async function applyDetails(db: ManageDb, row: OwnerCheckRow, patch: DetailsPatch): Promise<void> {
  if (!(EDITABLE_STATUSES as readonly string[]).includes(row.status)) {
    throw new AppError("Ce dataset n'est plus modifiable", 409);
  }
  const data: Prisma.DatasetUpdateManyMutationInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  const { count } = await db.dataset.updateMany({
    where: { id: row.id, provider: normalizeAddress(row.provider), status: { in: [...EDITABLE_STATUSES] } },
    data,
  });
  if (count !== 1) throw new AppError(CONCURRENT_CHANGE, 409);
}

/**
 * Retrait du consentement à l'amélioration des modèles : pose `trainingConsentRevokedAt`
 * sans effacer la date ni la version du consentement initial (16-socle-technique.md § 2).
 * Possible quel que soit le statut, y compris détruit : retirer un consentement n'ouvre rien.
 */
export async function revokeTrainingConsent(db: ManageDb, row: OwnerCheckRow, now: number = Date.now()): Promise<Date> {
  const revokedAt = new Date(now);
  const { count } = await db.dataset.updateMany({
    where: {
      id: row.id,
      provider: normalizeAddress(row.provider),
      trainingConsentAt: { not: null },
      trainingConsentRevokedAt: null,
    },
    data: { trainingConsentRevokedAt: revokedAt },
  });
  if (count !== 1) throw new AppError("Aucun consentement actif à retirer", 409);
  return revokedAt;
}

// ---------------------------------------------------------------------------
// Vue du propriétaire

/** Colonnes lues pour la fiche. Les trois colonnes de consentement sont ré-incluses ici seulement. */
export const OWNER_VIEW_OMIT = {
  trainingConsentAt: false,
  trainingConsentVersion: false,
  trainingConsentRevokedAt: false,
} as const;

export interface OwnerDatasetRow {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  status: string;
  category: string | null;
  modelId: string | null;
  modelVersion: string | null;
  sizeBytes: number | null;
  metrics: unknown;
  priceUsdcAtomic: string;
  ipfsCid: string | null;
  merkleRoot: string | null;
  evmDatasetId: string | null;
  evmMintTxHash: string | null;
  evmDestroyTxHash: string | null;
  deletionReconciledAt: Date | null;
  listedAt: Date | null;
  listingExpiresAt: Date | null;
  keyDestroyedAt: Date | null;
  trainingConsentAt?: Date | null;
  trainingConsentVersion?: string | null;
  trainingConsentRevokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OwnerDatasetView {
  id: string;
  name: string;
  description: string | null;
  status: string;
  displayStatus: StatusKind;
  category: string | null;
  modelId: string | null;
  modelVersion: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
  columnCount: number | null;
  priceUsdcAtomic: string;
  ipfsCid: string | null;
  merkleRoot: string | null;
  evmDatasetId: string | null;
  evmMintTxHash: string | null;
  deletionPending: boolean;
  /**
   * Le déploiement autorise-t-il une remise sur la marketplace ? Faux en démo Phala, où
   * rien ne repasse en ligne : la fiche masque alors les actions qui feraient signer un
   * grant pour un refus certain.
   */
  canRelist: boolean;
  listedAt: string | null;
  listingExpiresAt: string | null;
  listingExpired: boolean;
  keyDestroyedAt: string | null;
  consent: { givenAt: string | null; version: string | null; revokedAt: string | null; active: boolean };
  createdAt: string;
  updatedAt: string;
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/**
 * Vue de la fiche, construite champ par champ (jamais `...row`) : ni `wrappedKey`, ni
 * `runnerReceipt`, ni l'adresse du fournisseur, ni les métriques brutes ne sortent.
 * `inFlightLoans` sert à la pastille ; `null` si inconnu.
 */
export function toOwnerView(
  row: OwnerDatasetRow,
  inFlightLoans: number | null,
  now: number = Date.now(),
  options: TransitionOptions = {},
): OwnerDatasetView {
  const metrics = publicDatasetMetrics(row.metrics);
  const givenAt = iso(row.trainingConsentAt);
  const revokedAt = iso(row.trainingConsentRevokedAt);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    displayStatus: displayStatus({ status: row.status, listingExpiresAt: row.listingExpiresAt, inFlightLoans }, now),
    category: row.category,
    modelId: row.modelId,
    modelVersion: row.modelVersion,
    sizeBytes: row.sizeBytes,
    rowCount: metrics?.rowCount ?? null,
    columnCount: metrics?.columnCount ?? null,
    priceUsdcAtomic: row.priceUsdcAtomic,
    ipfsCid: row.ipfsCid,
    merkleRoot: row.merkleRoot,
    evmDatasetId: row.evmDatasetId,
    evmMintTxHash: row.evmMintTxHash,
    deletionPending: row.status === "DELETED" && !!row.evmDatasetId && !row.evmDestroyTxHash && !row.deletionReconciledAt,
    canRelist: !options.demoMode,
    listedAt: iso(row.listedAt),
    listingExpiresAt: iso(row.listingExpiresAt),
    listingExpired: isListingExpired(row.listingExpiresAt, now),
    keyDestroyedAt: iso(row.keyDestroyedAt),
    consent: { givenAt, version: row.trainingConsentVersion ?? null, revokedAt, active: givenAt !== null && revokedAt === null },
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

/** Lit la ligne complète du propriétaire (consentement ré-inclus) et son nombre de prêts en cours. */
export async function readOwnerView(
  db: ManageDb,
  id: unknown,
  owner: string,
  now: number = Date.now(),
  options: TransitionOptions = {},
): Promise<OwnerDatasetView> {
  const datasetId = assertDatasetId(id);
  const provider = tryNormalizeAddress(owner);
  if (!provider) throw new AppError("Dataset introuvable", 404);
  const row: OwnerDatasetRow | null = await db.dataset.findFirst({ where: { id: datasetId, provider }, omit: { ...OWNER_VIEW_OMIT } });
  if (!row || !addressesEqual(row.provider, owner)) throw new AppError("Dataset introuvable", 404);
  const inFlight = await db.loan.count({ where: { datasetId, status: { in: [...IN_FLIGHT_LOAN_STATUSES] } } });
  return toOwnerView(row, inFlight, now, options);
}

/** Statistiques privées d'un dataset ; le contrôle de propriété est fait avant toute lecture des prêts. */
export async function readDatasetStats(db: ManageDb, id: unknown, owner: string, now: number = Date.now()): Promise<LoanStats & { truncated: boolean }> {
  const row = await loadOwnedDataset(db, id, owner);
  const loans: LoanForStats[] = await db.loan.findMany({
    where: { datasetId: row.id },
    select: { status: true, createdAt: true, amountUsdcAtomic: true, datasetAmountUsdcAtomic: true, cancelTxHash: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_STATS_LOANS + 1,
  });
  const truncated = loans.length > MAX_STATS_LOANS;
  return { ...aggregateLoanStats(truncated ? loans.slice(0, MAX_STATS_LOANS) : loans, now), truncated };
}
