import type { ModelId } from "@/lib/models/registry";
import type { DatasetCategory } from "@/lib/datasets/publication";

/** Fichier lu dans le navigateur : contenu binaire (chiffré plus tard) et texte (contrôlé tout de suite). */
export interface LoadedFile {
  name: string;
  sizeBytes: number;
  content: ArrayBuffer;
  text: string;
}

/** Valeurs de l'étape 1. La catégorie vide signifie « pas encore choisie ». */
export interface DataValues {
  name: string;
  description: string;
  category: DatasetCategory | "";
  modelId: ModelId;
}

export type StepState = "pending" | "active" | "done" | "failed";

export const INPUT_CLASS =
  "w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-hidden transition-colors focus:border-white/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const PRIMARY_BUTTON_CLASS =
  "rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50";
export const SECONDARY_BUTTON_CLASS =
  "rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/30 disabled:opacity-50";
