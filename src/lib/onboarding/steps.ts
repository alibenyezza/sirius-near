import { addressesEqual } from "@/lib/evm/address";

/**
 * Parcours d'accueil : logique pure, sans React ni réseau.
 *
 * Les étapes de la carte « Get started » sont déduites de l'état réel du compte (wallet connecté
 * et session signée, statut de vérification lu sur le registre, soldes lus sur la chaîne, prêts renvoyés par
 * `GET /api/loans`) : rien n'est coché parce qu'un bouton a été cliqué. Seule la fermeture de la
 * carte est mémorisée (réglage `onboardingDismissed` du profil), et seulement une fois signé.
 *
 * En cas de doute (lecture en échec), une étape reste « à faire » et la décision de blocage
 * penche vers « laisser essayer » : le serveur et le contrat restent les seuls gardiens.
 */

/** Statut KYB vu par l'interface : `unknown` quand la lecture a échoué. */
export type KybGateState = "valid" | "missing" | "unknown";

export const ONBOARDING_STEP_IDS = ["connect", "signin", "verify", "fund", "pick", "borrow", "model"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export interface OnboardingLoan {
  borrower?: string | null;
  status: string;
  evmLockTxHash?: string | null;
  cancelTxHash?: string | null;
  refundable?: boolean;
}

export interface OnboardingInput {
  /** Wallet connecté au site (adresse connue). */
  connected: boolean;
  /** Session signée : sans elle, ni le statut de vérification ni les prêts ne sont lisibles. */
  authenticated: boolean;
  /** `null` : statut pas encore lu. */
  kyb: KybGateState | null;
  /** Solde natif en wei (chaîne décimale) ; `null` si illisible ou pas encore lu. */
  gasWei: string | null;
  /** Solde du jeton de règlement en unités atomiques ; `null` si illisible ou pas encore lu. */
  stableAtomic: string | null;
  /** Prêts du compte (`GET /api/loans`), ou `null` si la liste n'est pas encore lue. */
  loans: readonly OnboardingLoan[] | null;
  /** Wallet affiché : seuls ses prêts d'emprunteur comptent. */
  viewer: string | null;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
}

export interface FundingNeeds {
  /** Pas d'ETH pour payer le gas (ou solde illisible). */
  gas: boolean;
  /** Pas de jeton de règlement pour emprunter (ou solde illisible). */
  token: boolean;
}

export interface OnboardingProgress {
  steps: OnboardingStep[];
  /** Première étape non faite ; `null` quand tout est fait. */
  current: OnboardingStepId | null;
  completed: number;
  total: number;
  funding: FundingNeeds;
}

function positive(value: string | null): boolean {
  if (value === null || !/^\d+$/.test(value)) return false;
  return BigInt(value) > BigInt(0);
}

function sameAddress(left: string | null | undefined, right: string | null): boolean {
  if (typeof left !== "string" || !right) return false;
  try {
    return addressesEqual(left, right);
  } catch {
    return false;
  }
}

/** Prêts où le wallet est emprunteur (`GET /api/loans` renvoie aussi ceux où il fournit). */
export function borrowerLoans(loans: readonly OnboardingLoan[] | null, viewer: string | null): OnboardingLoan[] {
  return (loans ?? []).filter((loan) => sameAddress(loan.borrower, viewer));
}

/**
 * Emprunt réellement payé : lock envoyé ou confirmé, règlement, ou remboursement confirmé. Un
 * PENDING sans hash de lock est un devis refusé ou abandonné, et une réservation annulée sans
 * remboursement n'a jamais rien verrouillé.
 */
export function isPaidLoan(loan: OnboardingLoan): boolean {
  switch (loan.status) {
    case "SUBMITTING":
    case "ESCROWED":
    case "TRAINING":
    case "SETTLING":
    case "SETTLED":
      return true;
    case "PENDING":
      return Boolean(loan.evmLockTxHash);
    case "CANCELLED":
      return Boolean(loan.cancelTxHash);
    default:
      return false;
  }
}

/** Étapes de la carte « Get started », dans l'ordre, et la suivante à faire. */
export function deriveOnboardingProgress(input: OnboardingInput): OnboardingProgress {
  const connected = input.connected;
  const signed = connected && input.authenticated;
  // Avant la signature, le statut de vérification et les prêts éventuellement en mémoire ne sont pas ceux
  // de cette session : on ne s'y fie pas. Les soldes, eux, se lisent dès la connexion.
  const mine = signed ? borrowerLoans(input.loans, input.viewer) : [];
  const borrowed = mine.some(isPaidLoan);
  const funding: FundingNeeds = {
    gas: !connected || !positive(input.gasWei),
    token: !connected || !positive(input.stableAtomic),
  };
  const done: Record<OnboardingStepId, boolean> = {
    connect: connected,
    signin: signed,
    verify: signed && input.kyb === "valid",
    // Un emprunt déjà payé prouve que les fonds étaient là, même si le solde est retombé à zéro.
    fund: borrowed || (!funding.gas && !funding.token),
    // Choisir un dataset, c'est en avoir préparé l'emprunt, même abandonné au devis.
    pick: mine.length > 0,
    borrow: borrowed,
    model: mine.some((loan) => loan.status === "SETTLED"),
  };
  // Une étape aval faite valide les étapes amont qui en sont la condition (un modèle livré
  // suppose un emprunt, un emprunt suppose un dataset choisi).
  if (done.model) done.borrow = true;
  if (done.borrow) done.pick = true;
  const steps = ONBOARDING_STEP_IDS.map((id) => ({ id, done: done[id] }));
  const completed = steps.filter((step) => step.done).length;
  return {
    steps,
    current: steps.find((step) => !step.done)?.id ?? null,
    completed,
    total: steps.length,
    funding,
  };
}

/**
 * La carte est-elle affichée ? Avant la signature, toujours : il n'y a pas encore de profil où
 * lire ou ranger sa fermeture, et c'est justement là qu'elle guide. Une fois signé, jamais tant
 * que la préférence n'est pas lue (pas de clignotement), ni une fois fermée. Un parcours terminé
 * la masque aussi, sauf si l'utilisateur l'a rouverte lui-même depuis le menu (`reopened`).
 */
export function showsChecklist(state: { signedIn: boolean; dismissed: boolean | null; complete: boolean; reopened: boolean }): boolean {
  if (!state.signedIn) return true;
  if (state.reopened) return true;
  if (state.dismissed !== false) return false;
  return !state.complete;
}

/** Contenu de la fenêtre de vérification. */
export type VerificationMode =
  /** Accès instantané proposé, gas disponible (ou illisible : on laisse essayer). */
  | "instant"
  /** Accès instantané proposé, mais aucun ETH : expliquer comment en obtenir avant la transaction. */
  | "needs-gas"
  /** Accès instantané coupé côté serveur : formulaire d'invitation. */
  | "invitation";

export function verificationMode(input: { instantAccess: boolean; gasWei: string | null }): VerificationMode {
  if (!input.instantAccess) return "invitation";
  // Solde illisible : on ne bloque pas, le wallet dira lui-même s'il manque de quoi payer.
  if (input.gasWei === null) return "instant";
  return positive(input.gasWei) ? "instant" : "needs-gas";
}

/**
 * Au clic sur Emprunter ou Publier : ouvrir la vérification seulement si le registre dit
 * « non vérifié ». Statut illisible : on laisse l'action partir, le serveur tranche et son
 * message reste affiché.
 */
export function gateDecision(kyb: KybGateState | null): "proceed" | "verify" {
  return kyb === "missing" ? "verify" : "proceed";
}

/**
 * Fenêtre proposée juste après la connexion : wallet signé et non vérifié, accès instantané
 * actif, pas déjà proposée dans cette session, et aucune autre fenêtre (tuto, fonds, devis)
 * ouverte — deux fenêtres superposées se disputeraient le focus.
 */
export function shouldPromptVerification(input: {
  authenticated: boolean;
  kyb: KybGateState | null;
  instantAccess: boolean;
  shownThisSession: boolean;
  overlayOpen: boolean;
  /** Tutos en cours de lecture (`loading`) : le tuto de bienvenue peut encore s'ouvrir. */
  tourPending: boolean;
}): boolean {
  return (
    input.authenticated &&
    input.kyb === "missing" &&
    input.instantAccess &&
    !input.shownThisSession &&
    !input.overlayOpen &&
    !input.tourPending
  );
}

/**
 * Phase d'un prêt actif pour l'indicateur global :
 *  - `payment` : lock envoyé, pas encore finalisé (SUBMITTING, ou PENDING avec un hash de lock) ;
 *  - `escrow` : fonds en escrow, l'entraînement est à lancer depuis Train (ESCROWED) ;
 *  - `training` : entraînement en cours (TRAINING) ;
 *  - `delivering` : règlement envoyé, modèle en cours de livraison (SETTLING) ;
 *  - `attention` : échéance dépassée, une action est requise sur Train.
 */
export type ActiveLoanPhase = "payment" | "escrow" | "training" | "delivering" | "attention";

/** Priorité d'affichage : d'abord ce qui demande une action de l'utilisateur. */
const PHASE_ORDER: Record<ActiveLoanPhase, number> = { attention: 4, escrow: 3, delivering: 2, training: 1, payment: 0 };

/** Phase d'un prêt d'emprunteur, ou `null` s'il n'est pas en cours (devis, réglé, annulé). */
export function loanPhase(loan: OnboardingLoan): ActiveLoanPhase | null {
  let phase: ActiveLoanPhase;
  if (loan.status === "SUBMITTING" || (loan.status === "PENDING" && Boolean(loan.evmLockTxHash))) phase = "payment";
  else if (loan.status === "ESCROWED") phase = "escrow";
  else if (loan.status === "TRAINING") phase = "training";
  else if (loan.status === "SETTLING") phase = "delivering";
  else return null;
  return loan.refundable === true ? "attention" : phase;
}

/**
 * Prêts d'emprunteur en cours et la phase à afficher : celle du prêt qui demande le plus
 * d'attention. `null` sans prêt actif : l'indicateur ne s'affiche pas.
 */
export function activeLoanSummary(
  loans: readonly OnboardingLoan[] | null,
  viewer: string | null,
): { count: number; phase: ActiveLoanPhase } | null {
  let phase: ActiveLoanPhase | null = null;
  let count = 0;
  for (const loan of borrowerLoans(loans, viewer)) {
    const next = loanPhase(loan);
    if (next === null) continue;
    count += 1;
    if (phase === null || PHASE_ORDER[next] > PHASE_ORDER[phase]) phase = next;
  }
  return phase === null ? null : { count, phase };
}

/**
 * Verrou synchrone d'une action à un seul exemplaire en vol (Emprunter, Publier). La garde KYB
 * lit le réseau AVANT que le bouton passe en « occupé » : sans ce verrou, un double clic
 * lancerait deux préparations (deux réservations, deux devis). Un appel concurrent est ignoré
 * et résout `false` ; le verrou est relâché quand l'action se termine, même en erreur.
 */
export function createInFlightGuard() {
  let running = false;
  return {
    get running() {
      return running;
    },
    async run(action: () => Promise<unknown>): Promise<boolean> {
      if (running) return false;
      running = true;
      try {
        await action();
        return true;
      } finally {
        running = false;
      }
    },
  };
}

export type InFlightGuard = ReturnType<typeof createInFlightGuard>;

/**
 * Préférence « carte fermée » lue dans la réponse de `/api/profile`. `null` si la réponse ne
 * correspond pas au wallet attendu (session d'un autre compte restée dans un autre onglet) :
 * la carte ne s'affiche alors pas, plutôt que d'appliquer la préférence d'un autre wallet.
 */
export function parseChecklistDismissed(profile: unknown, expectedAddress: string): boolean | null {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const { address, settings } = profile as { address?: unknown; settings?: unknown };
  if (typeof address !== "string" || !sameAddress(address, expectedAddress)) return null;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  return (settings as { onboardingDismissed?: unknown }).onboardingDismissed === true;
}

/** Lit la réponse de `GET /api/kyb/status` : `unknown` pour tout ce qui est mal formé. */
export function parseKybGate(body: unknown): { kyb: KybGateState; instantAccess: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kyb: "unknown", instantAccess: false };
  const { valid, revoked, instantAccess } = body as Record<string, unknown>;
  const kyb: KybGateState = typeof valid !== "boolean" || typeof revoked !== "boolean"
    ? "unknown"
    : valid && !revoked ? "valid" : valid ? "unknown" : "missing";
  return { kyb, instantAccess: instantAccess === true };
}
