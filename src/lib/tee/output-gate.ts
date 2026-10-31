import "server-only";
import type { TrainedModel } from "./train";

// Output-gate (D-18) : borne ce qui peut sortir du calcul confidentiel. Le canal
// d'exfiltration d'un pipeline d'entraînement (même en TEE) = les poids du modèle,
// où un code malveillant peut encoder la donnée brute (mémorisation, stéga LSB).
const SIG_FIGS = 6; // précision retenue des poids → borne la capacité d'un canal caché (~20 bits/coef)
const MAX_MODEL_BYTES = 256 * 1024; // plafond de la sortie → borne l'info totale exfiltrable
// Plafond générique de largeur de sortie de l'output-gate (≠ MAX_FEATURES de l'algo courant,
// autre couche) : borne l'allocation avant sérialisation quel que soit le producteur.
const MAX_COEFFICIENTS = 10_000;

/** Arrondit à `sig` chiffres significatifs : tue les bits de poids faible, à toute échelle. */
function toSigFigs(x: number, sig: number): number {
  if (!Number.isFinite(x) || x === 0) return 0;
  return Number(x.toPrecision(sig));
}

/**
 * Quantifie poids et métriques, et reconstruit une struct canonique : champs listés
 * explicitement (ordre fixe → sérialisation déterministe + whitelist, aucun champ libre
 * où cacher un canal annexe). Un modèle déjà quantifié repasse à l'identique (idempotent).
 */
export function quantizeModel<T extends TrainedModel>(model: T): T {
  const base = {
    algo: model.algo,
    version: model.version,
    target: model.target,
    features: model.features,
    coefficients: model.coefficients.map((coefficient) => toSigFigs(coefficient, SIG_FIGS)),
  };
  if (model.algo === "linear_regression") {
    return {
      ...base,
      algo: "linear_regression",
      metrics: {
        r2: toSigFigs(model.metrics.r2, SIG_FIGS),
        rmse: toSigFigs(model.metrics.rmse, SIG_FIGS),
        mae: toSigFigs(model.metrics.mae, SIG_FIGS),
        n: model.metrics.n,
      },
    } as T;
  }
  return {
    ...base,
    algo: "logistic_regression",
    metrics: {
      accuracy: toSigFigs(model.metrics.accuracy, SIG_FIGS),
      precision: toSigFigs(model.metrics.precision, SIG_FIGS),
      recall: toSigFigs(model.metrics.recall, SIG_FIGS),
      f1: toSigFigs(model.metrics.f1, SIG_FIGS),
      n: model.metrics.n,
    },
  } as T;
}

/**
 * Applique l'output-gate (D-18) en une seule passe : quantifie, borne largeur et taille,
 * et renvoie le modèle gated (source unique post-gate) + son buffer canonique prêt à
 * chiffrer (= exactement la sérialisation de ce modèle). Lève si un plafond est dépassé.
 */
export function gateModel<T extends TrainedModel>(model: T): { model: T; buffer: Buffer } {
  const gated = quantizeModel(model);
  // Pré-check bon marché avant de matérialiser le JSON (borne l'allocation, anti-DoS).
  if (gated.coefficients.length > MAX_COEFFICIENTS) {
    throw new Error(`Trop de poids (${gated.coefficients.length} > ${MAX_COEFFICIENTS}) — borné par l'output-gate`);
  }
  const buffer = Buffer.from(JSON.stringify(gated));
  if (buffer.length > MAX_MODEL_BYTES) {
    throw new Error(`Sortie trop volumineuse (${buffer.length} > ${MAX_MODEL_BYTES} o) — bornée par l'output-gate`);
  }
  return { model: gated, buffer };
}
