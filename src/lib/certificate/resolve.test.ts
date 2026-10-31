import assert from "node:assert/strict";
import { test } from "node:test";
import { hashLoanAttestationPayload, serializeLoanAttestationPayload } from "@/lib/tee/attestation";
import {
  certificateExport,
  isCertificateLoanId,
  resolveCertificate,
  type CertificateLoanRow,
} from "./resolve";
import { certificateViewProps } from "./display";

const ESCROW = "0xc6a27dd5fdfdeda069b5634ca8d44416dfdb3f4f";
const CHAIN_ID = 46630;
const BORROWER = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const LOAN_KEY = `0x${"ab".repeat(32)}`;
const SETTLE_TX = `0x${"12".repeat(32)}`;
const binding = () => ({ chainId: CHAIN_ID, escrow: ESCROW });

function row(overrides: Partial<CertificateLoanRow> = {}, payloadOverrides: Record<string, unknown> = {}): CertificateLoanRow {
  const payload = serializeLoanAttestationPayload({
    chainId: CHAIN_ID,
    escrow: ESCROW,
    loanId: "cloan000000000000000000001",
    loanKey: LOAN_KEY,
    datasetId: "cdataset0000000000000000001",
    datasetCid: "bafy-dataset",
    provider: PROVIDER,
    borrower: BORROWER,
    amountUsdcAtomic: "2500000",
    challengeDays: 7,
    merkleRoot: "f".repeat(64),
    modelId: "logistic_regression",
    modelVersion: "1.0.0",
    modelCid: "bafy-model",
    releaseEnvelopeHash: "e".repeat(64),
    billingQuoteHash: `0x${"cd".repeat(32)}`,
    ...payloadOverrides,
  });
  return {
    id: "cloan000000000000000000001",
    status: "SETTLED",
    datasetId: "cdataset0000000000000000001",
    borrower: BORROWER,
    provider: PROVIDER,
    amountUsdcAtomic: "2500000",
    billingQuoteHash: `0x${"cd".repeat(32)}`,
    modelId: "logistic_regression",
    modelVersion: "1.0.0",
    modelCid: "bafy-model",
    evmLoanKey: LOAN_KEY,
    evmChainId: CHAIN_ID,
    evmEscrowAddress: ESCROW,
    attestationHash: hashLoanAttestationPayload(payload),
    attestationPayload: payload,
    attestationQuote: "ab".repeat(600),
    attestationEventLog: "[]",
    attestationComposeHash: "c".repeat(64),
    settleTxHash: SETTLE_TX,
    settledAt: new Date("2026-10-03T08:15:42Z"),
    dataset: {
      id: "cdataset0000000000000000001",
      name: "Retail churn",
      status: "LISTED",
      evmDatasetId: `0x${"01".repeat(32)}`,
      ipfsCid: "bafy-dataset",
      challengeDays: 7,
      merkleRoot: "f".repeat(64),
    },
    ...overrides,
  };
}

test("identifiant : borné en longueur et en alphabet avant toute lecture", () => {
  assert.equal(isCertificateLoanId("cloan000000000000000000001"), true);
  assert.equal(isCertificateLoanId("loan-1_A"), true);
  for (const bad of ["", "a".repeat(65), "../etc", "a b", "a%2F", "é", "<script>", null, 42, undefined]) {
    assert.equal(isCertificateLoanId(bad), false, String(bad));
  }
});

test("404 : prêt inexistant, identifiant hors format, dataset fermé — même réponse", () => {
  assert.deepEqual(resolveCertificate(null, binding), { kind: "not-found" });
  assert.deepEqual(resolveCertificate(row({ id: "../x" }), binding), { kind: "not-found" });
  for (const status of ["DRAFT", "LISTING", "PRIVATE", "DELETED"]) {
    const loan = row();
    loan.dataset = { ...loan.dataset, status };
    assert.deepEqual(resolveCertificate(loan, binding), { kind: "not-found" }, status);
  }
  const archivedWithoutTitle = row();
  archivedWithoutTitle.dataset = { ...archivedWithoutTitle.dataset, status: "SUSPENDED", evmDatasetId: null };
  assert.deepEqual(resolveCertificate(archivedWithoutTitle, binding), { kind: "not-found" });
});

test("datasets publics, semi-privés et archivés avec titre : certificat servi", () => {
  for (const status of ["LISTED", "UNLISTED", "SUSPENDED"]) {
    const loan = row();
    loan.dataset = { ...loan.dataset, status };
    assert.equal(resolveCertificate(loan, binding).kind, "ready", status);
  }
});

test("pas encore disponible : tout statut autre que SETTLED, même avec une attestation", () => {
  for (const status of ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "CANCELLED"]) {
    assert.deepEqual(resolveCertificate(row({ status }), binding), { kind: "unavailable" }, status);
  }
});

test("pas encore disponible : attestation, modèle ou règlement manquant ou mal formé", () => {
  const cases: Array<Partial<CertificateLoanRow>> = [
    { attestationHash: null },
    { attestationPayload: null },
    { modelCid: null },
    { settleTxHash: null },
    { settleTxHash: "0x1234" },
    { settleTxHash: `javascript:alert(1)//${"0".repeat(40)}` },
    { attestationHash: "not-a-hash" },
    { attestationPayload: "{}" },
    { modelVersion: "9.9.9" },
  ];
  for (const overrides of cases) {
    assert.deepEqual(resolveCertificate(row(overrides), binding), { kind: "unavailable" }, JSON.stringify(overrides));
  }
});

