import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AppError } from "@/lib/app-error";
import { RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { isRecordedQuoteHardwareValid } from "@/lib/tee/quote";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "settle.ts"), "utf8");

test("une release EVM réconciliée devient SETTLED après une réponse runner perdue", () => {
  const recovery = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(recovery, /resolution\?\.state === "settled"[\s\S]*?status: "SETTLED"[\s\S]*?settleTxHash: resolution\.txHash/);
});

test("le résultat runner est attesté avant sa persistance", () => {
  const preparation = SOURCE.slice(SOURCE.indexOf("export async function prepareLoanResult"));

  assert.match(preparation, /await verifyLoanAttestation\(/);
  assert.match(preparation, /attestationPayload: result\.attestation\.payload/);
  assert.match(preparation, /attestationQuote: result\.attestation\.evidence\?\.quote \?\? null/);
  assert.match(preparation, /auditReceipt: result\.attestation\.signature/);
});

test("le règlement refuse un résultat sans preuve d’attestation", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(settlement, /!loan\.attestationHash/);
  assert.match(settlement, /!loan\.attestationPayload/);
  assert.match(settlement, /TEE_MODE === "phala"/);
});

test("le règlement reprend avec le hash attesté, pas une capsule navigateur", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));

  assert.match(settlement, /payload\.releaseEnvelopeHash/);
  assert.doesNotMatch(settlement, /releaseEnvelopeHash: string/);
});

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("un règlement en attente de finalité reste SETTLING avec son hash, sans réconciliation ni retour arrière", () => {
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));
  const pending = settlement.slice(settlement.indexOf("if (error instanceof RunnerFinalityPending)"));

  assert.match(pending, /^if \(error instanceof RunnerFinalityPending\) \{[\s\S]*?status: "SETTLING"[\s\S]*?settleTxHash: error\.transactionHash[\s\S]*?throw error;\s*\}/);
  assert.ok(settlement.indexOf("RunnerFinalityPending") < settlement.indexOf("reconcileLoanEscrow"), "l’attente passe avant toute réconciliation");
});

