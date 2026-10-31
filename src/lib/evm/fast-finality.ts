/**
 * Finalité rapide : politique pure, partagée par Next, le reaper et l'enclave.
 *
 * Sur Robinhood Chain mainnet, le bloc `finalized` suit la finalité L1 et traîne un quart d'heure
 * derrière la tête. Un prêt attend donc deux fois : avant l'entraînement (le lock doit être sous
 * le bloc stable) et après le release (le règlement n'est « réglé » qu'une fois finalisé). Décision
 * des fondateurs (risque accepté, voir docs/passage-mainnet/20-finalite-rapide.md) : les petits
 * prêts peuvent être acceptés après N confirmations L2, avec contrôle du hash canonique, tant que
 * l'argent exposé à ce régime reste borné.
 *
 * Ce que N confirmations L2 garantissent, et ce qu'elles ne garantissent pas : sur un rollup à
 * séquenceur unique, elles protègent d'une vue RPC en retard ou incohérente (nœud qui n'a pas
 * encore le bloc, relecture d'une branche abandonnée côté RPC), pas d'un séquenceur qui publierait
 * deux histoires ou perdrait des blocs non encore postés sur L1. Le palier rapide repose donc sur
 * la confiance accordée au séquenceur de Robinhood Chain ; seul le bloc `finalized` (ou `safe`,
 * mesuré à 8–13 min, ce qui annulerait l'intérêt) en est indépendant. D'où les bornes.
 *
 * Trois bornes, lues dans l'environnement de chaque rôle :
 *  - `SIRIUS_FAST_FINALITY` : coupe-circuit. Absent ou `false` ⇒ aucune différence avec le
 *    comportement historique, partout. Toute autre valeur que `true`/`false` est refusée.
 *  - `SIRIUS_FAST_FINALITY_MAX_USDC` (défaut 25) : montant maximal d'un prêt (dataset + calcul)
 *    admissible, en unités du jeton. L'enclave l'applique seule, depuis son propre environnement
 *    attesté, quoi que Next demande.
 *  - `SIRIUS_FAST_FINALITY_TOTAL_USDC` (défaut 100) : somme maximale des prêts rapides en cours
 *    (ESCROWED, TRAINING, SETTLING). Seul Next connaît cette somme (base) : l'enclave n'en tient
 *    pas compte (`totalInFlightAtomic: null`).
 *  - `SIRIUS_FAST_FINALITY_CONFIRMATIONS` (défaut 30, entre 1 et 100) : profondeur L2 exigée à la
 *    place de `finalized`, toujours assortie d'un contrôle du hash canonique du bloc.
 *
 * Aucune lecture réseau ici ; le montant d'un prêt vient toujours des termes on-chain (devis signé
 * par l'enclave et vérifié par `matchesScope`, ou relecture du contrat), jamais d'une entrée client.
 */

export type FinalityTier = "FULL" | "FAST";

export interface FastFinalityConfig {
  enabled: boolean;
  /** Montant maximal d'un prêt rapide, en unités atomiques du jeton. */
  maxLoanAtomic: bigint;
  /** Somme maximale des prêts rapides en cours, en unités atomiques ; toujours ≥ `maxLoanAtomic`. */
  totalInFlightAtomic: bigint;
  /** Confirmations L2 exigées à la place du bloc `finalized`. */
  confirmations: number;
}

export const FAST_FINALITY_DEFAULT_MAX_USDC = "25";
export const FAST_FINALITY_DEFAULT_TOTAL_USDC = "100";
export const FAST_FINALITY_DEFAULT_CONFIRMATIONS = 30;
export const FAST_FINALITY_MIN_CONFIRMATIONS = 1;
export const FAST_FINALITY_MAX_CONFIRMATIONS = 100;

type Env = Record<string, string | undefined>;

export class FastFinalityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FastFinalityConfigError";
  }
}

const AMOUNT = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,30}))?$/;

/** Montant décimal en unités du jeton → unités atomiques ; `null` si illisible ou nul. */
export function usdcAmountToAtomic(value: string | undefined, decimals: number): bigint | null {
  if (typeof value !== "string" || !Number.isInteger(decimals) || decimals < 0) return null;
  const match = AMOUNT.exec(value.trim());
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  const atomic = BigInt(match[1]) * BigInt(10) ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return atomic > BigInt(0) ? atomic : null;
}

/**
 * Lecture et validation des bornes. Lève `FastFinalityConfigError` sur toute valeur invalide :
 * un rôle mal configuré refuse de démarrer plutôt que d'accepter une profondeur aléatoire.
 */
