/**
 * Règles de publication d'un dataset (docs/passage-mainnet/07-upload.md, 01 §3 et §4).
 *
 * Module pur, sans dépendance serveur : il est importé par le formulaire (affichage des
 * choix) et par la route de création (validation). La route ne fait **jamais** confiance
 * au navigateur : chaque valeur reçue repasse par les fonctions `parse*` ci-dessous.
 */

/** Bornes du nom et de la description, appliquées par le formulaire et par la route. */
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2_000;

/** Catégories de la liste fixe, telles qu'elles sont stockées en base (identifiants stables). */
export const DATASET_CATEGORIES = [
  "Finance",
  "Health",
  "Commerce",
  "Industry",
  "Mobility",
  "Energy",
  "Marketing",
  "Other",
] as const;

export type DatasetCategory = (typeof DATASET_CATEGORIES)[number];

/**
 * Clé de traduction (française) de chaque catégorie. Le site est affiché en anglais via
 * `t()` ; la clé française suit la convention des autres textes de l'interface.
 */
export const DATASET_CATEGORY_LABEL_KEYS: Readonly<Record<DatasetCategory, string>> = {
  Finance: "Finance",
  Health: "Santé",
  Commerce: "Commerce",
  Industry: "Industrie",
  Mobility: "Mobilité",
  Energy: "Énergie",
  Marketing: "Marketing",
  Other: "Autre",
};

/** Catégorie valide, ou `null`. Comparaison exacte : pas de normalisation de casse ni d'espace. */
export function parseDatasetCategory(value: unknown): DatasetCategory | null {
  if (typeof value !== "string") return null;
  return (DATASET_CATEGORIES as readonly string[]).includes(value) ? (value as DatasetCategory) : null;
}

/** Durées de publication proposées, en jours. */
export const LISTING_DURATIONS_DAYS = [7, 30, 90] as const;
export type ListingDurationDays = (typeof LISTING_DURATIONS_DAYS)[number];
export const DEFAULT_LISTING_DURATION_DAYS: ListingDurationDays = 30;

/** Durée valide (nombre strict, dans la liste), ou `null`. Une chaîne « 30 » est refusée. */
export function parseListingDurationDays(value: unknown): ListingDurationDays | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return (LISTING_DURATIONS_DAYS as readonly number[]).includes(value) ? (value as ListingDurationDays) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fin de publication pour une durée donnée, à partir de `now`. */
export function listingExpiryFrom(now: Date, days: ListingDurationDays): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * Délai de sécurité de l'escrow, en jours, fixé par Sirius pour tous les datasets
 * (01-decisions-avant-samedi.md §3). Il n'est plus demandé au fournisseur : la route de
 * création l'impose quelle que soit la valeur reçue, et le devis compute le relit depuis
 * le reçu de scellement de l'enclave.
 */
export const ESCROW_CHALLENGE_DAYS = 3;

/**
 * Texte du consentement à l'amélioration des modèles, clé de traduction française.
 * Le texte anglais affiché est celui de 07-upload.md, au mot près (`upload-en.ts`).
 * Toute modification du texte doit changer `TRAINING_CONSENT_VERSION` : la version
 * enregistrée en base identifie le texte exact que le fournisseur a accepté.
 */
export const TRAINING_CONSENT_TEXT_KEY =
  "Autoriser Sirius à utiliser ce dataset, uniquement dans l’enclave, pour évaluer et développer de nouveaux modèles. Vous pouvez retirer ce consentement à tout moment pour les usages futurs.";
export const TRAINING_CONSENT_VERSION = "2026-10-04";

/**
 * Consentement reçu du formulaire : `true` ou `false` uniquement. Absent vaut « non »
 * (la case est facultative et décochée par défaut) ; toute autre valeur (`"true"`, `1`,
 * `null`) est refusée plutôt qu'interprétée.
 */
export function parseTrainingConsent(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
}

/**
 * Durée de publication choisie, recalculée à partir des dates posées à la création du
 * brouillon. Un brouillon scellé peut attendre des jours avant que le fournisseur signe le
 * titre on-chain : la durée doit alors courir depuis la publication, pas depuis la
 * création. Si la durée stockée ne correspond à aucune durée proposée (dataset d'avant
 * ce champ, ligne modifiée à la main), on ne touche à rien.
 */
export function rebasedListingExpiry(
  dataset: { createdAt: Date; listingExpiresAt: Date | null },
  listedAt: Date,
): Date | null {
  if (!dataset.listingExpiresAt) return null;
  const elapsed = dataset.listingExpiresAt.getTime() - dataset.createdAt.getTime();
  const days = Math.round(elapsed / DAY_MS);
  if (!(LISTING_DURATIONS_DAYS as readonly number[]).includes(days)) return null;
  // `createDatasetDraft` calcule l'échéance à partir de `createdAt` : l'écart est nul pour
  // une ligne écrite par cette route. La tolérance d'une minute est purement défensive ;
  // au-delà, la ligne a été écrite autrement et on ne la touche pas.
  if (Math.abs(elapsed - days * DAY_MS) > 60_000) return null;
  return listingExpiryFrom(listedAt, days as ListingDurationDays);
}
