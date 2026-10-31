import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { issueRunnerCapability } from "@/lib/runner/capability";
import type { RunnerRaTlsEvidence } from "@/lib/tee/types";
import { initializeRunnerReplay } from "@/lib/runner/replay";
import { handleRunnerRequest, startRunner } from "./server";

interface TestResponse {
  body: unknown;
  status: number;
}

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.RUNNER_TRANSPORT_SECRET = Buffer.alloc(32, 12).toString("base64");
  process.env.SIRIUS_APP_ORIGIN = "http://localhost:3000";
});

async function request(
  method: string,
  url: string,
  capability?: string,
  body = "{}",
  includeLength = true,
  raTlsEvidence?: RunnerRaTlsEvidence,
  bootstrapOnly = false,
): Promise<TestResponse> {
  const req = Readable.from(method === "POST" ? [body] : []) as IncomingMessage;
  Object.assign(req, {
    headers: {
      ...(capability ? { "x-sirius-runner-capability": capability } : {}),
      ...(method === "POST" && includeLength ? { "content-length": String(Buffer.byteLength(body)) } : {}),
    },
    method,
    url,
  });

  let status = 0;
  let responseBody = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk: string) {
      responseBody = chunk;
      return this;
    },
  } as unknown as ServerResponse;

  await handleRunnerRequest(req, res, raTlsEvidence, bootstrapOnly);
  return { status, body: JSON.parse(responseBody) as unknown };
}

test("le contrat HTTP du runner impose healthcheck et capability", async () => {
  const health = await request("GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const unavailableRaTls = await request("GET", "/ra-tls");
  assert.equal(unavailableRaTls.status, 404);
  const evidence = {
    certificateSha256: "12".repeat(32),
    composeHash: "34".repeat(32),
    eventLog: "[]",
    ingressKeySha256: "78".repeat(32),
    masterKeyChainSha256: "9a".repeat(32),
    quote: "56",
    settlementAddress: `0x${"11".repeat(20)}`,
    bootstrapOnly: false,
  };
  const raTls = await request("GET", "/ra-tls", undefined, "{}", true, evidence);
  assert.equal(raTls.status, 200);
  assert.deepEqual(raTls.body, evidence);

  const unauthorized = await request("POST", "/dataset-ingress-key");
  assert.equal(unauthorized.status, 401);

  const capability = issueRunnerCapability("dataset-ingress-key", {});
  const authorized = await request("POST", "/dataset-ingress-key", capability);
  assert.equal(authorized.status, 200);
  const ingressKey = authorized.body as { origin: string; publicKey: string };
  assert.equal(Buffer.from(ingressKey.publicKey, "base64url").length, 65);
  assert.equal(ingressKey.origin, "http://localhost:3000");

  const replayed = await request("POST", "/dataset-ingress-key", capability);
  assert.equal(replayed.status, 409);

  const missingLength = await request(
    "POST",
    "/dataset-ingress-key",
    issueRunnerCapability("dataset-ingress-key", {}),
    "{}",
    false,
  );
  assert.equal(missingLength.status, 411);

  const oversized = await request(
    "POST",
    "/dataset-ingress-key",
    issueRunnerCapability("dataset-ingress-key", {}),
    "x".repeat(256 * 1024 + 1),
  );
  assert.equal(oversized.status, 413);

  const hashlockBody = JSON.stringify({
    loanId: "loan-2",
    datasetId: "dataset-1",
    borrower: "rBorrower",
  });
  const wrongScope = await request(
    "POST",
    "/prepare-escrow-lock",
    issueRunnerCapability("prepare-escrow-lock", {
      loanId: "loan-1",
      datasetId: "dataset-1",
      borrower: "rBorrower",
    }),
    hashlockBody,
  );
  assert.equal(wrongScope.status, 401);

  const trainingBody = JSON.stringify({
    datasetId: "dataset-1",
    jobId: "job-1",
    cid: "bafy-dataset",
    wrappedKey: "wrapped-key",
    merkleRoot: "a".repeat(64),
    priceUsdcAtomic: "1000000000000000000",
    challengeDays: 7,
    modelId: "other",
    modelVersion: "1.0.0",
    datasetReceipt: "not-read-before-model-validation",
  });
  const training = await request(
    "POST",
    "/run-training",
    issueRunnerCapability("run-training", { datasetId: "dataset-1", jobId: "job-1" }),
    trainingBody,
  );
  assert.equal(training.status, 400);
  assert.deepEqual(training.body, { error: "Modèle ou version non autorisé" });

  const trainingWrongScope = await request(
    "POST",
    "/run-training",
    issueRunnerCapability("run-training", { datasetId: "dataset-2", jobId: "job-1" }),
    trainingBody,
  );
  assert.equal(trainingWrongScope.status, 401);
});

test("l’amorçage expose la preuve et refuse toutes les opérations, même autorisées", async () => {
  const health = await request("GET", "/health", undefined, "{}", true, undefined, true);
  assert.deepEqual(health, { status: 200, body: { status: "bootstrap" } });
  const evidence: RunnerRaTlsEvidence = {
    certificateSha256: "12".repeat(32), composeHash: "34".repeat(32), eventLog: "[]",
    ingressKeySha256: "78".repeat(32), masterKeyChainSha256: "9a".repeat(32), quote: "56",
    settlementAddress: `0x${"11".repeat(20)}`, bootstrapOnly: true,
  };
  assert.deepEqual((await request("GET", "/ra-tls", undefined, "{}", true, evidence, true)).body, evidence);
  for (const op of ["dataset-ingress-key", "seal-dataset", "prepare-escrow-lock", "run-training", "run-loan-job", "settle-loan", "loan-model-key", "self-train-key"] as const) {
    const response = await request("POST", `/${op}`, issueRunnerCapability(op, {}), "{}", true, evidence, true);
    assert.equal(response.status, 503, op);
  }
});

test("le runner actif refuse un volume anti-rejeu perdu avant d’ouvrir son port", async () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-runner-start-"));
  const previous = process.env.RUNNER_REPLAY_DIR;
  process.env.RUNNER_REPLAY_DIR = root;
  try { await assert.rejects(startRunner({ port: 0, log: false }), /absent ou inaccessible/); }
  finally {
    if (previous === undefined) delete process.env.RUNNER_REPLAY_DIR;
    else process.env.RUNNER_REPLAY_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("la perte du registre coupe les admissions HTTP, y compris pour une capability déjà consommée", async () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-runner-loss-"));
  const previous = process.env.RUNNER_REPLAY_DIR;
  process.env.RUNNER_REPLAY_DIR = root;
  try {
    initializeRunnerReplay(root);
    const capability = issueRunnerCapability("dataset-ingress-key", {});
    assert.equal((await request("POST", "/dataset-ingress-key", capability)).status, 200);
    rmSync(join(root, "replay.sqlite"));
    assert.equal((await request("POST", "/dataset-ingress-key", capability)).status, 503);
    assert.equal((await request("POST", "/dataset-ingress-key", issueRunnerCapability("dataset-ingress-key", {}))).status, 503);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_REPLAY_DIR;
    else process.env.RUNNER_REPLAY_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
