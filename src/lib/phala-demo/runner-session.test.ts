import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { initializeBudgetLedger, type BudgetPolicy } from "../runner/budget-ledger";
import { runnerBudget } from "../runner/budget";
import { demoSessions, withDemoAdmission } from "./runner-session";
import { handleRunnerRequest } from "../../runner/server";
import { handleRunnerOp } from "../../runner/handler";

test("le contrôle HTTP exige son secret, ferme avant toute dépense et invalide une ancienne admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "sirius-demo-http-"));
  const saved = { ...process.env };
  const actor = `0x${"12".repeat(20)}`;
  const secret = Buffer.alloc(32, 9).toString("base64");
  const policy: BudgetPolicy = {
    version: 1, chainId: 46630, wallet: actor, accountingReference: "synthetic-demo", validUntil: Date.now() + 60_000,
    earnedMarginUsdMicros: "0", cashUsdMicros: "0", fixedReserveUsdMicros: "100",
    sponsored: { funding: "credits", creditsUsdMicros: "1000", cashUsdMicros: "0", ceilingUsdMicros: "900",
      maxOperations: 4, maxOperationsPerWallet: 2, maxConcurrent: 1, origin: "https://demo.example", observedAtMs: Date.now() - 1000 },
    costsUsdMicros: { request: "1", seal: "10", training: "50" },
    gas: { totalWei: "0", maxTransactionWei: "1", maxGas: "1", maxFeePerGasWei: "1", ethUsdMicrosUpperBound: "1", confirmations: 1 },
    maxFailures: 3, maxActive: 2,
  };
  Object.assign(process.env, { NODE_ENV: "test", EVM_NETWORK: "testnet", TEE_MODE: "phala", DSTACK_SIMULATOR_ENDPOINT: "",
    SIRIUS_PHALA_DEMO: "true", SIRIUS_APP_ORIGIN: policy.sponsored!.origin, SIRIUS_LOCK_AUTHORIZER: actor,
    SIRIUS_ESCROW_ADDRESS: `0x${"34".repeat(20)}`, RUNNER_BUDGET_FILE: join(root, "budget.sqlite"),
    RUNNER_DEMO_SESSION_FILE: join(root, "sessions.sqlite"), RUNNER_DEMO_CONTROL_SECRET: secret });
  initializeBudgetLedger(process.env.RUNNER_BUDGET_FILE!, policy);
  const request = async (body?: unknown, token = secret, bootstrap = false) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const req = Object.assign(Readable.from(data.length ? [data] : []), { method: body ? "POST" : "GET", url: "/operations/demo",
      headers: { authorization: `Bearer ${token}`, "content-length": String(data.length) } });
    let status = 0; let result = "";
    await handleRunnerRequest(req as unknown as IncomingMessage, {
      writeHead(code: number) { status = code; }, end(value: string) { result = value; },
    } as unknown as ServerResponse, undefined, bootstrap);
    return { status, body: JSON.parse(result) };
  };
  try {
    assert.equal((await request(undefined, "transport-is-not-control")).status, 401);
    assert.equal((await request(undefined, secret, true)).status, 503);
    assert.equal((await request()).body.session.open, false);
    const before = runnerBudget()!.snapshot();
    await assert.rejects(handleRunnerOp("run-training", {}), /fermée/);
    assert.deepEqual(runnerBudget()!.snapshot(), before);
    const open = await request({ command: "open", actor, revision: 0, policy: policy.sponsored });
    assert.equal(open.status, 200); assert.equal(open.body.available, true);
    await assert.rejects(handleRunnerOp("prepare-escrow-lock", {}), /propres données/);
    assert.equal((await request({ command: "close", actor, revision: 1 })).status, 200);
    assert.equal((await request({ command: "open", actor, revision: 2, policy: policy.sponsored })).status, 200);
    await assert.rejects(withDemoAdmission("train:old", actor, {}, async () => assert.fail("calcul interdit"), 1), /remplacée/);
    assert.deepEqual(runnerBudget()!.snapshot(), before);
  } finally {
    demoSessions().close(); runnerBudget()!.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true });
  }
});
