import { publicDatasetMetrics } from "@/lib/sirius/metrics";
import { MODEL_REGISTRY, modelSelection, type ModelId } from "@/lib/models/registry";
import { normalizeCategory, type CategoryId } from "./categories";
import { foldSearchText, MARKETPLACE_PAGE_SIZE, type MarketplaceQuery } from "./query";

/**
 * Projection publique d'un dataset de la marketplace, et règles « en ligne ».
 *
 * Tout ce qui sort vers un visiteur anonyme passe par `toPublicListing` ou `toPublicDetail`,
 * qui construisent un objet champ par champ : jamais d'étalement de la ligne Prisma. Un champ
 * ajouté demain au modèle `Dataset` (ou ré-inclus par erreur malgré l'`omit` global de
 * `src/lib/db.ts`) ne peut donc pas fuir par cette route.
 *
 * Module pur : aucun accès base ni réseau, testable sans Prisma.
 */

/**
 * Colonnes lues en base pour la marketplace. Liste blanche, passée en `select` à Prisma :
 * ni `wrappedKey`, ni consentement, ni CID, Merkle, reçu runner ou identifiants EVM.
 */
export const MARKETPLACE_DATASET_SELECT = {
  id: true,
  name: true,
  description: true,
  category: true,
  provider: true,
  modelId: true,
  modelVersion: true,
  metrics: true,
  sizeBytes: true,
  priceUsdcAtomic: true,
  challengeDays: true,
  status: true,
  listedAt: true,
  listingExpiresAt: true,
  keyDestroyedAt: true,
  createdAt: true,
} as const;

/** Ligne lue avec `MARKETPLACE_DATASET_SELECT`. */
export interface MarketplaceDatasetRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  provider: string;
  modelId: string | null;
  modelVersion: string | null;
  metrics: unknown;
  sizeBytes: number | null;
  priceUsdcAtomic: string;
  challengeDays: number;
  status: string;
  listedAt: Date | null;
  listingExpiresAt: Date | null;
  keyDestroyedAt: Date | null;
  createdAt: Date;
}

/**
 * Filtre Prisma des datasets en ligne : publiés (`LISTED`), clé active présente (DEK enveloppée
 * non effacée, titre on-chain minté), et annonce non expirée (`listingExpiresAt` absent, pour les
 * datasets publiés avant ce champ, ou futur). La pause fait passer le statut à `UNLISTED`
 * (docs 16) : elle est donc exclue ici.
 *
 * `wrappedKey` et `evmDatasetId` ne servent qu'au filtre : ils ne sont jamais sélectionnés
 * (l'`omit` global ne porte que sur ce qui est renvoyé, pas sur le `where`).
 */
export function onlineDatasetWhere(now: Date) {
  return {
    status: "LISTED" as const,
    keyDestroyedAt: null,
    wrappedKey: { not: null },
    evmDatasetId: { not: null },
    OR: [{ listingExpiresAt: null }, { listingExpiresAt: { gt: now } }],
  };
}