export function fastFinalityConfig(env: Env, decimals: number): FastFinalityConfig {
  const flag = env.SIRIUS_FAST_FINALITY?.trim().toLowerCase() ?? "";
  if (flag !== "" && flag !== "true" && flag !== "false") {
    throw new FastFinalityConfigError("SIRIUS_FAST_FINALITY doit valoir true ou false");
  }
  const enabled = flag === "true";
  const maxLoanAtomic = usdcAmountToAtomic(env.SIRIUS_FAST_FINALITY_MAX_USDC?.trim() || FAST_FINALITY_DEFAULT_MAX_USDC, decimals);
  if (maxLoanAtomic === null) throw new FastFinalityConfigError("SIRIUS_FAST_FINALITY_MAX_USDC invalide : montant positif attendu");
  const totalInFlightAtomic = usdcAmountToAtomic(env.SIRIUS_FAST_FINALITY_TOTAL_USDC?.trim() || FAST_FINALITY_DEFAULT_TOTAL_USDC, decimals);
  if (totalInFlightAtomic === null) throw new FastFinalityConfigError("SIRIUS_FAST_FINALITY_TOTAL_USDC invalide : montant positif attendu");
  if (maxLoanAtomic > totalInFlightAtomic) {
    throw new FastFinalityConfigError("SIRIUS_FAST_FINALITY_MAX_USDC supérieur à SIRIUS_FAST_FINALITY_TOTAL_USDC");
  }
  const rawConfirmations = env.SIRIUS_FAST_FINALITY_CONFIRMATIONS?.trim();
  const confirmations = rawConfirmations ? Number(rawConfirmations) : FAST_FINALITY_DEFAULT_CONFIRMATIONS;
  if (!/^[0-9]+$/.test(rawConfirmations || "0") || !Number.isSafeInteger(confirmations)
    || confirmations < FAST_FINALITY_MIN_CONFIRMATIONS || confirmations > FAST_FINALITY_MAX_CONFIRMATIONS) {
    throw new FastFinalityConfigError(
      `SIRIUS_FAST_FINALITY_CONFIRMATIONS invalide : entier entre ${FAST_FINALITY_MIN_CONFIRMATIONS} et ${FAST_FINALITY_MAX_CONFIRMATIONS} attendu`,
    );
  }
  return { enabled, maxLoanAtomic, totalInFlightAtomic, confirmations };
}

export interface FinalityTierInput {
  /** Montant du prêt (dataset + calcul), en unités atomiques, lu sur les termes on-chain. */
  amountAtomic: bigint;
  /**
   * Somme des prêts rapides en cours, hors ce prêt. `null` quand l'appelant ne la connaît pas
   * (l'enclave) : seul le seuil par prêt s'applique alors, le plafond global restant à Next.
   */
  inFlightFastAtomic: bigint | null;
  config: FastFinalityConfig;
}

/**
 * Profondeur exigée pour un prêt : `FAST` seulement si la finalité rapide est active, si le
 * montant ne dépasse pas le seuil par prêt et si l'exposition rapide totale, ce prêt compris,
 * reste sous le plafond. Les deux bornes sont inclusives (un prêt de 25 passe, 25,000001 non).
 * Tout le reste — prêts plus gros, plafond atteint, coupe-circuit — garde la finalité complète.
 */
export function finalityTierFor(input: FinalityTierInput): FinalityTier {
  const { amountAtomic, inFlightFastAtomic, config } = input;
  if (!config.enabled) return "FULL";
  if (amountAtomic <= BigInt(0) || amountAtomic > config.maxLoanAtomic) return "FULL";
  if (inFlightFastAtomic !== null && (inFlightFastAtomic < BigInt(0) || inFlightFastAtomic + amountAtomic > config.totalInFlightAtomic)) {
    return "FULL";
  }
  return "FAST";
}

/** Lecture tolérante d'un palier transmis entre rôles : absent ⇒ `FULL`, autre chose ⇒ `null`. */
export function parseFinalityTier(value: unknown): FinalityTier | null {
  if (value === undefined || value === null) return "FULL";
  return value === "FAST" || value === "FULL" ? value : null;
}

/**
 * Décision de l'enclave face à un palier demandé par Next. `FULL` demandé ⇒ `FULL`, toujours.
 * `FAST` demandé ⇒ accepté seulement si la politique attestée de l'enclave l'admet pour ce
 * montant ; sinon `null`, à transformer en refus explicite par l'appelant. L'enclave ne connaît
 * pas l'exposition en cours : elle n'applique que le coupe-circuit et le seuil par prêt.
 */
export function enclaveFinalityTier(requested: unknown, amountAtomic: bigint, config: FastFinalityConfig): FinalityTier | null {
  const tier = parseFinalityTier(requested);
  if (tier === null) return null;
  if (tier === "FULL") return "FULL";
  return finalityTierFor({ amountAtomic, inFlightFastAtomic: null, config }) === "FAST" ? "FAST" : null;
}
