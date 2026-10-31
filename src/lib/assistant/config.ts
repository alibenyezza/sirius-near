/**
 * Configuration de l'assistant Sirio (chat Claude dans la bulle du guide).
 *
 * Interrupteur : `SIRIUS_ASSISTANT_ENABLED` exactement « true ». Absent ou autre valeur, la route
 * répond 404 et la bulle n'affiche que la FAQ et le contact ; rien n'est alors exigé au démarrage.
 * Activé, il faut la clé `ANTHROPIC_API_KEY` (lue par le SDK lui-même, jamais par ce code) et le
 * secret `SIRIUS_ASSISTANT_SECRET` qui signe les réponses renvoyées au navigateur. Ni l'un ni
 * l'autre n'est retourné ni journalisé.
 */

export const ASSISTANT_FLAG = "SIRIUS_ASSISTANT_ENABLED";
export const ASSISTANT_KEY_VARIABLE = "ANTHROPIC_API_KEY";
export const ASSISTANT_SECRET_VARIABLE = "SIRIUS_ASSISTANT_SECRET";
export const ASSISTANT_DAILY_CAP_VARIABLE = "SIRIUS_ASSISTANT_DAILY_CAP";
export const ASSISTANT_DAILY_BUDGET_VARIABLE = "SIRIUS_ASSISTANT_DAILY_BUDGET_USD";
export const ASSISTANT_DAILY_PER_CLIENT_VARIABLE = "SIRIUS_ASSISTANT_DAILY_PER_IP";

/** Modèle imposé par le produit ; identifiant exact de l'API. */
export const ASSISTANT_MODEL = "claude-opus-5-5";
/** Réponses courtes : au-delà, la bulle devient illisible et la facture grimpe. */
export const ASSISTANT_MAX_OUTPUT_TOKENS = 800;
/** Longueur maximale d'un message utilisateur, en caractères. */
export const ASSISTANT_MAX_MESSAGE_CHARS = 1_000;
/** Messages d'historique acceptés (utilisateur + assistant), le dernier message compris. */
export const ASSISTANT_MAX_HISTORY = 10;
/** Total des caractères de l'historique envoyé au modèle. */
export const ASSISTANT_MAX_HISTORY_CHARS = 6_000;
/** Chemin de page facultatif joint à la question (contexte seulement, jamais de donnée de compte). */
export const ASSISTANT_MAX_PAGE_CHARS = 128;
/** Longueur minimale du secret de signature des réponses. */
export const ASSISTANT_SECRET_MIN_CHARS = 32;

/** Plafond quotidien de requêtes sur l'instance (toutes conversations), par défaut et au plus. */
export const DEFAULT_ASSISTANT_DAILY_CAP = 500;
export const MAX_ASSISTANT_DAILY_CAP = 2_000;
/** Budget quotidien estimé, en dollars, par défaut et au plus. */
export const DEFAULT_ASSISTANT_DAILY_BUDGET_USD = 5;
export const MAX_ASSISTANT_DAILY_BUDGET_USD = 1_000;
/** Questions par jour et par client (adresse IP si l'ingress la transmet, sinon wallet signé). */
export const DEFAULT_ASSISTANT_DAILY_PER_CLIENT = 40;
export const MAX_ASSISTANT_DAILY_PER_CLIENT = 1_000;

/**
 * Tarif public de Claude Opus 5.5, en nano-dollars par jeton (1 $ = 10^9) : 4 $ / 20 $ par
 * million de jetons en entrée / sortie, écriture de cache 5 $, lecture 0,20 $. Entiers pour que
 * l'addition en base reste exacte.
 */
export const ASSISTANT_PRICE_NANO_USD_PER_TOKEN = Object.freeze({
  input: 4_000,
  output: 20_000,
  cacheWrite: 5_000,
  cacheRead: 200,
});

