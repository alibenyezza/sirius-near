/**
 * Catégories de la marketplace : liste fixe de l'upload (docs/passage-mainnet/07-upload.md),
 * dans l'ordre du cahier des charges.
 *
 * La base stocke la catégorie en texte libre (`Dataset.category`) et la liste est tenue par le
 * code de l'upload, livré par une autre slice. Pour ne pas dépendre de la forme exacte qu'elle
 * choisira, la lecture accepte l'identifiant canonique (« health ») et les libellés français ou
 * anglais (« Santé », « Health »), sans tenir compte de la casse ni des accents. Toute autre
 * valeur est traitée comme une absence de catégorie : elle n'est ni affichée ni filtrable.
 *
 * Module pur : importable par le navigateur, le serveur et les tests.
 */

export const MARKETPLACE_CATEGORIES = [
  { id: "finance", label: "Finance", aliases: ["finance"] },
  { id: "health", label: "Santé", aliases: ["sante", "health", "healthcare"] },
  { id: "commerce", label: "Commerce", aliases: ["commerce", "retail"] },
  { id: "industry", label: "Industrie", aliases: ["industrie", "industry"] },
  { id: "mobility", label: "Mobilité", aliases: ["mobilite", "mobility"] },
  { id: "energy", label: "Énergie", aliases: ["energie", "energy"] },
  { id: "marketing", label: "Marketing", aliases: ["marketing"] },
  { id: "other", label: "Autre", aliases: ["autre", "other"] },
] as const;

export type CategoryId = (typeof MARKETPLACE_CATEGORIES)[number]["id"];

export const CATEGORY_IDS: readonly CategoryId[] = MARKETPLACE_CATEGORIES.map((category) => category.id);

/** Au-delà, la valeur stockée n'est pas une catégorie de la liste : inutile de la normaliser. */
const MAX_STORED_CATEGORY_LENGTH = 64;

function fold(value: string): string {
  // NFKD sépare les accents de leur lettre, puis on retire les diacritiques combinants.
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

const BY_ALIAS = new Map<string, CategoryId>(
  MARKETPLACE_CATEGORIES.flatMap((category) => [
    [category.id, category.id] as const,
    [fold(category.label), category.id] as const,
    ...category.aliases.map((alias) => [fold(alias), category.id] as const),
  ]),
);

/** Identifiant strict, tel qu'envoyé par l'interface dans un filtre. */
export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === "string" && (CATEGORY_IDS as readonly string[]).includes(value);
}

/** Catégorie stockée en base → identifiant canonique, ou `null` si inconnue. */
export function normalizeCategory(value: unknown): CategoryId | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STORED_CATEGORY_LENGTH) return null;
  return BY_ALIAS.get(fold(value)) ?? null;
}

/** Clé de traduction (française) du libellé d'une catégorie connue. */
export function categoryLabelKey(id: CategoryId): string {
  return MARKETPLACE_CATEGORIES.find((category) => category.id === id)!.label;
}
