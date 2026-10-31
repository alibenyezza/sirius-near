import type { BadgeVariant } from "./Badge";

/**
 * États d'une pastille. Les cinq premiers décrivent une annonce de dataset (Mes datasets,
 * marketplace), les trois derniers un prêt ou une opération.
 */
export const STATUS_KINDS = [
  "online",
  "borrowed",
  "paused",
  "expired",
  "destroyed",
  "pending",
  "failed",
  "refunded",
] as const;

export type StatusKind = (typeof STATUS_KINDS)[number];

export interface StatusMeta {
  /** Phrase française, clé de traduction (voir `src/lib/i18n/shared-en.ts`). */
  readonly labelKey: string;
  readonly variant: BadgeVariant;
}

export const STATUS_META: Readonly<Record<StatusKind, StatusMeta>> = {
  online: { labelKey: "En ligne", variant: "positive" },
  borrowed: { labelKey: "Emprunté", variant: "accent" },
  paused: { labelKey: "En pause", variant: "warning" },
  expired: { labelKey: "Expiré", variant: "muted" },
  destroyed: { labelKey: "Détruit", variant: "negative" },
  pending: { labelKey: "En attente", variant: "warning" },
  failed: { labelKey: "Échoué", variant: "negative" },
  refunded: { labelKey: "Remboursé", variant: "default" },
};

/** Libellé de repli quand l'état reçu du serveur n'est pas reconnu. */
export const UNKNOWN_STATUS_META: StatusMeta = { labelKey: "État inconnu", variant: "muted" };

export function isStatusKind(value: unknown): value is StatusKind {
  return typeof value === "string" && Object.hasOwn(STATUS_META, value);
}

/** Métadonnées d'un état, avec repli neutre pour une valeur inattendue venue de l'API. */
export function statusMeta(value: unknown): StatusMeta {
  return isStatusKind(value) ? STATUS_META[value] : UNKNOWN_STATUS_META;
}

/** Couleur du point de la pastille, dérivée de la variante (jamais le seul indicateur). */
export const STATUS_DOT_CLASS: Readonly<Record<BadgeVariant, string>> = {
  default: "bg-foreground/60",
  accent: "bg-accent",
  positive: "bg-positive",
  negative: "bg-negative",
  muted: "bg-muted",
  warning: "bg-yellow-400",
};
