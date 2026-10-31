import assert from "node:assert/strict";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import { recoverTypedDataAddress } from "viem";
import { handleRunnerOp } from "@/runner/handler";
import { getPublicClient } from "@/lib/evm/client";
import { runnerSettlementAddress } from "@/lib/evm/escrow";
import { lockAuthorizationTypedData, type LockAuthorization } from "@/lib/evm/lock-authorization";
import { loanIdHash } from "@/lib/evm/loan-key";
import { issueDatasetReceipt } from "@/lib/runner/receipt";
import { trainingProfileHash } from "@/lib/models/registry";
import { lockAuthorizationDeadline } from "@/lib/sirius/lock-policy";
import { PENDING_REAPER_TTL_MS } from "@/lib/sirius/reaper-policy";
import { escrowHashlock } from "./core";

const provider = `0x${"11".repeat(20)}` as const;
const borrower = `0x${"22".repeat(20)}` as const;
const escrow = `0x${"33".repeat(20)}` as const;
const datasetId = `0x${"44".repeat(32)}` as const;
const dataset = {
  datasetId: "dataset-permit", cid: "bafy-test", wrappedKey: "wrapped-test", merkleRoot: "55".repeat(32),
  priceUsdcAtomic: "1000000000000000000", challengeDays: 7,
  modelId: "linear_regression", modelVersion: "1.0.0",
} as const;
let live = true;
let signerMatches = true;

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 27).toString("base64");
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = escrow;
  process.env.SIRIUS_DATASET_ADDRESS = provider;
});

beforeEach(() => {
  live = true;
  signerMatches = true;
  mock.method(getPublicClient(), "readContract", async ({ functionName }: { functionName: string }) => {
    if (functionName === "datasetIdOf") return datasetId;
    if (functionName === "matchesScope") return live;
    if (functionName === "lockAuthorizer") return signerMatches ? runnerSettlementAddress() : provider;
    throw new Error(`Appel inattendu : ${functionName}`);
  });
});

afterEach(() => mock.restoreAll());

function input() {
  return { ...dataset, datasetReceipt: issueDatasetReceipt(provider, dataset), borrower, loanId: "loan-permit",
    authorizationDeadline: Math.floor(Date.now() / 1_000) + 240 };
}

test("le runner signe les termes du reçu et son propre hashlock sans révéler le préimage", async () => {
  const body = input();
  const result = await handleRunnerOp("prepare-escrow-lock", body) as { hashlock: `0x${string}`; authorization: LockAuthorization };
  assert.deepEqual(Object.keys(result).sort(), ["authorization", "hashlock"]);
  assert.equal(result.hashlock, escrowHashlock(body.loanId, borrower));
  const recovered = await recoverTypedDataAddress({ ...lockAuthorizationTypedData({
    borrower, provider, amount: BigInt(dataset.priceUsdcAtomic), challengeDays: dataset.challengeDays,
    datasetId, loanIdHash: loanIdHash(body.loanId), hashlock: result.hashlock, trainingProfile: trainingProfileHash(dataset),
  }, { chainId: 46630, escrow }, body.authorizationDeadline), signature: result.authorization.signature });
  assert.equal(recovered.toLowerCase(), runnerSettlementAddress());
});

test("un reçu altéré, un titre détruit ou un autre signataire ne reçoit pas de permis", async () => {
  await assert.rejects(handleRunnerOp("prepare-escrow-lock", { ...input(), priceUsdcAtomic: "2000000000000000000" }), /hors scope/);
  live = false;
  await assert.rejects(handleRunnerOp("prepare-escrow-lock", input()), /inactif ou hors scope/);
  live = true;
  signerMatches = false;
  await assert.rejects(handleRunnerOp("prepare-escrow-lock", input()), /signataire du runner/);
});

test("les permis restent courts et un renouvellement ne dépasse jamais la réservation DB", async () => {
  for (const offset of [-1, 600]) {
    await assert.rejects(handleRunnerOp("prepare-escrow-lock", { ...input(), authorizationDeadline: Math.floor(Date.now() / 1_000) + offset }), /expirée ou trop longue/);
  }
  const created = new Date(1_800_000_000_000);
  const afterApproval = created.getTime() + 5 * 60_000;
  const deadline = lockAuthorizationDeadline(created, afterApproval) * 1_000;
  assert.ok(deadline > afterApproval);
  assert.ok(deadline <= created.getTime() + PENDING_REAPER_TTL_MS - 60_000);
  assert.throws(() => lockAuthorizationDeadline(created, created.getTime() + PENDING_REAPER_TTL_MS), /expirée/);
});