export interface AssistantTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Coût estimé d'une réponse, en micro-dollars (1 $ = 10^6), arrondi au-dessus. */
export function estimateAssistantCostMicroUsd(usage: AssistantTokenUsage): number {
  const price = ASSISTANT_PRICE_NANO_USD_PER_TOKEN;
  const nano = usage.inputTokens * price.input + usage.outputTokens * price.output
    + usage.cacheWriteTokens * price.cacheWrite + usage.cacheReadTokens * price.cacheRead;
  return Math.ceil(nano / 1_000);
}

export type AssistantEnvironment = { readonly [variable: string]: string | undefined };

/** Vrai seulement si le drapeau vaut exactement « true ». */
export function assistantEnabled(env: AssistantEnvironment = process.env): boolean {
  return env.SIRIUS_ASSISTANT_ENABLED?.trim() === "true";
}

function boundedInteger(raw: string | undefined, fallback: number, max: number): number {
  const value = raw?.trim();
  if (!value || !/^[1-9][0-9]{0,6}$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed > max ? fallback : parsed;
}

/** Plafond quotidien de requêtes : entier 1–2000, sinon la valeur par défaut. */
export function assistantDailyCap(env: AssistantEnvironment = process.env): number {
  return boundedInteger(env.SIRIUS_ASSISTANT_DAILY_CAP, DEFAULT_ASSISTANT_DAILY_CAP, MAX_ASSISTANT_DAILY_CAP);
}

/** Questions par jour et par client : entier 1–1000, sinon la valeur par défaut. */
export function assistantDailyPerClient(env: AssistantEnvironment = process.env): number {
  return boundedInteger(env.SIRIUS_ASSISTANT_DAILY_PER_IP, DEFAULT_ASSISTANT_DAILY_PER_CLIENT, MAX_ASSISTANT_DAILY_PER_CLIENT);
}

/** Budget quotidien en micro-dollars : décimal « 5 » ou « 2.50 », 0 < budget ≤ 1000 $, sinon 5 $. */
export function assistantDailyBudgetMicroUsd(env: AssistantEnvironment = process.env): number {
  const raw = env.SIRIUS_ASSISTANT_DAILY_BUDGET_USD?.trim();
  const fallback = DEFAULT_ASSISTANT_DAILY_BUDGET_USD * 1_000_000;
  if (!raw || !/^[0-9]{1,4}(\.[0-9]{1,2})?$/.test(raw)) return fallback;
  const micro = Math.round(Number(raw) * 1_000_000);
  return micro <= 0 || micro > MAX_ASSISTANT_DAILY_BUDGET_USD * 1_000_000 ? fallback : micro;
}

/** Secret de signature des réponses, ou `null` s'il est absent ou trop court. */
export function assistantSecret(env: AssistantEnvironment = process.env): string | null {
  const secret = env.SIRIUS_ASSISTANT_SECRET?.trim() ?? "";
  return secret.length >= ASSISTANT_SECRET_MIN_CHARS ? secret : null;
}

/**
 * Contrôle de démarrage : un drapeau posé sans clé ni secret est une fonction annoncée qui
 * échouerait à chaque question. Un drapeau absent n'exige rien. Le message ne contient que des
 * noms de variables et des plafonds.
 */
export function assistantStartupNotice(env: AssistantEnvironment = process.env): string | null {
  const flag = env.SIRIUS_ASSISTANT_ENABLED?.trim();
  if (flag && flag !== "true" && flag !== "false") throw new Error("SIRIUS_ASSISTANT_ENABLED doit valoir true ou false");
  if (flag !== "true") return null;
  if (!env.ANTHROPIC_API_KEY?.trim()) throw new Error("SIRIUS_ASSISTANT_ENABLED=true exige ANTHROPIC_API_KEY");
  if (!assistantSecret(env)) throw new Error("SIRIUS_ASSISTANT_ENABLED=true exige SIRIUS_ASSISTANT_SECRET : 32 caractères au moins");
  return `[sirius] ${ASSISTANT_FLAG}=true : assistant Sirio ouvert, ${assistantDailyCap(env)} requêtes par jour au plus, `
    + `${(assistantDailyBudgetMicroUsd(env) / 1_000_000).toFixed(2)} $ de budget estimé par jour, ${assistantDailyPerClient(env)} par client et par jour.`;
}
