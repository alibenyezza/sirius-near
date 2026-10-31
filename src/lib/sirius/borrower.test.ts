import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "borrower.ts"), "utf8");
const RUNNER_HANDLER = readFileSync(join(process.cwd(), "src", "runner", "handler.ts"), "utf8");

test("la confirmation du lock précède les lectures EVM", () => {
  const finalize = SOURCE.slice(SOURCE.indexOf("export async function finalizeLoan"));
  const submission = finalize.indexOf('data: { status: "SUBMITTING", evmLockTxHash: submittedLockTxHash }');
  const confirmation = finalize.indexOf("await publicClient.waitForTransactionReceipt");
  const reads = finalize.indexOf("const [transaction, onChain] = await Promise.all");

  assert.ok(submission >= 0, "le hash doit être persisté avec le statut SUBMITTING");
  assert.ok(confirmation >= 0, "le lock doit être confirmé");
  assert.ok(reads >= 0, "les lectures EVM doivent rester parallèles après confirmation");
  assert.ok(submission < confirmation, "une coupure RPC ne doit pas perdre le hash déjà signé");
  assert.ok(confirmation < reads, "getTransaction et readLoan ne doivent pas précéder la confirmation du lock");
});

test("un prêt annulé sans remboursement on-chain reste récupérable", () => {
  const finalize = SOURCE.slice(SOURCE.indexOf("export async function finalizeLoan"));

  assert.match(finalize, /const recoverableCancellation = loan\.status === "CANCELLED" && !loan\.cancelTxHash/);
  assert.match(finalize, /status: \{ in: \["PENDING", "SUBMITTING", "CANCELLED"\] \},\r?\n      cancelTxHash: null/);
});

test("les essais annulés ne consomment pas le quota d’emprunts", () => {
  const prepare = SOURCE.slice(SOURCE.indexOf("export async function prepareLoan"), SOURCE.indexOf("export async function finalizeLoan"));

  assert.match(prepare, /status: \{ in: \["ESCROWED", "TRAINING", "SETTLING", "SETTLED"\] \}/);
});

test("le profil verrouillé est porté dans le lock, sans pré-entraînement", () => {
  const prepare = SOURCE.slice(SOURCE.indexOf("export async function prepareLoan"), SOURCE.indexOf("export async function finalizeLoan"));
  const model = prepare.indexOf("const model = modelSelection");
  const loan = prepare.indexOf("return tx.loan.create");
  const hashlock = prepare.indexOf("await prepareEscrowLockInRunner");

  assert.doesNotMatch(prepare, /validateTrainingInputInRunner/);
  assert.ok(model >= 0, "le profil du dataset doit être validé côté serveur");
  assert.ok(loan >= 0, "le prêt doit être créé après la validation");
  assert.ok(hashlock >= 0, "le hashlock doit être dérivé après la création du prêt");
  assert.ok(model < loan, "un profil absent ne doit pas créer de prêt");
  assert.match(prepare, /trainingProfile: trainingProfileHash\(model\)/);
});

test("le lock doit porter le titre EVM du dataset demandé", () => {
  const finalize = SOURCE.slice(SOURCE.indexOf("export async function finalizeLoan"));

  assert.match(finalize, /onChain\.datasetId\.toLowerCase\(\) !== loan\.dataset\.evmDatasetId\.toLowerCase\(\)/);
});

test("le TEE confirme le scope du self-train avant le déchiffrement", () => {
  const selfTraining = RUNNER_HANDLER.slice(
    RUNNER_HANDLER.lastIndexOf('case "run-training"'),
    RUNNER_HANDLER.lastIndexOf('case "self-train-key"'),
  );
  const scope = selfTraining.indexOf("await assertDatasetScope");
  const training = selfTraining.indexOf("await runSelfTraining");

  assert.ok(scope >= 0, "le titre EVM doit être vérifié");
  assert.ok(training >= 0, "le runner doit entraîner le dataset");
  assert.ok(scope < training, "le dataset ne doit pas être déchiffré avant sa vérification on-chain");
});

test("une annonce expirée n'est plus empruntable, même par son lien direct", () => {
  const prepare = SOURCE.slice(SOURCE.indexOf("export async function prepareLoan"), SOURCE.indexOf("export async function finalizeLoan"));

  assert.match(prepare, /if \(isListingExpired\(dataset\.listingExpiresAt\)\) throw new AppError\("Annonce expirée", 409\)/);
  // La réservation atomique refuse aussi une annonce expirée entre la lecture et la création du prêt.
  assert.match(prepare, /OR: \[\{ listingExpiresAt: null \}, \{ listingExpiresAt: \{ gt: new Date\(\) \} \}\]/);
  assert.equal(prepare.match(/isListingExpired\(dataset\.listingExpiresAt\)/g)?.length, 2, "prepareLoan et renewLoanLock vérifient l'expiration");
});

test("le coupe-circuit des admissions bloque préparation et renouvellement, pas la confirmation (A-17)", () => {
  const prepare = SOURCE.slice(SOURCE.indexOf("export async function prepareLoan"), SOURCE.indexOf("export async function renewLoanLock"));
  const renew = SOURCE.slice(SOURCE.indexOf("export async function renewLoanLock"), SOURCE.indexOf("export async function finalizeLoan"));
  const finalize = SOURCE.slice(SOURCE.indexOf("export async function finalizeLoan"));

  for (const [name, body, firstSideEffect] of [
    ["prepareLoan", prepare, "await requireCurrentEvmDeployment"],
    ["renewLoanLock", renew, "await requireCurrentEvmDeployment"],
  ] as const) {
    const gate = body.indexOf("assertAdmissionsOpen()");
    assert.ok(gate >= 0, `${name} doit vérifier le coupe-circuit des admissions`);
    assert.ok(gate < body.indexOf(firstSideEffect), `${name} doit refuser avant toute lecture`);
    assert.ok(gate < body.indexOf("prepareEscrowLockInRunner"), `${name} doit refuser avant toute autorisation de lock`);
  }
  // Des fonds déjà verrouillés on-chain doivent toujours pouvoir être enregistrés.
  assert.doesNotMatch(finalize, /assertAdmissionsOpen/);
});