test("pas encore disponible : attestation qui ne se recoupe pas avec le prêt", () => {
  const mismatches: Array<[Partial<CertificateLoanRow>, Record<string, unknown>]> = [
    [{}, { loanId: "cother" }],
    [{}, { loanKey: `0x${"00".repeat(32)}` }],
    [{}, { datasetId: "cother" }],
    [{}, { datasetCid: "bafy-other" }],
    [{}, { provider: BORROWER }],
    [{}, { borrower: PROVIDER }],
    [{}, { amountUsdcAtomic: "1" }],
    [{}, { billingQuoteHash: undefined }],
    [{}, { challengeDays: 3 }],
    [{}, { merkleRoot: "0".repeat(64) }],
    [{}, { modelId: "linear_regression" }],
    [{}, { modelCid: "bafy-other-model" }],
    [{}, { chainId: 1 }],
    [{}, { escrow: "0x0000000000000000000000000000000000000001" }],
  ];
  for (const [overrides, payloadOverrides] of mismatches) {
    assert.deepEqual(
      resolveCertificate(row(overrides, payloadOverrides), binding),
      { kind: "unavailable" },
      JSON.stringify(payloadOverrides),
    );
  }
  // Hash enregistré différent du payload.
  assert.deepEqual(resolveCertificate(row({ attestationHash: "0".repeat(64) }), binding), { kind: "unavailable" });
  // Déploiement d'escrow non approuvé : `loanEscrowBinding` lève.
  assert.deepEqual(
    resolveCertificate(row(), () => {
      throw new Error("Déploiement historique non autorisé");
    }),
    { kind: "unavailable" },
  );
});

test("certificat prêt : seuls les champs du certificat, payload gardé pour l'export", () => {
  const result = resolveCertificate(row(), binding);
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const { record } = result;
  assert.deepEqual(record.dataset, { id: "cdataset0000000000000000001", name: "Retail churn" });
  assert.deepEqual(record.model, { name: "Binary logistic regression v1.0.0", cid: "bafy-model" });
  assert.deepEqual(record.settlement, { txHash: SETTLE_TX, chainId: CHAIN_ID, network: "testnet" });
  assert.equal(record.evidence.payloadHash, row().attestationHash);
  assert.equal(record.evidence.composeHash, "c".repeat(64));
  // En dehors du payload attesté, aucune adresse, montant ou clé de prêt.
  const { evidence, ...shown } = record;
  const serialized = JSON.stringify(shown);
  for (const secret of [BORROWER, PROVIDER, "2500000", LOAN_KEY, ESCROW]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.ok(evidence.payload.includes(BORROWER));
});

test("event-log ou compose hash incomplet ou mal formé : preuve d'identité ignorée, pas inventée", () => {
  for (const overrides of [
    { attestationEventLog: null },
    { attestationComposeHash: null },
    { attestationComposeHash: "zz" },
  ]) {
    const result = resolveCertificate(row(overrides), binding);
    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") continue;
    assert.equal(result.record.evidence.eventLog, null);
    assert.equal(result.record.evidence.composeHash, null);
  }
  const noQuote = resolveCertificate(row({ attestationQuote: null }), binding);
  assert.equal(noQuote.kind === "ready" && noQuote.record.evidence.quote, null);
});

test("export JSON : pièces de vérification uniquement, aucun champ interne", () => {
  const result = resolveCertificate(row(), binding);
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const exported = certificateExport(result.record);
  assert.deepEqual(Object.keys(exported).sort(), [
    "attestation",
    "chainId",
    "format",
    "howToVerify",
    "loanId",
    "modelCid",
    "settlementTxHash",
  ]);
  assert.deepEqual(Object.keys(exported.attestation).sort(), [
    "composeHash",
    "eventLog",
    "payload",
    "payloadSha256",
    "tdxQuote",
  ]);
  // Le payload exporté est la chaîne exacte : son SHA-256 est celui de la quote.
  assert.equal(hashLoanAttestationPayload(exported.attestation.payload), exported.attestation.payloadSha256);
  const text = JSON.stringify(exported);
  for (const internal of ["auditReceipt", "runnerReceipt", "billingQuote\"", "evmHashlock", "wrappedKey", "keyRef"]) {
    assert.equal(text.includes(internal), false, internal);
  }
});

test("propriétés de la vue : aucune adresse, aucun montant, aucun payload", () => {
  const result = resolveCertificate(row(), binding);
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const props = certificateViewProps(result.record, { status: "absent" });
  assert.ok(props);
  const text = JSON.stringify(props);
  for (const secret of [BORROWER, PROVIDER, "2500000", LOAN_KEY, ESCROW, "releaseEnvelopeHash", "e".repeat(64)]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(props.proofHref, "/proof/cdataset0000000000000000001");
  assert.equal(props.downloadHref, "/api/certificate/cloan000000000000000000001/attestation");
  assert.equal(props.settlementHref?.endsWith(`/tx/${SETTLE_TX}`), true);
  assert.equal(props.settledAt, "2026-10-03 08:15 UTC");
});

test("chaîne inconnue de l'application : pas encore disponible (page et JSON alignés)", () => {
  const otherChain = () => ({ chainId: 1, escrow: ESCROW });
  assert.deepEqual(resolveCertificate(row({ evmChainId: 1 }, { chainId: 1 }), otherChain), { kind: "unavailable" });
});
