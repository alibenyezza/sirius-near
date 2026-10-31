import { getPublicClient } from "../../src/lib/evm/client";
import { beginDatasetIngestion } from "../../src/lib/sirius/pipeline";
import { prisma } from "../../src/lib/db";
import { prepareLoan } from "../../src/lib/sirius/borrower";
import { runSelfTrain } from "../../src/lib/sirius/self-train";
import { assertOperatorCode } from "../../src/lib/phala-demo/operator-code";
import { databaseOperatorAttempts } from "../../src/lib/phala-demo/operator-attempts";
import { randomUUID } from "node:crypto";
import type { RunnerGrant } from "../../src/lib/runner/authorization-contract";

const client = getPublicClient();
client.readContract = (async ({ address, functionName }: { address: string; functionName: string }) => {
  if (functionName === "VERSION") return address === process.env.SIRIUS_ESCROW_ADDRESS ? "sirius-escrow-usdc-v6" : "sirius-dataset-v4";
  if (functionName === "datasets") return process.env.SIRIUS_DATASET_ADDRESS;
  if (functionName === "escrow") return process.env.SIRIUS_ESCROW_ADDRESS;
  if (functionName === "datasetIdOf") return `0x${"67".repeat(32)}`;
  return true;
}) as typeof client.readContract;
client.getBlockNumber = async () => BigInt(10);
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === "http://runner.test.invalid/dataset-ingress-key") {
    return Response.json({ version: 1, publicKey: Buffer.alloc(65, 7).toString("base64url"), origin: "http://localhost" });
  }
  if (url === "http://runner.test.invalid/prepare-escrow-lock") {
    return Response.json({ hashlock: `0x${"89".repeat(32)}`, authorization: { deadline: Math.floor(Date.now() / 1000) + 60, signature: "0x" } });
  }
  if (url === "http://runner.test.invalid/run-training") {
    process.send?.({ accepted: true });
    await new Promise<void>((resolve) => process.once("message", () => resolve()));
    return Response.json({ modelCid: "bafy-model", metrics: { n: 20 }, runnerReceipt: "synthetic-result" });
  }
  throw new Error("Accès externe interdit dans le test PostgreSQL");
};

process.send?.("ready");
process.once("message", async (message: { task: "ingest" | "loan" | "training" | "operator-code"; provider: string }) => {
  try {
    if (message.task === "loan") await prepareLoan("history", message.provider);
    else if (message.task === "training") await runSelfTrain("history", message.provider, randomUUID(), "synthetic", {} as RunnerGrant);
    else if (message.task === "operator-code") await assertOperatorCode(message.provider, "wrong-operator-code", databaseOperatorAttempts);
    else await beginDatasetIngestion({ name: "synthetic", provider: message.provider, sizeBytes: 100,
      priceUsdcAtomic: "1000", challengeDays: 1, model: { modelId: "linear_regression", modelVersion: "1.0.0" } });
    process.send?.({ accepted: true });
  } catch (error) {
    process.send?.({ accepted: false, code: (error as { code?: string; status?: number }).code
      ?? (error as { status?: number }).status ?? (error as Error).message });
  } finally {
    await prisma.$disconnect();
    process.disconnect?.();
  }
});
