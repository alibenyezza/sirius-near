import { MAX_CSV_ROWS } from "@/lib/sirius/metrics";
import { modelSelectionForId, type ModelId } from "@/lib/models/registry";
import { isCategoryId, type CategoryId } from "./categories";

/**
 * Paramètres de recherche publics de la marketplace : lecture stricte et bornée.
 *
 * Tout vient de l'URL d'un visiteur anonyme. Chaque paramètre a une forme exacte et une borne ;
 * une valeur hors forme est refusée en 400 avec un message lisible, jamais tronquée ni devinée.
 * Un paramètre répété est refusé (deux valeurs pour un filtre n'ont pas de sens et masqueraient
 * l'une des deux). Les paramètres inconnus sont ignorés (liens partagés avec un suivi, etc.).
 *
 * Module pur : aucun accès base ni réseau.
 */

/** Cartes par page. */
export const MARKETPLACE_PAGE_SIZE = 24;
/**
 * Plafond des datasets en ligne lus par requête, les plus récemment publiés d'abord. Au-delà,
 * la réponse le signale (`truncated`). Pendant la bêta sur invitation, le catalogue est très en
 * dessous ; le passage à un filtrage en SQL est noté dans l'audit si le catalogue grandit.
 */
export const MARKETPLACE_MAX_CANDIDATES = 500;
export const MARKETPLACE_MAX_PAGE = Math.ceil(MARKETPLACE_MAX_CANDIDATES / MARKETPLACE_PAGE_SIZE);
/** Longueur maximale de la recherche, en points de code, après suppression des espaces autour. */
export const MAX_SEARCH_LENGTH = 100;
/** Au-delà, la valeur brute n'est même pas examinée. */
const MAX_RAW_PARAM_LENGTH = 400;
/** Mots de recherche pris en compte (les suivants rendraient la requête plus lente, pas plus utile). */
export const MAX_SEARCH_TERMS = 8;

export const MARKETPLACE_SORTS = ["recent", "borrowed", "price"] as const;
export type MarketplaceSort = (typeof MARKETPLACE_SORTS)[number];

export const MARKETPLACE_PARAMS = ["q", "category", "model", "minPrice", "maxPrice", "minRows", "maxRows", "verified", "sort", "page"] as const;
export type MarketplaceParam = (typeof MARKETPLACE_PARAMS)[number];

export interface MarketplaceQuery {
  /** Mots recherchés, déjà repliés (minuscules, sans accents). Vide : pas de recherche. */
  terms: string[];
  category: CategoryId | null;
  model: ModelId | null;
  /** Bornes du prix affiché, en unités atomiques du jeton, incluses. */
  minPriceAtomic: bigint | null;
  maxPriceAtomic: bigint | null;
  /** Bornes du nombre de lignes, incluses. */
  minRows: number | null;
  maxRows: number | null;
  verifiedOnly: boolean;
  sort: MarketplaceSort;
  page: number;
}

export type ParsedMarketplaceQuery = { ok: true; query: MarketplaceQuery } | { ok: false; error: string };

export const DEFAULT_MARKETPLACE_QUERY: MarketplaceQuery = {
  terms: [],
  category: null,
  model: null,
  minPriceAtomic: null,
  maxPriceAtomic: null,
  minRows: null,
  maxRows: null,
  verifiedOnly: false,
  sort: "recent",
  page: 1,
};

/** Messages d'erreur (clés françaises, traduites à l'affichage). */
export const QUERY_ERRORS = {
  duplicate: "Paramètre de recherche répété",
  search: "Recherche invalide (100 caractères au plus)",
  category: "Catégorie inconnue",
  model: "Modèle inconnu",
  price: "Prix invalide",
  priceRange: "Fourchette de prix invalide",
  rows: "Nombre de lignes invalide",
  rowsRange: "Fourchette de lignes invalide",
  verified: "Filtre fournisseur invalide",
  sort: "Tri inconnu",
  page: "Page invalide",
} as const;

/** Repli utilisé pour comparer la recherche aux noms et descriptions : minuscules, sans accents. */
export function foldSearchText(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Contrôles C0, DEL, C1 et substituts UTF-16 isolés : jamais légitimes dans une recherche.
const FORBIDDEN_SEARCH_CHARS = /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function parseSearch(raw: string): string[] | null {
  if (raw.length > MAX_RAW_PARAM_LENGTH || FORBIDDEN_SEARCH_CHARS.test(raw)) return null;
  const trimmed = raw.trim();
  if ([...trimmed].length > MAX_SEARCH_LENGTH) return null;
  const terms = foldSearchText(trimmed).split(/\s+/).filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_SEARCH_TERMS);
}

