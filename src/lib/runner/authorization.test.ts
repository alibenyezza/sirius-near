import assert from "node:assert/strict";
import { before, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { useWalletStore } from "@/stores/wallet";
import { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } from "./authorization-client";
import { buildDelegationMessage, encodeRunnerGrantHeader, parseRunnerGrantHeader } from "./authorization-contract";
import { verifyRunnerGrant } from "./authorization";
import { issueDatasetReceipt, verifyDatasetReceipt } from "./receipt";
import type { DatasetRef } from "@/lib/tee/contract";

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_APP_ORIGIN = "http://localhost:3000";
});

async function signedGrant(demoSessionRevision?: number) {
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f094538b2927f5fc5a8c7e1b3e49b920e33e9f8a");
  useWalletStore.getState().setConnected(account.address, "testnet", "external");
  const sessionPublicKey = await beginRunnerDelegation();
  const now = Date.now();
  const message = buildDelegationMessage({
    origin: "http://localhost:3000",
    address: account.address,
    sessionPublicKey,
    network: "testnet",
    issuedAt: now,
    expiresAt: now + 60_000,
    challengeToken: "challenge.signature",
  });
  await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
  const intentParts = ["dataset-1", "job-1", "receipt-1"];
  return {
    address: account.address.toLowerCase(),
    intentParts,
    grant: await issueRunnerGrant("run-training", { datasetId: "dataset-1", jobId: "job-1", ...(demoSessionRevision === undefined ? {} : { demoSessionRevision }) }, intentParts),
  };
}

test("le runner vérifie la délégation EIP-191 et consomme le grant", async () => {
  const { address, grant, intentParts } = await signedGrant();
  assert.deepEqual(parseRunnerGrantHeader(encodeRunnerGrantHeader(grant)), grant);
  const expected = { operation: "run-training" as const, datasetId: "dataset-1", jobId: "job-1", intentParts };
  assert.equal((await verifyRunnerGrant(grant, expected)).subject, address);
  await assert.rejects(verifyRunnerGrant(grant, expected), /déjà utilisé/);
});

test("la révision Phala est signée et un grant d’une ancienne session ne traverse pas la réouverture", async () => {
  const { grant, intentParts } = await signedGrant(3);
  const expected = { operation: "run-training" as const, datasetId: "dataset-1", jobId: "job-1", intentParts, demoSessionRevision: 5 };
  await assert.rejects(verifyRunnerGrant(grant, expected), /hors scope/);
  grant.payload.demoSessionRevision = 5;
  await assert.rejects(verifyRunnerGrant(grant, expected), /Signature/);
});

test("un grant ne peut pas être élargi à un autre dataset", async () => {
  const { grant, intentParts } = await signedGrant();
  await assert.rejects(
    verifyRunnerGrant(grant, { operation: "run-training", datasetId: "dataset-2", jobId: "job-1", intentParts }),
    /hors scope/,
  );
});

test("le reçu de dataset lie les termes USDC au contenu scellé", () => {
  const dataset = {
    datasetId: "dataset-1",
    cid: "bafy-dataset",
    wrappedKey: "wrapped-key",
    merkleRoot: "0xabc123",
    priceUsdcAtomic: "2500000",
    challengeDays: 7,
    modelId: "linear_regression",
    modelVersion: "1.0.0",
  } as const satisfies DatasetRef;
  const receipt = issueDatasetReceipt("0x1111111111111111111111111111111111111111", dataset);
  assert.equal(verifyDatasetReceipt(receipt, dataset).priceUsdcAtomic, "2500000");
  assert.throws(() => verifyDatasetReceipt(receipt, { ...dataset, priceUsdcAtomic: "1" }), /hors scope/);
  assert.throws(() => verifyDatasetReceipt(receipt, { ...dataset, modelId: "logistic_regression" }), /hors scope/);
});