test("l’entraînement n’est demandé au runner qu’après finalité du lock, au palier décidé en transaction", () => {
  const preparation = SOURCE.slice(SOURCE.indexOf("export async function prepareLoanResult"));

  assert.ok(preparation.indexOf("assertLockStable") < preparation.indexOf('status: "TRAINING"'), "garde avant la prise du lease");
  assert.ok(preparation.indexOf("assertLockStable") < preparation.indexOf("runLoanJobInRunner("));
  // Le palier candidat est lu sans écrire (dryRun), avec relecture du montant on-chain ; la garde de
  // profondeur passe à ce palier, et seulement ensuite la ligne est marquée (plafond jamais occupé
  // par un lock pas encore assez profond). Le runner reçoit le palier de la ligne.
  assert.match(preparation, /verifyOnChainAmount = async \(\) => \{[\s\S]*?readLoan\([\s\S]*?onChain\?\.amountUsdcAtomic === lock\.amountUsdcAtomic/);
  const dryRun = preparation.indexOf("assignLoanFinalityTier(lock, verifyOnChainAmount, { dryRun: true })");
  const guard = preparation.indexOf("await assertLockStable(client, lockRef, candidate, LOCK_FINALITY_PENDING)");
  const marking = preparation.indexOf("await assignLoanFinalityTier(lock, verifyOnChainAmount);");
  assert.ok(dryRun > 0 && dryRun < guard && guard < marking, "candidat → garde → marquage");
  assert.match(preparation, /if \(marked !== "FAST"\) await assertLockStable\(client, lockRef, "FULL", LOCK_FINALITY_PENDING\)/);
  // Prêt rapide réglé : preuves de rediffusion conservées après le passage en SETTLED, sans bloquer.
  const settled = SOURCE.slice(SOURCE.indexOf('status: "SETTLED", settleTxHash: settlement.settleTxHash'));
  assert.match(settled, /if \(effectiveLoanFinalityTier\(loan\.finalityTier\) === "FAST"\) await recordSettlementEvidence\(loanId\);/);
  // Palier effectif : celui de la ligne tant que le coupe-circuit est ouvert, FULL sinon.
  assert.match(preparation, /runLoanJobInRunner\([\s\S]*?billingQuote,\s*effectiveLoanFinalityTier\(loan\.finalityTier\),\s*\)/);
  const settlement = SOURCE.slice(SOURCE.indexOf("export async function settlePreparedLoan"));
  assert.match(settlement, /settleLoanInRunner\([\s\S]*?authorization,\s*effectiveLoanFinalityTier\(loan\.finalityTier\),\s*\)/);
  const key = read("src", "app", "api", "loans", "[id]", "key", "route.ts");
  assert.match(key, /loanModelKeyInRunner\([\s\S]*?loan\.settleTxHash,\s*effectiveLoanFinalityTier\(loan\.finalityTier\),\s*\)/);
  assert.match(key, /if \(loan\.finalityReview\) return NextResponse\.json\(\{ error: "Règlement en cours de revue : livraison suspendue" \}, \{ status: 409 \}\)/);
});

test("finalité rapide : l'enclave arbitre seule le palier des trois opérations v7, Next ne transmet que FAST", () => {
  const handler = read("src", "runner", "handler.ts");
  const client = read("src", "lib", "tee", "runner-client.ts");
  // Montant du devis signé, bornes de l'environnement attesté, refus explicite sinon.
  // La décision ne réserve rien : règlement et livraison de clé la reprennent telle quelle.
  const decision = handler.slice(handler.indexOf("function loanFinalityTier("), handler.indexOf("function reserveFastExposure("));
  assert.match(decision, /enclaveFinalityTier\(requested, BigInt\(totalQuoteAmount\(quote\)\), fastFinalityPolicy\(\)\)[\s\S]*?throw new AppError\("Finalité rapide refusée par l’enclave pour ce prêt", 409\)/);
  assert.doesNotMatch(decision, /reserveFastExposure|requireBillingBudget/, "aucune réservation dans la décision");
  // Plafond d'exposition de l'enclave : réservé au lancement seulement, après lecture du lock à la
  // profondeur rapide ; atteint ⇒ finalité complète si le lock est finalisé, sinon « en attente »
  // (RunnerRetryLater : ni échec compté ni crédit consommé), jamais un refus dur.
  // `lastIndexOf` : les mêmes libellés apparaissent d'abord dans scopeForRunnerOp.
  const run = handler.slice(handler.lastIndexOf('case "run-loan-job"'), handler.lastIndexOf('case "recover-loan-job"'));
  assert.match(run, /loanFinalityTier\(body\.finalityTier, signedQuote\.quote\) : "FULL"/, "run-loan-job : finalité complète sans devis v7");
  const scopeRead = run.indexOf("loanScope(candidateTier)");
  const reservation = run.indexOf("!reserveFastExposure(signedQuote.quote)");
  assert.ok(scopeRead > 0 && scopeRead < reservation, "lecture du lock avant la réservation");
  assert.match(run, /!reserveFastExposure\(signedQuote\.quote\)\) \{[\s\S]*?try \{ await loanScope\("FULL"\); \} catch \{ throw new RunnerRetryLater\(LOCK_FINALITY_PENDING\); \}/);
  // Les deux autres opérations décident sans réserver : une livraison après release ne touche pas le plafond.
  const settleOp = handler.slice(handler.lastIndexOf('case "settle-loan"'), handler.lastIndexOf('case "loan-model-key"'));
  const keyOp = handler.slice(handler.lastIndexOf('case "loan-model-key"'), handler.lastIndexOf('case "run-training"'));
  for (const [name, source] of [["settle-loan", settleOp], ["loan-model-key", keyOp]] as const) {
    assert.match(source, /loanFinalityTier\(body\.finalityTier/, name);
    assert.doesNotMatch(source, /reserveFastExposure/, `${name} ne réserve jamais`);
  }
  assert.equal(handler.split("reserveFastExposure(").length - 1, 3, "définition, appel du registre, appel au lancement : rien d'autre");
  // Côté règlement : la part est rendue au release confirmé, à la résolution déjà close et à l'échec définitif, jamais sur une attente.
  const settlement = read("src", "lib", "billing", "settlement.ts");
  assert.match(settlement, /if \(resolution\.state !== "active"\) ledger\.releaseFastExposure\(quoteWorkflow\(quote\)\);/);
  assert.match(settlement, /catch \(error\) \{[\s\S]*?if \(!releasesReservation\(error\)\) ledger\.releaseFastExposure\(quoteWorkflow\(quote\)\);[\s\S]*?throw error;/);
  assert.match(settlement, /const refundTxHash = await sendBilledAction\(quote, loanKey, "failure", data\);\s*[\s\S]*?ledger\.releaseFastExposure\(quoteWorkflow\(quote\)\);/);
  assert.match(handler, /settleBilledEscrow\(signedQuote\.quote, receipt\.loanKey as `0x\$\{string\}`, preimage, lockBlock, finalityTier\)/);
  assert.match(handler, /publishedFinalizedPreimage\([\s\S]*?loanFinalityTier\(body\.finalityTier, signed\.quote\)\)/);
  // Le client n'ajoute le champ que pour FAST : un prêt FULL envoie la charge historique.
  assert.match(client, /return tier === "FAST" \? \{ finalityTier: "FAST" \} : \{\};/);
  for (const op of ["run-loan-job", "settle-loan", "loan-model-key"]) {
    const call = client.slice(client.indexOf(`"${op}"`));
    assert.match(call.slice(0, call.indexOf(";")), /\.\.\.finalityTierField\(finalityTier\)/, op);
  }
});

test("l’attente de finalité traverse le runner distant comme en processus", () => {
  const server = read("src", "runner", "server.ts");
  const client = read("src", "lib", "tee", "runner-client.ts");
  const route = read("src", "app", "api", "loans", "[id]", "settle", "route.ts");

  assert.match(server, /err instanceof RunnerFinalityPending[\s\S]*?send\(202, \{ state: "pending-finality", transactionHash: err\.transactionHash/);
  assert.match(client, /response\.status === 202 && body\.state === "pending-finality"[\s\S]*?throw new RunnerFinalityPending/);
  assert.match(client, /!response\.ok \|\| response\.status !== 200/, "aucune autre réponse 2xx n’est prise pour un succès");
  assert.match(route, /err instanceof RunnerFinalityPending[\s\S]*?pending: true[\s\S]*?status: 202/);
});

// --- Règlement devenu impossible après l'échéance (audit A-05) : exécution réelle de
// `settlePreparedLoan` avec ses dépendances remplacées, comme dans runner-provenance.test.ts.

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(join(process.cwd(), file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Date, console, process, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

const KEY = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;
const OTHER_TX = `0x${"23".repeat(32)}`;
const ESCROW = `0x${"33".repeat(20)}`;
const savedTeeMode = process.env.TEE_MODE;
beforeEach(() => { process.env.TEE_MODE = "development"; });
afterEach(() => {
  if (savedTeeMode === undefined) delete process.env.TEE_MODE;
  else process.env.TEE_MODE = savedTeeMode;
});

type Resolution = { state: "active" } | { state: "settled"; txHash: string };

function settlementFixture(
  evmDeadline: Date | undefined,
  runner: () => Promise<never>,
  resolution: Resolution = { state: "active" },
  quote: Record<string, unknown> = {},
) {
  const loan = {
    id: "loan", datasetId: "dataset", borrower: `0x${"44".repeat(20)}`, provider: `0x${"55".repeat(20)}`,
    status: "TRAINING", amountUsdcAtomic: "100", modelId: "linear_regression", modelVersion: "1.0.0",
    modelCid: "bafyModel", runnerReceipt: "receipt", evmLoanKey: KEY, evmLockBlock: "10", evmDeadline,
    settleTxHash: TX, billingQuoteHash: `0x${"66".repeat(32)}`, attestationHash: "attestation-hash",
    attestationPayload: "attestation-payload", updatedAt: new Date(0), runnerKind: "PHALA", runnerDeploymentId: "phala:runner",
    attestationQuote: "aa", attestationEventLog: "[]", attestationComposeHash: "88".repeat(32),
    dataset: { ipfsCid: "bafyDataset", merkleRoot: "77".repeat(32), challengeDays: 7 },
  };
  const payload = {
    chainId: 46630, escrow: ESCROW, loanId: loan.id, loanKey: KEY, datasetId: loan.datasetId, datasetCid: loan.dataset.ipfsCid,
    provider: loan.provider, borrower: loan.borrower, amountUsdcAtomic: loan.amountUsdcAtomic, billingQuoteHash: loan.billingQuoteHash,
    challengeDays: 7, merkleRoot: loan.dataset.merkleRoot, modelId: loan.modelId, modelVersion: loan.modelVersion,
    modelCid: loan.modelCid, releaseEnvelopeHash: "envelope-hash",
  };
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const api = load<typeof import("./settle")>("src/lib/sirius/settle.ts", {
    "server-only": {}, "@/lib/errors": { AppError },
    "@/lib/runner/provenance": { assertCurrentRunner: async () => ({}) },
    "@/lib/db": { prisma: { loan: {
      findUnique: async () => loan,
      updateMany: async (args: (typeof updates)[number]) => { updates.push(args); return { count: 1 }; },
    } } },
    "@/lib/evm/escrow": { reconcileLoanEscrow: async () => resolution },
    "@/lib/evm/client": {}, "@/lib/evm/finality": {},
    "@/lib/runner/failure-policy": { RunnerFinalityPending },
    "@/lib/tee/runner-client": { settleLoanInRunner: runner },
    "./model-storage": {}, "@/lib/models/registry": {}, "@/lib/runner/delivery": {},
    "@/lib/tee/attestation": {
      hashLoanAttestationPayload: () => loan.attestationHash,
      parseLoanAttestationPayload: () => payload,
      serializeLoanAttestationPayload: () => "",
    },
    "@/lib/tee/quote": quote,
    "@/lib/tee/evm-binding": { evmEscrowBinding: () => ({ chainId: 46630, escrow: ESCROW }) },
    "@/lib/billing/loan": { loanBillingQuote: () => ({ quote: {} }) },
    "@/lib/loans/settlement-status": { LOCK_FINALITY_PENDING: "attente" },
    "./finality-tier": { assignLoanFinalityTier: async () => "FULL", effectiveLoanFinalityTier: (tier: string) => tier },
    "./settlement-evidence": { recordSettlementEvidence: async () => false },
  });
  return { api, updates };
}

const overdue = () => new Date(Date.now() - 60_000);
const inTime = () => new Date(Date.now() + 60_000);
const rejected = (message: string, status: number) => async () => { throw new AppError(message, status); };

test("A-05 : release rejetée après l'échéance, escrow encore verrouillé : le hash mort est effacé et le prêt redevient remboursable", async () => {
  // Le runner a diffusé un release avant l'échéance (hash persisté en attente de finalité), puis la
  // transaction a été rejetée : « Règlement on-chain rejeté » à la confirmation, « Tentative de
  // règlement épuisée » à chaque reprise. Après l'échéance, le contrat refuse tout nouveau release.
  for (const [message, status] of [["Règlement on-chain rejeté : aucune relance automatique", 502], ["Tentative de règlement épuisée", 503]] as const) {
    const { api, updates } = settlementFixture(overdue(), rejected(message, status));
    await assert.rejects(api.settlePreparedLoan("loan"), (error: unknown) => error instanceof AppError && error.message === message && error.status === status);
    assert.equal(updates.length, 2, message);
    assert.equal(updates[0].data.status, "SETTLING");
    assert.equal(updates[1].where.status, "SETTLING");
    // Sans hash, `isOverdueUnsettled` propose « Rembourser », masque « Finaliser » et le reaper ne relance plus.
    assert.deepEqual({ ...updates[1].data }, { status: "TRAINING", settleTxHash: null });
  }
});

test("avant l'échéance, ou sans échéance connue, un release rejeté garde son hash : aucun remboursement n'est encore possible", async () => {
  for (const evmDeadline of [inTime(), undefined]) {
    const { api, updates } = settlementFixture(evmDeadline, rejected("Tentative de règlement épuisée", 503));
    await assert.rejects(api.settlePreparedLoan("loan"), /Tentative de règlement épuisée/);
    assert.deepEqual({ ...updates[1].data }, { status: "TRAINING" }, String(evmDeadline));
  }
});

test("échu mais en attente de finalité : le hash du release diffusé est conservé, jamais de remboursement", async () => {
  const { api, updates } = settlementFixture(overdue(), async () => { throw new RunnerFinalityPending(OTHER_TX); });
  await assert.rejects(api.settlePreparedLoan("loan"), (error: unknown) => error instanceof RunnerFinalityPending);
  assert.equal(updates.length, 2);
  assert.equal(updates[1].data.settleTxHash, OTHER_TX);
  assert.equal(updates[1].data.status, undefined);
});

test("échu mais réglé on-chain : le prêt est clôturé SETTLED avec le hash de la chaîne, jamais remboursé", async () => {
  const { api, updates } = settlementFixture(overdue(), rejected("Tentative de règlement épuisée", 503), { state: "settled", txHash: OTHER_TX });
  await assert.rejects(api.settlePreparedLoan("loan"), /Tentative de règlement épuisée/);
  assert.equal(updates[1].data.status, "SETTLED");
  assert.equal(updates[1].data.settleTxHash, OTHER_TX);
});

// --- Quote enregistrée à l'entraînement, revérifiée au règlement (audit A-01) : le TCB d'Intel
// peut avoir été déclassé entre-temps ; seule une révocation ou une signature refusée bloque.

const recordedQuote = (verification: Record<string, unknown>) => ({
  isRecordedQuoteHardwareValid,
  verifyTdxQuote: async () => ({ reportDataMatches: true, codeIdentityMatches: true, ...verification }),
});

test("A-01 : une quote enregistrée dont le TCB est passé OutOfDate depuis l'entraînement se règle encore", async () => {
  process.env.TEE_MODE = "phala";
  const { api, updates } = settlementFixture(inTime(), rejected("Tentative de règlement épuisée", 503), { state: "active" },
    recordedQuote({ hardwareVerified: false, tcbStatus: "OutOfDate" }));
  // Le runner est atteint : la vérification de la quote a laissé passer le règlement.
  await assert.rejects(api.settlePreparedLoan("loan"), /Tentative de règlement épuisée/);
  assert.equal(updates[0].data.status, "SETTLING");
});

test("A-01 : une quote enregistrée révoquée par Intel, ou dont la signature échoue, ne se règle pas", async () => {
  process.env.TEE_MODE = "phala";
  for (const verification of [{ hardwareVerified: false, tcbStatus: "Revoked" }, { hardwareVerified: false }]) {
    const { api, updates } = settlementFixture(inTime(), rejected("Tentative de règlement épuisée", 503), { state: "active" },
      recordedQuote(verification));
    await assert.rejects(api.settlePreparedLoan("loan"), (error: unknown) =>
      error instanceof AppError && error.message === "Quote TDX runner non authentifiée" && error.status === 502);
    assert.equal(updates.length, 0, JSON.stringify(verification));
  }
});