/**
 * Montant décimal en unités du jeton (« 12.5 ») → unités atomiques. Partie entière sur huit
 * chiffres au plus (le prix total, gain du fournisseur plus calcul, peut dépasser le plafond d'un
 * million par prêt) ; décimales au plus celles du jeton, jamais arrondies.
 */
export function parseTokenAmount(raw: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const pattern = decimals === 0
    ? /^(0|[1-9][0-9]{0,7})$/
    : new RegExp(`^(0|[1-9][0-9]{0,7})(?:\\.([0-9]{1,${decimals}}))?$`);
  const match = pattern.exec(raw);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  return BigInt(match[1]) * BigInt(10) ** BigInt(decimals) + BigInt(fraction || "0");
}

function parseRows(raw: string): number | null {
  if (!/^(0|[1-9][0-9]{0,5})$/.test(raw)) return null;
  const value = Number(raw);
  return value <= MAX_CSV_ROWS ? value : null;
}

/**
 * Lit les paramètres publics. `decimals` : précision du jeton du réseau, pour les prix.
 * Une valeur vide vaut une absence (formulaire soumis avec un champ vidé).
 */
export function parseMarketplaceQuery(params: URLSearchParams, decimals: number): ParsedMarketplaceQuery {
  const fail = (error: string): ParsedMarketplaceQuery => ({ ok: false, error });
  const values = new Map<MarketplaceParam, string>();
  for (const name of MARKETPLACE_PARAMS) {
    const all = params.getAll(name);
    if (all.length > 1) return fail(QUERY_ERRORS.duplicate);
    if (all.length === 1 && all[0] !== "") values.set(name, all[0]);
  }
  const query: MarketplaceQuery = { ...DEFAULT_MARKETPLACE_QUERY, terms: [] };

  const q = values.get("q");
  if (q !== undefined) {
    const terms = parseSearch(q);
    if (!terms) return fail(QUERY_ERRORS.search);
    query.terms = terms;
  }

  const category = values.get("category");
  if (category !== undefined) {
    if (!isCategoryId(category)) return fail(QUERY_ERRORS.category);
    query.category = category;
  }

  const model = values.get("model");
  if (model !== undefined) {
    const selection = modelSelectionForId(model);
    if (!selection) return fail(QUERY_ERRORS.model);
    query.model = selection.modelId;
  }

  for (const [name, key] of [["minPrice", "minPriceAtomic"], ["maxPrice", "maxPriceAtomic"]] as const) {
    const raw = values.get(name);
    if (raw === undefined) continue;
    const amount = raw.length > MAX_RAW_PARAM_LENGTH ? null : parseTokenAmount(raw, decimals);
    if (amount === null) return fail(QUERY_ERRORS.price);
    query[key] = amount;
  }
  if (query.minPriceAtomic !== null && query.maxPriceAtomic !== null && query.minPriceAtomic > query.maxPriceAtomic) {
    return fail(QUERY_ERRORS.priceRange);
  }

  for (const name of ["minRows", "maxRows"] as const) {
    const raw = values.get(name);
    if (raw === undefined) continue;
    const rows = parseRows(raw);
    if (rows === null) return fail(QUERY_ERRORS.rows);
    query[name] = rows;
  }
  if (query.minRows !== null && query.maxRows !== null && query.minRows > query.maxRows) {
    return fail(QUERY_ERRORS.rowsRange);
  }

  const verified = values.get("verified");
  if (verified !== undefined) {
    if (verified !== "1" && verified !== "0") return fail(QUERY_ERRORS.verified);
    query.verifiedOnly = verified === "1";
  }

  const sort = values.get("sort");
  if (sort !== undefined) {
    if (!(MARKETPLACE_SORTS as readonly string[]).includes(sort)) return fail(QUERY_ERRORS.sort);
    query.sort = sort as MarketplaceSort;
  }

  const page = values.get("page");
  if (page !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(page) || Number(page) > MARKETPLACE_MAX_PAGE) return fail(QUERY_ERRORS.page);
    query.page = Number(page);
  }

  return { ok: true, query };
}
