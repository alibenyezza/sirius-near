import type { EvmNetwork } from "@/lib/evm/networks";

/** Site de staging, lié au testnet (docs/passage-mainnet/13-reglages.md). */
export const TESTNET_SITE_URL = "https://sirius-evm-staging.vercel.app";

/** Adresse d'écriture pour une entreprise sans invitation KYB. */
export const KYB_CONTACT_EMAIL = "sirius.data.contact@gmail.com";

export interface NetworkInfo {
  /** Clé de traduction du libellé. */
  label: string;
  /** Lien « Try it on testnet » : seulement depuis le mainnet, jamais sur le testnet. */
  testnetUrl: string | null;
}

/** Réseau du site (fixé par l'environnement, non modifiable) et lien éventuel vers le testnet. */
export function networkInfo(network: EvmNetwork): NetworkInfo {
  return network === "mainnet"
    ? { label: "Robinhood Chain mainnet", testnetUrl: TESTNET_SITE_URL }
    : { label: "Robinhood Chain testnet", testnetUrl: null };
}

/** Langues proposées : l'anglais seul, comme `PROFILE_LANGUAGES` côté serveur. */
export const LANGUAGE_CHOICES = ["en"] as const;
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number];

/** Langue enregistrée dans la réponse de `/api/profile`, ou `null` si absente ou inconnue. */
export function savedLanguage(profile: unknown): LanguageChoice | null {
  if (!profile || typeof profile !== "object") return null;
  const settings = (profile as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return null;
  const language = (settings as { language?: unknown }).language;
  return (LANGUAGE_CHOICES as readonly unknown[]).includes(language) ? (language as LanguageChoice) : null;
}

/** Réglages annoncés mais pas encore disponibles : affichés grisés avec « Soon ». Clés de traduction. */
export const SETTINGS_SOON = [
  { title: "Notifications", hint: "Email alerts when your dataset is borrowed, a training finishes or a payment arrives." },
  { title: "Display preferences", hint: "Density and appearance options." },
  { title: "Collapse the menu by default", hint: "Start with the sidebar collapsed." },
] as const;

export const KYB_SOON = [
  { title: "Online verification without an invitation", hint: "Submit your company details and be verified by a Sirius verifier." },
  { title: "Benefits of verification", hint: "Verified provider badge, higher lending limits and early access to new models." },
] as const;

/** Ce que l'accès instantané livre déjà : annoncé « bientôt » à côté du bouton, il contredirait la page. */
const KYB_SOON_REPLACED_BY_INSTANT_ACCESS: ReadonlySet<string> = new Set(["Online verification without an invitation"]);

/** Cartes « bientôt » de /kyb, sans celles que l'accès instantané rend caduques quand il est proposé. */
export function kybSoonItems(instantAccess: boolean): readonly (typeof KYB_SOON)[number][] {
  return instantAccess ? KYB_SOON.filter((item) => !KYB_SOON_REPLACED_BY_INSTANT_ACCESS.has(item.title)) : KYB_SOON;
}
