import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { MAX_CSV_ROWS } from "@/lib/sirius/metrics";
import { MAX_TRAINING_FEATURES, MIN_TRAINING_ROWS } from "@/lib/tee/train";
import type { TranslationVariables } from "@/lib/i18n/english";
import { formatCount, formatLimitBytes } from "./numbers";

/**
 * Textes d'avertissement communs (docs/passage-mainnet/16-socle-technique.md, section 4).
 *
 * Un seul fichier source : le même texte apparaît partout et se modifie en un endroit.
 * Les clés sont les phrases françaises, traduites en anglais dans
 * `src/lib/i18n/shared-en.ts` ; on les affiche avec `t(key, variables)` de `useLocale()`.
 *
 * Les limites citées sont lues dans le code, jamais recopiées :
 *   MAX_DATASET_BYTES      src/lib/tee/contract.ts
 *   MAX_CSV_ROWS           src/lib/sirius/metrics.ts
 *   MIN_TRAINING_ROWS      src/lib/tee/train.ts
 *   MAX_TRAINING_FEATURES  src/lib/tee/train.ts
 * Aucune de ces trois sources n'est réservée au serveur (ni `server-only`, ni module
 * Node), elles sont donc importées telles quelles, sans déplacement ni réexport.
 * `disclaimers.test.ts` vérifie ce point et que les textes suivent les constantes.
 */

/** Adresse de contact affichée dans les textes et utilisée par les liens `mailto:`. */
export const CONTACT_EMAIL = "sirius.data.contact@gmail.com";

export const DISCLAIMER_IDS = [
  "modelQuality",
  "contactUs",
  "betaLimits",
  "retrainDeterministic",
  "dataLimits",
] as const;

export type DisclaimerId = (typeof DISCLAIMER_IDS)[number];

export interface DisclaimerCopy {
  /** Phrase française, clé de traduction. */
  readonly key: string;
  /** Valeurs injectées dans les `{paramètres}` de la clé. */
  readonly variables: Readonly<TranslationVariables>;
}

export interface DataLimits {
  maxDatasetBytes: number;
  minRows: number;
  maxRows: number;
  maxFeatures: number;
}

/** Valeurs affichées du texte `dataLimits`, calculées à partir des limites données. */
export function dataLimitsVariables(limits: DataLimits): TranslationVariables {
  return {
    maxSize: formatLimitBytes(limits.maxDatasetBytes),
    minRows: formatCount(limits.minRows),
    maxRows: formatCount(limits.maxRows),
    maxFeatures: formatCount(limits.maxFeatures),
  };
}

export const DISCLAIMERS: Readonly<Record<DisclaimerId, DisclaimerCopy>> = {
  modelQuality: {
    key: "Sirius entraîne pour l’instant des modèles de base : régression linéaire et régression logistique sur données tabulaires. Les résultats dépendent des données. De nouveaux modèles sont en développement.",
    variables: {},
  },
  contactUs: {
    key: "Besoin d’un modèle plus puissant ou de données précises ? Contactez-nous à {email}.",
    variables: { email: CONTACT_EMAIL },
  },
  betaLimits: {
    key: "Bêta : vérification on-chain instantanée du wallet, montants plafonnés par prêt et au total.",
    variables: {},
  },
  retrainDeterministic: {
    key: "La régression linéaire et la régression logistique sont déterministes : réentraîner sur les mêmes données donne le même modèle.",
    variables: {},
  },
  dataLimits: {
    key: "CSV jusqu’à {maxSize}, de {minRows} à {maxRows} lignes, colonnes numériques, jusqu’à {maxFeatures} variables explicatives.",
    variables: dataLimitsVariables({
      maxDatasetBytes: MAX_DATASET_BYTES,
      minRows: MIN_TRAINING_ROWS,
      maxRows: MAX_CSV_ROWS,
      maxFeatures: MAX_TRAINING_FEATURES,
    }),
  },
};

export type Translate = (key: string, variables?: TranslationVariables) => string;

/** Texte traduit d'un avertissement, prêt à afficher. */
export function disclaimerText(id: DisclaimerId, t: Translate): string {
  const { key, variables } = DISCLAIMERS[id];
  return t(key, variables);
}

/**
 * Lien `mailto:` vers le contact. L'objet éventuel est encodé strictement : un objet
 * construit à partir d'un nom de dataset ne peut ni ajouter d'en-tête (`%0D%0A`), ni de
 * destinataire, ni de paramètre (`&`, `?`, `cc=`).
 */
export function contactMailtoHref(subject?: string): string {
  const base = `mailto:${CONTACT_EMAIL}`;
  const cleaned = subject === undefined ? "" : sanitizeSubject(subject, 200);
  return cleaned ? `${base}?subject=${encodeURIComponent(cleaned)}` : base;
}

/**
 * Objet de courriel nettoyé : contrôles remplacés par une espace, substituts UTF-16 isolés
 * remplacés par U+FFFD (sinon `encodeURIComponent` lève une `URIError`), coupure sur des
 * points de code entiers (jamais au milieu d'un emoji).
 */
function sanitizeSubject(value: string, maxCodePoints: number): string {
  const characters: string[] = [];
  // `for...of` itère par points de code : un substitut isolé ressort seul.
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const isLoneSurrogate = code >= 0xd800 && code <= 0xdfff;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    characters.push(isLoneSurrogate ? "\uFFFD" : isControl ? " " : character);
  }
  return Array.from(characters.join("").trim()).slice(0, maxCodePoints).join("").trim();
}
