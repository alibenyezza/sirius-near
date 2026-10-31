import type { EvmNetwork } from "@/lib/evm/networks";
import type { ActiveLoanPhase, OnboardingStepId } from "./steps";

/**
 * Textes du parcours d'accueil rangés hors des composants, pour que le test de traduction
 * vérifie chacune de ces clés (le test global ne voit que les littéraux passés à `t()`).
 * `{token}` est le jeton de règlement du réseau (`stablecoinSymbol`), jamais écrit en dur. Les
 * phrases qui parlent du mainnet ont une variante sans ce mot pour le testnet.
 */

type StepCopy = Record<OnboardingStepId, { title: string; body: string }>;

const STEP_COPY_BASE: Omit<StepCopy, "verify"> = {
  connect: { title: "Connecte ton wallet", body: "Ton wallet est ton compte Sirius : pas d’e-mail ni de mot de passe." },
  signin: {
    title: "Connecte-toi",
    body: "Signe un message dans ton wallet : c’est gratuit, ce n’est pas une transaction, et ça prouve que ce wallet est bien à toi.",
  },
  fund: { title: "Ajoute de l’ETH et des {token}", body: "L’ETH paie le gas de chaque transaction ; les {token} paient l’emprunt." },
  pick: { title: "Choisis un dataset", body: "Parcours la marketplace et ouvre la fiche d’un dataset." },
  borrow: { title: "Emprunte-le", body: "Sur la fiche, clique sur Emprunter : le prix du dataset et le compute sont bloqués en escrow." },
  model: { title: "Récupère ton modèle", body: "L’entraînement tourne dans une enclave TEE ; ton modèle t’attend sur la page Entraîner." },
};

const VERIFY_BODY: Record<EvmNetwork, string> = {
  mainnet: "Obligatoire pour prêter et emprunter sur mainnet. Une seule transaction à confirmer.",
  testnet: "Obligatoire pour prêter et emprunter. Une seule transaction à confirmer.",
};

/** Titre et explication de chaque étape de la carte « Get started », selon le réseau du site. */
export function stepCopy(network: EvmNetwork): StepCopy {
  return { verify: { title: "Vérifie ton wallet", body: VERIFY_BODY[network] }, ...STEP_COPY_BASE };
}

/** Accueil du tableau de bord pour un visiteur pas encore connecté ou pas encore signé. */
export const WELCOME_TITLE = "Bienvenue sur Sirius";
export const WELCOME_BODY =
  "Loue des datasets privés pour entraîner tes modèles sans jamais exposer les données ; leurs fournisseurs sont payés à chaque entraînement.";

/** Origine de la fenêtre de vérification. */
export type VerificationIntroReason = "prompt" | "checklist" | "borrow" | "publish";

const GENERAL_INTRO: Record<EvmNetwork, string> = {
  mainnet: "Avant de prêter ou d’emprunter un dataset sur mainnet, ton wallet doit être vérifié. Ça prend une seule transaction.",
  testnet: "Avant de prêter ou d’emprunter un dataset, ton wallet doit être vérifié. Ça prend une seule transaction.",
};

const ACTION_INTRO = {
  borrow: "Pour emprunter ce dataset, ton wallet doit d’abord être vérifié. Une fois fait, l’emprunt reprend tout seul.",
  publish: "Pour publier un dataset, ton wallet doit d’abord être vérifié. Une fois fait, la publication reprend toute seule.",
} as const;

/** Phrase d'introduction de la fenêtre de vérification, selon l'action qui l'a ouverte et le réseau. */
export function verificationIntro(reason: VerificationIntroReason, network: EvmNetwork): string {
  return reason === "borrow" || reason === "publish" ? ACTION_INTRO[reason] : GENERAL_INTRO[network];
}

/** Libellé de chaque phase d'un prêt actif dans l'indicateur global. */
export const LOAN_PHASE_LABEL: Record<ActiveLoanPhase, string> = {
  payment: "paiement en cours de finalisation",
  escrow: "fonds en escrow · lance l’entraînement",
  training: "entraînement en cours",
  delivering: "livraison du modèle",
  attention: "action requise sur Train",
};

/** Ordre des étapes d'un prêt, pour la petite frise de l'indicateur (une échéance dépassée n'y figure pas). */
export const LOAN_PHASE_STEPS: readonly ActiveLoanPhase[] = ["payment", "escrow", "training", "delivering"];

/** Toutes les clés ci-dessus, pour le test de traduction. */
export function onboardingCopyKeys(): string[] {
  const networks: EvmNetwork[] = ["mainnet", "testnet"];
  return [
    ...networks.flatMap((network) => Object.values(stepCopy(network)).flatMap((copy) => [copy.title, copy.body])),
    ...networks.flatMap((network) => (["prompt", "checklist", "borrow", "publish"] as const).map((reason) => verificationIntro(reason, network))),
    ...Object.values(LOAN_PHASE_LABEL),
    WELCOME_TITLE,
    WELCOME_BODY,
  ];
}
