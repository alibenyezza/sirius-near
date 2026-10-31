import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attestLoanExecution,
  hashLoanAttestationPayload,
  parseLoanAttestationPayload,
  serializeLoanAttestationPayload,
  verifyAttestation,
} from "./attestation";

const input = {
  chainId: 46630,
  escrow: "0xc6a27dd5fdfdeda069b5634ca8d44416dfdb3f4f",
  loanId: "loan-1",
  loanKey: `0x${"ab".repeat(32)}`,
  datasetId: "dataset-1",
  datasetCid: "bafy-dataset",
  provider: "0x930f5a13d65b3e7e07431a38da30229562e3318b",
  borrower: "0x37f98be7c9d48b5d39e449616e7c70e37e29db13",
  amountUsdcAtomic: "2500000",
  challengeDays: 7,
  merkleRoot: "f".repeat(64),
  modelId: "logistic_regression" as const,
  modelVersion: "1.0.0",
  modelCid: "bafy-model",
  releaseEnvelopeHash: "e".repeat(64),
};

test("le payload d’attestation lie le modèle, le scope et la capsule", () => {
  const payload = serializeLoanAttestationPayload(input);
  const parsed = parseLoanAttestationPayload(payload);

  assert.equal(parsed.modelId, "logistic_regression");
  assert.equal(parsed.modelVersion, "1.0.0");
  assert.equal(parsed.datasetCid, input.datasetCid);
  assert.equal(parsed.releaseEnvelopeHash, input.releaseEnvelopeHash);
  assert.notEqual(
    hashLoanAttestationPayload(payload),
    hashLoanAttestationPayload(serializeLoanAttestationPayload({ ...input, modelId: "linear_regression" })),
  );
  assert.notEqual(
    hashLoanAttestationPayload(payload),
    hashLoanAttestationPayload(serializeLoanAttestationPayload({ ...input, releaseEnvelopeHash: "d".repeat(64) })),
  );
});

test("le payload d’attestation refuse les champs libres et les modèles inconnus", () => {
  assert.throws(
    () => parseLoanAttestationPayload(JSON.stringify({ ...JSON.parse(serializeLoanAttestationPayload(input)), extra: true })),
    /invalide/i,
  );
  assert.throws(
    () => parseLoanAttestationPayload(serializeLoanAttestationPayload({ ...input, modelId: "other" as never })),
    /invalide/i,
  );
  assert.throws(
    () => parseLoanAttestationPayload(serializeLoanAttestationPayload({ ...input, modelVersion: "1.0.1" })),
    /invalide/i,
  );
});

test("le runner signe le hash exact du payload canonique", async () => {
  process.env.SIRIUS_MASTER_KEY ??= Buffer.alloc(32, 23).toString("base64");
  process.env.TEE_MODE = "stub";
  const attestation = await attestLoanExecution(input);

  assert.equal(attestation.evidence, null);
  assert.equal(attestation.payloadHash, hashLoanAttestationPayload(attestation.payload));
  assert.equal(verifyAttestation(attestation), true);
});