/** Même règle que `onlineDatasetWhere`, revérifiée en mémoire sur chaque ligne lue. */
export function isOnlineDataset(
  row: Pick<MarketplaceDatasetRow, "status" | "keyDestroyedAt" | "listingExpiresAt">,
  now: Date,
): boolean {
  if (row.status !== "LISTED" || row.keyDestroyedAt !== null) return false;
  if (row.listingExpiresAt === null) return true;
  const expiresAt = row.listingExpiresAt instanceof Date ? row.listingExpiresAt.getTime() : Number.NaN;
  // Une date illisible n'est pas « absente » : par prudence, le dataset est considéré expiré.
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/** Statistiques publiques d'un dataset, tirées des prêts. */
export interface LoanStats {
  /** Prêts dont les fonds ont été verrouillés (en cours, réglés ou remboursés). */
  borrowCount: number;
  /** Prêts réglés au fournisseur (transaction de règlement connue). */
  settledCount: number;
  /** Prêts remboursés à l'emprunteur (transaction de remboursement connue). */
  refundedCount: number;
}

export const EMPTY_LOAN_STATS: LoanStats = { borrowCount: 0, settledCount: 0, refundedCount: 0 };

/**
 * Frais de calcul ajoutés au gain du fournisseur pour un profil d'entraînement.
 * - `none` : facturation v6, aucun frais de calcul (le total est le prix du dataset) ;
 * - `quoted` : montant du dernier devis signé pour ce profil, à défaut celui du tarif publié
 *   (indicatif, le devis fait foi) ;
 * - `unknown` : ni devis récent ni tarif publié, ou configuration illisible.
 */
export type ComputeFee =
  | { kind: "none"; atomic: "0" }
  | { kind: "quoted"; atomic: string }
  | { kind: "unknown"; atomic: null };

export type ComputeFees = Record<ModelId, ComputeFee>;

export const UNKNOWN_COMPUTE_FEE: ComputeFee = { kind: "unknown", atomic: null };

/** Carte de la grille. */
export interface PublicListing {
  id: string;
  name: string;
  category: CategoryId | null;
  modelId: ModelId | null;
  modelVersion: string | null;
  rowCount: number | null;
  columnCount: number | null;
  sizeBytes: number | null;
  /** Gain du fournisseur par emprunt (prix du dataset dans le devis), unités atomiques. */
  providerPriceAtomic: string;
  /** Prix affiché : total payé par l'emprunteur si les frais sont connus, sinon le gain du fournisseur. */
  priceAtomic: string;
  priceKind: "borrowerPays" | "providerReceives";
  borrowCount: number;
  /** `true` vérifié KYB, `false` non vérifié, `null` statut illisible. */
  verified: boolean | null;
  listedAt: string | null;
}

/** Fiche publique. */
export interface PublicDetail extends PublicListing {
  description: string | null;
  /** Adresse publique du fournisseur (titulaire du titre on-chain). */
  provider: string;
  /** Délai de sécurité de l'escrow : au-delà, sans règlement, l'emprunteur récupère ses fonds. */
  challengeDays: number;
  settledCount: number;
  refundedCount: number;
  /** Prêts réglés / prêts résolus (réglés + remboursés), entre 0 et 1 ; `null` sans prêt résolu. */
  successRate: number | null;
  computeFee: ComputeFee;
}

const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;

function safeSize(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isoDate(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Profil d'entraînement reconnu (identifiant et version du registre), sinon `null`. */
function knownModel(row: Pick<MarketplaceDatasetRow, "modelId" | "modelVersion">) {
  return modelSelection(row.modelId, row.modelVersion);
}

/** Prix affiché : part du fournisseur + frais de calcul quand ils sont connus, sinon la seule part. */
export function displayedPrice(providerPriceAtomic: string, fee: ComputeFee): Pick<PublicListing, "priceAtomic" | "priceKind"> {
  if (fee.kind !== "unknown" && ATOMIC.test(providerPriceAtomic) && ATOMIC.test(fee.atomic)) {
    return { priceAtomic: (BigInt(providerPriceAtomic) + BigInt(fee.atomic)).toString(), priceKind: "borrowerPays" };
  }
  return { priceAtomic: providerPriceAtomic, priceKind: "providerReceives" };
}

/** Frais applicables à une ligne : ceux de son profil, inconnus si le profil n'est pas reconnu. */
export function feeForRow(row: Pick<MarketplaceDatasetRow, "modelId" | "modelVersion">, fees: ComputeFees): ComputeFee {
  const model = knownModel(row);
  return model ? fees[model.modelId] : UNKNOWN_COMPUTE_FEE;
}

export function toPublicListing(
  row: MarketplaceDatasetRow,
  stats: LoanStats,
  verified: boolean | null,
  fee: ComputeFee,
): PublicListing {
  const metrics = publicDatasetMetrics(row.metrics);
  const model = knownModel(row);
  const providerPriceAtomic = ATOMIC.test(row.priceUsdcAtomic) ? row.priceUsdcAtomic : "";
  return {
    id: row.id,
    name: row.name,
    category: normalizeCategory(row.category),
    // Un profil inconnu est rendu tel quel pour que la carte affiche « Profil absent ».
    modelId: model ? model.modelId : null,
    modelVersion: model ? model.modelVersion : null,
    rowCount: metrics?.rowCount ?? null,
    columnCount: metrics?.columnCount ?? null,
    sizeBytes: safeSize(row.sizeBytes),
    providerPriceAtomic,
    ...displayedPrice(providerPriceAtomic, fee),
    borrowCount: safeCount(stats.borrowCount),
    verified: typeof verified === "boolean" ? verified : null,
    listedAt: isoDate(row.listedAt),
  };
}

export function toPublicDetail(
  row: MarketplaceDatasetRow,
  stats: LoanStats,
  verified: boolean | null,
  fee: ComputeFee,
): PublicDetail {
  const settledCount = safeCount(stats.settledCount);
  const refundedCount = safeCount(stats.refundedCount);
  const resolved = settledCount + refundedCount;
  return {
    ...toPublicListing(row, stats, verified, fee),
    description: row.description,
    provider: row.provider,
    challengeDays: safeCount(row.challengeDays),
    settledCount,
    refundedCount,
    successRate: resolved > 0 ? settledCount / resolved : null,
    computeFee: fee,
  };
}

/** Texte de recherche d'une ligne : nom et description, repliés une fois. */
export function searchableText(row: Pick<MarketplaceDatasetRow, "name" | "description">): string {
  return foldSearchText(`${row.name}\n${row.description ?? ""}`);
}

/** Tous les mots doivent apparaître dans le nom ou la description (sous-chaîne, pas d'expression régulière). */
export function matchesSearch(text: string, terms: readonly string[]): boolean {
  return terms.every((term) => text.includes(term));
}

export interface ListingCandidate {
  listing: PublicListing;
  /** Texte replié de `searchableText`. */
  text: string;
  /** Pour départager les égalités : date de publication, sinon de création. */
  publishedAt: number;
}

function compareRecent(left: ListingCandidate, right: ListingCandidate): number {
  if (left.publishedAt !== right.publishedAt) return right.publishedAt - left.publishedAt;
  return left.listing.id < right.listing.id ? 1 : left.listing.id > right.listing.id ? -1 : 0;
}

function priceOf(candidate: ListingCandidate): bigint | null {
  return ATOMIC.test(candidate.listing.priceAtomic) ? BigInt(candidate.listing.priceAtomic) : null;
}

/** Filtre puis trie les candidats selon la requête. Ne coupe pas en pages. */
export function filterAndSortListings(candidates: readonly ListingCandidate[], query: MarketplaceQuery): ListingCandidate[] {
  const kept = candidates.filter((candidate) => {
    const { listing } = candidate;
    if (query.category !== null && listing.category !== query.category) return false;
    if (query.model !== null && listing.modelId !== query.model) return false;
    if (query.verifiedOnly && listing.verified !== true) return false;
    if (query.minRows !== null || query.maxRows !== null) {
      if (listing.rowCount === null) return false;
      if (query.minRows !== null && listing.rowCount < query.minRows) return false;
      if (query.maxRows !== null && listing.rowCount > query.maxRows) return false;
    }
    if (query.minPriceAtomic !== null || query.maxPriceAtomic !== null) {
      const price = priceOf(candidate);
      if (price === null) return false;
      if (query.minPriceAtomic !== null && price < query.minPriceAtomic) return false;
      if (query.maxPriceAtomic !== null && price > query.maxPriceAtomic) return false;
    }
    return query.terms.length === 0 || matchesSearch(candidate.text, query.terms);
  });
  return kept.sort((left, right) => {
    if (query.sort === "borrowed" && left.listing.borrowCount !== right.listing.borrowCount) {
      return right.listing.borrowCount - left.listing.borrowCount;
    }
    if (query.sort === "price") {
      const a = priceOf(left);
      const b = priceOf(right);
      // Un prix illisible va en fin de liste plutôt que d'être compté comme gratuit.
      if (a === null || b === null) {
        if (a !== b) return a === null ? 1 : -1;
      } else if (a !== b) {
        return a < b ? -1 : 1;
      }
    }
    return compareRecent(left, right);
  });
}

export interface ListingPage {
  items: PublicListing[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
}

export function paginate(sorted: readonly ListingCandidate[], page: number, pageSize = MARKETPLACE_PAGE_SIZE): ListingPage {
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  // Page au-delà de la fin (lien partagé, datasets retirés entre-temps) : ramenée à la dernière,
  // plutôt qu'un catalogue vide qui se dirait vide.
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * pageSize;
  return {
    items: sorted.slice(start, start + pageSize).map((candidate) => candidate.listing),
    total: sorted.length,
    page: current,
    pageCount,
    pageSize,
  };
}

/** Ce que le profil d'entraînement produit, pour la fiche. */
export function modelOutput(modelId: ModelId): string {
  return MODEL_REGISTRY[modelId].description;
}
