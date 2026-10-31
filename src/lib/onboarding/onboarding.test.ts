import assert from "node:assert/strict";
import { test } from "node:test";
import { EN_MESSAGES } from "@/lib/i18n/english";
import { LOAN_PHASE_LABEL, WELCOME_BODY, WELCOME_TITLE, onboardingCopyKeys, stepCopy, verificationIntro } from "./copy";
import {
  ONBOARDING_STEP_IDS,
  activeLoanSummary,
  createInFlightGuard,
  loanPhase,
  deriveOnboardingProgress,
  gateDecision,
  isPaidLoan,
  parseChecklistDismissed,
  parseKybGate,
  shouldPromptVerification,
  showsChecklist,
  verificationMode,
  type OnboardingInput,
  type OnboardingLoan,
} from "./steps";

const ME = `0x${"ab".repeat(20)}`;
const ME_UPPER = `0x${"AB".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const TX = `0x${"22".repeat(32)}`;

function input(overrides: Partial<OnboardingInput> = {}): OnboardingInput {
  return { connected: true, authenticated: true, kyb: "missing", gasWei: "0", stableAtomic: "0", loans: [], viewer: ME, ...overrides };
}

function loan(status: string, overrides: Partial<OnboardingLoan> = {}): OnboardingLoan {
  return { borrower: ME, status, evmLockTxHash: null, cancelTxHash: null, ...overrides };
}

function done(progress: ReturnType<typeof deriveOnboardingProgress>) {
  return Object.fromEntries(progress.steps.map((step) => [step.id, step.done]));
}

test("ordre des étapes : du wallet au modèle livré", () => {
  assert.deepEqual([...ONBOARDING_STEP_IDS], ["connect", "signin", "verify", "fund", "pick", "borrow", "model"]);
});

test("visiteur sans wallet : la première étape est la connexion, rien d'autre n'est coché", () => {
  const progress = deriveOnboardingProgress(input({ connected: false, authenticated: false, kyb: null, gasWei: null, stableAtomic: null, loans: null, viewer: null }));
  assert.equal(progress.current, "connect");
  assert.equal(progress.completed, 0);
  assert.equal(progress.total, 7);
  assert.deepEqual(progress.funding, { gas: true, token: true });
  // Session ou soldes restés en mémoire sans wallet connecté : jamais pris en compte.
  const stale = deriveOnboardingProgress(input({ connected: false, authenticated: true, kyb: "valid", gasWei: "1", stableAtomic: "1", loans: [loan("SETTLED")] }));
  assert.equal(stale.current, "connect");
  assert.equal(stale.completed, 0);
});

test("wallet connecté mais pas signé : la signature est l'étape courante, KYB et prêts ignorés", () => {
  const progress = deriveOnboardingProgress(input({ authenticated: false, kyb: "valid", loans: [loan("SETTLED")] }));
  assert.equal(progress.current, "signin");
  assert.deepEqual(done(progress), { connect: true, signin: false, verify: false, fund: false, pick: false, borrow: false, model: false });
  // Les soldes se lisent sans session : des fonds déjà présents cochent l'étape.
  const funded = deriveOnboardingProgress(input({ authenticated: false, gasWei: "1", stableAtomic: "1" }));
  assert.equal(funded.current, "signin");
  assert.equal(done(funded).fund, true);
  assert.equal(funded.completed, 2);
});

test("compte neuf signé : connexion et signature faites, la vérification est l'étape courante", () => {
  const progress = deriveOnboardingProgress(input());
  assert.deepEqual(progress.steps.map((step) => step.id), [...ONBOARDING_STEP_IDS]);
  assert.equal(progress.current, "verify");
  assert.equal(progress.completed, 2);
  assert.equal(progress.total, 7);
  assert.deepEqual(progress.funding, { gas: true, token: true });
});

test("statut de vérification inconnu ou pas encore lu : l'étape reste à faire", () => {
  assert.equal(deriveOnboardingProgress(input({ kyb: "unknown" })).current, "verify");
  assert.equal(deriveOnboardingProgress(input({ kyb: null })).current, "verify");
});

test("fonds : il faut à la fois de l'ETH pour le gas et le jeton pour emprunter", () => {
  const onlyGas = deriveOnboardingProgress(input({ kyb: "valid", gasWei: "1000" }));
  assert.equal(onlyGas.current, "fund");
  assert.deepEqual(onlyGas.funding, { gas: false, token: true });
  const onlyToken = deriveOnboardingProgress(input({ kyb: "valid", stableAtomic: "5" }));
  assert.equal(onlyToken.current, "fund");
  assert.deepEqual(onlyToken.funding, { gas: true, token: false });
  const both = deriveOnboardingProgress(input({ kyb: "valid", gasWei: "1000", stableAtomic: "5" }));
  assert.equal(both.current, "pick");
  // Solde illisible : jamais compté comme disponible.
  for (const unreadable of [null, "", "-1", "0x10", "abc"]) {
    assert.equal(deriveOnboardingProgress(input({ kyb: "valid", gasWei: unreadable, stableAtomic: "5" })).funding.gas, true);
  }
});

test("emprunt payé : les étapes amont sont validées même si le solde est retombé à zéro", () => {
  const progress = deriveOnboardingProgress(input({ kyb: "valid", loans: [loan("ESCROWED", { evmLockTxHash: TX })] }));
  assert.deepEqual(done(progress), { connect: true, signin: true, verify: true, fund: true, pick: true, borrow: true, model: false });
  assert.equal(progress.current, "model");
});

test("un devis abandonné compte comme dataset choisi, pas comme emprunt", () => {
  const progress = deriveOnboardingProgress(input({ kyb: "valid", gasWei: "1", stableAtomic: "1", loans: [loan("PENDING")] }));
  assert.deepEqual(done(progress), { connect: true, signin: true, verify: true, fund: true, pick: true, borrow: false, model: false });
  assert.equal(progress.current, "borrow");
});

test("modèle livré : tout est fait, la carte n'a plus d'étape courante", () => {
  const progress = deriveOnboardingProgress(input({ kyb: "valid", loans: [loan("SETTLED")] }));
  assert.equal(progress.current, null);
  assert.equal(progress.completed, 7);
});

test("seuls les prêts où le wallet est emprunteur comptent, quelle que soit la casse", () => {
  const asProvider = deriveOnboardingProgress(input({ kyb: "valid", loans: [loan("SETTLED", { borrower: OTHER })] }));
  assert.equal(asProvider.current, "fund");
  const mixedCase = deriveOnboardingProgress(input({ kyb: "valid", viewer: ME_UPPER, loans: [loan("SETTLED")] }));
  assert.equal(mixedCase.current, null);
  const malformed = deriveOnboardingProgress(input({ kyb: "valid", loans: [loan("SETTLED", { borrower: "pas une adresse" })] }));
  assert.equal(malformed.current, "fund");
  assert.equal(deriveOnboardingProgress(input({ kyb: "valid", viewer: null, loans: [loan("SETTLED")] })).current, "fund");
});

test("emprunt payé : lock envoyé, confirmé, réglé ou remboursé ; jamais un devis ou une annulation sans remboursement", () => {
  for (const status of ["SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "SETTLED"]) assert.equal(isPaidLoan(loan(status)), true, status);
  assert.equal(isPaidLoan(loan("PENDING")), false);
  assert.equal(isPaidLoan(loan("PENDING", { evmLockTxHash: TX })), true);
  assert.equal(isPaidLoan(loan("CANCELLED")), false);
  assert.equal(isPaidLoan(loan("CANCELLED", { cancelTxHash: TX })), true);
  assert.equal(isPaidLoan(loan("INCONNU")), false);
});

test("affichage de la carte : préférence lue, non fermée, parcours inachevé — ou rouverte à la main", () => {
  const signedIn = true;
  assert.equal(showsChecklist({ signedIn, dismissed: null, complete: false, reopened: false }), false);
  assert.equal(showsChecklist({ signedIn, dismissed: true, complete: false, reopened: false }), false);
  assert.equal(showsChecklist({ signedIn, dismissed: false, complete: false, reopened: false }), true);
  assert.equal(showsChecklist({ signedIn, dismissed: false, complete: true, reopened: false }), false);
  assert.equal(showsChecklist({ signedIn, dismissed: true, complete: true, reopened: true }), true);
});

test("affichage de la carte avant la signature : toujours, sans préférence à lire", () => {
  assert.equal(showsChecklist({ signedIn: false, dismissed: null, complete: false, reopened: false }), true);
  // Une fermeture restée en mémoire d'un autre compte ne masque pas l'accueil d'un visiteur.
  assert.equal(showsChecklist({ signedIn: false, dismissed: true, complete: false, reopened: false }), true);
});

test("fenêtre de vérification : invitation si l'accès instantané est coupé, explication du gas sans ETH", () => {
  assert.equal(verificationMode({ instantAccess: false, gasWei: "100" }), "invitation");
  assert.equal(verificationMode({ instantAccess: false, gasWei: "0" }), "invitation");
  assert.equal(verificationMode({ instantAccess: true, gasWei: "0" }), "needs-gas");
  assert.equal(verificationMode({ instantAccess: true, gasWei: "1" }), "instant");
  // Solde illisible : on laisse essayer, le wallet dira s'il manque de quoi payer.
  assert.equal(verificationMode({ instantAccess: true, gasWei: null }), "instant");
});

test("garde Emprunter / Publier : seul un « non vérifié » lu sur le registre ouvre la vérification", () => {
  assert.equal(gateDecision("missing"), "verify");
  assert.equal(gateDecision("valid"), "proceed");
  assert.equal(gateDecision("unknown"), "proceed");
  assert.equal(gateDecision(null), "proceed");
});

test("proposition après connexion : une fois, jamais par-dessus une autre fenêtre ou un tuto à venir", () => {
  const base = { authenticated: true, kyb: "missing" as const, instantAccess: true, shownThisSession: false, overlayOpen: false, tourPending: false };
  assert.equal(shouldPromptVerification(base), true);
  assert.equal(shouldPromptVerification({ ...base, authenticated: false }), false);
  assert.equal(shouldPromptVerification({ ...base, kyb: "valid" }), false);
  assert.equal(shouldPromptVerification({ ...base, kyb: "unknown" }), false);
  assert.equal(shouldPromptVerification({ ...base, kyb: null }), false);
  assert.equal(shouldPromptVerification({ ...base, instantAccess: false }), false);
  assert.equal(shouldPromptVerification({ ...base, shownThisSession: true }), false);
  assert.equal(shouldPromptVerification({ ...base, overlayOpen: true }), false);
  assert.equal(shouldPromptVerification({ ...base, tourPending: true }), false);
});

test("statut de vérification : seule une réponse bien formée donne « vérifié » ou « non vérifié »", () => {
  assert.deepEqual(parseKybGate({ valid: true, revoked: false, expiresAt: 1, instantAccess: true }), { kyb: "valid", instantAccess: true });
  assert.deepEqual(parseKybGate({ valid: false, revoked: false, expiresAt: null }), { kyb: "missing", instantAccess: false });
  assert.deepEqual(parseKybGate({ valid: false, revoked: true, expiresAt: 1 }), { kyb: "missing", instantAccess: false });
  // Incohérent (valide et révoqué) ou mal formé : inconnu, rien n'est bloqué.
  assert.equal(parseKybGate({ valid: true, revoked: true }).kyb, "unknown");
  for (const body of [null, undefined, [], "x", {}, { known: true }, { valid: "true", revoked: false }]) {
    assert.equal(parseKybGate(body).kyb, "unknown");
  }
  assert.equal(parseKybGate({ valid: false, revoked: false, instantAccess: "true" }).instantAccess, false);
});

test("préférence de la carte : lue seulement dans le profil du wallet attendu", () => {
  assert.equal(parseChecklistDismissed({ address: ME, settings: { onboardingDismissed: true } }, ME_UPPER), true);
  assert.equal(parseChecklistDismissed({ address: ME, settings: {} }, ME), false);
  assert.equal(parseChecklistDismissed({ address: ME, settings: { onboardingDismissed: "true" } }, ME), false);
  assert.equal(parseChecklistDismissed({ address: OTHER, settings: { onboardingDismissed: false } }, ME), null);
  for (const body of [null, [], {}, { address: ME }, { address: ME, settings: null }]) {
    assert.equal(parseChecklistDismissed(body, ME), null);
  }
});

test("phase d'un prêt : paiement en finalisation, escrow, entraînement, livraison", () => {
  assert.equal(loanPhase(loan("SUBMITTING")), "payment");
  assert.equal(loanPhase(loan("PENDING", { evmLockTxHash: TX })), "payment");
  assert.equal(loanPhase(loan("ESCROWED")), "escrow");
  assert.equal(loanPhase(loan("TRAINING")), "training");
  assert.equal(loanPhase(loan("SETTLING")), "delivering");
  // Devis refusé ou abandonné, prêt réglé ou annulé : pas en cours.
  for (const status of ["PENDING", "SETTLED", "CANCELLED", "INCONNU"]) assert.equal(loanPhase(loan(status)), null, status);
  assert.equal(loanPhase(loan("SETTLING", { refundable: true })), "attention");
  assert.equal(EN_MESSAGES[LOAN_PHASE_LABEL.payment], "payment finalizing");
  assert.equal(EN_MESSAGES[LOAN_PHASE_LABEL.escrow], "funds in escrow — start training");
  assert.equal(EN_MESSAGES[LOAN_PHASE_LABEL.training], "training");
  assert.equal(EN_MESSAGES[LOAN_PHASE_LABEL.delivering], "delivering model");
});

test("indicateur global : prêts actifs de l'emprunteur, la phase qui demande une action en premier", () => {
  assert.equal(activeLoanSummary(null, ME), null);
  assert.equal(activeLoanSummary([loan("PENDING"), loan("SETTLED"), loan("CANCELLED")], ME), null);
  assert.deepEqual(activeLoanSummary([loan("SUBMITTING")], ME), { count: 1, phase: "payment" });
  assert.deepEqual(activeLoanSummary([loan("PENDING", { evmLockTxHash: TX })], ME), { count: 1, phase: "payment" });
  assert.deepEqual(activeLoanSummary([loan("ESCROWED")], ME), { count: 1, phase: "escrow" });
  assert.deepEqual(activeLoanSummary([loan("SUBMITTING"), loan("TRAINING")], ME), { count: 2, phase: "training" });
  assert.deepEqual(activeLoanSummary([loan("TRAINING"), loan("SETTLING")], ME), { count: 2, phase: "delivering" });
  // Fonds en escrow : l'entraînement est à lancer, cela passe avant un prêt qui suit son cours.
  assert.deepEqual(activeLoanSummary([loan("SETTLING"), loan("ESCROWED")], ME), { count: 2, phase: "escrow" });
  assert.deepEqual(activeLoanSummary([loan("TRAINING", { refundable: true }), loan("ESCROWED")], ME), { count: 2, phase: "attention" });
  // Prêts où l'on est fournisseur : jamais affichés.
  assert.equal(activeLoanSummary([loan("TRAINING", { borrower: OTHER })], ME), null);
  assert.equal(activeLoanSummary([loan("TRAINING")], null), null);
});

test("verrou d'action : un double clic pendant la garde KYB ne lance qu'une préparation", async () => {
  const guard = createInFlightGuard();
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action = async () => {
    calls += 1;
    await pending;
  };
  const first = guard.run(action);
  assert.equal(guard.running, true);
  assert.equal(await guard.run(action), false, "second clic ignoré");
  release();
  assert.equal(await first, true);
  assert.equal(calls, 1);
  assert.equal(guard.running, false);
  // Relâché même en erreur : l'utilisateur peut réessayer.
  await assert.rejects(guard.run(async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(guard.running, false);
  assert.equal(await guard.run(async () => {}), true);
});

test("fenêtre de vérification : une fin tardive d'une ouverture remplacée ne ferme pas la nouvelle", async () => {
  const store = await import("@/components/onboarding/onboarding-store");
  const first = store.requestVerification("borrow");
  const firstId = store.useOnboardingStore.getState().dialog!.id;
  const second = store.requestVerification("publish");
  const secondId = store.useOnboardingStore.getState().dialog!.id;
  assert.notEqual(firstId, secondId);
  // La première ouverture a été remplacée : son action d'origine ne reprend pas.
  assert.equal(await first, false);
  // Formulaire d'invitation de la première fenêtre qui aboutit après coup : sans effet.
  store.closeVerification(true, firstId);
  assert.equal(store.useOnboardingStore.getState().dialog?.id, secondId);
  store.closeVerification(true, secondId);
  assert.equal(store.useOnboardingStore.getState().dialog, null);
  assert.equal(await second, true);
});

test("textes sensibles au réseau : jamais « mainnet » sur le testnet", () => {
  for (const reason of ["prompt", "checklist", "borrow", "publish"] as const) {
    assert.doesNotMatch(verificationIntro(reason, "testnet"), /mainnet/i, reason);
    assert.doesNotMatch(EN_MESSAGES[verificationIntro(reason, "testnet")], /mainnet/i, reason);
  }
  for (const copy of Object.values(stepCopy("testnet"))) {
    assert.doesNotMatch(`${copy.title} ${copy.body}`, /mainnet/i);
    assert.doesNotMatch(`${EN_MESSAGES[copy.title]} ${EN_MESSAGES[copy.body]}`, /mainnet/i);
  }
  assert.doesNotMatch(`${EN_MESSAGES[WELCOME_TITLE]} ${EN_MESSAGES[WELCOME_BODY]}`, /mainnet/i);
  assert.match(EN_MESSAGES[stepCopy("mainnet").verify.body], /mainnet/);
  assert.match(EN_MESSAGES[verificationIntro("prompt", "mainnet")], /mainnet/);
});

test("tous les textes du parcours ont une traduction anglaise sans « USDC » écrit en dur", () => {
  for (const key of onboardingCopyKeys()) {
    assert.ok(Object.hasOwn(EN_MESSAGES, key), key);
    assert.doesNotMatch(EN_MESSAGES[key], /USDC/, key);
  }
  assert.match(EN_MESSAGES[stepCopy("mainnet").fund.title], /\{token\}/);
});

test("étapes de connexion : la signature est présentée comme gratuite et sans transaction", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const copy = stepCopy(network);
    assert.equal(EN_MESSAGES[copy.connect.title], "Connect your wallet");
    assert.equal(EN_MESSAGES[copy.signin.title], "Sign in");
    assert.match(EN_MESSAGES[copy.signin.body], /free/);
    assert.match(EN_MESSAGES[copy.signin.body], /not a transaction/);
    assert.match(EN_MESSAGES[copy.signin.body], /own this wallet/);
  }
  assert.equal(EN_MESSAGES[WELCOME_TITLE], "Welcome to Sirius");
  assert.match(EN_MESSAGES[WELCOME_BODY], /without ever exposing the data/);
});
