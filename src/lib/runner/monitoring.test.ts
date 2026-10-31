import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { initializeBudgetLedger, type BudgetPolicy } from "./budget-ledger";
import { monitoringAuthorized } from "./monitoring";
import { handleRunnerRequest } from "../../runner/server";

const root = mkdtempSync(join(tmpdir(), "sirius-monitor-route-"));
const saved = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

test("la supervision reste accessible sans budget disponible, sans autoriser de calcul ni exposer la politique", async () => {
  const secret = Buffer.alloc(32, 21).toString("base64");
  process.env.RUNNER_MONITOR_SECRET = secret;
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = `0x${"34".repeat(20)}`;
  process.env.SIRIUS_LOCK_AUTHORIZER = `0x${"12".repeat(20)}`;
  process.env.RUNNER_BUDGET_FILE = join(root, "ledger.sqlite");
  const policy: BudgetPolicy = {
    version: 1, chainId: 46630, wallet: process.env.SIRIUS_LOCK_AUTHORIZER, accountingReference: "synthetic-monitor",
    validUntil: Date.now() - 1, earnedMarginUsdMicros: "0", cashUsdMicros: "0", fixedReserveUsdMicros: "0",
    costsUsdMicros: { request: "1", seal: "1", training: "1" },
    gas: { totalWei: "0", maxTransactionWei: "1", maxGas: "1", maxFeePerGasWei: "1", ethUsdMicrosUpperBound: "1", confirmations: 1 },
    maxFailures: 1, maxActive: 1,
  };
  initializeBudgetLedger(process.env.RUNNER_BUDGET_FILE, policy);
  assert.equal(monitoringAuthorized(`Bearer ${secret}`), true);
  for (const header of [undefined, "bad", [secret], `Bearer ${Buffer.alloc(32, 22).toString("base64")}`]) assert.equal(monitoringAuthorized(header), false);
  const request = async (method: string, authorization?: string, bootstrap = false) => {
    let status = 0;
    let body = "";
    await handleRunnerRequest({ method, url: "/operations/budget", headers: { authorization } } as IncomingMessage,
      { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as ServerResponse,
      undefined, bootstrap);
    return { status, body: JSON.parse(body) };
  };
  assert.equal((await request("GET")).status, 401);
  assert.equal((await request("POST", `Bearer ${secret}`)).status, 405);
  assert.equal((await request("GET", `Bearer ${secret}`, true)).status, 503);
  const report = await request("GET", `Bearer ${secret}`);
  assert.equal(report.status, 200);
  assert.equal(report.body.check.expired, true);
  assert.equal(report.body.check.canQuote, false);
  assert.equal(report.body.check.allocatedUsd, "0");
  assert.equal(report.body.policy, undefined);
  assert.doesNotMatch(JSON.stringify(report.body), /synthetic-monitor|wrappedKey|modelKey|preimage/);
});
